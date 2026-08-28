import { spawn } from 'node:child_process';
import { SAMPLE_RATE } from './mixer.js';

/* The encoder end of the timeline: paced PCM in, one MP3 stream out, fanned
   to every listener on the channel.

   Three things break a stream like this quietly rather than loudly, and all
   three are handled here. Each one is marked below. */

const BITRATE = '64k';

/* Gotcha 2. res.write() returns false when the socket send buffer is full,
   and Node will happily queue whatever else you hand it, without limit. One
   listener on bad LTE is enough to grow the heap until the process dies, and
   it takes the whole site with it, not just this stream. Past this much
   buffered, drop the audio instead. Live audio that arrives late is worth
   nothing anyway. */
const MAX_BUFFERED = 128 * 1024;

/* Same reasoning on the way in. ffmpeg reading 96 kB/s of PCM keeps up with
   room to spare, so anything queued here means it has stopped reading, and
   queueing more will not restart it. */
const MAX_STDIN_BUFFERED = 256 * 1024;

/* Gotcha 1 needs every child stream to have a permanent reader. stderr is the
   easy one to forget: ffmpeg writes to it, nothing drains it, the pipe fills
   at 64 kB, and ffmpeg blocks forever on the write. The session then hangs
   rather than crashing, so nothing notices and nothing restarts it. Draining
   it into a small ring of lines costs nothing and makes a failure legible. */
const STDERR_KEEP = 10;

export function createEncoder({ onExit }) {
  const listeners = new Map(); // res -> { needsSync, bytes }
  const errLines = [];
  let bytesOut = 0;
  let framesIn = 0;
  let framesDropped = 0;
  let writeDrops = 0;
  let dead = false;

  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', '+nobuffer',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', BITRATE,
    /* The bit reservoir lets a frame borrow bits from the frames before it.
       That is fine for a file and wrong here: a listener joining mid stream
       lands on a frame whose data is partly in frames it never received, and
       decodes a second of mud before it catches up. Off, every frame stands
       alone. */
    '-reservoir', '0',
    /* Xing writes a header describing total length, which this stream does
       not have, and an ID3 tag puts non-audio bytes in front of the first
       frame. Neither belongs on something endless. */
    '-write_xing', '0',
    '-id3v2_version', '0',
    /* Without this the mp3 muxer fills a 32 kB buffer before flushing, which
       at 64 kbit/s is four seconds of latency added for no reason. */
    '-flush_packets', '1',
    '-f', 'mp3', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  /* Gotcha 1, the part that is fatal rather than merely wedging: an
     unhandled 'error' on any of these streams is an unhandled exception, and
     that does not kill the session, it kills the whole web app. ffmpeg dying
     while the mixer is mid write gives stdin an EPIPE, which is exactly this
     case and happens on every teardown race. */
  ff.on('error', (err) => fail(`spawn: ${err.message}`));
  ff.stdin.on('error', () => {});
  ff.stdout.on('error', () => {});
  ff.stderr.on('error', () => {});

  ff.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      errLines.push(line.trim());
      if (errLines.length > STDERR_KEEP) errLines.shift();
    }
  });

  /* Gotcha 1 again: stdout is the one that matters most. It has a permanent
     consumer from the moment the child exists, whether or not anyone is
     listening, so the pipe can never fill and stall the encoder. With no
     listeners the bytes are simply discarded. */
  ff.stdout.on('data', (chunk) => {
    bytesOut += chunk.length;
    for (const [res, state] of listeners) send(res, state, chunk);
  });

  ff.on('close', (code, signal) => {
    if (dead) return;
    dead = true;
    if (onExit) onExit({ code, signal, stderr: errLines.slice() });
  });

  function fail(message) {
    errLines.push(message);
    if (errLines.length > STDERR_KEEP) errLines.shift();
    if (dead) return;
    dead = true;
    if (onExit) onExit({ code: null, signal: null, stderr: errLines.slice() });
  }

  /* Gotcha 3. An MP3 stream is a run of self-delimiting frames, and a decoder
     handed the middle of one has no way to know where it is. Safari's answer
     is to sometimes start and sometimes sit there doing nothing, which reads
     as a flaky network rather than a bug in here. So a listener's first write
     starts at a frame header: 11 set bits, meaning 0xFF then the top three
     bits of the next byte.

     A match on the very last byte of a chunk cannot be confirmed, since the
     second byte is in the chunk after it. Rare enough that waiting 26ms for
     the next chunk is the right trade against carrying state for it. */
  function syncOffset(buf) {
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) return i;
    }
    return -1;
  }

  function send(res, state, chunk) {
    if (res.writableEnded || res.destroyed) return;

    if (res.writableLength > MAX_BUFFERED) {
      /* Dropped bytes leave this listener part way through a frame, so put it
         back into the same state a fresh listener is in and let it rejoin at
         the next header. Otherwise it decodes the tail of a frame it never
         got the head of. */
      state.needsSync = true;
      state.dropped++;
      writeDrops++;
      return;
    }

    let out = chunk;
    if (state.needsSync) {
      const at = syncOffset(chunk);
      if (at < 0) return;
      out = at === 0 ? chunk : chunk.subarray(at);
      state.needsSync = false;
    }

    state.bytes += out.length;
    res.write(out);
  }

  return {
    /* One frame per 20ms of real time, straight from the mixer. */
    write(frame) {
      if (dead || ff.stdin.destroyed || ff.stdin.writableEnded) return;
      framesIn++;
      if (ff.stdin.writableLength > MAX_STDIN_BUFFERED) {
        framesDropped++;
        return;
      }
      ff.stdin.write(frame);
    },

    attach(res) {
      listeners.set(res, { needsSync: true, bytes: 0, dropped: 0 });
    },

    detach(res) {
      listeners.delete(res);
    },

    get listenerCount() {
      return listeners.size;
    },

    stats() {
      return {
        pid: ff.pid,
        alive: !dead,
        framesIn,
        framesDropped,
        writeDrops,
        bytesOut,
        stderr: errLines.slice()
      };
    },

    kill() {
      if (dead) return;
      dead = true;
      for (const res of listeners.keys()) {
        if (!res.writableEnded) res.end();
      }
      listeners.clear();
      /* end() rather than destroy() so ffmpeg sees EOF and exits on its own.
         SIGKILL after a grace period covers the case where it does not. */
      try { ff.stdin.end(); } catch { /* already gone */ }
      const grace = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
      grace.unref();
      ff.once('close', () => clearTimeout(grace));
    }
  };
}
