import { defineConfig } from 'vite';

// https://vitejs.dev/config
//
// `ssh2` (and its optional native accelerator `cpu-features`) must stay external:
// it uses dynamic requires and optional `.node` binaries that Rollup cannot bundle.
// It remains in `dependencies`, so Electron Forge packages it into the app's pruned
// node_modules; `plugin-auto-unpack-natives` unpacks any native optionals from the asar.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['ssh2', 'cpu-features'],
    },
  },
});
