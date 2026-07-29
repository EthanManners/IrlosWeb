# Build spec: irlos.live

Build the production site for IRLOS, a GPL-3.0 IRL streaming platform.

Two reference files are in the repo. Read both before writing anything.

- `reference/draft.html` defines the visual language, the copy voice, and the product facts. Do not restyle it.
- `reference/backpack-3d.html` is a working Three.js prototype for the backpack page. Integrate it, do not rebuild it.

---

## 0. Rules that override everything else

1. **Never invent a fact.** No metric, testimonial, client name, ship date, spec, price, or capability that is not written in this document or in the reference files. If you need one, stop and ask. A plausible-sounding invented number on a commerce page is a legal problem, not a copy problem.
2. **No em dashes anywhere.** Not in prose, `<title>`, alt text, commit messages, or code comments. `grep -rnP '\x{2014}' .` must return zero results before you call any phase done.
3. **No build step.** No React, Vue, Svelte, Tailwind, Vite, webpack, or PostCSS. Static HTML, one shared stylesheet, small vanilla JS modules.
4. **Prices live in Stripe.** The browser never sends an amount, and the server never reads one from a request body.
5. When a choice is between something clever and something a solo operator can debug at 3am, pick the second one.

---

## 1. The business

| SKU | Price | Delivery |
|---|---|---|
| `irlos-iso` | free | direct download, GPL-3.0 |
| `irlos-cloud` | $30/mo | managed relay plus IrlosStudio, provisioned by hand within 24h |
| `irlos-backpack` | $1,000 one-time, or $99 refundable deposit | hardware, first production run, not yet built |

Cloud is the priority SKU. It is the only one deliverable today, it has near-zero marginal cost, and it carries the Streamer University credential. The backpack does not exist yet, so its buy flow must be honest about timing.

Verified traction, use these exact numbers and no others: **500+ streams served**, **99.99% relay uptime**, **4 streamers currently using it**. Do not display the streamer count as a headline metric.

---

## 2. Stack

- nginx serves static files and reverse proxies `/api/` to Node on `127.0.0.1:8787`
- Node 20+, Express 4, ES modules
- SQLite via `better-sqlite3`
- Stripe Node SDK, API version pinned explicitly
- Three.js served from the site's own origin under `/vendor/`, never a CDN

```
express  stripe  better-sqlite3  helmet  express-rate-limit  dotenv  nodemailer
```

`better-sqlite3` compiles natively. Confirm `build-essential` and `python3` are present on the target box or the deploy will fail on first install.

---

## 3. Target file tree

```
irlos-web/
  server/
    index.js            express app, middleware order matters
    routes/checkout.js  three Checkout Session endpoints
    routes/webhook.js   raw body, signature verified, idempotent
    routes/admin.js     basic auth, orders, queue, CSV
    lib/db.js           better-sqlite3 init and migrations
    lib/mail.js         nodemailer through local postfix
    lib/config.js       SHIP_DATE and every other single-source constant
  public/
    index.html  cloud.html  backpack.html  download.html
    success.html  cancel.html  terms.html  refunds.html  privacy.html  404.html
    css/irlos.css
    js/chrome.js  starfield.js  bootlog.js  backpack3d.js  checkout.js
    vendor/three.min.js
    img/
  reference/
    draft.html  backpack-3d.html
  deploy/
    irlos-web.service  nginx.conf
  .env.example  README.md
```

---

## 4. Pages

```
/            home, ported from draft.html section for section
/cloud       what IrlosStudio is, the web panel, chat commands, what provisioning means
/backpack    3D schematic model, specs, ship window, deposit terms, buy
/download    .iso, sha256, flashing steps, hardware compatibility
/success     reads session_id, confirms the purchase, states the next step and when
/cancel      one line, link back to packages
/terms  /refunds  /privacy
/admin       basic auth, order list, deposit queue with positions, CSV export
/404
```

Header and footer are injected by `js/chrome.js` into `<div data-chrome="header">` and `<div data-chrome="footer">`. No templating dependency.

---

## 5. Stripe

Use **Checkout Sessions**, not the Payment Element. Subscriptions, SCA, receipts, and card updates come free, and the Billing Portal means subscription cancellation is never a manual job.

### Endpoints

```
POST /api/checkout/cloud      mode: 'subscription'
POST /api/checkout/backpack   mode: 'payment', body: { variant: 'full' | 'deposit' }
POST /api/portal              Billing Portal session for existing subscribers
POST /api/webhook             Stripe receiver
GET  /api/order/:session_id   purchase summary for /success, no PII beyond the SKU and status
```

### Gotchas that will cost hours if missed

- Mount `express.raw({type:'application/json'})` on `/api/webhook` **before** `express.json()`. Signature verification fails silently against a parsed body. This is the single most common break.
- `success_url` must contain the literal `{CHECKOUT_SESSION_ID}` template, unencoded.
- The Billing Portal requires a configuration saved in the Stripe dashboard before the API call works.
- Pin `apiVersion` in the Stripe constructor. An unpinned SDK changes behaviour under you on deploy.
- Webhooks retry. Store `event.id` and return 200 on a duplicate without reprocessing.

