import { FOLDER_MIME, driveKind, exportMimeFor, importFileName } from '../../shared/domain/drive';
import type { DriveKind, DriveLink, MarkdownFolder, RemoteFile } from '../../shared/domain/drive';
import { DriveApi, DriveError, q } from './api';
import type { DriveFile } from './api';
import {
  GoogleAuthError,
  SCOPE_FILE,
  SCOPE_READONLY,
  authorize,
  refreshAccess,
  revokeToken,
} from './oauth';
import type { GoogleEndpoints, OAuthClient, TokenSet } from './oauth';
import { CLIENT_ACCOUNT, TOKENS_ACCOUNT } from './secrets';
import type { SecretStore } from './secrets';

export interface DriveStatus {
  /** An OAuth client ID and secret are in the keychain. */
  clientConfigured: boolean;
  /** The client ID with its middle hidden, for recognising it. Never the secret. */
  clientIdHint: string | null;
  connected: boolean;
  email: string | null;
  /** The export scope (drive.file) has been granted too. */
  canExport: boolean;
}

export interface BrowseItem {
  id: string;
  name: string;
  mimeType: string;
  kind: DriveKind;
  modifiedAt: string;
}

/** A Drive file as bytes the existing importers read (M5), for GD-2 and MS-1. */
export interface FetchedDriveFile {
  fileId: string;
  /** The name the importer records, with .docx or .xlsx added to a Google file (IM-6). */
  fileName: string;
  /** Drive's modified time: the newer source wins on a conflict (IM-7). */
  modifiedAt: string;
  kind: 'workbook' | 'document';
  /** The file's own type in Drive. */
  mimeType: string;
  data: Buffer;
}

export interface DriveServiceDeps {
  secrets: SecretStore;
  endpoints: GoogleEndpoints;
  openBrowser: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  authTimeoutMs?: number;
}

interface StoredTokens extends TokenSet {
  email: string | null;
}

const SUPPORTED_Q = [
  FOLDER_MIME,
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]
  .map((m) => `mimeType = '${m}'`)
  .join(' or ');

/** Marks a folder the app created as an export target (GD-4). Visible only to this app. */
const EXPORT_PROPERTY = { key: 'novelCompanion', value: 'exportTarget' };

const NOT_SET_UP =
  'Google Drive is not set up. Add the OAuth client ID and secret in Settings first (docs/DRIVE-SETUP.md).';
const NOT_CONNECTED = 'Google Drive is not connected. Connect it in Settings.';

export class DriveService {
  readonly api: DriveApi;
  private readonly f: typeof fetch;

  constructor(private readonly d: DriveServiceDeps) {
    this.f = d.fetch ?? fetch;
    this.api = new DriveApi({
      endpoints: d.endpoints,
      fetch: this.f,
      token: (force) => this.accessToken(force === true),
    });
  }

  // ---------- client and tokens (GD-1, GD-5) ----------

