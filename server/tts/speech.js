import { spawn } from 'node:child_process';
import { SAMPLE_RATE } from './mixer.js';
import {
  TTS_ENGINE, TTS_VOICE,
  PIPER_BIN, PIPER_MODEL, PIPER_RATE, PIPER_LENGTH_SCALE
} from '../lib/config.js';

/* One speech process per session, kept alive for the life of the session.

   Not one per message. Spawning espeak per utterance costs 30 to 60ms of
   process startup before a word comes out, and on a busy channel that is a
   process launch every couple of seconds forever. The child sits idle between
   utterances instead, which costs nothing.

   Both engines emit a single continuous PCM stream with no markers in it, so
   nothing in the bytes says where one utterance ends and the next begins.
   That is why exactly one line is ever in flight: the invariant is that all
   audio arriving before the next line is written belongs to the current
   utterance, which makes the boundary a fact rather than a guess. */

const ENGINES = {
  /* Verified against espeak-ng 1.50 on the box: it starts emitting ~80ms
     after the first line, without waiting for stdin to close, and writes one
     RIFF header up front followed by raw PCM forever. mb-us2 is 16 kHz mono,
     with a declared data size of 0x7FFFF000, the usual streaming placeholder. */
  'espeak-ng': {
    bin: 'espeak-ng',
    args: () => ['-v', TTS_VOICE, '--stdout'],
    hasWavHeader: true,
    rate: 16000,       // read from the header at runtime, this is the fallback
    /* espeak trickles audio out as it synthesises and does pause mid sentence,
       so a gap has to be long to mean anything. */
    quietMs: 400
  },
  /* --output_raw is headerless s16le at the model's own rate, so there is
     nothing to strip and the rate has to be configured.

     --quiet matters more than it looks. Without it piper writes an info line
     per utterance, which would push every real error out of the ten line
     stderr ring that /tts/api/status reports, so a genuine failure would be
     invisible behind a wall of real-time-factor messages.

     Measured on the box, not guessed: 1.4s to load the model, then a real-time
     factor of 0.50 on its single core, 143MB resident once warm and 226MB at
     the peak of loading. */
  piper: {
    bin: PIPER_BIN,
    args: () => [
      '--model', PIPER_MODEL,
      '--length_scale', String(PIPER_LENGTH_SCALE),
      '--output_raw', '--quiet'
    ],
    hasWavHeader: false,
    rate: PIPER_RATE,
    splitSentences: true,
    /* piper does not trickle. It infers a whole sentence and writes it in one
       burst, and the burst is contiguous: measured on the box, the gap between
       chunks inside one is 1 to 8ms idle and 168ms worst case with the core
       contended. Nothing like espeak's, so it does not need espeak's gate. */
    quietMs: 150
  }
};

/* Playback starts once this much audio is buffered, not when the child goes
   quiet. That distinction is most of the latency in here.

   Waiting for quiet meant every message paid the full gate before its first
   word, which is dead time: piper delivers a sentence as one burst of ~1.5s of
   audio per pipe read, so by the time the first chunk lands there is already
   far more than enough to start on and the gate was only ever confirming
   something already known. A quarter second is a jitter buffer, the same thing
   any streaming player keeps, and it absorbs the gaps measured above with room
   to spare. */
const START_BUFFER_MS = 250;

/* A line handed to piper is written one sentence at a time, and the next
   sentence is not written until the previous one's audio has arrived.

   This is not tidiness, it is the only thing making the boundary real. piper
   infers a sentence at a time and emits it in one burst, so the wall clock gap
   between two sentences of the same message is however long the second takes
   to infer, which at a real-time factor of 0.5 is seconds. That gap is
   indistinguishable from the end of the message. Write a whole line at once
   and "lol. what about the battery?" plays "lol.", drains while sentence two
   is still being inferred, finalises the utterance, and the rest of the
   message is then discarded by the no-line-in-flight guard in onAudio: the
   message is silently truncated and nothing anywhere reports it.

   espeak does not need this. It runs at something like a hundred times real
   time, so a whole line is out of it inside one QUIET_MS window. */
