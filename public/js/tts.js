/* The chat reader page.

   One <audio> element, one stream, started by a tap. iOS Safari suspends Web
   Audio, Web Speech and every timer that would advance a playlist the moment
   the screen locks, so anything clever here would stop the audio the instant
   the phone goes in a pocket. The rules that follow from that:

     - play() is called inside the tap handler, never after an await or a
       fetch, or iOS treats it as unprompted and refuses
     - the stream is never re-pointed at a new URL as part of normal playback
     - a drop is recovered by reconnecting the same element, with backoff */
(function () {
  var form = document.getElementById('ttsForm');
  if (!form) return;

  var input = document.getElementById('ttsChannel');
  var btn = document.getElementById('ttsPlay');
  var state = document.getElementById('ttsState');
  var audio = document.getElementById('ttsAudio');

  var KEY = 'irlos.tts.channel';
  var BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
  var POLL_MS = 15000;

  var slug = '';
  var wanted = false;    // the user has asked for audio and has not asked to stop
  var userPaused = false; // they pressed pause, on the page or on the lock screen
  var tries = 0;
  var retryTimer = null;
  var pollTimer = null;

  try {
    var last = localStorage.getItem(KEY);
    if (last) input.value = last;
  } catch (e) { /* private mode, no memory, fine */ }

  /* ── ui ─────────────────────────────────────────────────────────────── */

  function say(text, bad) {
    state.textContent = text;
    state.classList.toggle('is-error', !!bad);
  }

  function setBtn(label) {
    btn.textContent = label;
  }

  function clean(value) {
    return String(value || '').trim().toLowerCase().replace(/^@/, '');
  }

  /* ── playback ───────────────────────────────────────────────────────── */

  /* Called from the tap handler on the way in and from the retry timer after
     that. A fresh query string every time on purpose: after Safari gives up
     on a connection it will happily hand back the same dead one for the same
     URL, and the retry then does nothing at all. */
  function connect() {
    audio.src = '/tts/stream/' + encodeURIComponent(slug) + '.mp3?t=' + Date.now();
    audio.load();
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function (err) {
        // load() cancelling the previous play() is expected, not a failure
        if (err && err.name === 'AbortError') return;
        if (err && err.name === 'NotAllowedError') {
          wanted = false;
          setBtn('play');
          say('your browser wants a tap before it will play audio. press play.', true);
          return;
        }
        retry('could not start');
      });
    }
  }

  function start() {
    var value = clean(input.value);
    if (!value) { say('type a channel name first', true); input.focus(); return; }
    if (!/^[a-z0-9_-]{1,25}$/.test(value)) {
      say('channel names are letters, numbers, dashes and underscores', true);
      return;
    }

    slug = value;
    try { localStorage.setItem(KEY, slug); } catch (e) { /* fine */ }

    wanted = true;
    userPaused = false;
    tries = 0;
    setBtn('stop');
    say('connecting to ' + slug);
    connect();      // still inside the tap. Nothing may await before this line.
    describe();
    poll();
  }

  function stop() {
    wanted = false;
    userPaused = false;
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(pollTimer); pollTimer = null;
    audio.pause();
    /* Dropping the source as well as pausing, so the server sees the socket
       close and can let the session go idle instead of encoding for nobody. */
    audio.removeAttribute('src');
    audio.load();
    setBtn('play');
    say('stopped');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  }

  function retry(why) {
    if (!wanted || userPaused || retryTimer) return;
    var wait = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
    tries++;
    say(why + '. reconnecting in ' + Math.round(wait / 1000) + 's, try ' + tries, true);

    /* A refusal and a dropped network are the same error event on the audio
       element, and with the session cap at one under piper the refusal is the
       likely one. Ask, and replace the message if that is what happened. The
       retry still stands: a slot frees five minutes after its last listener
       leaves, and this is exactly the wait that gets there. */
    fetch('/tts/api/capacity/' + encodeURIComponent(slug))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cap) {
        /* Only if the retry this was asked for is still the pending one, so a
           slow answer cannot overwrite the message of a later attempt. */
        if (!cap || !cap.refused || !retryTimer) return;
        say('the reader is already on another channel and runs one at a time. ' +
            'waiting for it to free up, try ' + tries, true);
      })
      .catch(function () { /* then the first message was the right one */ });

    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!wanted || userPaused) return;
      say('reconnecting to ' + slug);
      connect();
    }, wait);
  }

  /* ── element events ─────────────────────────────────────────────────── */

  audio.addEventListener('playing', function () {
    tries = 0;
    clearTimeout(retryTimer); retryTimer = null;
    say('live: ' + slug);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  audio.addEventListener('waiting', function () {
    if (wanted) say('buffering');
  });

  audio.addEventListener('error', function () {
    if (wanted) retry('stream dropped');
  });

  audio.addEventListener('stalled', function () {
    if (wanted) retry('stream stalled');
  });

  /* This stream has no end, so reaching one means the server went away. */
  audio.addEventListener('ended', function () {
    if (wanted) retry('stream ended');
  });

  /* iOS pauses the element itself when it loses the network or the audio
     session is taken by a call. That is not the user asking for silence, so
     pick it back up. A real pause, from the page or the lock screen, sets
     userPaused first and is left alone. */
  audio.addEventListener('pause', function () {
    if (!wanted || userPaused) return;
    if (audio.ended || audio.error) return;
    retry('playback was interrupted');
  });

  /* Coming back to the foreground is the cheapest chance to notice the audio
     died while the screen was off, and to fix it without waiting out a
     backoff the phone was too asleep to run. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !wanted || userPaused) return;
    poll();
    if (audio.paused) {
      clearTimeout(retryTimer); retryTimer = null;
      tries = 0;
      say('reconnecting to ' + slug);
      connect();
    }
  });

  /* ── lock screen ────────────────────────────────────────────────────── */

  function describe() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: slug,
      artist: 'kick chat',
      album: 'irlos.live',
      artwork: [{ src: '/img/box-hero-poster.jpg', sizes: '1280x720', type: 'image/jpeg' }]
    });

    handler('play', function () {
      userPaused = false;
      audio.play();
    });
    handler('pause', function () {
      userPaused = true;
      audio.pause();
      say('paused');
      navigator.mediaSession.playbackState = 'paused';
    });
    handler('stop', stop);
    /* There is one thing to skip and it is whatever is being said, so the
       lock screen's next track button is the natural place for it. */
    handler('nexttrack', skipUtterance);

    /* Seeking an endless stream is meaningless, and leaving the controls
       enabled invites a tap that does nothing. */
    handler('seekbackward', null);
    handler('seekforward', null);
    handler('seekto', null);
    handler('previoustrack', null);
  }

  function handler(name, fn) {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) { /* unsupported action */ }
  }

  function skipUtterance() {
    if (!slug) return;
    fetch('/tts/api/skip/' + encodeURIComponent(slug), { method: 'POST' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.skipped === false) say('nothing being said right now');
      })
      .catch(function () { /* the audio is what matters, not the button */ });
  }

  /* ── status ─────────────────────────────────────────────────────────── */

  /* Only while the page is in front. A locked phone freezes these timers
     anyway, and the audio element is the thing that has to survive the lock,
     not this. */
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!wanted || document.hidden) return;

    fetch('/tts/api/status/' + encodeURIComponent(slug))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || !wanted || audio.paused) return;

        /* A channel that does not exist, or a Cloudflare challenge, leaves the
           audio playing perfectly and completely silent. Without this the page
           looks healthy and the user is left wondering why nobody is talking,
           so a chat that is not connected is said plainly and first. */
        if (s.ws === 'failed') {
          say('cannot read ' + slug + ': ' + (s.wsDetail || 'channel not found'), true);
          return;
        }

        var bits = ['live: ' + slug];
        if (s.ws !== 'subscribed') bits.push('chat ' + s.ws);
        if (typeof s.queue === 'number' && s.queue > 0) bits.push(s.queue + ' queued');
        bits.push(s.listeners + (s.listeners === 1 ? ' listener' : ' listeners'));
        say(bits.join(' · '));
      })
      .catch(function () { /* the status line is decoration, the stream is not */ })
      .then(function () {
        if (wanted && !document.hidden) pollTimer = setTimeout(poll, POLL_MS);
      });
  }

  /* ── go ─────────────────────────────────────────────────────────────── */

  /* submit, not click: this fires for the button and for the keyboard's go
     key, and both keep the user activation that iOS requires for play(). */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (wanted) { stop(); return; }
    start();
  });

  input.addEventListener('input', function () {
    if (!wanted) say('');
  });
})();
