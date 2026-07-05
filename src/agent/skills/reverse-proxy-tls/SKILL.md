---
name: reverse-proxy-tls
description: Put a public domain with HTTPS in front of an app or container using nginx and Let's Encrypt (certbot). Use whenever the user mentions a domain, HTTPS, SSL/TLS, certificates, or making a locally-running app reachable from the internet.
---

# Public domain + HTTPS with nginx and Let's Encrypt

Apps deployed the standard way listen on 127.0.0.1. nginx is the single front door:
it owns ports 80/443, terminates TLS, and proxies to the app. This keeps every app
port private and lets many apps share one server.

## 1. Preflight: does DNS point here yet?

Let's Encrypt validates over the public internet, so the domain MUST resolve to
this server before certbot can succeed:

```
SERVER_IP=$(curl -4 -s ifconfig.me)
DOMAIN_IP=$(getent hosts <domain> | awk '{print $1}' | head -1)
echo "server=$SERVER_IP domain=$DOMAIN_IP"
```

If they differ (or the domain doesn't resolve): set everything up over plain HTTP,
then tell the user exactly which DNS record to add (`A record: <domain> →
<server IP>`) and to ask you to enable HTTPS once it propagates. Do NOT run certbot
anyway — repeated failures trip Let's Encrypt rate limits that block the domain for
hours.

## 2. Install nginx and open the firewall

```
DEBIAN_FRONTEND=noninteractive sudo apt-get install -y nginx   # or dnf/yum/apk
sudo systemctl enable --now nginx
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp                # if ufw is active
```

(firewalld: `sudo firewall-cmd --permanent --add-service={http,https} && sudo firewall-cmd --reload`)

## 3. Write the server block

Write with writeRemoteFile (sudo=true) to
`/etc/nginx/sites-available/<domain>` (Debian/Ubuntu) or `/etc/nginx/conf.d/<domain>.conf` (RHEL/Alpine):

```nginx
server {
    listen 80;
    server_name <domain>;

    location / {
        proxy_pass http://127.0.0.1:<port>;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket support — harmless for plain HTTP apps, required for anything live
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

On Debian/Ubuntu enable it: `sudo ln -sf /etc/nginx/sites-available/<domain> /etc/nginx/sites-enabled/`.
Uploads bigger than 1MB? Add `client_max_body_size 50m;`.

**Validate before reload — never leave nginx broken:**

```
sudo nginx -t && sudo systemctl reload nginx
curl -sSI http://<domain>    # or http://127.0.0.1 with -H "Host: <domain>"
```

## 4. Get the certificate

```
DEBIAN_FRONTEND=noninteractive sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <domain> --non-interactive --agree-tos -m admin@<domain> --redirect
```

`--redirect` makes certbot rewrite the server block so HTTP forwards to HTTPS.
If the user gave a real email, use it (expiry warnings go there).
Add `-d www.<domain>` only if that subdomain also has a DNS record.

## 5. Verify — both the cert and renewal

```
curl -sSI https://<domain>                      # 200/301, no cert errors
sudo certbot renew --dry-run                    # renewal will actually work
systemctl list-timers | grep -i certbot         # auto-renew timer exists
```

## 6. Report

Give the user the final `https://<domain>` URL, note that the certificate renews
itself automatically, and remind them the app port is not directly reachable —
everything goes through nginx.
