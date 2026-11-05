import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';

/* Accounts for stream control. Passwords are scrypt hashes (node's own crypto,
   no native dependency). Sessions are random tokens in an HttpOnly cookie; the
   database keeps only their sha256, so a leaked database signs nobody in. */

const scrypt = promisify(scryptCb);
/* N = 2^15 costs about 32MB and 100ms per hash: affordable on this 1GB box,
   and login is rate limited on top. */
const N = 32768, R = 8, P = 1, KEYLEN = 32, MAXMEM = 64 * 1024 * 1024;

export const COOKIE = 'irlos_session';
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

const stmt = {
  user: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (username, password_hash, must_change_password, seat, created_at)
    VALUES (?, ?, 1, ?, ?)`),
  setPassword: db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?
    WHERE id = ?`),
  removeUser: db.prepare('DELETE FROM users WHERE username = ?'),
  allUsers: db.prepare('SELECT username, seat, must_change_password, created_at, password_changed_at FROM users ORDER BY username'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionUser: db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  seat: db.prepare('SELECT * FROM seats WHERE name = ?'),
  upsertSeat: db.prepare(`
    INSERT INTO seats (name, ssh_target, created_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET ssh_target = excluded.ssh_target`),
  allSeats: db.prepare('SELECT * FROM seats ORDER BY name')
};

const now = () => new Date().toISOString();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return timingSafeEqual(key, expected);
}

/* Unknown usernames still pay for one hash, so timing does not reveal which
   accounts exist. */
const dummyHash = hashPassword(randomBytes(16).toString('hex'));

export async function checkLogin(username, password) {
  const user = stmt.user.get(String(username).trim());
  const ok = await verifyPassword(String(password), user ? user.password_hash : await dummyHash);
  return ok && user ? user : null;
}

/* Temporary passwords are typed on a phone: three groups of four from an
   alphabet with no look-alikes (60 bits). */
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

export function createSession(userId) {
  stmt.pruneSessions.run(now());
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  stmt.insertSession.run(sha256(token), userId, now(), expires);
  return token;
}

export function sessionUser(token) {
  return token ? stmt.sessionUser.get(sha256(token), now()) : undefined;
}

export function endSession(token) {
  if (token) stmt.deleteSession.run(sha256(token));
}

/* A user's own change keeps the session they made it from and ends the rest. */
export async function changePassword(user, password, keepToken) {
  stmt.setPassword.run(await hashPassword(password), 0, now(), user.id);
  stmt.deleteOtherSessions.run(user.id, sha256(keepToken || ''));
}

export function cookieValue(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

/* For the users CLI. */
export async function addUser(username, seat) {
  const password = temporaryPassword();
  stmt.insertUser.run(username, await hashPassword(password), seat || null, now());
  return password;
}

export async function resetUser(username) {
  const user = stmt.user.get(username);
  if (!user) return null;
  const password = temporaryPassword();
  stmt.setPassword.run(await hashPassword(password), 1, now(), user.id);
  stmt.deleteUserSessions.run(user.id);
  return password;
}

export const removeUser = (username) => stmt.removeUser.run(username).changes > 0;
export const allUsers = () => stmt.allUsers.all();
export const seatByName = (name) => (name ? stmt.seat.get(name) : undefined);
export const upsertSeat = (name, target) => stmt.upsertSeat.run(name, target, now());
export const allSeats = () => stmt.allSeats.all();
