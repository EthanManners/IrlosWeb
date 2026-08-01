import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from './config.js';

const file = resolve(DB_PATH);
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
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
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
`);

const stmt = {
  insertOrder: db.prepare(`
    INSERT INTO orders (stripe_session_id, stripe_customer_id, sku, amount_cents,
                        currency, email, queue_position, status, created_at)
    VALUES (@stripe_session_id, @stripe_customer_id, @sku, @amount_cents,
            @currency, @email, @queue_position, @status, @created_at)`),
  orderBySession: db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?'),
  allOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC'),
  customerByEmail: db.prepare(`
    SELECT * FROM orders
    WHERE email = ? AND stripe_customer_id IS NOT NULL
    ORDER BY created_at DESC, id DESC LIMIT 1`),
  eventSeen: db.prepare('SELECT 1 FROM webhook_events WHERE id = ?'),
  recordEvent: db.prepare('INSERT INTO webhook_events (id, received_at) VALUES (?, ?)')
};

export function orderBySession(sessionId) {
  return stmt.orderBySession.get(sessionId);
}

export function allOrders() {
  return stmt.allOrders.all();
}

export function customerByEmail(email) {
  return stmt.customerByEmail.get(email);
}

/* stripe_session_id holds a Checkout session id for cloud and a PaymentIntent
   id for the backpack. Either way it is the reference Stripe knows the payment
   by, and the UNIQUE constraint is what makes webhook delivery idempotent.
   queue_position is a leftover from the deposit queue: the column stays so the
   existing table needs no migration, and nothing writes it any more. */
export const insertOrder = db.transaction(function (order) {
  stmt.insertOrder.run({ ...order, queue_position: null });
  return stmt.orderBySession.get(order.stripe_session_id);
});

/* Returns true the first time an event id is seen, false on a replay.
   The insert is the check, so a race cannot slip through. */
export function markEventNew(eventId) {
  try {
    stmt.recordEvent.run(eventId, new Date().toISOString());
    return true;
  } catch (err) {
    if (err && String(err.code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw err;
  }
}
