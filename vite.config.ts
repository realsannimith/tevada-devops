import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// This config exists so tooling (e.g. the shadcn CLI) can detect the Vite +
// React setup and resolve the `@/` alias. Electron Forge does NOT use this file;
// it uses vite.main.config.ts / vite.preload.config.ts / vite.renderer.config.ts
// as declared in forge.config.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
