/* The timeline.

   iOS Safari suspends Web Audio, Web Speech and any JS that would advance a
   playlist the instant the screen locks. One <audio> element playing an
   unbroken media stream started by a user gesture is the only thing that
   keeps running. So the server has to produce audio that never ends and never
   gaps, dead chat included, and everything in this file follows from that. */

export const SAMPLE_RATE = 48000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = 960;             // 48000 Hz * 0.020 s
export const FRAME_BYTES = FRAME_SAMPLES * 2; // s16le, mono

/* Handed to the sink whenever the source has nothing to say. Never written
   to, so one shared buffer is enough. */
const SILENCE = Buffer.alloc(FRAME_BYTES);

/* A tick that runs late emits the frames it owes, which is what keeps the
   timeline matched to the wall clock. A tick that runs a very long way late
   is a different thing: a suspended process or a stalled event loop leaves a
   deadline minutes in the past, and paying that debt back at once dumps
   minutes of audio into the encoder that no listener is waiting for. Past a
   second behind, write the gap off and resynchronise. */
const MAX_CATCHUP_MS = 1000;

/* Builds the paced clock. `source` returns the next FRAME_BYTES of PCM or
   null for silence, `sink` receives exactly one frame per 20ms of real time. */
export function createMixer({ source, sink, onError }) {
  let timer = null;
  let running = false;
  let deadline = 0;
  let started = 0;
  let frames = 0;

  /* Deliberately not setInterval. setInterval drifts by however long each
     callback takes, and the error compounds: the stream ends up tens of
     seconds adrift from real time after an hour, which sounds like the audio
     slowly falling behind chat and never recovering. This form carries the
     absolute deadline forward instead, so a slow frame is repaid by the next
     one rather than added to a running total. */
  function tick() {
    if (!running) return;

    deadline += FRAME_MS;
    const now = performance.now();
    if (now - deadline > MAX_CATCHUP_MS) deadline = now;

    let frame = null;
    try {
      frame = source();
    } catch (err) {
      /* A source that throws must not take the timeline down with it. Silence
         is always a valid frame, so the stream survives a broken speaker. */
      if (onError) onError(err);
    }

    sink(frame && frame.length === FRAME_BYTES ? frame : SILENCE);
    frames++;

    timer = setTimeout(tick, Math.max(0, deadline - performance.now()));
  }

  return {
    start() {
      if (running) return;
      running = true;
      started = performance.now();
      deadline = started;
      timer = setTimeout(tick, 0);
    },

    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    /* How far the emitted audio has fallen behind real time. The only honest
       measure of whether the pacing works, and the thing to read after a long
       listen: it should stay inside a frame or two, not grow. */
    stats() {
      const elapsed = running ? performance.now() - started : 0;
      return {
        frames,
        elapsedMs: Math.round(elapsed),
        audioMs: frames * FRAME_MS,
        driftMs: Math.round(frames * FRAME_MS - elapsed)
      };
    }
  };
}
