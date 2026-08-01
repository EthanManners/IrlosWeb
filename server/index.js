import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, shipDateText, STRIPE_PUBLISHABLE_KEY } from './lib/config.js';
import { backpackPrice } from './lib/price.js';
import './lib/db.js';
import webhookRouter from './routes/webhook.js';
import checkoutRouter from './routes/checkout.js';
import adminRouter from './routes/admin.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx sits in front, rate limiting needs the real client address

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      /* keep in sync with the add_header line in deploy/nginx.conf.
         The Stripe hosts are what Elements needs: js.stripe.com for the
         library and its field iframes, api.stripe.com for confirmation,
         hooks.stripe.com for bank redirects during 3-D Secure. */
      scriptSrc: ["'self'", 'https://js.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.stripe.com'],
      frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://checkout.stripe.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'https://checkout.stripe.com']
    }
  },
  crossOriginEmbedderPolicy: false
}));

/* Stripe signature verification needs the raw request body, so this route
   mounts before express.json(). Moving it below breaks every webhook. */
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* Everything the pages need to render a price or a date, from the one place
   each of those lives. The publishable key is safe to hand out; it is the
   secret key's counterpart and can only start payments, not read them. */
app.get('/api/config', async (req, res) => {
  const body = { shipDate: shipDateText(), stripeKey: STRIPE_PUBLISHABLE_KEY };
  try {
    body.price = (await backpackPrice()).display;
  } catch (err) {
    /* A missing price must not take the ship date down with it: the pages
       fall back to the figure in their own markup. */
    console.error('[config] backpack price unavailable:', err.message);
  }
  res.json(body);
});

app.use('/api', checkoutRouter);
app.use('/admin', adminRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

/* nginx serves public/ in production. Express serves it too so local dev
   needs nothing but this process. */
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* Every page is a directory with an index.html, so the URLs carry no
   extension. Old .html links keep working, here and in deploy/nginx.conf. */
app.use((req, res, next) => {
  const m = /^\/(.+)\.html$/.exec(req.path);
  if (!m) return next();
  const slug = m[1].replace(/(^|\/)index$/, '');
  res.redirect(301, slug ? `/${slug}/` : '/');
});

app.use(express.static(pub));
app.use((req, res) => res.status(404).sendFile(path.join(pub, '404', 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`irlos-web listening on 127.0.0.1:${PORT}`);
});
