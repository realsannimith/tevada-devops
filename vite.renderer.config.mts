import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// This file uses the `.mts` extension so Vite loads it as an ES module, which is
// required because `@vitejs/plugin-react` and `@tailwindcss/vite` are ESM-only.
// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
