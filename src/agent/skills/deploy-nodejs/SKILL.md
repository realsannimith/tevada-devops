---
name: deploy-nodejs
description: Node.js specifics for a Docker deploy — Express, NestJS, Fastify, Koa, Hono, Hapi, AdonisJS, or any other Node/Bun server app. Use with docker-deploy whenever the app being deployed is a Node.js backend (repo has package.json and is not a Next.js/Nuxt/SvelteKit-style frontend — those use deploy-ssr-frontend or deploy-static-frontend).
---

# Deploy a Node.js app (any framework)

`docker-deploy` owns the overall flow. This skill supplies the Node specifics:
package-manager detection, a production multi-stage Dockerfile, and the CMD /
port facts per framework.

If package.json depends on `next`, `nuxt`, `@sveltejs/kit`, `@remix-run/*`,
`react-router` (v7 framework mode) or `astro`, this is a frontend app — load
`deploy-ssr-frontend` (server-rendered) or `deploy-static-frontend` (static
build) instead.

## 1. Inspect the repo

Package manager from the lockfile (use the same one — mixing managers breaks
resolution):

| Lockfile | Install (with dev deps, for build) | Prune / prod install |
|---|---|---|
| `package-lock.json` | `npm ci` | `npm ci --omit=dev` |
| `pnpm-lock.yaml` | `corepack enable && pnpm i --frozen-lockfile` | `pnpm i --frozen-lockfile --prod` |
| `yarn.lock` | `corepack enable && yarn --frozen-lockfile` | `yarn --frozen-lockfile --production` |
| `bun.lock` / `bun.lockb` | `bun install --frozen-lockfile` | `bun install --frozen-lockfile --production` |

Then read `package.json`:

- `scripts.build` present (TypeScript, bundlers) → the image must run the build
  in a build stage.
- Entry file: `scripts.start` usually says it (`node dist/main.js`,
  `node server.js`). NestJS builds to `dist/main.js`; plain TS projects often
  `dist/index.js`.
- Port: grep for `process.env.PORT` and the fallback (`|| 3000`). Express/Nest
  default 3000, Fastify examples often 3000, Hapi 3000, Hono (node-server)
  3000. Pass `PORT` explicitly in the run command so there is no guessing.
- Engine: match `engines.node` if pinned; otherwise `node:22-alpine`.

## 2. Dockerfile (multi-stage, npm shown — swap install lines per table)

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build --if-present

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

- No build script / plain JS app → single stage: install with `--omit=dev`,
  copy the source, `CMD ["node", "server.js"]`.
- **CMD must be exec-form `node` directly, never `npm start`** — npm swallows
  SIGTERM, so `docker stop` waits 10 s then SIGKILLs the app mid-request.
- The official image ships a `node` user — use it (`USER node`).
- Copy only what the runtime needs into the final stage (dist + prod
  node_modules + package.json); source and dev deps stay in the build stage.
- Bun app (`bun.lock`, or scripts run `bun`) → base image `oven/bun:1`,
  `CMD ["bun", "src/index.ts"]` (Bun runs TS directly; often no build stage
  needed).
- Prisma in deps → add `RUN npx prisma generate` after install in the build
  stage, copy `node_modules/.prisma` into the final image, and run migrations
  as a one-off: `sudo docker run --rm --env-file /opt/<app>/.env <app>:latest npx prisma migrate deploy`.
- Native modules (bcrypt, sharp, better-sqlite3) failing on alpine → switch
  both stages to `node:22-slim` (glibc) rather than fighting musl.

## 3. Env & data

- `NODE_ENV=production` always (Express skips dev middleware, deps behave).
- Secrets via `--env-file /opt/<app>/.env` (mode 600), per docker-deploy.
- App needs a database/Redis → that's a stack: load `docker-compose-stack`.
- **Uploads**: Node apps love saving uploads into the project — grep for
  multer (`dest:` / `diskStorage` destination), formidable, busboy, and
  `fs.writeFile`/`createWriteStream` paths; typical dirs `uploads/`,
  `public/uploads`, `files/`. Named volume over every hit
  (`-v <app>-uploads:/app/uploads`, see docker-deploy § "Persistent data") —
  anything written inside the container is erased by the next redeploy or
  github-auto-deploy cycle.
- SQLite → named volume over the directory holding the `.sqlite` file.

## 4. Verify (in addition to docker-deploy's checks)

- `curl -s http://127.0.0.1:<port>/` (or a known route — check the router file
  for `/health`, `/api`) answers.
- Logs show the framework's listen line ("Nest application successfully
  started", "Server listening at") and no `EADDRINUSE`/unhandled rejection.
- `sudo docker stop <app> && sudo docker start <app>` completes in seconds —
  if stop takes 10 s, signals aren't reaching node (see CMD rule above).
