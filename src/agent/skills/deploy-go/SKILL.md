---
name: deploy-go
description: Go specifics for a Docker deploy — any Go service (net/http, Gin, Echo, Fiber, Chi, gRPC). Use with docker-deploy whenever the app being deployed is Go (repo has go.mod).
---

# Deploy a Go app (any framework)

`docker-deploy` owns the overall flow. Go compiles to a single static binary,
so the framework (Gin, Echo, Fiber, Chi, plain net/http) changes nothing about
the deploy — the pattern is always: build a static binary, ship it in a
minimal image. Final images are ~15 MB.

## 1. Inspect the repo

- Main package: a root `main.go` → build `.`; a `cmd/` directory → pick the
  right one (`ls cmd/`) and build `./cmd/<name>`. Multiple cmd entries → ask
  the user which is the server unless it's obvious (e.g. `cmd/server`).
- Port: grep for `Listen`/`Run(` and `os.Getenv("PORT")`. Gin defaults to
  8080; most Go services read PORT or hardcode one. Pass `-e PORT=` at run
  time if the code reads it; otherwise use what's hardcoded.
- Go version: from the `go` directive in go.mod — match the builder image tag.
- CGO: if the app imports sqlite or similar CGO packages, `CGO_ENABLED=0`
  breaks the build — for those use `CGO_ENABLED=1`, add
  `RUN apk add --no-cache gcc musl-dev` in the builder, and keep the alpine
  runtime (not scratch).

## 2. Dockerfile

```dockerfile
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/app .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D appuser
USER appuser
COPY --from=build /bin/app /bin/app
EXPOSE 8080
CMD ["/bin/app"]
```

- `go mod download` before copying source → dependency layer caches across
  rebuilds.
- `CGO_ENABLED=0` + `-ldflags="-s -w"` → small static binary.
- ca-certificates matters: without it any outbound HTTPS call from the app
  fails with x509 errors — a classic "works locally, breaks in scratch" bug.
- App reads config files or templates at runtime (`templates/`, `static/`,
  `config.yaml`)? Compiled binaries don't include them unless the code uses
  `go:embed` — check, and `COPY --from=build` those dirs too.
- **Uploads / writable data**: grep for `os.Create`, `os.MkdirAll`,
  `os.WriteFile`, `io.Copy` destinations (typical dirs `uploads/`, `data/`,
  `files/`) and SQLite paths. Named volume over each
  (`-v <app>-uploads:/uploads`, docker-deploy § "Persistent data") — the
  container filesystem is erased on every redeploy/auto-deploy.

## 3. Verify (in addition to docker-deploy's checks)

- `curl -s http://127.0.0.1:<port>/` (or a route from the router setup —
  grep for `GET(` / `HandleFunc`) answers.
- Logs are clean — Go apps that crash on missing env/config exit instantly,
  so `sudo docker ps` showing "Restarting" means read the first log lines.
- If the app serves gRPC (not HTTP), curl won't work — verify with
  `sudo docker logs` showing the listen line and the port being open:
  `nc -z 127.0.0.1 <port>`.
