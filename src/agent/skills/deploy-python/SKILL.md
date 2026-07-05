---
name: deploy-python
description: Python specifics for a Docker deploy — FastAPI, Django, Flask, Litestar, Starlette, aiohttp, Sanic, Tornado, or any other WSGI/ASGI framework. Use with docker-deploy whenever the app being deployed is Python (repo has requirements.txt, pyproject.toml, Pipfile, or setup.py).
---

# Deploy a Python app (any framework)

`docker-deploy` owns the overall flow (install Docker, get the code, run the
container, verify, report). This skill supplies the Python specifics: framework
and dependency-manager detection, a production Dockerfile, and the gotchas that
break Python deploys.

Golden rule: **never ship a dev server**. No `flask run`, no `manage.py
runserver`, no `uvicorn --reload`. Production means gunicorn/uvicorn workers.

## 1. Inspect the repo

Detect the dependency manager (decides the install lines):

| Marker | Manager | Install inside Dockerfile |
|---|---|---|
| `requirements.txt` | pip | `pip install --no-cache-dir -r requirements.txt` |
| `uv.lock` | uv | `pip install uv && uv sync --frozen --no-dev` then `ENV PATH="/app/.venv/bin:$PATH"` |
| `poetry.lock` | poetry | `pip install poetry && poetry config virtualenvs.create false && poetry install --only main --no-root` |
| `Pipfile.lock` | pipenv | `pip install pipenv && pipenv install --deploy --system` |
| only `pyproject.toml` | pip (PEP 517) | `pip install --no-cache-dir .` |

Detect the framework from dependencies (grep requirements/pyproject):
`fastapi`, `django`, `flask`, `litestar`, `starlette`, `aiohttp`, `sanic`,
`tornado`, `bottle`, `falcon`. Anything ASGI (fastapi, litestar, starlette,
sanic, quart) runs under uvicorn workers; anything WSGI (flask, django classic,
bottle, falcon) runs under plain gunicorn.

Find the app entrypoint — look for the module that defines the app object:
`grep -rn "FastAPI()\|Flask(__name__)\|Litestar(" --include="*.py" -l .`
Common shapes: `main:app`, `app.main:app`, `app:app`. For Django find the
project package: `ls */wsgi.py` → entry is `<project>.wsgi:application`.

Match the Python version to the repo if pinned (`.python-version`,
`requires-python` in pyproject); otherwise use `3.12-slim`.

## 2. Dockerfile

Base template (pip shown — swap the install lines per the table above):

```dockerfile
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn "uvicorn[standard]"
COPY . .
RUN useradd -m appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8000", "main:app"]
```

- Copy the dependency manifest **before** the code so rebuilds reuse the
  dependency layer.
- If a dependency needs compiling (psycopg2, lxml, pillow often do on slim),
  add build tools: `RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && rm -rf /var/lib/apt/lists/*`
  — or prefer binary wheels (`psycopg[binary]`, `psycopg2-binary`).
- Workers: 2 is right for a small VPS; scale toward `2×CPU+1` on bigger boxes.

CMD per framework:

| Framework | CMD |
|---|---|
| FastAPI / Litestar / Starlette / Quart (ASGI) | `["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8000", "main:app"]` |
| Flask / Bottle / Falcon (WSGI) | `["gunicorn", "-w", "2", "-b", "0.0.0.0:8000", "app:app"]` |
| Django | `["gunicorn", "-w", "2", "-b", "0.0.0.0:8000", "<project>.wsgi:application"]` |
| aiohttp | `["gunicorn", "-k", "aiohttp.GunicornWebWorker", "-w", "2", "-b", "0.0.0.0:8000", "main:app"]` |
| Sanic / Tornado (own server) | run the app module directly: `["python", "-m", "main"]` — check it binds 0.0.0.0 |

## 3. Django extras (skip for other frameworks)

- Env (via `--env-file`, never baked in): `DJANGO_SETTINGS_MODULE`,
  `SECRET_KEY` (generatePassword), `DEBUG=0`,
  `ALLOWED_HOSTS=<domain-or-server-ip>`, `DATABASE_URL` if used.
- Static files — add to the Dockerfile before switching user:
  `RUN python manage.py collectstatic --noinput`
  (needs a dummy `SECRET_KEY=build` env for the build step). Serve them with
  whitenoise if it's in the deps; otherwise nginx via `reverse-proxy-tls`.
- Migrations — run as a one-off container against the same env/volume, never
  automatically on every start:
  `sudo docker run --rm --env-file /opt/<app>/.env <app>:latest python manage.py migrate`
- SQLite database → mount a named volume over its directory or the data dies
  with the container. Postgres/MySQL/Redis → this is a multi-container app:
  load `docker-compose-stack` instead.

## 4. Uploads & writable data (all frameworks — check before first run)

Many Python apps save user uploads inside the project tree; a redeploy erases
them unless the path is on a named volume (docker-deploy § "Persistent data"):

- Django: `MEDIA_ROOT` in settings is where FileField/ImageField uploads land
  (commonly `media/`) → `-v <app>-media:/app/media`.
- Flask / FastAPI: grep for `.save(`, `UploadFile`, `shutil.copy`,
  `aiofiles` write paths — typical dirs `uploads/`, `static/uploads`, `files/`.
- Volume every hit. Do this before the container first runs, and record the
  `-v` flags so github-auto-deploy carries them.

## 5. Verify (in addition to docker-deploy's checks)

- FastAPI: `curl -s http://127.0.0.1:<port>/docs` returns HTML (if docs enabled).
- Django: response is not a yellow 500 page; `sudo docker logs` shows gunicorn
  workers booted, no `DisallowedHost`.
- Any: logs show the worker class you intended (uvicorn workers for ASGI —
  running an ASGI app under plain gunicorn sync workers "works" then breaks
  under load).
