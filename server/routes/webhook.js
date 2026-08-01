import { Router } from 'express';
import Stripe from 'stripe';
import {
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL, shipDateText
} from '../lib/config.js';
import { db, insertOrder, markEventNew } from '../lib/db.js';
import { mailCustomer, mailOperator } from '../lib/mail.js';

const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_unset', { apiVersion: '2024-06-20' });

const router = Router();

/* req.body is a Buffer here: index.js mounts express.raw() on this route,
   ahead of express.json(). Signature verification dies on a parsed body. */
router.post('/', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send('signature verification failed');
  }

  /* Webhooks retry. A replayed event id gets a 200 and no reprocessing. */
  if (!markEventNew(event.id)) {
    return res.json({ received: true, duplicate: true });
  }

  /* Cloud is a subscription bought through hosted Checkout. The backpack is
     bought through the site's own form, which produces a PaymentIntent and no
     session at all. Both end here and become one order row. */
  const handler = event.type === 'checkout.session.completed' ? handleSession
    : event.type === 'payment_intent.succeeded' ? handleIntent
      : null;

  if (handler) {
    try {
      await handler(event.data.object);
    } catch (err) {
      console.error('[webhook] processing failed:', err.message);
      /* 500 so Stripe retries. Unmark the event or the retry would be
         treated as a duplicate and skipped. */
      unmarkEvent(event.id);
      return res.status(500).send('processing failed');
    }
  }

  res.json({ received: true });
});

function unmarkEvent(id) {
  db.prepare('DELETE FROM webhook_events WHERE id = ?').run(id);
}

function handleSession(session) {
  return record({
    ref: session.id,
    customer: session.customer || null,
    sku: (session.metadata && session.metadata.sku) || 'unknown',
    amount: session.amount_total ?? 0,
    currency: session.currency || 'usd',
    email: (session.customer_details && session.customer_details.email) || '',
    status: session.payment_status || 'paid'
  });
}

function handleIntent(intent) {
  return record({
    ref: intent.id,
    customer: typeof intent.customer === 'string' ? intent.customer : null,
    sku: (intent.metadata && intent.metadata.sku) || 'unknown',
    amount: intent.amount_received ?? intent.amount ?? 0,
    currency: intent.currency || 'usd',
    email: intent.receipt_email || '',
    status: 'paid'
  });
}

async function record(p) {
  const sku = p.sku;
  const email = p.email;

  /* Two deliveries can race past the duplicate check before either inserts.
     The UNIQUE constraint on stripe_session_id makes the second a no-op. */
  try {
    insertOrder({
      stripe_session_id: p.ref,
      stripe_customer_id: p.customer,
      sku,
      amount_cents: p.amount,
      currency: p.currency,
      email,
      status: p.status,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      console.warn('[webhook] order already stored for', p.ref);
      return;
    }
    throw err;
  }

  const ship = shipDateText();
  let subject, body;
  if (sku === 'cloud') {
    subject = 'irlos-cloud: payment received, server on the way';
    body = [
      'Payment received. Thanks.',
      '',
      'I provision every cloud server by hand. Yours will be ready within 24 hours,',
      'and the connection details will land in this inbox.',
      '',
      `Manage or cancel the subscription any time: ${SITE_URL}/cloud/`,
      '',
      'ethan, irlos maintainer'
    ].join('\n');
  } else if (sku === 'backpack-full') {
    subject = 'irlos-backpack: order received';
    body = [
      'Order received. Thanks.',
      '',
      'This is the first production run. Each bag is assembled and tested before',
      `it ships. Current ship window: ${ship}.`,
      '',
      `Refund terms: ${SITE_URL}/refunds/`,
      '',
      'ethan, irlos maintainer'
    ].join('\n');
  } else {
    subject = 'irlos: payment received';
    body = 'Payment received. Thanks.';
  }

  if (email) await mailCustomer(email, subject, body);

  /* This alert is the only trigger for manual provisioning. */
  const alert = [
    `sku: ${sku}`,
    `email: ${email}`,
    `amount: ${(p.amount / 100).toFixed(2)} ${p.currency.toUpperCase()}`,
    `reference: ${p.ref}`,
    sku === 'cloud' ? '' : null,
    sku === 'cloud' ? 'ACTION: provision this server within 24 hours.' : null,
    sku === 'backpack-full' ? 'ACTION: shipping address is on the payment in Stripe.' : null
  ].filter((l) => l !== null).join('\n');
  await mailOperator(`[irlos] ${sku} purchase: ${email}`, alert);
}

export default router;