  private client(): OAuthClient | null {
    const raw = this.d.secrets.get(CLIENT_ACCOUNT);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as Partial<OAuthClient>;
      return c.clientId && c.clientSecret
        ? { clientId: c.clientId, clientSecret: c.clientSecret }
        : null;
    } catch {
      return null;
    }
  }

  private tokens(): StoredTokens | null {
    const raw = this.d.secrets.get(TOKENS_ACCOUNT);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as StoredTokens;
      return t.refreshToken ? t : null;
    } catch {
      return null;
    }
  }

  private saveTokens(t: StoredTokens): void {
    this.d.secrets.set(TOKENS_ACCOUNT, JSON.stringify(t));
  }

  status(): DriveStatus {
    const c = this.client();
    const t = this.tokens();
    return {
      clientConfigured: c !== null,
      clientIdHint: c ? hint(c.clientId) : null,
      connected: c !== null && t !== null,
      email: t?.email ?? null,
      canExport: t?.scopes.includes(SCOPE_FILE) ?? false,
    };
  }

  /** Store the OAuth client in the keychain. A changed client drops the old tokens. */
  setClient(clientId: string, clientSecret: string): DriveStatus {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
      throw new Error(
        'That is not a Google OAuth client ID. It ends in .apps.googleusercontent.com.',
      );
    }
    if (secret.length < 8 || /\s/.test(secret)) {
      throw new Error('That client secret looks incomplete. Copy it again from Google Cloud.');
    }
    const before = this.client();
    if (before && before.clientId !== id) this.d.secrets.delete(TOKENS_ACCOUNT);
    this.d.secrets.set(CLIENT_ACCOUNT, JSON.stringify({ clientId: id, clientSecret: secret }));
    return this.status();
  }

  /** Remove the client and any tokens made with it. */
  async clearClient(): Promise<DriveStatus> {
    await this.disconnect();
    this.d.secrets.delete(CLIENT_ACCOUNT);
    return this.status();
  }

  /** GD-1: sign in through the system browser with read-only access for import. */
  async connect(): Promise<DriveStatus> {
    return this.signIn([SCOPE_READONLY]);
  }

  /** GD-4: add access to the files the app creates, for export. Asked only when exporting. */
  async allowExport(): Promise<DriveStatus> {
    if (!this.tokens()) throw new Error(NOT_CONNECTED);
    return this.signIn([SCOPE_READONLY, SCOPE_FILE]);
  }

  private async signIn(scopes: string[]): Promise<DriveStatus> {
    const client = this.client();
    if (!client) throw new Error(NOT_SET_UP);
    const set = await authorize({
      client,
      scopes,
      endpoints: this.d.endpoints,
      openBrowser: this.d.openBrowser,
      fetch: this.f,
      ...(this.d.authTimeoutMs ? { timeoutMs: this.d.authTimeoutMs } : {}),
    });
    if (!set.scopes.includes(SCOPE_READONLY)) {
      // Revoking one token of a grant revokes the whole grant, so tokens kept
      // from an earlier connect stop working too: drop them, so status is true.
      this.d.secrets.delete(TOKENS_ACCOUNT);
      await revokeToken(set.refreshToken, this.d.endpoints, this.f);
      throw new Error(
        'Google Drive was not connected: the box allowing the app to see your Drive files was left unticked. Connect again and tick it.',
      );
    }
    if (scopes.includes(SCOPE_FILE) && !set.scopes.includes(SCOPE_FILE)) {
      this.saveTokens({ ...set, email: this.tokens()?.email ?? null });
      throw new Error(
        'Export was not allowed: the box allowing the app to create files was left unticked. Try again and tick it.',
      );
    }
    this.saveTokens({ ...set, email: this.tokens()?.email ?? null });
    try {
      const me = await this.api.about();
      // A disconnect during the lookup wins: write only over this same grant.
      const now = this.tokens();
      if (now?.refreshToken === set.refreshToken) {
        this.saveTokens({ ...now, email: me.email || null });
      }
    } catch {
      // The account name is a nicety; the connection works without it.
    }
    return this.status();
  }

  /** GD-5: revoke at Google (best effort) and delete the tokens from the keychain. */
  async disconnect(): Promise<DriveStatus> {
    const t = this.tokens();
    this.d.secrets.delete(TOKENS_ACCOUNT);
    if (t) await revokeToken(t.refreshToken, this.d.endpoints, this.f);
    return this.status();
  }

  private async accessToken(force: boolean): Promise<string> {
    const client = this.client();
    if (!client) throw new DriveError(NOT_SET_UP, 0);
    const t = this.tokens();
    if (!t) throw new DriveError(NOT_CONNECTED, 0);
    if (!force && t.expiresAt - 60_000 > Date.now()) return t.accessToken;
    try {
      const fresh = await refreshAccess(client, t.refreshToken, this.d.endpoints, this.f);
      // GD-5: a disconnect (or a new connect) while the refresh was in flight
      // wins. Never write a token set back over a cleared or replaced one.
      const now = this.tokens();
      if (now?.refreshToken !== t.refreshToken) throw new DriveError(NOT_CONNECTED, 401);
      this.saveTokens({
        ...now,
        accessToken: fresh.accessToken,
        expiresAt: fresh.expiresAt,
        scopes: fresh.scopes ?? now.scopes,
      });
      return fresh.accessToken;
    } catch (e) {
      if (e instanceof GoogleAuthError && e.code === 'invalid_grant') {
        if (this.tokens()?.refreshToken === t.refreshToken) {
          this.d.secrets.delete(TOKENS_ACCOUNT);
        }
        throw new DriveError(e.message, 401);
      }
      throw e;
    }
  }

  // ---------- choosing files (GD-2) ----------

  async browse(p: {
    folderId?: string | null;
    place?: 'myDrive' | 'shared';
    search?: string;
  }): Promise<{ folder: { id: string; name: string } | null; items: BrowseItem[] }> {
    let query: string;
    let folder: { id: string; name: string } | null = null;
    if (p.search?.trim()) {
      query = `name contains ${q(p.search.trim())} and trashed = false and (${SUPPORTED_Q})`;
    } else if (p.folderId) {
      const meta = await this.api.get(p.folderId);
      if (!meta) throw new Error('That folder is no longer in Google Drive.');
      folder = { id: meta.id, name: meta.name };
      query = `${q(p.folderId)} in parents and trashed = false`;
    } else if (p.place === 'shared') {
      query = 'sharedWithMe and trashed = false';
    } else {
      query = `'root' in parents and trashed = false`;
    }
    const files = await this.api.list(query, 500);
    return { folder, items: files.map(toItem) };
  }

  // ---------- change detection (GD-3) ----------

  /** What Drive says now about every linked file, and every supported file inside linked folders. */
  async check(
    links: readonly DriveLink[],
  ): Promise<{ remote: RemoteFile[]; missing: string[]; missingFolders: string[] }> {
    const remote: RemoteFile[] = [];
    const missing: string[] = [];
    const missingFolders: string[] = [];
    for (const link of links) {
      const meta = await this.api.get(link.id);
      if (!meta || meta.trashed) {
        (link.kind === 'folder' ? missingFolders : missing).push(link.id);
        continue;
      }
      if (link.kind !== 'folder') {
        remote.push({ ...pick(meta), linkId: link.id });
        continue;
      }
      for (const f of await this.walk(meta.id)) remote.push({ ...pick(f), linkId: link.id });
    }
    return { remote, missing, missingFolders };
  }

  /** Supported files in a folder and its subfolders, at most four levels and 1,000 files. */
  private async walk(folderId: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let level = [folderId];
    for (let depth = 0; depth < 4 && level.length && out.length < 1000; depth++) {
      const next: string[] = [];
      for (const id of level) {
        for (const f of await this.api.list(`${q(id)} in parents and trashed = false`)) {
          const kind = driveKind(f.mimeType, f.name);
          if (kind === 'folder') next.push(f.id);
          else if (kind !== 'other') out.push(f);
        }
      }
      level = next;
    }
    return out.slice(0, 1000);
  }

  // ---------- fetching (GD-2, and MS-1 for M7) ----------

  /**
   * One Drive file as Word or Excel bytes. A Google Doc is exported as .docx
   * and a Google Sheet as .xlsx; an uploaded Word or Excel file is downloaded
   * as it is. Read-only: nothing in Drive is changed (MS-5).
   */
  async fetchFile(fileId: string): Promise<FetchedDriveFile> {
    const meta = await this.api.get(fileId);
    if (!meta || meta.trashed) {
      throw new Error('That file is no longer in Google Drive. It may be deleted or unshared.');
    }
    const kind = driveKind(meta.mimeType, meta.name);
    if (kind !== 'workbook' && kind !== 'document') {
      throw new Error(
        `The app imports Word, Excel, Google Docs, and Google Sheets files. ${meta.name} is none of these.`,
      );
    }
    const asOffice = exportMimeFor(meta.mimeType);
    const data = asOffice
      ? await this.api.exportAs(meta.id, asOffice)
      : await this.api.download(meta.id);
    return {
      fileId: meta.id,
      fileName: importFileName(meta.name, meta.mimeType),
      modifiedAt: new Date(meta.modifiedTime).toISOString(),
      kind,
      mimeType: meta.mimeType,
      data,
    };
  }

  // ---------- export (GD-4) ----------

  /** Folders this app created for exports. With drive.file the app sees only its own folders. */
  async exportFolders(): Promise<{ id: string; name: string }[]> {
    this.requireExport();
    const files = await this.api.list(
      `appProperties has { key=${q(EXPORT_PROPERTY.key)} and value=${q(EXPORT_PROPERTY.value)} } and trashed = false and mimeType = '${FOLDER_MIME}'`,
      200,
    );
    return files.map((f) => ({ id: f.id, name: f.name }));
  }

  /** A new export folder at the top of My Drive. Tommy may move it anywhere afterwards. */
  async createExportFolder(name: string): Promise<{ id: string; name: string }> {
    this.requireExport();
    const clean = name.trim();
    if (!clean) throw new Error('Give the folder a name.');
    const f = await this.api.createFolder(clean, null, {
      [EXPORT_PROPERTY.key]: EXPORT_PROPERTY.value,
    });
    return { id: f.id, name: f.name };
  }

  /**
   * Write one export: a new dated folder inside the chosen folder, holding the
   * JSON file and one folder per section of Markdown files. Every file is new,
   * so an export never overwrites an earlier one.
   */
  async exportBible(p: {
    parentId: string;
    folderName: string;
    json: { name: string; text: string };
    markdown: MarkdownFolder[];
  }): Promise<{ folder: { id: string; name: string; url: string | null }; files: number }> {
    this.requireExport();
    const root = await this.api.createFolder(p.folderName, p.parentId);
    await this.api.upload(p.json.name, root.id, 'application/json', p.json.text);
    let files = 1;
    for (const section of p.markdown) {
      const folder = await this.api.createFolder(section.folder, root.id);
      await pool(section.files, 4, async (file) => {
        await this.api.upload(file.name, folder.id, 'text/markdown', file.content);
        files += 1;
      });
    }
    return {
      folder: { id: root.id, name: root.name, url: root.webViewLink ?? null },
      files,
    };
  }

  private requireExport(): void {
    if (!this.status().connected) throw new Error(NOT_CONNECTED);
    if (!this.status().canExport) {
      throw new Error('Allow export first: the app needs permission to create files in Drive.');
    }
  }
}

function hint(clientId: string): string {
  const head = clientId.split('.')[0] ?? clientId;
  return `${head.slice(0, 6)}…${head.slice(-4)}.apps.googleusercontent.com`;
}

function toItem(f: DriveFile): BrowseItem {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    kind: driveKind(f.mimeType, f.name),
    modifiedAt: new Date(f.modifiedTime).toISOString(),
  };
}

function pick(f: DriveFile): Omit<RemoteFile, 'linkId'> {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: new Date(f.modifiedTime).toISOString(),
  };
}

async function pool<T>(items: readonly T[], size: number, run: (t: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  });
  await Promise.all(workers);
}
