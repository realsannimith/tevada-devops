---
name: deploy-php
description: PHP specifics for a Docker deploy — Laravel, Symfony, WordPress, or any plain PHP app. Use with docker-deploy whenever the app being deployed is PHP (repo has composer.json, artisan, index.php, or the user says WordPress).
---

# Deploy a PHP app (Laravel, Symfony, WordPress, plain PHP)

`docker-deploy` owns the overall flow. This skill supplies the PHP specifics.
The pragmatic single-container base is `php:8.3-apache`; it avoids wiring
php-fpm + nginx as two containers for simple deploys.

WordPress is special-cased below — never build it from source.

## 1. Identify the flavor

- `artisan` file → Laravel (docroot `public/`, port inside container 80).
- `bin/console` + `config/packages/` → Symfony (docroot `public/`).
- `wp-config.php` or the user says "WordPress" → official image, see § 4.
- Just `index.php` / `*.php` → plain PHP, docroot is the repo root.

Check `composer.json` `require.php` for the version; match the image tag.

## 2. Dockerfile (Laravel / Symfony / plain PHP)

```dockerfile
FROM composer:2 AS deps
WORKDIR /app
COPY . .
RUN composer install --no-dev --optimize-autoloader --no-interaction --no-scripts

FROM php:8.3-apache
RUN docker-php-ext-install pdo_mysql opcache && a2enmod rewrite
COPY --from=deps /app /var/www/html
# Laravel/Symfony serve from public/ — skip these two lines for plain PHP
ENV APACHE_DOCUMENT_ROOT=/var/www/html/public
RUN sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf
RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache 2>/dev/null || chown -R www-data:www-data /var/www/html
EXPOSE 80
```

- Add PHP extensions the app actually needs (`docker-php-ext-install`):
  `pdo_pgsql` (needs `apt-get install libpq-dev` first), `gd`, `intl`, `zip`,
  `bcmath` — composer install errors will name any that are missing.
- No Postgres/MySQL on this server yet? The database belongs in a compose
  stack — load `docker-compose-stack` and put app + db there.

## 3. Laravel extras

- `.env` via `--env-file`: `APP_KEY` (generate with
  `php artisan key:generate --show` in a one-off container, or
  `echo "base64:$(openssl rand -base64 32)"`), `APP_ENV=production`,
  `APP_DEBUG=false`, `APP_URL`, `DB_*`.
- After first run, one-offs against the same env:
  `sudo docker exec <app> php artisan migrate --force` and
  `php artisan config:cache && php artisan route:cache`.
- `storage/` holds uploads/logs — `Storage::put`/`store()` uploads land in
  `storage/app` → named volume, or every redeploy erases user files:
  `-v <app>-storage:/var/www/html/storage`. Apps using the `public` disk also
  need the symlink recreated once: `sudo docker exec <app> php artisan storage:link`.
- Plain PHP / Symfony: grep for `move_uploaded_file` destinations — often
  `uploads/` inside the docroot → `-v <app>-uploads:/var/www/html/uploads`
  (docker-deploy § "Persistent data").

## 4. WordPress

Use the official image + MySQL as a compose stack (load
`docker-compose-stack`): services `wordpress:6` (env `WORDPRESS_DB_HOST`,
`WORDPRESS_DB_USER/PASSWORD/NAME`) and `mysql:8`, named volumes for
`/var/www/html` and `/var/lib/mysql`, wordpress port on 127.0.0.1. Passwords
via generatePassword. Never build WordPress from a Dockerfile and never run it
without a persistent volume — themes, plugins and uploads live in the
container filesystem.

## 5. Verify (in addition to docker-deploy's checks)

- `curl -sI http://127.0.0.1:<port>/` → 200 (Laravel welcome/login page, not
  the Apache default page — that means the docroot rewrite didn't apply).
- Laravel: a 500 with `APP_DEBUG=false` is blank — check
  `sudo docker exec <app> tail -50 /var/www/html/storage/logs/laravel.log`.
- Deep links work (`curl -sI .../some/route` is not Apache 404) — proves
  mod_rewrite + .htaccess took effect.
