import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Run by Claude Code with ELECTRON_RUN_AS_NODE=1 (Atelier's own executable acts as node).
          'agent-mcp': resolve(__dirname, 'src/agent/mcp.ts'),
          'agent-hook': resolve(__dirname, 'src/agent/hook.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer') } },
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
  },
});
