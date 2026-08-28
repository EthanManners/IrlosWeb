import { createMixer, FRAME_SAMPLES } from './mixer.js';
import { createEncoder } from './encoder.js';
import { createQueue, utteranceFor } from './queue.js';
import { createSpeech } from './speech.js';
import { chatroomId, createKickClient } from './kick.js';
import { TTS_MAX_SESSIONS } from '../lib/config.js';

/* One session per channel, held in memory. Built when the first listener
   arrives, torn down five minutes after the last one leaves, so an idle
   channel costs nothing and a listener who locks their phone, loses signal in
   a tunnel and comes back does not pay to start it again.

   A session owns a Kick websocket, a message queue, a speech child, an ffmpeg
   encoder and the set of responses being written to.

   The ordering rule that everything else follows from: the mixer and encoder
   start immediately and unconditionally, before the chatroom lookup has even
   been attempted. A bad channel name, a Cloudflare challenge or a dead
   websocket all show up as silence on a stream that is still running, never
   as a stream that fails to start. An iPhone that has already begun playing
   keeps playing; one that never started cannot be started again without
   another tap, and the user has locked their phone and put it away. */

const sessions = new Map();

const IDLE_MS = 5 * 60 * 1000;

/* This box is shared with two other sites, so an unbounded Map keyed by
   whatever slug a stranger types is a way to spawn ffmpeg until the machine
   falls over. Both caps are deliberately low: raise them when there is a
   reason to, not in advance.

   The session cap now depends on the engine and comes from config: a piper
   session is a 143MB neural synthesiser using half of the box's only core,
   where an espeak one is neither. This caps concurrent *channels*; listeners
   on the same channel share one session and are capped separately. */
const MAX_SESSIONS = TTS_MAX_SESSIONS;
const MAX_LISTENERS = 20;

/* An encoder that dies mid listen gets replaced rather than ending everyone's
   stream, since the fresh one picks up in the same byte stream and each
   listener resynchronises on the next frame header. A dying encoder that
   keeps dying is a real fault, and retrying it forever just hides it. */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60 * 1000;

/* The chatroom lookup goes through Cloudflare, which fails transiently. Worth
   a few tries; not worth hammering, since the usual cause is a typo. */
const LOOKUP_TRIES = 4;
const LOOKUP_BACKOFF_MS = [2000, 5000, 15000];

/* ── the source ──────────────────────────────────────────────────────────── */

/* Called once per 20ms frame. Returns a frame of speech, or null for silence,
   which is most of the time on most channels. This is the whole timeline: if
   something is being said, play the next slice of it, otherwise start the next
   thing in the queue, otherwise say nothing at all. */
function makeSource(session) {
  return function nextFrame() {
    const pcm = session.speech.read(FRAME_SAMPLES);
    if (pcm) return toBuffer(pcm);

    /* Nothing playing. Start the next line if there is one. Its audio is not
       ready this instant, so this frame is still silence; the synthesiser
       needs a moment and the gap between utterances is where it gets one. */
    if (!session.speech.busy && session.queue.depth > 0) {
      const item = session.queue.shift();
      if (item) {
        const line = utteranceFor(item);
        if (!session.speech.say(line)) session.speechFailures++;
      }
    }
    return null;
  };
}

/* A view, not a copy: read() hands back a freshly allocated array every time,
   so nothing else can be holding this memory. Int16Array is host endian, and
   every machine this runs on is little endian, which is what s16le wants. */
function toBuffer(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}

/* ── lifecycle ───────────────────────────────────────────────────────────── */

