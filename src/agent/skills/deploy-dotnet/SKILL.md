---
name: deploy-dotnet
description: .NET specifics for a Docker deploy — ASP.NET Core (Web API, MVC, Blazor Server, minimal APIs) or any C#/.NET service. Use with docker-deploy whenever the app being deployed is .NET (repo has *.csproj, *.fsproj, or *.sln).
---

# Deploy a .NET app (ASP.NET Core)

`docker-deploy` owns the overall flow. This skill supplies the .NET specifics.

## 1. Inspect the repo

- Find the startup project: the `.csproj` whose folder has `Program.cs` with
  `WebApplication`/`Host` builder. A `.sln` with several projects → publish
  that specific csproj, not the solution.
- .NET version: `<TargetFramework>net8.0</TargetFramework>` in the csproj —
  match both image tags below (`8.0` shown; use what the project targets).
- Port: .NET 8+ images listen on **8080** by default (and run as non-root
  user `app` out of the box). .NET 6/7 images default to 80. Either way, pin
  it explicitly with `ASPNETCORE_URLS` so there's no ambiguity.

## 2. Dockerfile

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY *.sln ./
COPY **/*.csproj ./
RUN for f in *.csproj; do mkdir -p "${f%.csproj}" && mv "$f" "${f%.csproj}/"; done 2>/dev/null; dotnet restore || true
COPY . .
RUN dotnet publish <Project>/<Project>.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080
CMD ["dotnet", "<Project>.dll"]
```

Single-project repos can skip the sln/restore gymnastics: `COPY . .` then
`dotnet publish -c Release -o /out` from the project folder.

- The DLL name matches the csproj name — confirm with `ls /out/*.dll` if the
  build layout is unusual.
- EF Core migrations: run as a one-off, not on boot —
  `sudo docker run --rm --env-file /opt/<app>/.env <app>:latest dotnet <Project>.dll --migrate`
  only if the app supports a migrate flag; otherwise the standard approach is
  `dotnet ef database update` from the repo with the connection string, or
  `Database.Migrate()` already in Program.cs (check — many templates have it).
- Config: env vars override appsettings.json using `__` as the section
  separator (`ConnectionStrings__Default=...`) — use `--env-file`, don't edit
  appsettings inside the image.
- **Uploads**: grep for `IFormFile` + `CopyTo`/`CopyToAsync` destinations —
  commonly `wwwroot/uploads` or a configured `UploadPath`. Named volume over
  each (`-v <app>-uploads:/app/wwwroot/uploads`, docker-deploy § "Persistent
  data"), or every redeploy erases user files. SQLite `.db` paths too.

## 3. Verify (in addition to docker-deploy's checks)

- `curl -s http://127.0.0.1:<port>/` (Blazor/MVC) or a known API route
  (`/swagger` in dev-enabled apps, `/healthz` if mapped) answers.
- Logs show `Now listening on: http://0.0.0.0:8080` — listening on a
  different port than you published means ASPNETCORE_URLS didn't take.
- HTTPS redirect loops behind nginx → the app calls
  `UseHttpsRedirection()`; either forward proto headers in nginx
  (reverse-proxy-tls does) or set `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`.
