---
name: deploy-ssr-frontend
description: Server-rendered frontend specifics for a Docker deploy — Next.js, Nuxt, SvelteKit, Remix / React Router v7, Astro SSR, Angular SSR. Use with docker-deploy when the app is a meta-framework frontend that renders on a Node server (has API routes, server actions, or SSR). For pure static builds use deploy-static-frontend instead.
---

# Deploy a server-rendered frontend (Next.js, Nuxt, SvelteKit, Remix, Astro SSR)

`docker-deploy` owns the overall flow. This skill supplies the meta-framework
specifics. These apps build to a small Node server; the Dockerfile shape is
always: build stage (full deps) → runtime stage (build output only).

First decide SSR vs static: if the config sets a static export/adapter
(`output: 'export'` in next.config, `@astrojs/*static*`, `adapter-static` in
SvelteKit, `ssr: false` + generate in Nuxt), it builds to plain files — load
`deploy-static-frontend` instead.

## Build-time env warning (applies to all of them)

`NEXT_PUBLIC_*`, `VITE_*`, `PUBLIC_*` variables are **baked in at build time**
— passing them at `docker run` does nothing. Pass them as build args:
`ARG NEXT_PUBLIC_API_URL` + `ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL`
before `RUN npm run build`, and build with `--build-arg`. Server-only secrets
still go in the runtime `--env-file`, never into the image.

Use the package manager the lockfile dictates (see `deploy-nodejs` § 1 for the
npm/pnpm/yarn/bun install lines). npm shown below.

## Next.js

Best practice is standalone output — a self-contained server with pruned deps.
Check `next.config.*`; if `output: 'standalone'` is not set, add it (one-line
edit, safe).

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Without standalone, the runtime stage needs full prod deps +
`CMD ["npx", "next", "start"]` — works, but the image is several times larger.

## Nuxt 3

Builds to `.output/` — fully self-contained, no node_modules needed at runtime.

- Build stage: `RUN npm run build`
- Runtime: `COPY --from=build /app/.output ./.output`,
  `ENV NITRO_HOST=0.0.0.0 NITRO_PORT=3000`, `EXPOSE 3000`,
  `CMD ["node", ".output/server/index.mjs"]`

## SvelteKit (adapter-node)

Requires `@sveltejs/adapter-node` in svelte.config (add it if the project uses
`adapter-auto` — that one can't produce a server build in Docker).

- Build stage: `RUN npm run build` → `build/`
- Runtime: copy `build/`, `package.json`, and prod node_modules
  (`npm ci --omit=dev`), `ENV HOST=0.0.0.0 PORT=3000`,
  `CMD ["node", "build/index.js"]`

## Remix / React Router v7 (framework mode)

- Build stage: `RUN npm run build` → `build/server` + `build/client`
- Runtime: prod deps + build output,
  `CMD ["npx", "react-router-serve", "./build/server/index.js"]`
  (older Remix: `["npx", "remix-serve", "./build/server/index.js"]`), port 3000.
  If the repo has its own `server.js`/`server.ts` (custom Express server), run
  that instead — check `scripts.start`.

## Astro (SSR, @astrojs/node adapter)

- Build stage: `RUN npm run build` → `dist/`
- Runtime: copy `dist/` + prod deps, `ENV HOST=0.0.0.0 PORT=4321`,
  `EXPOSE 4321`, `CMD ["node", "dist/server/entry.mjs"]`

## Angular (SSR / Universal)

- Build stage: `RUN npm run build` → `dist/<project>/`
- Runtime: copy dist, `CMD ["node", "dist/<project>/server/server.mjs"]`,
  port 4000. (No `server/` dir in dist → it's a static build; use
  `deploy-static-frontend`.)

## Runtime writes (uploads)

Meta-framework apps with API routes / server actions sometimes accept file
uploads and write them to disk (`public/uploads`, `./uploads`, `./data`) —
grep the server code for `writeFile` / `formData.get('file')` handling. The
build output inside the container is replaced wholesale on every redeploy, so
any such path needs a named volume (docker-deploy § "Persistent data"). Watch
the workdir: in a Next.js standalone image, relative paths resolve against
`/app`, so `./uploads` → `-v <app>-uploads:/app/uploads`.

## Verify (in addition to docker-deploy's checks)

- `curl -s http://127.0.0.1:<port>/` returns the page **with rendered HTML
  content** (not an empty `<div id="root">` — that would mean SSR isn't
  actually running).
- A second route (any real page) also answers — catches builds where only the
  index was prerendered.
- These apps sit behind nginx in production: finish with `reverse-proxy-tls`
  when the user has a domain.