### On `checkout.session.completed`

1. Insert the order into SQLite
2. If `backpack-deposit`, assign the next queue position and include it in the confirmation
3. Email the customer through local Postfix on ethanmanners.com
4. Email the operator. Cloud needs manual provisioning within 24h and this alert is the only trigger

Do not auto-provision servers. A manual step with a reliable alert beats an automation that fails quietly.

### Schema

```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  stripe_session_id TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  sku TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  email TEXT NOT NULL,
  queue_position INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
```

### Environment

```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_CLOUD
STRIPE_PRICE_BACKPACK_FULL
STRIPE_PRICE_BACKPACK_DEPOSIT
SITE_URL
ADMIN_USER
ADMIN_PASS
OPERATOR_EMAIL
SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS
DB_PATH
```

Commit `.env.example` with every key documented and no real values.

---

## 6. Legal and factual constraints

These cost money when wrong.

- **State a ship date on every backpack buy control and inside Checkout.** Without one, the FTC Mail Order Rule defaults to 30 days, after which the buyer can demand a refund on request. Keep it in `lib/config.js` as `SHIP_DATE` and render it from there everywhere. It is currently unset. **Ask for it. Do not invent one.**
- **Deposits are a liability, not revenue.** `/refunds` must state the $99 is refundable until that customer's build starts, and must be linked from the deposit control and from Checkout.
- **Streamer University.** IRLOS was used there. Never imply the event, Kai Cenat, or any platform endorsed it. Keep the footer disclaimer: not affiliated with or endorsed by Streamer University, Twitch, Kick, or YouTube.
- **Client names** appear only with written permission on file. If permission is missing for one, that row comes out rather than being softened.
- **Facts, fixed:** Will used IRLOS Cloud at Streamer University, not a backpack. Adrian bought the first backpack ever built and still streams on it. Nick streams IRL full time on a relay. The backpack is single-SIM and single-modem, and the specs section keeps saying so in those words.
- **GPL-3.0.** Source stays public. Paying buys assembly, hosting, and support, never the right to run the software. A corresponding-source offer must be reachable from the footer.

---

## 7. Copy

The draft copy went through several passes to strip AI tells. Match it. Do not improve it.

**Banned**

- Em dashes, per rule 0.2
- Three-beat lists that say one thing: "real people, real networks, real conditions"
- Anaphora: "nothing dangling, nothing to configure"
- "It's not X, it's Y"
- Performative honesty: "I won't pretend otherwise", "let me be blunt", "here's the truth"
- Filler: actually, truly, simply, seamlessly, robust, powerful, cutting-edge, forever, at the end of the day, in today's world
- Cute headers: "no linux degree required", "what it is and what it isn't"
- Exclamation marks
- Any sentence whose only job is restating the sentence before it

**Required**

- Lowercase h1 and h2
- Specific numbers instead of adjectives. "500+ streams", never "battle-tested"
- Short declaratives
- First person singular when the operator speaks: "You email me when something breaks"
- The GPL argument as a competitive fact, not a virtue: "the license lets you do anything with it, including compete with me"

Authority order when in doubt: the draft's specs section, then its package descriptions, then its hero.

---

## 8. Design system

Tokens come from the draft. Do not add new ones.

```css
--bg:#08080a; --surface:#0e0e10; --text:#e8e4da; --muted:#948f86; --dim:#6a655d;
--accent:#00d4ff; --accent-dim:#0a6f85; --live:#4ade80;
--rule:#1e1e20; --rule-2:#2e2e31; --max:1080px;
```

JetBrains Mono for everything. Inter only for paragraphs longer than two lines. Headings lowercase, weight 800, letter-spacing between -0.03em and -0.048em.

Carry onto every page:

- Shell prompt separators between sections, in the form `$ user@irlos:~$ cat SETUP.md`
- Output blocks hung off a 1px left rule
- The package manifest table with a `package / cost / contents / install` header row
- Hairline borders only. No shadows, no card gradients, no rounded corners
- Starfield hero on `/` only. Other pages get a plain bordered header block

Every animation respects `prefers-reduced-motion` and pauses offscreen via IntersectionObserver and on `visibilitychange`.

---

## 9. The backpack model

`reference/backpack-3d.html` is a working prototype. Read it and integrate it. Do not rebuild it from scratch and do not restyle it. Extract it into `js/backpack3d.js` and mount it on `/backpack`.

### What it does

1. The bag drops in from above while fading up, contact shadow growing underneath as it lands
2. Short hold, then the front panel hinges open at its bottom edge
3. Internals and cable runs fade in, labels appear
4. Hovering a component highlights it, brightens its label, and fills a terminal readout with that component's name, one sentence, and a small spec table
5. An `explode` control pulls components apart along their own axes and eases the camera back
6. Drag to rotate with inertia, drag vertically to tilt within clamped limits
7. Tap does what hover does, on touch

