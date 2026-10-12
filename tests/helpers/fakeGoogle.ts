import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake Google for tests (T-2: "Drive import and export against a mocked
 * Drive"). It speaks the same HTTP as Google's OAuth and Drive v3 endpoints
 * the app calls, on 127.0.0.1, so no test ever reaches the network. The
 * consent page answers at once with a redirect to the app's loopback
 * listener, as Google does after the person clicks Allow.
 */

export const READONLY = 'https://www.googleapis.com/auth/drive.readonly';
export const FILE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents: string[];
  trashed?: boolean;
  shared?: boolean;
  /** The bytes a download or an export returns. */
  content?: Buffer;
  appProperties?: Record<string, string>;
  /** Set on files created through the API, with the client that created them. */
  createdByApp?: boolean;
}

export interface FakeGoogle {
  base: string;
  clientId: string;
  clientSecret: string;
  files: Map<string, FakeFile>;
  /** Every request, as "METHOD /path". */
  calls: string[];
  /** The last consent request's query parameters. */
  lastAuth: URLSearchParams | null;
  /** The last token exchange's form. */
  lastTokenForm: URLSearchParams | null;
  revoked: string[];
  /** File IDs whose metadata request answers with this HTTP status (for example 500). */
  failFiles: Map<string, number>;
  /** What the next consent does: allow (optionally granting fewer scopes) or deny. */
  consent: { deny?: boolean; grant?: string[] };
  /** Make every refresh token stop working, as Google does after 7 days in testing. */
  expireRefreshTokens(): void;
  addFile(f: Omit<FakeFile, 'modifiedTime' | 'parents'> & Partial<FakeFile>): FakeFile;
  touch(id: string, at?: string, content?: Buffer): void;
  /** Uploaded file contents, by name. */
  uploads: { name: string; parent: string; mimeType: string; content: string }[];
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export async function startFakeGoogle(opts: { email?: string } = {}): Promise<FakeGoogle> {
  const clientId = '123456789012-abcdefghij.apps.googleusercontent.com';
  const clientSecret = 'GOCSPX-fake-secret-value';
  const codes = new Map<
    string,
    { scopes: string[]; challenge: string; redirectUri: string; clientId: string }
  >();
  const refresh = new Map<string, string[]>();
  const access = new Map<string, string[]>();
  let counter = 0;
  const id = (p: string) => `${p}${(++counter).toString().padStart(4, '0')}`;

  const fake: FakeGoogle = {
    base: '',
    clientId,
    clientSecret,
    files: new Map(),
    calls: [],
    lastAuth: null,
    lastTokenForm: null,
    revoked: [],
    failFiles: new Map(),
    consent: {},
    uploads: [],
    expireRefreshTokens() {
      refresh.clear();
    },
    addFile(f) {
      const file: FakeFile = {
        modifiedTime: '2026-10-01T10:00:00.000Z',
        parents: ['root'],
        ...f,
      };
      fake.files.set(file.id, file);
      return file;
    },
    touch(fileId, at = new Date().toISOString(), content) {
      const f = fake.files.get(fileId);
      if (!f) throw new Error(`no fake file ${fileId}`);
      f.modifiedTime = at;
      if (content) f.content = content;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const driveError = (res: ServerResponse, status: number, reason: string, message: string) =>
    json(res, status, { error: { code: status, message, errors: [{ reason, message }] } });

  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const meta = (f: FakeFile) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    parents: f.parents,
    trashed: f.trashed ?? false,
    webViewLink: `https://drive.google.com/drive/folders/${f.id}`,
  });

  /** Enough of Drive's query language for the queries the app sends. */
  const matches = (f: FakeFile, q: string): boolean => {
    if (/trashed = false/.test(q) && f.trashed) return false;
    const parent = /'([^']+)' in parents/.exec(q);
    if (parent && !f.parents.includes(parent[1] as string)) return false;
    if (/sharedWithMe/.test(q) && !f.shared) return false;
    const name = /name contains '([^']*)'/.exec(q);
    if (name && !f.name.toLowerCase().includes((name[1] as string).toLowerCase())) return false;
    const prop = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
    if (prop && f.appProperties?.[prop[1] as string] !== prop[2]) return false;
    const mimes = [...q.matchAll(/mimeType = '([^']+)'/g)].map((m) => m[1]);
    if (mimes.length && !mimes.includes(f.mimeType)) return false;
    return true;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      fake.calls.push(`${req.method} ${url.pathname}`);

      // ---------- OAuth ----------
      if (url.pathname === '/o/oauth2/v2/auth') {
        const p = url.searchParams;
        fake.lastAuth = p;
        const redirect = new URL(p.get('redirect_uri') ?? '');
        redirect.searchParams.set('state', p.get('state') ?? '');
        if (fake.consent.deny || p.get('client_id') !== clientId) {
          redirect.searchParams.set('error', 'access_denied');
        } else {
          const asked = (p.get('scope') ?? '').split(' ');
          const scopes = fake.consent.grant ?? asked;
          const code = `code-${id('c')}`;
          codes.set(code, {
            // As for installed apps, Google grants exactly the scopes asked (or `consent.grant`):
            // there is no incremental authorization, so earlier grants are not carried over.
            scopes,
            challenge: p.get('code_challenge') ?? '',
            redirectUri: p.get('redirect_uri') ?? '',
            clientId: p.get('client_id') ?? '',
          });
          redirect.searchParams.set('code', code);
        }
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams((await body(req)).toString());
        fake.lastTokenForm = form;
        if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
          return json(res, 401, { error: 'invalid_client' });
        }
        if (form.get('grant_type') === 'authorization_code') {
          const c = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = b64url(createHash('sha256').update(verifier).digest());
          if (!c || c.challenge !== challenge || c.redirectUri !== form.get('redirect_uri')) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          const at = `at-${randomBytes(6).toString('hex')}`;
          const rt = `rt-${randomBytes(6).toString('hex')}`;
          access.set(at, c.scopes);
          refresh.set(rt, c.scopes);
          return json(res, 200, {
            access_token: at,
            refresh_token: rt,
            expires_in: 3599,
            scope: c.scopes.join(' '),
            token_type: 'Bearer',
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          const scopes = refresh.get(form.get('refresh_token') ?? '');
          if (!scopes) return json(res, 400, { error: 'invalid_grant' });
          const at = `at-${randomBytes(6).toString('hex')}`;
          access.set(at, scopes);
          return json(res, 200, { access_token: at, expires_in: 3599, scope: scopes.join(' ') });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/revoke' && req.method === 'POST') {
        const token = new URLSearchParams((await body(req)).toString()).get('token') ?? '';
        fake.revoked.push(token);
        refresh.delete(token);
        return json(res, 200, {});
      }

      // ---------- Drive v3 ----------
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      const scopes = auth ? access.get(auth[1] as string) : undefined;
      if (!scopes) return driveError(res, 401, 'authError', 'Invalid Credentials');
      const canRead = (f: FakeFile) =>
        scopes.includes(READONLY) || (scopes.includes(FILE) && f.createdByApp === true);
      const canWrite = scopes.includes(FILE);

      if (url.pathname === '/drive/v3/about') {
        return json(res, 200, {
          user: { emailAddress: opts.email ?? 'writer@example.com', displayName: 'Writer' },
        });
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const list = [...fake.files.values()]
          .filter((f) => canRead(f) && matches(f, q))
          .sort(
            (a, b) =>
              Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER) ||
              a.name.localeCompare(b.name),
          );
        return json(res, 200, { files: list.map(meta) });
      }
      const one = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
      if (one && req.method === 'GET') {
        const failing = fake.failFiles.get(decodeURIComponent(one[1] as string));
        if (failing && !one[2]) return driveError(res, failing, 'backendError', 'Backend Error');
        const f = fake.files.get(decodeURIComponent(one[1] as string));
        if (!f || !canRead(f)) return driveError(res, 404, 'notFound', 'File not found');
        if (one[2]) {
          if (!f.mimeType.startsWith('application/vnd.google-apps.')) {
            return driveError(res, 403, 'fileNotExportable', 'Only Docs Editors files');
          }
          res.writeHead(200, { 'Content-Type': url.searchParams.get('mimeType') ?? '' });
          return res.end(f.content ?? Buffer.alloc(0));
        }
        if (url.searchParams.get('alt') === 'media') {
          if (f.mimeType.startsWith('application/vnd.google-apps.')) {
            return driveError(res, 403, 'fileNotDownloadable', 'Use Export');
          }
          res.writeHead(200, { 'Content-Type': f.mimeType });
          return res.end(f.content ?? Buffer.alloc(0));
        }
        return json(res, 200, meta(f));
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
        if (!canWrite) return driveError(res, 403, 'insufficientPermissions', 'Insufficient scope');
        const m = JSON.parse((await body(req)).toString()) as Partial<FakeFile>;
        const parent = m.parents?.[0];
        if (parent && !(fake.files.get(parent)?.createdByApp ?? false)) {
          return driveError(res, 404, 'notFound', `File not found: ${parent}.`);
        }
        const f = fake.addFile({
          id: id('fold'),
          name: m.name ?? 'Untitled',
          mimeType: m.mimeType ?? FOLDER,
          parents: m.parents ?? ['root'],
          modifiedTime: new Date().toISOString(),
          createdByApp: true,
          ...(m.appProperties ? { appProperties: m.appProperties } : {}),
        });
        return json(res, 200, meta(f));
      }
      if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        if (!canWrite) return driveError(res, 403, 'insufficientPermissions', 'Insufficient scope');
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1] ?? '';
        const raw = (await body(req)).toString();
        const parts = raw.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
        const partBody = (p: string) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
        const m = JSON.parse(partBody(parts[0] ?? '{}')) as {
          name: string;
          parents: string[];
          mimeType: string;
        };
        const parent = m.parents[0] ?? '';
        if (!(fake.files.get(parent)?.createdByApp ?? false)) {
          return driveError(res, 404, 'notFound', `File not found: ${parent}.`);
        }
        const content = partBody(parts[1] ?? '');
        fake.uploads.push({ name: m.name, parent, mimeType: m.mimeType, content });
        const f = fake.addFile({
          id: id('up'),
          name: m.name,
          mimeType: m.mimeType,
          parents: [parent],
          content: Buffer.from(content),
          createdByApp: true,
          modifiedTime: new Date().toISOString(),
        });
        return json(res, 200, meta(f));
      }
      driveError(res, 404, 'notFound', `No fake for ${req.method} ${url.pathname}`);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
