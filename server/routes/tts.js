import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { reserve, attach, detach, status, skip, capacity } from '../tts/session.js';

const router = Router();

/* Kick slugs are letters, digits, underscores and hyphens. Anything else is
   rejected before it can key a Map, name a session or reach the channel
   lookup that the Kick code will shell out to. */
const SLUG = /^[a-zA-Z0-9_-]{1,25}$/;

/* Generous enough that a phone retrying through a tunnel with backoff never
   hits it, tight enough that nobody opens a hundred channels for fun. */
const streamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});

router.get('/stream/:slug.mp3', streamLimiter, (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG.test(slug)) return res.status(400).type('text/plain').send('bad channel name');

  /* Before a single header goes out, because after that a refusal can only be
     a hang up and the page has no way to tell that apart from a dead network. */
  const room = reserve(slug);
  if (!room.ok) {
    console.warn(`[tts:${slug}] refused a listener: ${room.error}`);
    return res.status(room.status).type('text/plain').send(room.error);
  }

  /* No Content-Length and no Accept-Ranges: bytes. This has no length and
     cannot be seeked, and telling Safari otherwise makes it try, fail, and
     look like the stream is broken. A 200 with no length is what every
     internet radio station has answered a range request with for twenty
     years, and it is what the media element expects here. */
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
    /* Belt and braces for the nginx side. deploy/nginx.conf turns
       buffering off for this path, but if that block is ever missed this
       header alone still stops nginx holding tens of seconds of audio. */
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  /* The default socket timeout would cut a long listen off mid stream, and
     Nagle would sit on 20ms of audio waiting for company. */
  req.socket.setTimeout(0);
  if (res.socket) res.socket.setNoDelay(true);

  attach(slug, res);

  let done = false;
  const drop = () => {
    if (done) return;
    done = true;
    detach(slug, res);
  };

  /* 'close' covers the phone going away without a word, which is the normal
     case. The others are here because a response that errors and is never
     removed stays in the fan out set being written to forever. */
  req.on('close', drop);
  res.on('close', drop);
  res.on('error', drop);
});

/* Reserves nothing on purpose: this is what the page asks after a stream has
   failed, and asking must not itself take the last slot the caller is hoping
   for. Unlike /api/status this answers for a channel with no session, which is
   the only case it exists to explain, so a bad slug is a 400 and never a 404. */
router.get('/api/capacity/:slug', apiLimiter, (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG.test(slug)) return res.status(400).json({ error: 'bad channel name' });
  res.json(capacity(slug));
});

router.get('/api/status/:slug', apiLimiter, (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG.test(slug)) return res.status(400).json({ error: 'bad channel name' });

  const state = status(slug);
  if (!state) return res.status(404).json({ error: 'no session for that channel' });
  res.json(state);
});

router.post('/api/skip/:slug', apiLimiter, (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG.test(slug)) return res.status(400).json({ error: 'bad channel name' });

  const result = skip(slug);
  if (!result) return res.status(404).json({ error: 'no session for that channel' });
  res.json(result);
});

export default router;
