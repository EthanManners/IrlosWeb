import { Router } from 'express';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';
import {
  STRIPE_SECRET_KEY, STRIPE_PRICE_CLOUD, STRIPE_PRICE_BACKPACK_FULL,
  SITE_URL, shipDateText
} from '../lib/config.js';
import { orderBySession, customerByEmail } from '../lib/db.js';
import { backpackPrice } from '../lib/price.js';

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
router.use('/payment-intent', limiter);
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

/* The backpack is sold through the site's own checkout form, so it needs a
   PaymentIntent rather than a hosted Checkout session. The amount is read from
   the Stripe price here and never accepted from the client. */
router.post('/payment-intent', async (req, res) => {
  try {
    const price = await backpackPrice();
    const intent = await stripe.paymentIntents.create({
      amount: price.amount,
      currency: price.currency,
      automatic_payment_methods: { enabled: true },
      /* FTC Mail Order Rule: the ship window is stated at the point of sale.
         The terms ride along on the charge itself too, so a dispute months
         from now can be answered with the payment record alone. */
      description: `irlos-backpack, first production run, built to order, final sale, ships by ${shipDateText()}`,
      metadata: {
        sku: 'backpack-full',
        ship_window: shipDateText(),
        terms: 'built to order, final sale, acknowledged at checkout'
      }
    });
    res.json({
      clientSecret: intent.client_secret,
      amount: price.amount,
      currency: price.currency,
      display: price.display,
      shipDate: shipDateText()
    });
  } catch (err) {
    console.error('[payment-intent]', err.message);
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

/* Purchase summary for /success. Nothing beyond the SKU, status and ship
   window leaves the server. Cloud orders are keyed by Checkout session,
   backpack orders by PaymentIntent. */
router.get('/order/:ref', (req, res) => {
  const id = req.params.ref;
  if (!/^(cs|pi)_[a-zA-Z0-9_]+$/.test(id)) return res.status(400).json({ error: 'bad reference' });
  const row = orderBySession(id);
  if (!row) return res.status(404).json({ error: 'order not found' });
  res.json({
    sku: row.sku,
    status: row.status,
    shipDate: shipDateText()
  });
});

export default router;
