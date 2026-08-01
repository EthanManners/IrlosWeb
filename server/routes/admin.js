import { Router } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { ADMIN_USER, ADMIN_PASS, shipDateText } from '../lib/config.js';
import { allOrders } from '../lib/db.js';

const router = Router();

function digest(s) {
  return createHash('sha256').update(String(s)).digest();
}
function same(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

function requireAdmin(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(503).send('admin disabled: ADMIN_USER and ADMIN_PASS are unset');
  }
  const header = req.headers.authorization || '';
  const [scheme, cred] = header.split(' ');
  if (scheme === 'Basic' && cred) {
    const text = Buffer.from(cred, 'base64').toString();
    const i = text.indexOf(':');
    if (i > -1 && same(text.slice(0, i), ADMIN_USER) && same(text.slice(i + 1), ADMIN_PASS)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="irlos admin", charset="UTF-8"');
  return res.status(401).send('auth required');
}

router.use(requireAdmin);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function money(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`;
}

/* Server-rendered on purpose: no scripts, nothing to break, reload to refresh. */
router.get('/', (req, res) => {
  const orders = allOrders();

  const orderRows = orders.map((o) => `
    <tr>
      <td>${o.id}</td>
      <td>${esc(o.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(o.sku)}</td>
      <td>${esc(o.email)}</td>
      <td>${esc(money(o.amount_cents, o.currency))}</td>
      <td>${esc(o.status)}</td>
      <td class="mono">${esc(o.stripe_session_id)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>irlos admin</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/css/irlos.css" />
</head>
<body>
  <section class="page-head">
    <div class="wrap">
      <h1>admin</h1>
      <p class="prose">${orders.length} orders &middot; ship window: ${esc(shipDateText())}</p>
    </div>
  </section>
  <main id="main">
    <div class="wrap cmd"><span class="u">user@irlos</span>:<span class="c">~</span>$ <span class="c">irlos orders --all</span></div>
    <section class="wrap">
      <div class="out">
        <h2 class="h">orders</h2>
        <p class="prose" style="margin:0 0 1rem;"><a href="/admin/orders.csv">export csv</a></p>
        ${orders.length ? `<table class="tbl"><thead><tr><th>id</th><th>created</th><th>sku</th><th>email</th><th>amount</th><th>status</th><th>reference</th></tr></thead><tbody>${orderRows}</tbody></table>` : '<p class="prose">No orders yet.</p>'}
      </div>
    </section>
  </main>
</body>
</html>`);
});

router.get('/orders.csv', (req, res) => {
  const cols = ['id', 'created_at', 'sku', 'email', 'amount_cents', 'currency',
    'status', 'stripe_session_id', 'stripe_customer_id'];
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const o of allOrders()) lines.push(cols.map((c) => cell(o[c])).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="irlos-orders.csv"');
  res.send(lines.join('\n') + '\n');
});

export default router;
