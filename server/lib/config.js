import 'dotenv/config';

/* The one place the ship date lives. It is unset on purpose: no date has been
   committed yet. Set a real one before launch, like 'March 2027'. Every page
   and every Checkout session renders it from here. Do not invent one. */
export const SHIP_DATE = null;

/* Text shown wherever a ship date belongs while SHIP_DATE is null. */
export const SHIP_DATE_FALLBACK = 'TBD';

export function shipDateText() {
  return SHIP_DATE || SHIP_DATE_FALLBACK;
}

export const PORT = Number(process.env.PORT || 8787);
export const SITE_URL = process.env.SITE_URL || 'http://localhost:8787';

export const DB_PATH = process.env.DB_PATH || 'data/irlos.db';

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
export const STRIPE_PRICE_CLOUD = process.env.STRIPE_PRICE_CLOUD || '';
export const STRIPE_PRICE_BACKPACK_FULL = process.env.STRIPE_PRICE_BACKPACK_FULL || '';
export const STRIPE_PRICE_BACKPACK_DEPOSIT = process.env.STRIPE_PRICE_BACKPACK_DEPOSIT || '';

export const ADMIN_USER = process.env.ADMIN_USER || '';
export const ADMIN_PASS = process.env.ADMIN_PASS || '';

export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || '';
export const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';

/* Warn loudly at boot about anything that will break a purchase. The server
   still starts so the static site and health check stay up. */
const needed = [
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_CLOUD',
  'STRIPE_PRICE_BACKPACK_FULL', 'STRIPE_PRICE_BACKPACK_DEPOSIT',
  'SITE_URL', 'ADMIN_USER', 'ADMIN_PASS', 'OPERATOR_EMAIL'
];
for (const name of needed) {
  if (!process.env[name]) console.warn(`[config] ${name} is not set`);
}
if (!SHIP_DATE) console.warn('[config] SHIP_DATE is unset, buy controls will say TBD');
