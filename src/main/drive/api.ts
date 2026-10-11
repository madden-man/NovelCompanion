import { randomBytes } from 'node:crypto';
import type { GoogleEndpoints } from './oauth';

/** The Drive v3 REST calls the app makes, from the main process only (ARCH-1). */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
}

export class DriveError extends Error {
  override name = 'DriveError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,parents,trashed,webViewLink';

/** Plain words for what Drive said (NF-3). */
function driveErrorText(status: number, reason: string): string {
  if (status === 401)
    return 'Google Drive asked the app to sign in again. Connect again in Settings.';
  if (status === 403 && /insufficient|scope/i.test(reason)) {
    return 'The Drive connection does not allow this. Connect again in Settings and allow the access the app asks for.';
  }
  if (status === 403 && /exportSizeLimit|too large/i.test(reason)) {
    return 'Google will not export this file because it is larger than 10 MB. Download it as Word or Excel and import the file instead.';
  }
  if (status === 403 && /rate|quota/i.test(reason)) {
    return 'Google Drive is limiting requests right now. Wait a minute and try again.';
  }
  if (status === 404)
    return 'Google Drive could not find that file. It may be deleted or no longer shared with you.';
  if (status === 429)
    return 'Google Drive is limiting requests right now. Wait a minute and try again.';
  if (status >= 500) return 'Google Drive is having trouble right now. Try again in a few minutes.';
  return `Google Drive refused the request (${status}${reason ? `: ${reason}` : ''}).`;
}

export interface DriveApiOptions {
  endpoints: GoogleEndpoints;
  /** A valid access token; `force` asks for a refresh after a 401. */
  token: (force?: boolean) => Promise<string>;
  fetch?: typeof fetch;
}

export class DriveApi {
  private readonly f: typeof fetch;
  constructor(private readonly o: DriveApiOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await this.o.token(force);
      try {
        return await this.f(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        throw new DriveError(
          'The app could not reach Google Drive. Check your network connection and try again.',
          0,
        );
      }
    };
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      const reason = [body.error?.errors?.[0]?.reason, body.error?.message]
        .filter(Boolean)
        .join(' ');
      throw new DriveError(driveErrorText(res.status, reason), res.status);
    }
    return res;
  }

  private url(path: string, params: Record<string, string> = {}, base = this.o.endpoints.drive) {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** The signed-in account, shown as "Connected as". */
  async about(): Promise<{ email: string; name: string }> {
    const res = await this.send(this.url('/about', { fields: 'user(emailAddress,displayName)' }));
    const body = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
    return { email: body.user?.emailAddress ?? '', name: body.user?.displayName ?? '' };
  }

  /** Every file matching a Drive query, following pages up to `max`. */
  async list(q: string, max = 1000): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.send(
        this.url('/files', {
          q,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: '200',
          orderBy: 'folder,name',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken && out.length < max);
    return out.slice(0, max);
  }

  /** One file's details, or null when Drive no longer has it for this account. */
  async get(id: string): Promise<DriveFile | null> {
    try {
      const res = await this.send(
        this.url(`/files/${encodeURIComponent(id)}`, {
          fields: FILE_FIELDS,
          supportsAllDrives: 'true',
        }),
      );
      return (await res.json()) as DriveFile;
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return null;
      throw e;
    }
  }

  /** The bytes of a stored file (Word or Excel uploaded to Drive). */
  async download(id: string): Promise<Buffer> {
    const res = await this.send(
      this.url(`/files/${encodeURIComponent(id)}`, { alt: 'media', supportsAllDrives: 'true' }),
    );
    return Buffer.from(await res.arrayBuffer());
  }

  /** A Google Doc or Sheet exported to an Office format. */
  async exportAs(id: string, mimeType: string): Promise<Buffer> {
    const res = await this.send(this.url(`/files/${encodeURIComponent(id)}/export`, { mimeType }));
    return Buffer.from(await res.arrayBuffer());
  }

  async createFolder(
    name: string,
    parent: string | null,
    appProperties?: Record<string, string>,
  ): Promise<DriveFile> {
    const res = await this.send(this.url('/files', { fields: FILE_FIELDS }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parent ? { parents: [parent] } : {}),
        ...(appProperties ? { appProperties } : {}),
      }),
    });
    return (await res.json()) as DriveFile;
  }

  /** Create one file with its content in a single multipart upload. */
  async upload(
    name: string,
    parent: string,
    mimeType: string,
    content: string,
  ): Promise<DriveFile> {
    const boundary = `nc${randomBytes(12).toString('hex')}`;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name, parents: [parent], mimeType })}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const res = await this.send(
      this.url('/files', { uploadType: 'multipart', fields: FILE_FIELDS }, this.o.endpoints.upload),
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return (await res.json()) as DriveFile;
  }
}

/** Quote a value inside a Drive query string. */
export const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