function createSession(slug) {
  const session = {
    slug,
    createdAt: Date.now(),
    listeners: new Set(),
    idleTimer: null,
    restarts: [],
    encoder: null,
    mixer: null,
    queue: createQueue(),
    speech: null,
    kick: null,
    chatroom: null,
    ws: 'connecting',
    wsDetail: '',
    speechFailures: 0,
    closed: false
  };

  session.speech = createSpeech({
    onError: (err) => {
      /* Speech dying is bad but survivable: the stream stays up and goes
         quiet, which is far better than dropping every listener. It is loud
         in the log and visible on the status endpoint. */
      console.error(`[tts:${slug}] speech:`, err.message);
    }
  });

  /* Load the model now, into the dead time between the session being built and
     the first chat message arriving, rather than in front of that message. */
  session.speech.warm();

  startEncoder(session);

  session.mixer = createMixer({
    source: makeSource(session),
    sink: (frame) => { if (session.encoder) session.encoder.write(frame); },
    onError: (err) => console.error(`[tts:${slug}] source:`, err.message)
  });
  session.mixer.start();

  sessions.set(slug, session);
  /* Deliberately not awaited. The audio timeline is already running by this
     point, and the lookup is allowed to take as long as it takes. */
  connectChat(session);
  /* Armed from the moment it exists, not from the moment it first empties. A
     session whose listener gives up between reserving it and attaching would
     otherwise sit at zero listeners forever with nothing scheduled to collect
     it, encoding audio for nobody until the process restarts. */
  armIdleTimer(session);
  console.log(`[tts:${slug}] session up`);
  return session;
}

/* Look the channel up, then hold the websocket open. Failure here never
   touches the audio: the stream keeps running and the reason is on the status
   endpoint, where the page shows it. */
