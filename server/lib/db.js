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
  maxQueuePosition: db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS max FROM orders WHERE sku = 'backpack-deposit'"),
  allOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC'),
  depositQueue: db.prepare("SELECT * FROM orders WHERE sku = 'backpack-deposit' AND status = 'paid' ORDER BY queue_position"),
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

export function depositQueue() {
  return stmt.depositQueue.all();
}

export function customerByEmail(email) {
  return stmt.customerByEmail.get(email);
}

/* Inserts an order, assigning the next queue position to deposits.
   Runs in a transaction so two deposits cannot share a position. */
export const insertOrder = db.transaction(function (order) {
  let queue_position = null;
  if (order.sku === 'backpack-deposit') {
    queue_position = stmt.maxQueuePosition.get().max + 1;
  }
  stmt.insertOrder.run({ ...order, queue_position });
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
