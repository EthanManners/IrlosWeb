import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePassword, checkLogin, clearSessionCookie, cookieValue, createSession, endSession,
  MIN_PASSWORD, sessionUser, setSessionCookie
} from '../lib/auth.js';

const router = Router();

/* Cookies are SameSite=Strict and every write here must be a JSON request,
   which a cross-site form cannot send without a CORS preflight. Together that
   is the CSRF defence. */
export function jsonOnly(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'json_required' });
  }
  next();
}

/* Signed-in users only. Until a temporary password is changed, the account
   can do nothing but change it. */
export function requireUser(req, res, next) {
  const token = cookieValue(req);
  const user = sessionUser(token);
  if (!user) return res.status(401).json({ error: 'signed_out' });
  req.user = user;
  req.sessionToken = token;
  next();
}

export function requireActiveUser(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.must_change_password) {
      return res.status(403).json({ error: 'password_change_required' });
    }
    next();
  });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many attempts. Try again in 15 minutes.' }
});

router.use(jsonOnly);

const me = (user) => ({
  username: user.username,
  mustChangePassword: Boolean(user.must_change_password),
  seat: user.seat
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const user = await checkLogin(username, password);
  if (!user) {
    console.log(`[account] failed login for "${username.slice(0, 64)}" from ${req.ip}`);
    return res.status(401).json({ error: 'bad_login', message: 'Wrong username or password.' });
  }
  setSessionCookie(res, createSession(user.id));
  console.log(`[account] ${user.username} signed in from ${req.ip}`);
  res.json(me(user));
});

router.post('/logout', (req, res) => {
  endSession(cookieValue(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireUser, (req, res) => res.json(me(req.user)));

router.post('/password', loginLimiter, requireUser, async (req, res) => {
  const { current, next } = req.body || {};
  if (typeof current !== 'string' || typeof next !== 'string' || next.length > 256) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  if (next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: 'too_short', message: `Use at least ${MIN_PASSWORD} characters.` });
  }
  if (!(await checkLogin(req.user.username, current))) {
    return res.status(401).json({ error: 'bad_login', message: 'Your current password is wrong.' });
  }
  if (next === current) {
    return res.status(400).json({ error: 'same_password', message: 'Pick a new password.' });
  }
  await changePassword(req.user, next, req.sessionToken);
  console.log(`[account] ${req.user.username} changed their password`);
  res.json({ ...me(req.user), mustChangePassword: false });
});

export default router;
