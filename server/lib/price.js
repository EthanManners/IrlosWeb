import Stripe from 'stripe';
import { STRIPE_SECRET_KEY, STRIPE_PRICE_BACKPACK_FULL } from './config.js';

const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_unset', { apiVersion: '2024-06-20' });

/* The amount lives in Stripe and nowhere else. The page renders what this
   returns and the PaymentIntent charges it, so the two cannot drift apart.
   Cached because it changes about once a year and every checkout asks. */
const TTL_MS = 5 * 60 * 1000;
let cache = null;

export async function backpackPrice() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (!STRIPE_PRICE_BACKPACK_FULL) throw new Error('STRIPE_PRICE_BACKPACK_FULL is not set');

  const price = await stripe.prices.retrieve(STRIPE_PRICE_BACKPACK_FULL);
  if (!price.active) throw new Error(`price ${price.id} is not active`);
  if (typeof price.unit_amount !== 'number') {
    throw new Error(`price ${price.id} has no unit_amount, tiered pricing is not supported here`);
  }

  const value = {
    amount: price.unit_amount,
    currency: price.currency,
    display: format(price.unit_amount, price.currency)
  };
  cache = { at: Date.now(), value };
  return value;
}

/* en-US formatting on purpose: the site is written in one language and the
   price string is baked into copy next to it. */
function format(amountCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2
  }).format(amountCents / 100);
}
