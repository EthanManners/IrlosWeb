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

  if (event.type === 'checkout.session.completed') {
    try {
      await handleCompleted(event.data.object);
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

async function handleCompleted(session) {
  const sku = (session.metadata && session.metadata.sku) || 'unknown';
  const email = (session.customer_details && session.customer_details.email) || '';

  /* Two deliveries can race past the duplicate check before either inserts.
     The UNIQUE constraint on stripe_session_id makes the second a no-op. */
  let order;
  try {
    order = insertOrder({
      stripe_session_id: session.id,
      stripe_customer_id: session.customer || null,
      sku,
      amount_cents: session.amount_total ?? 0,
      currency: session.currency || 'usd',
      email,
      status: session.payment_status || 'paid',
      created_at: new Date().toISOString()
    });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      console.warn('[webhook] order already stored for', session.id);
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
      `Manage or cancel the subscription any time: ${SITE_URL}/cloud.html`,
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
      `Refund terms: ${SITE_URL}/refunds.html`,
      '',
      'ethan, irlos maintainer'
    ].join('\n');
  } else if (sku === 'backpack-deposit') {
    subject = `irlos-backpack: deposit received, you are number ${order.queue_position} in the queue`;
    body = [
      'Deposit received. Thanks.',
      '',
      `You are number ${order.queue_position} in the build queue.`,
      `Current ship window: ${ship}.`,
      '',
      'The $99 is refundable until your build starts. Reply to this email and',
      `it comes back, no questions. Terms: ${SITE_URL}/refunds.html`,
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
    `amount: ${((session.amount_total ?? 0) / 100).toFixed(2)} ${(session.currency || 'usd').toUpperCase()}`,
    `session: ${session.id}`,
    order.queue_position ? `queue position: ${order.queue_position}` : null,
    sku === 'cloud' ? '' : null,
    sku === 'cloud' ? 'ACTION: provision this server within 24 hours.' : null
  ].filter((l) => l !== null).join('\n');
  await mailOperator(`[irlos] ${sku} purchase: ${email}`, alert);
}

export default router;
