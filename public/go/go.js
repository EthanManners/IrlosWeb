/* irlos.live/go: sign in, then one button that starts and stops your stream.
   Ending a live stream takes two taps so a phone in a pocket can't do it. */

const $ = (id) => document.getElementById(id);
let status = null;
let confirmUntil = 0;
let busy = false;
let timer = null;

async function api(path, body) {
  const init = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  try {
    const res = await fetch(`/api/${path}`, { credentials: 'same-origin', ...init });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, ok: false, data: { message: 'No connection. Check your signal.' } };
  }
}

function show(view) {
  for (const id of ['login', 'password', 'control']) $(id).hidden = id !== view;
  $('logout').hidden = view === 'login';
}

function say(text) {
  $('message').textContent = text || '';
}

async function boot() {
  clearTimeout(timer);
  const r = await api('account/me');
  if (r.status === 401) {
    $('who').textContent = '';
    return show('login');
  }
  if (!r.ok) {
    say(r.data.message || 'Something went wrong. Reload the page.');
    timer = setTimeout(boot, 5000);
    return;
  }
  $('who').textContent = r.data.username;
  if (r.data.mustChangePassword) return show('password');
  show('control');
  poll();
}

async function poll() {
  clearTimeout(timer);
  if (document.hidden) return;
  const r = await api('stream');
  if (r.status === 401 || r.status === 403) return boot();
  status = r.ok ? r.data : { offline: true, message: r.data.message };
  render();
  timer = setTimeout(poll, 2000);
}

/* Is there a stream (or a start in progress) for the button to end? */
const running = (s) => s.wantStreaming || ['starting', 'active', 'reconnecting'].includes(s.state);

function render() {
  const s = status || {};
  const confirming = Date.now() < confirmUntil;
  let label, hint = '', cls = '', enabled = true, clock = '', detail = '';
  if (s.offline) {
    [label, enabled, detail] = ['Offline', false, s.message];
  } else if (s.studio !== 'ready') {
    [label, enabled, detail] = ['Booting', false, 'Your stream server is starting up.'];
  } else if (s.state === 'stopping') {
    [label, enabled] = ['Stopping', false];
  } else if (s.state === 'active') {
    [label, hint, cls, clock] = ['Live', 'tap to end', 'live', `● ${hms(s.durationMs)}`];
  } else if (s.state === 'reconnecting') {
    [label, hint, cls, clock] = ['Retrying', 'tap to end', 'warn', 'connection dropped, retrying'];
  } else if (running(s)) {
    [label, hint, cls] = ['Starting', 'tap to cancel', 'pending'];
    if (s.lastError) detail = `Retrying: ${s.lastError}`;
  } else {
    label = 'Go live';
  }
  if (confirming && enabled && running(s)) [label, hint, cls] = ['End?', 'tap again', 'confirm'];
  if (busy) enabled = false;
  if (!detail && s.scene && running(s)) {
    detail = `scene ${s.scene}${s.outputKbps ? ` · ${s.outputKbps} kbps` : ''}`;
  }
  const go = $('go');
  go.className = `go ${cls}`;
  go.disabled = !enabled;
  $('label').textContent = label;
  $('hint').textContent = hint;
  $('clock').textContent = clock;
  $('detail').textContent = detail || '';
}

function hms(ms) {
  const t = Math.floor((ms || 0) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
}

$('go').addEventListener('click', async () => {
  if (busy || !status || status.offline) return;
  const stop = running(status);
  if (stop && Date.now() > confirmUntil) {
    confirmUntil = Date.now() + 3000;
    render();
    setTimeout(render, 3100);
    return;
  }
  confirmUntil = 0;
  busy = true;
  render();
  const r = await api(stop ? 'stream/stop' : 'stream/start', {});
  busy = false;
  say(r.ok ? '' : r.data.message || 'That did not work. Try again.');
  if (!r.ok && navigator.vibrate) navigator.vibrate(200);
  poll();
});

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  say('');
  const r = await api('account/login', { username: f.get('username'), password: f.get('password') });
  if (!r.ok) return say(r.data.message || 'Could not sign in.');
  e.target.reset();
  boot();
});

$('password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  say('');
  const r = await api('account/password', { current: f.get('current'), next: f.get('next') });
  if (!r.ok) return say(r.data.message || 'Could not save the password.');
  e.target.reset();
  boot();
});

$('logout').addEventListener('click', async () => {
  clearTimeout(timer);
  await api('account/logout', {});
  say('');
  boot();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('control').hidden) poll();
});

boot();
