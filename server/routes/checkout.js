import { Router } from 'express';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';
import {
  STRIPE_SECRET_KEY, STRIPE_PRICE_CLOUD,
  STRIPE_PRICE_BACKPACK_FULL, STRIPE_PRICE_BACKPACK_DEPOSIT,
  SITE_URL, shipDateText
} from '../lib/config.js';
import { orderBySession, customerByEmail } from '../lib/db.js';

/* apiVersion pinned on purpose: an unpinned SDK changes behaviour on deploy */
const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_unset', { apiVersion: '2024-06-20' });

const router = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});
router.use('/checkout', limiter);
router.use('/portal', limiter);

/* success_url keeps the literal {CHECKOUT_SESSION_ID} template, unencoded.
   Stripe substitutes it after payment. */
const SUCCESS_URL = `${SITE_URL}/success/?session_id={CHECKOUT_SESSION_ID}`;
const CANCEL_URL = `${SITE_URL}/cancel/`;

router.post('/checkout/cloud', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_CLOUD, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { sku: 'cloud' },
      subscription_data: { metadata: { sku: 'cloud' } },
      custom_text: {
        submit: {
          message: 'Provisioned by hand within 24 hours of payment. Connection details arrive by email. Cancel any time from the billing portal.'
        }
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout/cloud]', err.message);
    res.status(502).json({ error: 'could not start checkout' });
  }
});

router.post('/checkout/backpack', async (req, res) => {
  const variant = req.body && req.body.variant;
  if (variant !== 'full' && variant !== 'deposit') {
    return res.status(400).json({ error: 'variant must be full or deposit' });
  }
  const deposit = variant === 'deposit';
  /* FTC Mail Order Rule: the ship window is stated inside Checkout, and the
     deposit's refund terms are stated with it. Both render from config. */
  const message = deposit
    ? `Ships by ${shipDateText()}. The $99 deposit is refundable until your build starts. Terms: ${SITE_URL}/refunds/`
    : `First production run. Ships by ${shipDateText()}. Refund terms: ${SITE_URL}/refunds/`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price: deposit ? STRIPE_PRICE_BACKPACK_DEPOSIT : STRIPE_PRICE_BACKPACK_FULL,
        quantity: 1
      }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { sku: deposit ? 'backpack-deposit' : 'backpack-full' },
      custom_text: { submit: { message } }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout/backpack]', err.message);
    res.status(502).json({ error: 'could not start checkout' });
  }
});

/* Billing Portal for existing subscribers. Requires the portal configuration
   to be saved once in the Stripe dashboard or this call 400s. */
router.post('/portal', async (req, res) => {
  const email = req.body && typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'email required' });
  const row = customerByEmail(email);
  if (!row) return res.status(404).json({ error: 'no subscription found' });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${SITE_URL}/cloud/`
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('[portal]', err.message);
    res.status(502).json({ error: 'could not open billing portal' });
  }
});

/* Purchase summary for /success. Nothing beyond the SKU, status, queue
   position and ship window leaves the server. */
router.get('/order/:session_id', (req, res) => {
  const id = req.params.session_id;
  if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) return res.status(400).json({ error: 'bad session id' });
  const row = orderBySession(id);
  if (!row) return res.status(404).json({ error: 'order not found' });
  res.json({
    sku: row.sku,
    status: row.status,
    queuePosition: row.queue_position,
    shipDate: shipDateText()
  });
});

export default router;