function splitSentences(line) {
  /* Split after . ! ? ; : when the next thing is a space, which is roughly
     where piper's own phonemiser splits. Over-splitting only costs one quiet
     window and sounds the same, since piper would give each of these falling
     sentence intonation anyway. Under-splitting is what has to be avoided.
     The digit guard keeps "$1,200." and "1.5kg" in one piece. */
  const parts = line
    .split(/(?<![0-9])(?<=[.!?;:])["')\]]?\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [line];
}

/* piper has taken longer than this over one sentence, so it is not coming.
   Without a ceiling here a child that wedges mid line leaves an utterance in
   flight forever, and the session stops reading chat with no error and no
   recovery. Generous: 60s of audio at the length cap, inferred at a real-time
   factor much worse than the box's own, is still inside it. */
const MAX_INFER_MS = 120 * 1000;

/* A 120 character line is about eight seconds of speech. Sixty seconds of
   audio for one line means something has gone wrong, and the buffer should
   not grow to match. */
const MAX_UTTERANCE_SAMPLES = SAMPLE_RATE * 60;

/* Audio that stops instantly at a non-zero sample is a click, and a click at
   the end of every single line is the kind of thing that makes a stream sound
   broken rather than merely robotic. Five milliseconds is inaudible as a fade
   and completely removes the edge. espeak usually trails off into near silence
   on its own, which would make this unnecessary, but "usually" is doing too
   much work there and skip() cuts mid-word by definition. */
const FADE_SAMPLES = Math.round(SAMPLE_RATE * 0.005);

function fadeTail(buf, end) {
  const n = Math.min(end, FADE_SAMPLES);
  for (let i = 0; i < n; i++) {
    const gain = (n - 1 - i) / n;
    buf[end - n + i] = Math.round(buf[end - n + i] * gain);
  }
}

export function createSpeech({ onError }) {
  const engine = ENGINES[TTS_ENGINE] || ENGINES['espeak-ng'];
  const QUIET_MS = engine.quietMs;
  const START_BUFFER_SAMPLES = Math.round(SAMPLE_RATE * (START_BUFFER_MS / 1000));

  let child = null;
  let dead = false;
  let headerLeft = engine.hasWavHeader ? 44 : 0;
  let headerBuf = [];
  let odd = null;                 // trailing byte of an odd length chunk
  let resample = null;
  let inRate = engine.rate;

  let current = null;             // the line in flight
  let tail = null;                // a few faded samples left over from a skip
  let quietTimer = null;
  let inferTimer = null;          // watchdog on a sentence that produced nothing
  let spoken = 0;
  let failures = 0;
  /* Audio that turned up with no line in flight. Should be zero outside of a
     skip. Anything else here means an utterance was finalised while its child
     was still producing it, which is a message that got truncated with nobody
     told, so it is worth a number rather than a shrug. */
  let stranded = 0;

  const errLines = [];

  function note(line) {
    errLines.push(line);
    if (errLines.length > 10) errLines.shift();
  }

  function start() {
    child = spawn(engine.bin, engine.args(), { stdio: ['pipe', 'pipe', 'pipe'] });

    /* Every stream gets a reader and an error handler. An unhandled 'error'
       is an unhandled exception and takes the whole web app with it, and an
       undrained stdout fills its pipe and wedges the child silently. */
    child.on('error', (err) => {
      dead = true;
      note(`spawn: ${err.message}`);
      if (onError) onError(new Error(`${engine.bin}: ${err.message}`));
    });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stderr.on('data', (c) => {
      for (const l of String(c).split('\n')) if (l.trim()) note(l.trim());
    });

    child.stdout.on('data', onAudio);

    child.on('close', (code, signal) => {
      if (dead) return;
      dead = true;
      note(`exited code=${code} signal=${signal}`);
      if (onError) onError(new Error(`${engine.bin} exited (${code || signal})`));
    });
  }

  /* The single door to the child's stdin. Arms the watchdog on the way out,
     because from here until audio comes back there is nothing else watching
     whether the child is still alive. */
  function write(text) {
    if (dead || !child || !child.stdin.writable) return false;
    try {
      child.stdin.write(text + '\n');
    } catch (err) {
      note(`write: ${err.message}`);
      return false;
    }
    if (current) current.awaiting = true;
    clearTimeout(inferTimer);
    inferTimer = setTimeout(() => {
      if (!current) return;
      note('no audio for a written sentence, ending the line');
      current.forceEnd = true;
    }, MAX_INFER_MS);
    inferTimer.unref();
    return true;
  }

  function onAudio(chunk) {
    /* The WAV header arrives once, at the very start, and may be split across
       chunks. Parsing it rather than assuming 16 kHz means switching voices
       does not silently detune every utterance. */
    if (headerLeft > 0) {
      headerBuf.push(chunk);
      const have = headerBuf.reduce((n, b) => n + b.length, 0);
      if (have < 44) return;
      const all = Buffer.concat(headerBuf);
      headerBuf = [];
      headerLeft = 0;
      /* Bytes 24 to 27 of a RIFF header are the sample rate. Reading it beats
         hardcoding 16000: mb-us2 is 16 kHz but the built in espeak voices are
         22050, and guessing wrong detunes every utterance by a third. */
      const declaredRate = all.readUInt32LE(24);
      if (declaredRate >= 8000 && declaredRate <= 96000) inRate = declaredRate;
      resample = makeResampler(inRate, SAMPLE_RATE);
      chunk = all.subarray(44);
      if (chunk.length === 0) return;
    }

    if (!resample) resample = makeResampler(inRate, SAMPLE_RATE);

    /* A chunk boundary can land between the two bytes of a sample. Carrying
       the odd byte matters: getting this wrong shifts every following sample
       by one byte and turns the rest of the stream into noise. */
    if (odd) { chunk = Buffer.concat([odd, chunk]); odd = null; }
    if (chunk.length % 2) {
      odd = chunk.subarray(chunk.length - 1);
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    if (chunk.length === 0) return;

    const input = new Int16Array(chunk.length / 2);
    for (let i = 0; i < input.length; i++) input[i] = chunk.readInt16LE(i * 2);

    const out = resample(input);
    if (!out.length) return;

    if (!current) {
      /* Audio with no line in flight. Normally the tail of a skipped
         utterance still coming out of the child; anything else is a boundary
         that was called wrong, hence the counter. */
      stranded++;
      return;
    }

    if (current.forceEnd) return;

    if (current.total + out.length > MAX_UTTERANCE_SAMPLES) {
      note('utterance exceeded the length cap, truncating');
      current.pending.length = 0;
      current.forceEnd = true;
      return;
    }

    current.parts.push(out);
    current.total += out.length;
    current.remaining += out.length;
    current.lastAudioAt = performance.now();
    current.awaiting = false;

    /* Start as soon as there is a cushion, rather than waiting out the gate to
       be told what the cushion already proves. */
    if (current.remaining >= START_BUFFER_SAMPLES) current.ready = true;

    /* Audio came back, so the child is not wedged. */
    clearTimeout(inferTimer);
    inferTimer = null;

    /* The gate no longer decides that the line is over: it only says the child
       has stopped for now, which is the cue to start playing a line too short
       to have filled the jitter buffer, and to hand over the next sentence.
       Whether the line has actually ended is decided in read(), at the moment
       the buffer runs dry, because that is the only moment it matters and the
       only moment the answer is certain. */
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (!current) return;
      current.ready = true;
      if (current.pending.length) write(current.pending.shift());
    }, QUIET_MS);
  }

  return {
    get busy() { return current !== null; },
    get engineName() { return `${engine.bin} ${TTS_ENGINE === 'espeak-ng' ? TTS_VOICE : PIPER_MODEL}`; },
    get alive() { return !dead; },

    /* Spawn the child now rather than on the first line. piper spends 1.4s
       loading 61MB of weights before it can say anything, and left lazy that
       wait lands on the first message of the session, which is the one someone
       is watching for. Called when the session is built, so it happens during
       the dead time before any chat has arrived. Harmless for espeak, which
       has nothing to load. */
    warm() {
      if (!child && !dead) start();
    },

    /* True if the line was handed to the child. One at a time, always. */
    say(text) {
      if (dead || current) return false;
      const line = String(text || '').replace(/[\r\n]+/g, ' ').trim();
      if (!line) return false;
      if (!child) start();
      if (dead || !child.stdin.writable) return false;

      const chunks = engine.splitSentences ? splitSentences(line) : [line];

      current = {
        parts: [], total: 0, remaining: 0, played: 0,
        pending: chunks.slice(1),  // written one at a time, see splitSentences
        ready: false,     // enough has arrived to start playing, never unset
        awaiting: false,  // a sentence is written and its audio has not landed
        forceEnd: false,  // stop now regardless: length cap or a dead child
        lastAudioAt: 0,
        text: line
      };
      if (!write(chunks[0])) {
        current = null;
        failures++;
        return false;
      }
      spoken++;
      return true;
    },

    /* The next `count` samples of the current utterance, or null when there is
       nothing to play. Called by the mixer once per frame. */
    read(count) {
      /* The fade left over from a skip goes out first. It is one frame at
         most, and the next line's audio is still being synthesised, so the
         two can never contend. */
      if (tail) {
        const out = new Int16Array(count);
        const take = Math.min(count, tail.length);
        out.set(tail.subarray(0, take));
        tail = take >= tail.length ? null : tail.subarray(take);
        return out;
      }

      if (!current || !current.ready) return null;

      const out = new Int16Array(count);
      let filled = 0;

      while (filled < count && current.parts.length) {
        const part = current.parts[0];
        const offset = current.played;
        const take = Math.min(count - filled, part.length - offset);
        out.set(part.subarray(offset, offset + take), filled);
        filled += take;
        current.played += take;
        current.remaining -= take;
        if (current.played >= part.length) {
          current.parts.shift();
          current.played = 0;
        }
      }

      if (filled === 0) {
        /* Nothing left to play, which is where the line either ends or simply
           underruns. Draining faster than the synthesiser produces is an
           underrun, and cutting the utterance off there would clip the end of
           the line and hand the rest to whatever gets spoken next. Silence for
           a frame is the right answer, and it recovers on its own.

           Three things have to be true to call it the end, and they are
           checked here rather than latched earlier because here is where all
           three are actually known: nothing is written and waiting to come
           back, no sentence of this line is still queued, and the child has
           been quiet since. */
        const quiet = performance.now() - current.lastAudioAt >= QUIET_MS;
        if (current.forceEnd ||
            (current.ready && !current.awaiting && !current.pending.length && quiet)) {
          current = null;
        }
        return null;
      }

      /* A partly filled frame is the end of the line: the rest of the frame is
         already zero. Ramp into that zero rather than stepping into it. */
      if (filled < count) fadeTail(out, filled);
      return out;
    },

    /* Drops the rest of whatever is being said. Audio still in the child's
       pipe is discarded by the guard in onAudio rather than being played as
       the front of the next line. */
    skip() {
      if (!current) return false;

      /* Cutting mid word at full amplitude is the worst click in here, and
         skip is a button someone presses on purpose, so it gets a fade rather
         than a hard stop. Held outside `current` so the session is free to
         start the next line on the very next frame. */
      if (current.ready && current.parts.length) {
        const grab = new Int16Array(FADE_SAMPLES);
        let filled = 0;
        let played = current.played;
        for (const part of current.parts) {
          const take = Math.min(FADE_SAMPLES - filled, part.length - played);
          grab.set(part.subarray(played, played + take), filled);
          filled += take;
          played = 0;
          if (filled >= FADE_SAMPLES) break;
        }
        if (filled > 0) {
          fadeTail(grab, filled);
          tail = grab.subarray(0, filled);
        }
      }

      /* Anything still pending for this line is dropped with it. Nothing has
         been written for those sentences yet, so there is nothing in the
         child to discard either. */
      current = null;
      clearTimeout(quietTimer);
      quietTimer = null;
      clearTimeout(inferTimer);
      inferTimer = null;
      return true;
    },

    stats() {
      return {
        engine: TTS_ENGINE,
        alive: !dead,
        speaking: current !== null,
        ready: current ? current.ready : false,
        bufferedMs: current ? Math.round((current.remaining / SAMPLE_RATE) * 1000) : 0,
        spoken,
        failures,
        stranded,
        inputRate: inRate,
        stderr: errLines.slice()
      };
    },

    stop() {
      dead = true;
      clearTimeout(quietTimer);
      clearTimeout(inferTimer);
      current = null;
      if (!child) return;
      try { child.stdin.end(); } catch { /* already gone */ }
      const grace = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
      grace.unref();
      child.once('close', () => clearTimeout(grace));
    }
  };
}

/* Linear interpolation, which for upsampling speech to 48 kHz is honest
   enough: it images above the source's Nyquist, but the source is a 16 kHz
   robot voice and the result goes through a 64 kbit/s mp3 encoder that
   lowpasses most of it away. A windowed sinc would be better and nobody would
   hear the difference here.

   The carry matters. Interpolating the first output sample of a chunk needs
   the last input sample of the one before it, and without it every chunk
   boundary gets a discontinuity, which is a click roughly 50 times a second. */
function makeResampler(inRate, outRate) {
  const step = inRate / outRate;
  let carry = 0;
  let pos = 0;

  return function resample(input) {
    const n = input.length;
    if (n === 0) return new Int16Array(0);

    const count = Math.max(0, Math.ceil((n - pos) / step));
    const out = new Int16Array(count);

    let k = 0;
    while (pos < n && k < count) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? carry : input[i - 1];
      const b = input[i];
      let v = a + (b - a) * frac;
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out[k++] = v;
      pos += step;
    }

    carry = input[n - 1];
    pos -= n;
    /* Rebasing can land a hair below zero: 500 * (1/3) * 3 is not exactly 500
       in binary floating point. Math.floor of -1e-13 is -1, which reads
       input[-1] and input[-2], gets undefined, arithmetics to NaN, and an
       Int16Array stores NaN as 0. That is one dead sample at every chunk
       boundary that happened to split a sample, which is a click, and it is
       invisible until you go looking at the actual numbers. */
    if (pos < 0) pos = 0;

    return k === count ? out : out.subarray(0, k);
  };
}
