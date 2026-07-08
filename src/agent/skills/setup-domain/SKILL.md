---
name: setup-domain
description: Point a custom domain at a deployed service using an on-screen form the user fills in (domain, port, HTTPS, email), then wire up nginx + TLS from their answers. Use whenever the user wants to add/connect/configure a domain or custom URL for an app, service, container, or website — especially from the Artifacts tab. This is the form-first entry point; it hands the actual nginx/certbot work to reverse-proxy-tls.
---

# Set up a domain (form-first)

Your users are not sysadmins — collecting the domain, port, and HTTPS choice
through an on-screen form is far easier for them than answering questions in
chat. So this job starts with the `requestDomainSetup` tool, not with questions.

## 1. Find the service and its port FIRST — that's your job, not the user's

The user should never have to know or type the port. YOU deployed the service,
so YOU determine the port before showing the form:

```
docker ps --format '{{.Names}}\t{{.Ports}}'     # containerised apps + their ports
ss -tlnp                                         # anything else listening locally
```

Identify the app the user means and the local port it listens on (e.g. a
container published on `127.0.0.1:8000`). Pass that as `suggestedPort` so the
form shows the user the detected port, pre-filled. If you genuinely can't tell,
inspect the container (`docker inspect <name> --format '{{json .Config.Env}} {{json .NetworkSettings.Ports}}'`)
or read its compose/env file rather than leaving the field blank.

## 2. Get the server IP, then open the form

Let's Encrypt (HTTPS) only works once the domain's DNS already points at this
server. Get this server's public IP first (`curl -4 -s ifconfig.me`, or the
host from `listServers`), then call `requestDomainSetup` with `appName`,
`suggestedPort`, AND `serverIp`. The form itself shows the user a built-in DNS
guide (the exact A record to add, with your `serverIp` as the value) — so pass
the IP and you don't need to spell the record out in chat first. Do NOT ask for
the domain/port/email in plain text — the form collects them.

## 3. Show the DNS setup guide — ALWAYS, and clearly

The tool returns `values`: `domain`, `port`, `www` ('true'/'false'), `https`
('true'/'false'), `email`. If the user cancelled (`submitted:false`), ask how
they'd like to proceed instead of guessing.

Before touching nginx, check whether their DNS already points here and show them
a clear, copy-pasteable DNS guide either way — most users have NOT set up DNS yet
and this is the step they most need help with:

```
SERVER_IP=$(curl -4 -s ifconfig.me)
DOMAIN_IP=$(getent hosts <domain> | awk '{print $1}' | head -1)
echo "server=$SERVER_IP domain=$DOMAIN_IP"
```

Then ALWAYS present the exact record(s) to add, as a markdown table, in plain
language a non-expert can follow. Split the host into the record NAME your
registrar expects: for a bare domain (`example.com`) the name is `@`; for a
subdomain (`app.example.com`) the name is the label (`app`).

> **Add this DNS record at your domain provider** (GoDaddy, Namecheap,
> Cloudflare, Google Domains, etc. — wherever you bought/manage the domain):
>
> | Type | Name | Value | TTL |
> |------|------|-------|-----|
> | A | `app` | `<SERVER_IP>` | 3600 (or Auto) |
>
> (add a second identical `A` row with name `www` only if you chose the www option)
>
> **Steps:** 1) Log in to your domain provider and open its DNS / DNS Management
> page. 2) Add a new **A record** with the values above. 3) Save. DNS changes
> usually take a few minutes (occasionally up to an hour) to take effect. On
> Cloudflare, set the record to **DNS only** (grey cloud) for the certificate
> step, then you can re-enable the proxy afterwards.

If `DOMAIN_IP` already equals `SERVER_IP`, tell them DNS is already pointing here
and continue straight to HTTPS. If it doesn't match yet, still lay out the guide
above, set up plain HTTP now, and tell them to reply once they've added the
record so you can enable HTTPS — do NOT run certbot against a domain that doesn't
resolve here (repeated failures trip Let's Encrypt rate limits for hours).

## 4. Configure nginx (+ HTTPS when DNS is ready)

Load **reverse-proxy-tls** and follow it with those values:

- Install nginx, write the server block for `domain` → `127.0.0.1:port`
  (add `www.<domain>` to `server_name` and `-d www.<domain>` only if `www` is
  true), validate (`nginx -t`) and reload.
- If `https` is true AND DNS resolves here: run certbot with `-m <email>
  --redirect` (add `-d www.<domain>` when `www` is true).

## 5. Verify and report

Verify per reverse-proxy-tls § 5 (`curl -sSI https://<domain>`, `certbot renew
--dry-run`). Then tell the user their live URL (`https://<domain>` or
`http://<domain>` if HTTPS was deferred), that the certificate auto-renews, and
— if DNS wasn't ready — repeat the exact A record to add and to ask you to enable
HTTPS once it propagates.
