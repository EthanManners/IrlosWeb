# irlos-web

The production site for [irlos.live](https://irlos.live): static pages served by nginx, plus a small Express server for Stripe Checkout, the webhook, and the admin page. GPL-3.0.

## layout

```
public/     static site: html, css, js, vendored three.js
server/     express app on 127.0.0.1:8787, /api and /admin
deploy/     systemd unit and nginx config
reference/  the design drafts the site was built from
```

## local dev

Needs Node 20+, plus `build-essential` and `python3` for the `better-sqlite3` native build.

```
cp .env.example .env      # fill in Stripe test keys
npm install
npm run dev               # serves the whole site on http://localhost:8787
```

The express server serves `public/` directly in dev, so nginx is not needed locally. The SQLite database appears at `data/irlos.db` on first run.

### stripe

Create three prices in the Stripe dashboard (test mode first) and put their ids in `.env`:

- `STRIPE_PRICE_CLOUD`: $30/month recurring
- `STRIPE_PRICE_BACKPACK_FULL`: $1,000 one time
- `STRIPE_PRICE_BACKPACK_DEPOSIT`: $99 one time

Then forward webhooks:

```
stripe listen --forward-to localhost:8787/api/webhook
```

`stripe listen` prints a `whsec_...` secret. That is your `STRIPE_WEBHOOK_SECRET` for local dev. Pay with card `4242 4242 4242 4242` and watch the webhook return 200, the order land in `data/irlos.db`, and both emails go out (needs a local SMTP listener, or read the `[mail]` log lines).

The Billing Portal needs its configuration saved once in the Stripe dashboard (Settings, Billing Portal) or `/api/portal` will 400.

## deploy

Target: one box with nginx, node, postfix.

```
rsync repo to /opt/irlos-web, then on the box:
cd /opt/irlos-web && npm install --omit=dev
cp deploy/irlos-web.service /etc/systemd/system/
   # create /etc/irlos-web.env, mode 600, from .env.example with live values
cp deploy/nginx.conf /etc/nginx/sites-available/irlos.live
ln -s ../sites-available/irlos.live /etc/nginx/sites-enabled/
certbot --nginx -d irlos.live
useradd -r irlos && mkdir -p /opt/irlos-web/data && chown irlos: /opt/irlos-web/data
systemctl daemon-reload && systemctl enable --now irlos-web
nginx -t && systemctl reload nginx
curl https://irlos.live/api/health   # {"ok":true}
```

Point a production webhook endpoint (dashboard, `checkout.session.completed`) at `https://irlos.live/api/webhook` and put its signing secret in `/etc/irlos-web.env`.

## open items, blocking launch

1. **SHIP_DATE is unset.** Set the real ship window in `server/lib/config.js`. Every page and Checkout session renders it from there; until it is set, buy controls say TBD. Do not launch backpack sales without it: without a stated date the FTC Mail Order Rule defaults to 30 days.
2. **Contact email.** `CONTACT` in `public/js/chrome.js` is a placeholder. Set the real address.
3. **ISO release.** `public/download.html` has `ISO_URL` and `ISO_SHA256` placeholders for the real release link and checksum.
4. **Images.** `public/img/` needs `adrian.jpeg`, `will.jpg`, `nick.jpg` (avatars from the old repo) and `og.jpg` for link previews. Client names stay only with written permission on file.
5. **Backpack internals are an invented layout.** Positions, dimensions and explode vectors in the `PARTS` array in `public/js/backpack3d.js` must be corrected against the real build, and the component descriptions are placeholders to rewrite.
6. **Policy copy review.** `terms.html` and `refunds.html` state conservative defaults (cancel before ship for full refund, subscription runs to period end). Confirm they match what you actually offer.
7. **Real device pass.** Lighthouse 95+ on `/` and `/backpack`, and the backpack page held at 30fps on a mid-range Android. If it cannot, swap the canvas for a static render of the open state and keep the `<dl>`.