**Change from the prototype:** it autoplays on load because it is standalone. On `/backpack` the model sits below the fold, so trigger the sequence the first time the section enters the viewport, once only. A user who arrives to a finished animation they never saw has been given nothing.

### Hold these

- Procedural geometry only. `BoxGeometry` and `CylinderGeometry` with `EdgesGeometry` outlines in `--accent`. It should read as a technical drawing. No GLTF, no textures, no bloom, no environment maps, no 3D artist.
- **Components are data, not hardcoded meshes.** The `PARTS` array carries id, title, description, spec pairs, geometry, position, and explode vector per component. Adding or moving a component means editing that array and nothing else. If you find yourself touching mesh construction to change a spec value, the refactor is wrong.
- **Labels and the readout are HTML**, positioned by projecting 3D anchors to screen space each frame. Selectable, indexable, screen-reader readable. Never draw text into the canvas.
- Below the canvas, the same components as a plain `<dl>`. That element is the no-JS fallback, the reduced-motion fallback, and the SEO surface at once. Generate it and the 3D labels from the same source so they cannot drift.
- Raycast against fill meshes only, and skip any component whose reveal opacity is below half, so nothing invisible is hoverable.
- `prefers-reduced-motion` renders the bag already open, no drop, no idle rotation.
- Render loop pauses via IntersectionObserver when offscreen and on `visibilitychange`.
- Drag to rotate with inertia. No OrbitControls. Pointer handling is already written.
- Under 700px: widen FOV, hide label subtext, dock the readout full width along the bottom.

**The internal layout is invented.** Pi at top, battery at bottom, modem and SSD flanking, antennas up the straps. Every position, dimension, and explode vector must be corrected against the real build before launch. Component descriptions are placeholder and must pass section 7. Flag both in the README as open items rather than silently shipping a guess.

**Budget check.** Three.js is roughly 600KB before gzip on a page whose buyer is deciding about $1,000, often on a phone. Measure on a mid-range Android. If sustained frame rate is under 30, replace the canvas with a static render of the open state and keep the `<dl>`. Losing the animation costs nothing that sells. A janky page costs the sale. The page must work without WebGL.

---

## 10. Ops

- systemd unit `irlos-web.service`, `Restart=always`, secrets via `EnvironmentFile=/etc/irlos-web.env` mode 600. Never in the repo.
- nginx: static root with `try_files`, `location /api/ { proxy_pass http://127.0.0.1:8787; }`, TLS via certbot, HSTS, gzip and brotli on static assets.
- `helmet` with a CSP allowing Stripe and Google Fonts. Three.js is same-origin so it needs no exception.
- `express-rate-limit` on every `/api/checkout/*` route.
- `README.md` covering local dev, `stripe listen --forward-to localhost:8787/api/webhook`, and deploy steps.

---

## 11. Phases and acceptance criteria

Do not start a phase until the one before it passes. State which phase you are on at the top of each response.

**Phase 1: static port.** Split `draft.html` into `css/irlos.css`, `js/starfield.js`, `js/bootlog.js`, `js/chrome.js`, rebuild `/`.
Passes when: `/` is visually identical to the draft side by side, `grep -rnP '\x{2014}' public/` returns nothing, and the starfield still accelerates on CTA hover.

**Phase 2: server skeleton.** Express, health check, SQLite schema, systemd and nginx configs.
Passes when: `GET /api/health` returns 200 through nginx, the DB file is created on first run, and the service survives `systemctl restart`.

**Phase 3: payments.** Three Checkout endpoints, webhook, `/success`, `/cancel`.
Passes when: a Stripe test card completes all three purchases, `stripe listen` shows each webhook returning 200, a replayed event does not double-insert, the order lands in SQLite, both emails send, and a deposit gets a queue position.

**Phase 4: pages.** `/cloud`, `/backpack` with the model, `/download`.
Passes when: the model triggers on scroll into view, the `<dl>` matches the labels, reduced-motion renders it open, and the page holds 30fps on a mid-range phone.

**Phase 5: policy and admin.** `/terms`, `/refunds`, `/privacy`, `/admin`.
Passes when: `SHIP_DATE` renders from `lib/config.js` in every location, `/refunds` is linked from the deposit control, and `/admin` rejects a bad password.

**Phase 6: ship check.** Lighthouse 95+ on performance and accessibility for `/` and `/backpack`. Full keyboard navigation. Real mobile device, not a simulator. `grep -rnP '\x{2014}' .` clean across the whole repo.

---

## 12. Do not

- Add a build step, framework, or CSS library
- Auto-provision servers on payment
- Accept payment details anywhere except Stripe Checkout
- Store card data
- Invent metrics, testimonials, names, ship dates, or specs. Ask instead
- Change the palette or typography
- Write an em dash
