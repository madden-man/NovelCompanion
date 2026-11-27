import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

/** File types the web build holds (P4's `dist/web`). */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface WebServerOptions {
  /** The Fetch handler served at `/rpc` (`createRpc`); it queues requests itself. */
  rpc: (request: Request) => Promise<Response>;
  /** A folder of static files served at `/`, with `index.html` for any path without a file. */
  staticDir?: string | null;
}

/**
 * A58: the local stand-in for Netlify, for development and tests: `/rpc` goes
 * to the same handler the function wraps, anything else to the static web
 * build when there is one. Every static answer carries `noindex` (PH-14).
 */
export function webServer(options: WebServerOptions): Server {
  return createServer((req, res) => {
    void route(options, req, res).catch((e: unknown) => {
      console.error('Novel Companion serve-web:', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('The local server failed on this request.');
    });
  });
}

async function route(
  options: WebServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/rpc') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const answer = await options.rpc(
      new Request(url, {
        method: req.method ?? 'GET',
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
    return;
  }
  const file = options.staticDir ? await staticFile(options.staticDir, url.pathname) : null;
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex' });
    res.end('Not found.');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'X-Robots-Tag': 'noindex',
    'Cache-Control': 'no-cache',
  });
  res.end(await readFile(file));
}

/** The file for a path inside the folder, `index.html` when there is none; never outside it. */
async function staticFile(dir: string, pathname: string): Promise<string | null> {
  const root = resolve(dir);
  const wanted = resolve(join(root, normalize(decodeURIComponent(pathname))));
  if (wanted !== root && !wanted.startsWith(root + sep)) return null;
  for (const candidate of [wanted, join(root, 'index.html')]) {
    const found = await stat(candidate).catch(() => null);
    if (found?.isFile()) return candidate;
  }
  return null;
}
