import { defineConfig } from 'vite';

// Config the main process reads from `process.env` at runtime. In DEV these come
// from `.env` via `dotenv/config` (see src/main.ts). A PACKAGED app ships no
// `.env`, so for production builds we bake them into the main bundle from the
// BUILD environment — which in CI is populated from GitHub Actions secrets and
// is never committed to the repo. Unset → empty string → the feature is simply
// disabled (e.g. Google Drive sync stays off) rather than crashing.
//
// Note on the Google client secret: for a Google "Desktop app" OAuth client the
// secret is not a true confidential secret (the flow is PKCE-protected), so
// baking it into the distributed binary is acceptable — but it still must not
// live in the repo, hence build-time injection from a GitHub secret.
const BAKED_ENV_KEYS = [
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_APP_SLUG',
] as const;

// https://vitejs.dev/config
//
// `ssh2` (and its optional native accelerator `cpu-features`) must stay external:
// it uses dynamic requires and optional `.node` binaries that Rollup cannot bundle.
// Packaged builds ship it via the RUNTIME_MODULES whitelist in forge.config.ts
// (plugin-vite otherwise strips node_modules from the package entirely);
// plugin-auto-unpack-natives unpacks the native optionals from the asar.
export default defineConfig(({ mode }) => {
  const define: Record<string, string> = {};
  // Only bake for production packaging. In development (`bun run dev`) we leave
  // `process.env.X` untouched so the runtime dotenv value from `.env` is used.
  if (mode === 'production') {
    for (const key of BAKED_ENV_KEYS) {
      define[`process.env.${key}`] = JSON.stringify(process.env[key] ?? '');
    }
  }
  return {
    define,
    build: {
      rollupOptions: {
        external: ['ssh2', 'cpu-features'],
      },
    },
  };
});