async function connectChat(session) {
  let lastError = null;

  for (let attempt = 0; attempt < LOOKUP_TRIES; attempt++) {
    if (session.closed) return;
    try {
      session.chatroom = await chatroomId(session.slug);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      session.ws = 'looking up';
      session.wsDetail = `attempt ${attempt + 1} failed`;
      const wait = LOOKUP_BACKOFF_MS[Math.min(attempt, LOOKUP_BACKOFF_MS.length - 1)];
      if (attempt < LOOKUP_TRIES - 1) await sleep(wait);
    }
  }

  if (session.closed) return;

  if (lastError) {
    session.ws = 'failed';
    session.wsDetail = lastError.message;
    console.error(`[tts:${session.slug}] chatroom lookup failed:`, lastError.message);
    return;
  }

  console.log(`[tts:${session.slug}] chatroom ${session.chatroom}`);

  session.kick = createKickClient({
    slug: session.slug,
    id: session.chatroom,
    onState: (state, detail) => {
      session.ws = state;
      session.wsDetail = detail || '';
      if (state === 'error') console.warn(`[tts:${session.slug}] ws error: ${detail}`);
    },
    onMessage: ({ username, content }) => {
      session.queue.push(username, content);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function startEncoder(session) {
  session.encoder = createEncoder({
    onExit: ({ code, signal, stderr }) => {
      if (session.closed) return;
      console.error(
        `[tts:${session.slug}] ffmpeg exited code=${code} signal=${signal}` +
        (stderr.length ? ` last: ${stderr.join(' | ')}` : '')
      );
      restartEncoder(session);
    }
  });
}

function restartEncoder(session) {
  const now = Date.now();
  session.restarts = session.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
  session.restarts.push(now);

  if (session.restarts.length > MAX_RESTARTS) {
    console.error(`[tts:${session.slug}] ffmpeg will not stay up, closing session`);
    destroySession(session.slug);
    return;
  }

  const listeners = [...session.listeners];
  startEncoder(session);
  /* Re-attached rather than reconnected: each one is marked as needing a
     frame header again, which is exactly the mid stream join case. */
  for (const res of listeners) session.encoder.attach(res);
  console.warn(`[tts:${session.slug}] ffmpeg restarted, ${listeners.length} listener(s) carried over`);
}

function destroySession(slug) {
  const session = sessions.get(slug);
  if (!session) return;
  session.closed = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.mixer.stop();

  /* Stopped before the encoder, so nothing is still trying to produce audio
     for a pipeline that is going away. Both leave child processes behind if
     they are skipped, and those children outlive the session. */
  if (session.kick) session.kick.stop();
  if (session.speech) session.speech.stop();

  /* Closed here rather than left to the encoder. When a session is torn down
     because ffmpeg would not stay up, the encoder is already dead and its own
     teardown is a no-op, which would leave every listener holding an open
     socket that has gone quiet: the one failure this whole design is supposed
     to avoid. Ending the response is what tells the page to reconnect. */
  for (const res of session.listeners) {
    if (!res.writableEnded) res.end();
  }
  session.listeners.clear();

  session.encoder.kill();
  sessions.delete(slug);
  console.log(`[tts:${slug}] session down`);
}

function armIdleTimer(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.listeners.size === 0) destroySession(session.slug);
  }, IDLE_MS);
  /* An idle session must not be the reason the process refuses to exit. */
  session.idleTimer.unref();
}

/* ── the bit the routes use ──────────────────────────────────────────────── */

/* Split from attach() so a refusal can still be a real status code. Once the
   stream's headers are out the only way left to say no is to hang up, which
   the page can only read as a network fault. Both halves are synchronous, so
   nothing can change between them. */
export function reserve(slug) {
  let session = sessions.get(slug);

  if (!session) {
    if (sessions.size >= MAX_SESSIONS) {
      return { ok: false, status: 503, error: 'too many channels running right now' };
    }
    session = createSession(slug);
  }

  if (session.listeners.size >= MAX_LISTENERS) {
    return { ok: false, status: 503, error: 'too many listeners on this channel' };
  }

  return { ok: true };
}

export function attach(slug, res) {
  const session = sessions.get(slug);
  if (!session) return false;

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  session.listeners.add(res);
  session.encoder.attach(res);
  return true;
}

export function detach(slug, res) {
  const session = sessions.get(slug);
  if (!session) return;
  session.listeners.delete(res);
  session.encoder.detach(res);
  if (session.listeners.size === 0) armIdleTimer(session);
}

/* What reserve() would say about this slug right now, without reserving
   anything. The page asks after a stream fails so it can tell "the reader is
   full" apart from "the network dropped", which look identical from a media
   element: both are an error event and nothing else. Worth having since the
   session cap is 1 under piper, so a second channel being refused is an
   ordinary Tuesday rather than a corner case.

   `refused` is the whole answer, and it is not the same as `full`: a slug that
   already has a session is let in whatever the count is, which is exactly the
   case of a listener reconnecting to the channel they were already on. Report
   the count but never the names, since the caller has no business knowing what
   anyone else is listening to. */
export function capacity(slug) {
  const full = sessions.size >= MAX_SESSIONS;
  return {
    sessions: sessions.size,
    max: MAX_SESSIONS,
    full,
    refused: full && !sessions.has(slug)
  };
}

export function status(slug) {
  const session = sessions.get(slug);
  if (!session) return null;

  const mixer = session.mixer.stats();
  const encoder = session.encoder.stats();
  const speech = session.speech.stats();
  const q = session.queue.stats();

  return {
    slug,
    listeners: session.listeners.size,
    uptimeMs: Date.now() - session.createdAt,
    source: 'chat',
    ws: session.ws,
    wsDetail: session.wsDetail,
    chatroom: session.chatroom,
    queue: q.depth,
    chat: {
      received: session.kick ? session.kick.received : 0,
      queued: q.accepted,
      dropped: q.rejected,
      muted: q.muted,
      overflowed: q.overflowed
    },
    speech: {
      engine: speech.engine,
      alive: speech.alive,
      speaking: speech.speaking,
      bufferedMs: speech.bufferedMs,
      spoken: speech.spoken,
      failures: speech.failures + session.speechFailures,
      stranded: speech.stranded,
      inputRate: speech.inputRate
    },
    audio: {
      framesEmitted: mixer.frames,
      audioMs: mixer.audioMs,
      elapsedMs: mixer.elapsedMs,
      /* Should sit within a frame or two of zero however long it runs. If
         this grows, the pacing is broken. */
      driftMs: mixer.driftMs,
      encoderAlive: encoder.alive,
      framesDroppedToEncoder: encoder.framesDropped,
      slowListenerDrops: encoder.writeDrops,
      bytesEncoded: encoder.bytesOut
    }
  };
}

/* Cuts the current line short. The next frame finds nothing playing and pulls
   the next thing off the queue, so a skip costs one frame of silence. */
export function skip(slug) {
  const session = sessions.get(slug);
  if (!session) return null;
  return { ok: true, skipped: session.speech.skip(), queue: session.queue.depth };
}
