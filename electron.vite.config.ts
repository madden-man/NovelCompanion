import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin, Rollup } from 'vite';
import { contentSecurityPolicy } from './src/shared/csp';

/** Writes the renderer CSP meta tag: strict when built, plus the hot reload socket in dev. */
function cspMeta(): Plugin {
  return {
    name: 'novel-companion-csp',
    transformIndexHtml(html, ctx) {
      return html.replace(
        '__CONTENT_SECURITY_POLICY__',
        contentSecurityPolicy(Boolean(ctx.server)),
      );
    },
  };
}

const root = import.meta.dirname;

/** zod ships comments Rollup cannot place; they are harmless. */
const quietZod: Rollup.WarningHandlerWithDefault = (warning, warn) => {
  if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules/zod')) return;
  warn(warning);
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(root, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      // A sandboxed preload cannot load node_modules, so zod and the IPC
      // contract are bundled in, and the output is CommonJS.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        onwarn: quietZod,
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react(), cspMeta()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
        onwarn: quietZod,
      },
    },
  },
});
