import { spawn } from 'node:child_process';
import WebSocket from 'ws';

/* Kick ingest: turn a channel name into a chatroom id, then hold a websocket
   open and hand back the messages.

   `ws` rather than the global WebSocket on purpose. The global exists on
   Node 22 and up; the box runs Node 20, where it is undefined. Writing
   against it works perfectly in dev and throws on the first connection in
   production, which is the worst possible place to find out. */

const PUSHER_URL =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679' +
  '?protocol=7&client=js&version=8.4.0-rc2&flash=false';

const CHAT_EVENTS = new Set([
  'App\\Events\\ChatMessageEvent',
  'App\\Events\\ChatMessageSentEvent'
]);

/* ── slug to chatroom id ─────────────────────────────────────────────────── */

/* kick.com sits behind Cloudflare, which turns away Node's fetch on the TLS
   fingerprint alone. The system curl binary presents a fingerprint Cloudflare
   accepts, so the lookup shells out. Both happen to pass from these two IPs
   today, but that is a property of the IPs and the day, not something to
   depend on.

   Spawned with an argument array and no shell, so a channel name can never be
   read as anything but one argument however it got here. */
const ids = new Map();

export async function chatroomId(slug) {
  if (ids.has(slug)) return ids.get(slug);

  let id = null;
  let firstError = null;

  /* The clean way: 60 bytes of JSON with the field named right there. */
  try {
    const body = await curlJson(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
    const found = body && body.chatroom && body.chatroom.id;
    if (typeof found === 'number') id = found;
  } catch (err) {
    firstError = err;
  }

  /* The ugly way, for when Cloudflare decides the API is not for us. The
     popout chat page is an ordinary browser page and gets challenged less, and
     it carries the same id inside its server rendered payload. Scraping it is
     fragile by nature, since it breaks whenever Kick redeploys their
     frontend, so it is strictly a fallback and never the first choice. */
  if (id === null) {
    const html = await curlText(`https://kick.com/popout/${encodeURIComponent(slug)}/chat`);
    const m = /\\?"chatroom\\?":\s*\{\\?"id\\?":\s*(\d{1,12})/.exec(html);
    if (m) id = Number(m[1]);
  }

  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error(
      `no chatroom id for channel "${slug}"` +
      (firstError ? `: ${firstError.message}` : '')
    );
  }

  /* Cached with no expiry because a channel's chatroom id does not change.
     Only successes are kept: a failure is usually a typo or a Cloudflare
     challenge, and neither should be remembered as fact. */
  ids.set(slug, id);
  return id;
}

async function curlJson(url) {
  const text = await curlText(url);
  try {
    return JSON.parse(text);
  } catch {
    /* An HTML body here is a Cloudflare challenge page, not a channel. */
    const hint = /^\s*</.test(text) ? 'got HTML, likely a Cloudflare challenge' : 'got unparseable body';
    throw new Error(`kick lookup failed: ${hint}`);
  }
}

function curlText(url) {
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-sS', '--max-time', '15', '--compressed',
      '-H', 'Accept: application/json',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const out = [];
    const err = [];
    let settled = false;

    /* Every stream gets a reader and an error handler. An unhandled 'error'
       here is an unhandled exception, which takes down the web app rather
       than this one lookup. */
    curl.stdout.on('data', (c) => out.push(c));
    curl.stderr.on('data', (c) => err.push(c));
    curl.stdout.on('error', () => {});
    curl.stderr.on('error', () => {});

    curl.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(`curl could not run: ${e.message}`));
    });

    curl.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        return reject(new Error(`curl exited ${code}: ${Buffer.concat(err).toString().trim()}`));
      }
      resolve(Buffer.concat(out).toString());
    });
  });
}

/* ── the websocket ───────────────────────────────────────────────────────── */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/* Pusher tells us its activity timeout on connect. If the line goes quiet for
   that long we ping, and if the pong does not come back we treat the socket as
   dead. Without this a connection that dies without a FIN, which is what a
   dropped route looks like, stays "open" forever and the channel goes silent
   with everything reporting healthy. */
const DEFAULT_ACTIVITY_MS = 120 * 1000;
const PONG_GRACE_MS = 30 * 1000;

