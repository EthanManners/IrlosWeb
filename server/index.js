import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, shipDateText } from './lib/config.js';
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
      /* keep in sync with the add_header line in deploy/nginx.conf */
      scriptSrc: ["'self'", 'https://js.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ['https://js.stripe.com', 'https://checkout.stripe.com'],
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
app.get('/api/config', (req, res) => res.json({ shipDate: shipDateText() }));

app.use('/api', checkoutRouter);
app.use('/admin', adminRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

/* nginx serves public/ in production. Express serves it too so local dev
   needs nothing but this process. */
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`irlos-web listening on 127.0.0.1:${PORT}`);
});
