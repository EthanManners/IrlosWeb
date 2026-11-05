import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { seatByName } from '../lib/auth.js';
import { icp } from '../lib/seat.js';
import { jsonOnly, requireActiveUser } from './account.js';

/* The one-button stream control behind /go. Each signed-in user drives the
   irlosd on their own seat, and nothing else: the seat comes from their
   account, never from the request. */

const router = Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Slow down a little.' }
});

router.use(jsonOnly, requireActiveUser);

/* Messages a streamer can act on, instead of operator-facing ones. */
const FRIENDLY = {
  no_stream_key: "Your stream key isn't set up yet. Message IRLOS support.",
  output_busy: 'Hang on, the stream is still changing state.',
  seat_offline: "Your stream server isn't reachable right now. Message IRLOS support.",
  no_seat: "Your account doesn't have a stream server yet. Message IRLOS support."
};

function fail(res, status, code, message) {
  res.status(status).json({ error: code, message: FRIENDLY[code] || message || 'Something went wrong.' });
}

async function ask(req, res, op) {
  const seat = seatByName(req.user.seat);
  if (!seat) {
    fail(res, 409, 'no_seat');
    return null;
  }
  try {
    return await icp(seat.ssh_target, { op });
  } catch (err) {
    console.error(`[stream] ${req.user.username} ${op}: seat unreachable: ${err.message}`);
    fail(res, 503, 'seat_offline');
    return null;
  }
}

/* Phones poll this every couple of seconds; one fetch per second per seat is
   plenty, however many tabs are open. */
const cache = new Map();

router.get('/', async (req, res) => {
  const hit = cache.get(req.user.seat);
  let resp = hit && Date.now() - hit.at < 1000 ? hit.resp : null;
  if (!resp) {
    resp = await ask(req, res, 'get_status');
    if (!resp) return;
    cache.set(req.user.seat, { at: Date.now(), resp });
  }
  if (resp.ok !== true) return fail(res, 502, resp.error?.code, resp.error?.message);
  const r = resp.result;
  res.json({
    studio: r.studio,
    state: r.stream?.state ?? null,
    durationMs: r.stream?.duration_ms ?? 0,
    lastError: r.stream?.last_error || '',
    wantStreaming: Boolean(r.want_streaming),
    scene: r.scene ?? null,
    outputKbps: r.output_kbps ?? null
  });
});

for (const [path, op] of [['/start', 'start_streaming'], ['/stop', 'stop_streaming']]) {
  router.post(path, writeLimiter, async (req, res) => {
    const resp = await ask(req, res, op);
    if (!resp) return;
    cache.delete(req.user.seat);
    console.log(`[stream] ${req.user.username} ${op}: ${resp.ok ? resp.result?.state : resp.error?.code}`);
    if (resp.ok !== true) return fail(res, 409, resp.error?.code, resp.error?.message);
    res.json({ state: resp.result?.state ?? null });
  });
}

export default router;
