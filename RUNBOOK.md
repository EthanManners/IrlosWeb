# Deploying irlos.live

Run in this order. The README's sequence fails at the TLS step, see step 6.

Assumes Ubuntu, root or sudo, and DNS for `irlos.live` and `www.irlos.live` already pointing at this box. Check that first, because certbot cannot issue without it:

```bash
dig +short irlos.live
dig +short www.irlos.live
curl -4 ifconfig.me     # must match
```

---

## 1. Prerequisites

```bash
apt update
apt install nginx certbot python3-certbot-nginx build-essential python3 rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install nodejs
node -v     # v20 or higher
```

`build-essential` and `python3` are there for `better-sqlite3`. It normally installs a prebuilt binary, but when there is no prebuild for your Node ABI it compiles from source, and without those packages `npm install` dies with a node-gyp error.

## 2. Put the code at /opt/irlos-web

The systemd unit and nginx config both hardcode that path. If you pulled somewhere else:

```bash
mkdir -p /opt/irlos-web
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude 'data' \
  /path/where/you/pulled/ /opt/irlos-web/
cd /opt/irlos-web
```

Keep the git checkout wherever it is and rsync from it on every deploy. Do not run the service out of the checkout.

## 3. Service user and data directory

Before `npm install`, because the unit has `ProtectSystem=strict` with `ReadWritePaths=/opt/irlos-web/data`. If that directory does not exist, the service fails to start with a confusing namespace error rather than a missing-directory one.

```bash
useradd -r -s /usr/sbin/nologin irlos
mkdir -p /opt/irlos-web/data
chown -R irlos:irlos /opt/irlos-web/data
```

## 4. Install dependencies

```bash
cd /opt/irlos-web
npm install --omit=dev
```

`node_modules` stays root-owned. The service only reads it, so that is correct.

## 5. Environment file, test keys first

```bash
cp .env.example /etc/irlos-web.env
chmod 600 /etc/irlos-web.env
chown root:root /etc/irlos-web.env
vim /etc/irlos-web.env
```

Use `sk_test_...` and test-mode price ids for now. You will swap to live keys in step 10, after a real end to end run. Leave `STRIPE_WEBHOOK_SECRET` empty for the moment, you get it in step 8.

Set `DB_PATH=data/irlos.db` and `PORT=8787`.

On mail: `SMTP_HOST=localhost` only works if Postfix runs on **this** box. Your mail stack is on ethanmanners.com, so if that is a different VPS, point `SMTP_HOST` at it and make sure it accepts relay from this IP. Otherwise every order confirmation silently fails.

## 6. Certificate before the TLS config

This is the step the README gets wrong. `deploy/nginx.conf` references `/etc/letsencrypt/live/irlos.live/fullchain.pem`. That file does not exist yet, so `nginx -t` fails, so nginx will not reload, so `certbot --nginx` cannot complete. Chicken and egg.

Stand up a plain HTTP block first:

```bash
cat > /etc/nginx/sites-available/irlos.live <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name irlos.live www.irlos.live;
    root /opt/irlos-web/public;
    index index.html;
    location / { try_files $uri $uri/ =404; }
}
EOF

ln -sf ../sites-available/irlos.live /etc/nginx/sites-enabled/irlos.live
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Confirm `http://irlos.live` serves the homepage, then issue the certificate without letting certbot rewrite anything:

```bash
certbot certonly --nginx -d irlos.live -d www.irlos.live
ls /etc/letsencrypt/live/irlos.live/
```

Now install the real config:

```bash
cp /opt/irlos-web/deploy/nginx.conf /etc/nginx/sites-available/irlos.live
nginx -t && systemctl reload nginx
```

### Add the www block

`deploy/nginx.conf` redirects www to apex on port 80, but its 443 block only answers for `irlos.live`. Anyone hitting `https://www.irlos.live` directly falls through to nginx's default server and gets a certificate name mismatch warning, which looks broken to a buyer. Append this:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.irlos.live;
    ssl_certificate /etc/letsencrypt/live/irlos.live/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/irlos.live/privkey.pem;
    return 301 https://irlos.live$request_uri;
}
```

If `nginx -t` warns that `listen ... http2` is deprecated, you are on nginx 1.25+. Drop `http2` from the listen lines and add `http2 on;` inside each server block.

## 7. Start the service

```bash
cp /opt/irlos-web/deploy/irlos-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now irlos-web
systemctl status irlos-web --no-pager
```

Verify the app directly, then through nginx:

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s https://irlos.live/api/health      # {"ok":true}
```

If it will not start:

```bash
journalctl -u irlos-web -n 60 --no-pager
```

Usual causes, in order of likelihood: `data/` missing or not owned by `irlos`, a malformed line in `/etc/irlos-web.env`, or a missing native build for `better-sqlite3`.

## 8. Stripe webhook

Dashboard, Developers, Webhooks, add endpoint:

- URL `https://irlos.live/api/webhook`
- Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`

Copy its signing secret into `/etc/irlos-web.env` as `STRIPE_WEBHOOK_SECRET`, then:

```bash
systemctl restart irlos-web
```

Send a test event from the dashboard and confirm a 200. A 400 here is almost always the raw-body problem, where `express.json()` ran before the webhook route consumed the raw buffer.

## 9. Test purchase, still in test mode

Buy Cloud with `4242 4242 4242 4242`, any future expiry, any CVC. Then check all four:

```bash
journalctl -u irlos-web -f                              # webhook 200
sqlite3 /opt/irlos-web/data/irlos.db 'select * from orders;'
```

Plus the customer email arrived, and the operator alert arrived. That alert is your provisioning trigger, so if it does not land, you will not know you have a customer.

Also load `https://irlos.live/admin` and confirm basic auth challenges you and the order appears.

## 10. Go live

Only after step 9 passes end to end.

```bash
vim /etc/irlos-web.env    # sk_live_..., live price ids, live webhook secret
systemctl restart irlos-web
```

The live webhook is a **separate endpoint** in the dashboard with its own signing secret. Test-mode secrets do not validate live events.

Before you flip the backpack buttons on, `SHIP_DATE` in `server/lib/config.js` has to be a real date. Until then leave Cloud selling on its own, which is the honest and the legal position.

---

## Redeploy

```bash
cd /path/to/checkout && git pull
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude 'data' \
  ./ /opt/irlos-web/
cd /opt/irlos-web && npm install --omit=dev
systemctl restart irlos-web
nginx -t && systemctl reload nginx      # only if nginx.conf changed
```

`--exclude data` matters. Without it, rsync deletes your orders database.

## Checks worth keeping

```bash
systemctl status irlos-web
journalctl -u irlos-web --since '1 hour ago'
certbot renew --dry-run
sqlite3 /opt/irlos-web/data/irlos.db 'select created_at, sku, email, status from orders order by id desc limit 20;'
```

Back the database up somewhere off the box. It is the only record of deposit queue positions that is not reconstructible from Stripe.
