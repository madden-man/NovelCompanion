import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { defineConfig } from 'vite';
import type { Plugin, Rollup } from 'vite';
import { contentSecurityPolicy } from './src/shared/csp';
import { writeBuildId } from './scripts/build-id';

/**
 * A58 P4: the phone's web build (`npm run build:web`, which netlify.toml runs).
 * The same renderer as the desk, with `src/web/main.tsx` installing the fetch
 * transport as `window.api`. Output in `dist/web`: the shell, the manifest and
 * icons, and `sw.js`, which precaches the shell (PH-24). The build id is
 * written first, so this bundle and the function import the same one (PH-21).
 */
const root = import.meta.dirname;
const outDir = resolve(root, 'dist/web');

/** The CSP meta tag: only same-origin connections, as on the desk (ARCH-1). */
function cspMeta(): Plugin {
  return {
    name: 'novel-companion-web-csp',
    transformIndexHtml(html, ctx) {
      return html.replace(
        '__CONTENT_SECURITY_POLICY__',
        contentSecurityPolicy(Boolean(ctx.server)),
      );
    },
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** PH-24: once the bundle is written, build `sw.js` with the shell's file list and the build id. */
function serviceWorker(buildId: string): Plugin {
  return {
    name: 'novel-companion-service-worker',
    apply: 'build',
    async closeBundle() {
      const precache = filesUnder(outDir)
        .map((f) => `/${relative(outDir, f).split(sep).join('/')}`)
        .filter((u) => u !== '/sw.js' && !u.endsWith('.map'))
        .sort();
      await build({
        entryPoints: [resolve(root, 'src/web/sw.ts')],
        outfile: join(outDir, 'sw.js'),
        bundle: true,
        format: 'iife',
        target: 'es2020',
        minify: true,
        logLevel: 'warning',
        define: {
          __NC_BUILD_ID__: JSON.stringify(buildId),
          __NC_PRECACHE__: JSON.stringify(precache),
        },
      });
    },
  };
}

/** zod ships comments Rollup cannot place; they are harmless. */
const quietZod: Rollup.WarningHandlerWithDefault = (warning, warn) => {
  if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules/zod')) return;
  warn(warning);
};

export default defineConfig(() => {
  const buildId = writeBuildId(root);
  return {
    root: resolve(root, 'src/web'),
    publicDir: resolve(root, 'src/web/public'),
    base: '/',
    plugins: [react(), cspMeta(), serviceWorker(buildId)],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { onwarn: quietZod },
    },
    server: {
      // `npm run dev:web`: the local function from `scripts/serve-web.ts` answers /rpc.
      proxy: { '/rpc': 'http://127.0.0.1:8787' },
    },
  };
});
