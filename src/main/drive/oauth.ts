import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * GD-1: Google's OAuth 2.0 flow for installed (desktop) apps, as documented
 * at developers.google.com/identity/protocols/oauth2/native-app (checked
 * 2026-10-11): the system browser opens Google's consent page, Google
 * redirects to a one-shot listener on the loopback address
 * (http://127.0.0.1:<random port>), and the code is exchanged with a PKCE
 * verifier (S256). Custom URI schemes and copy-paste codes are no longer
 * supported by Google, so the loopback listener is the only route.
 */

/** Read and download Drive files, used for import only (GD-1). */
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
/** Create files, and see only the files this app created (GD-4 export). */
export const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file';

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  drive: string;
  upload: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};

/** The same paths under one base address: the fake Google the tests run. */
export function endpointsAt(base: string): GoogleEndpoints {
  const b = base.replace(/\/$/, '');
  return {
    auth: `${b}/o/oauth2/v2/auth`,
    token: `${b}/token`,
    revoke: `${b}/revoke`,
    drive: `${b}/drive/v3`,
    upload: `${b}/upload/drive/v3`,
  };
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  scopes: string[];
}

export class GoogleAuthError extends Error {
  override name = 'GoogleAuthError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** A PKCE verifier (43 to 128 characters) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function authUrl(
  endpoints: GoogleEndpoints,
  p: {
    clientId: string;
    redirectUri: string;
    scopes: readonly string[];
    challenge: string;
    state: string;
  },
): string {
  const url = new URL(endpoints.auth);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: p.scopes.join(' '),
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    // A refresh token, so the app stays connected between launches.
    access_type: 'offline',
    // Ask again on every connect, so Google always returns a refresh token.
    prompt: 'consent',
    // Adding the export scope keeps the import scope already granted.
    include_granted_scopes: 'true',
  }).toString();
  return url.toString();
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px -apple-system,system-ui,sans-serif;max-width:32em;margin:4em auto;line-height:1.5">` +
  `<h1 style="font-size:1.4em">${title}</h1><p>${text}</p></body>`;

export interface AuthorizeOptions {
  client: OAuthClient;
  scopes: readonly string[];
  endpoints: GoogleEndpoints;
  /** Opens the consent page in the system browser (never in the app's window). */
  openBrowser: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  /** How long to wait for the person to finish in the browser. */
  timeoutMs?: number;
}

/** Run the whole sign-in: listener, browser, code, token exchange. */
export async function authorize(opts: AuthorizeOptions): Promise<TokenSet> {
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  let settle!: (r: { code: string } | { error: string }) => void;
  const result = new Promise<{ code: string } | { error: string }>((res) => (settle = res));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const got = url.searchParams;
    if (got.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE('Sign-in not recognised', 'Start again from Novel Companion.'));
      return;
    }
    const code = got.get('code');
    const error = got.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    if (code) {
      res.end(PAGE('Connected', 'Google Drive is connected. You can close this tab.'));
      settle({ code });
    } else {
      res.end(PAGE('Not connected', 'Google Drive was not connected. You can close this tab.'));
      settle({ error: error ?? 'unknown' });
    }
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const timer = setTimeout(() => settle({ error: 'timeout' }), timeoutMs);
  try {
    await opts.openBrowser(
      authUrl(opts.endpoints, {
        clientId: opts.client.clientId,
        redirectUri,
        scopes: opts.scopes,
        challenge,
        state,
      }),
    );
    const outcome = await result;
    if ('error' in outcome) {
      throw new GoogleAuthError(
        outcome.error === 'access_denied'
          ? 'Google Drive was not connected: access was declined in the browser.'
          : outcome.error === 'timeout'
            ? 'Google Drive was not connected: the browser sign-in took more than five minutes. Try again.'
            : `Google Drive was not connected. Google said: ${outcome.error}.`,
        outcome.error,
      );
    }
    return await exchangeCode(opts, outcome.code, verifier, redirectUri);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

type TokenReply = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postForm(
  doFetch: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<TokenReply> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new GoogleAuthError(
      'The app could not reach Google. Check your network connection and try again.',
      'network',
    );
  }
  const body = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok || body.error) {
    const code = body.error ?? `http_${res.status}`;
    throw new GoogleAuthError(tokenErrorText(code), code);
  }
  return body;
}

function tokenErrorText(code: string): string {
  switch (code) {
    case 'invalid_grant':
      return 'Google ended the Drive connection (it expires after 7 days while the Google Cloud app is in testing). Connect again in Settings.';
    case 'invalid_client':
    case 'unauthorized_client':
      return 'Google did not accept the OAuth client ID or secret. Check them in Settings against Google Cloud (docs/DRIVE-SETUP.md).';
    default:
      return `Google refused the sign-in (${code}). Try connecting again.`;
  }
}

async function exchangeCode(
  opts: AuthorizeOptions,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenSet> {
  const body = await postForm(opts.fetch ?? fetch, opts.endpoints.token, {
    code,
    client_id: opts.client.clientId,
    // Google treats a desktop client secret as not confidential, but still asks for it.
    client_secret: opts.client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  if (!body.access_token || !body.refresh_token) {
    throw new GoogleAuthError(
      'Google did not return a refresh token. Remove Novel Companion at myaccount.google.com/permissions and connect again.',
      'no_refresh_token',
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scopes: (body.scope ?? opts.scopes.join(' ')).split(/\s+/).filter(Boolean),
  };
}

/** A fresh access token from the refresh token. */
export async function refreshAccess(
  client: OAuthClient,
  refreshToken: string,
  endpoints: GoogleEndpoints,
  doFetch: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number; scopes: string[] | null }> {
  const body = await postForm(doFetch, endpoints.token, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!body.access_token) throw new GoogleAuthError(tokenErrorText('no_access'), 'no_access');
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : null,
  };
}

/** Tell Google to forget the grant. Best effort: disconnecting never waits on the network. */
export async function revokeToken(
  token: string,
  endpoints: GoogleEndpoints,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch(endpoints.revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
