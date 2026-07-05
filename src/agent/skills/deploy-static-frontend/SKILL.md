---
name: deploy-static-frontend
description: Static site / SPA specifics for a Docker deploy — React (Vite/CRA), Vue, Angular, Svelte, Astro static, Gatsby, Hugo, Jekyll, Eleventy, Docusaurus, or plain HTML. Use with docker-deploy when the app builds to static files served by nginx (no server-side rendering — SSR apps use deploy-ssr-frontend).
---

# Deploy a static site or SPA (nginx)

`docker-deploy` owns the overall flow. Static builds ship as a tiny
nginx:alpine image: build stage produces files, final stage serves them.

## 1. Identify the builder and output directory

| Repo markers | Build command | Output dir |
|---|---|---|
| `vite.config.*` (React/Vue/Svelte/vanilla) | `npm run build` | `dist` |
| CRA (`react-scripts` in deps) | `npm run build` | `build` |
| `angular.json` | `npm run build` | `dist/<project>/browser` |
| `astro.config.*` (no SSR adapter) | `npm run build` | `dist` |
| `gatsby-config.*` | `npm run build` | `public` |
| `next.config.*` with `output: 'export'` | `npm run build` | `out` |
| `docusaurus.config.*` | `npm run build` | `build` |
| `.eleventy.js` / `eleventy.config.*` | `npx @11ty/eleventy` | `_site` |
| `hugo.toml` / `config.toml` + `content/` | (hugo image below) | `public` |
| `_config.yml` + Gemfile with jekyll | (jekyll image below) | `_site` |
| plain `index.html`, no build system | none | repo root |

Trust the repo over the table: check `scripts.build` and any `outDir` /
`outputPath` in the config. Same build-time env rule as SSR apps: `VITE_*` /
`REACT_APP_*` / `NEXT_PUBLIC_*` values are baked in during build — pass them
as `--build-arg`, not at run time.

## 2. Dockerfile

Node-based builders (npm shown — swap per lockfile, see `deploy-nodejs` § 1):

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

Hugo: build stage `FROM hugomods/hugo:exts AS build` + `RUN hugo --minify`,
copy `/src/public`. Jekyll: `FROM ruby:3.3 AS build` +
`RUN bundle install && bundle exec jekyll build`, copy `_site`. Plain HTML:
skip the build stage, `COPY . /usr/share/nginx/html`.

## 3. nginx.conf — write this with writeRemoteFile next to the Dockerfile

SPAs (React Router, Vue Router — client-side routing) need the fallback or
every deep link 404s; pure static sites (Hugo, Jekyll, Docusaurus) should 404
properly instead, so drop the `try_files` fallback line for those.

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
  location / {
    try_files $uri $uri/ /index.html;   # SPA fallback — remove for non-SPA sites
  }
}
```

(The `/assets/` path matches Vite's hashed output; CRA uses `/static/` —
match whatever the build actually emits.)

## 4. Run & verify

Run per docker-deploy (`-p 127.0.0.1:<port>:80`). Then:

- `curl -s http://127.0.0.1:<port>/` returns the index HTML.
- For SPAs: `curl -s http://127.0.0.1:<port>/some/route` also returns the
  index (fallback works) — a 404 here means broken deep links.
- A hashed asset from the HTML (`curl -sI .../assets/index-*.js`) returns 200
  with the long cache header.

If the site calls an API, the API URL was baked at build time — confirm it
points where the user expects (common failure: it still says localhost).
Finish with `reverse-proxy-tls` when a domain is involved.

Static nginx containers are read-only content — there is no runtime data to
persist here. If users "upload" through the site, the files land on the API
backend, and THAT deployment needs the named-volume treatment (docker-deploy
§ "Persistent data") — check it when you deploy the backend.