export function createKickClient({ slug, id, onMessage, onState }) {
  let ws = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;
  let activityTimer = null;
  let pongTimer = null;
  let state = 'connecting';
  let activityMs = DEFAULT_ACTIVITY_MS;
  let received = 0;

  const channel = `chatrooms.${id}.v2`;

  function setState(next, detail) {
    if (state === next) return;
    state = next;
    if (onState) onState(next, detail);
  }

  function clearTimers() {
    clearTimeout(activityTimer); activityTimer = null;
    clearTimeout(pongTimer); pongTimer = null;
  }

  /* Any traffic at all counts as proof of life, not just chat: on a quiet
     channel the only thing arriving may be pusher's own keepalives. */
  function sawActivity() {
    clearTimers();
    activityTimer = setTimeout(() => {
      send({ event: 'pusher:ping', data: {} });
      pongTimer = setTimeout(() => {
        /* terminate, not close: a half open socket will not answer a clean
           handshake, and waiting for one is how this hangs instead of
           reconnecting. */
        if (ws) ws.terminate();
      }, PONG_GRACE_MS);
    }, activityMs);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* closing under us */ }
    }
  }

  function connect() {
    if (stopped) return;
    setState(attempt === 0 ? 'connecting' : 'reconnecting');

    ws = new WebSocket(PUSHER_URL, { handshakeTimeout: 15000 });

    ws.on('open', () => {
      if (stopped) return ws.close();
      attempt = 0;
      send({ event: 'pusher:subscribe', data: { auth: '', channel } });
      sawActivity();
    });

    ws.on('message', (raw) => {
      sawActivity();
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return; // not something we can act on
      }
      handle(frame);
    });

    /* Both of these have to be here. An unhandled 'error' on a socket is an
       unhandled exception, and ws emits one for every failed DNS lookup and
       refused connection, which is exactly what happens when the network
       drops. */
    ws.on('error', (err) => {
      setState('error', err.message);
    });

    ws.on('close', () => {
      clearTimers();
      ws = null;
      if (stopped) return;
      scheduleReconnect();
    });
  }

  function handle(frame) {
    const event = frame.event;

    if (event === 'pusher:ping') {
      send({ event: 'pusher:pong', data: {} });
      return;
    }
    if (event === 'pusher:pong') {
      clearTimeout(pongTimer); pongTimer = null;
      return;
    }

    if (event === 'pusher:connection_established') {
      const payload = decode(frame.data);
      if (payload && Number(payload.activity_timeout) > 0) {
        activityMs = Number(payload.activity_timeout) * 1000;
        sawActivity();
      }
      setState('connected');
      return;
    }

    if (event === 'pusher_internal:subscription_succeeded') {
      setState('subscribed');
      return;
    }

    if (event === 'pusher:error') {
      const payload = decode(frame.data);
      setState('error', payload && payload.message ? payload.message : 'pusher error');
      return;
    }

    if (!CHAT_EVENTS.has(event)) return;

    const payload = decode(frame.data);
    if (!payload) return;

    /* The sender shape differs slightly between the two chat events, so read
       whichever is present rather than assuming. */
    const sender = payload.sender || {};
    const username = sender.username || sender.slug || '';
    const content = payload.content;
    if (!username || typeof content !== 'string') return;

    received++;
    if (onMessage) onMessage({ username, content });
  }

  /* THE gotcha in this protocol: `data` is not a nested object, it is a string
     containing JSON. Reading frame.data.content gives undefined forever and
     looks like the channel simply having no chat. */
  function decode(data) {
    if (data && typeof data === 'object') return data;
    if (typeof data !== 'string') return null;
    try { return JSON.parse(data); } catch { return null; }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    /* Jitter so that every session on the box does not come back at the same
       instant after a network blip and get throttled together. */
    const wait = base + Math.floor(Math.random() * 500);
    attempt++;
    setState('reconnecting', `in ${Math.round(wait / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
    reconnectTimer.unref();
  }

  connect();

  return {
    get state() { return state; },
    get received() { return received; },
    stop() {
      stopped = true;
      clearTimers();
      clearTimeout(reconnectTimer); reconnectTimer = null;
      if (ws) {
        ws.removeAllListeners();
        ws.terminate();
        ws = null;
      }
      setState('stopped');
    }
  };
}
