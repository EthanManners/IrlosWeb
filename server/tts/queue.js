/* What is worth saying out loud, and in what order.

   Everything here is about making text speakable. There is deliberately no
   spam filtering: no dedupe, no per-user rate limit. The streamer wants a
   hectic chat, so a person hammering enter and six people posting the same
   emote all get read. The only bound left is the queue depth, which is a
   throughput limit rather than a judgement about the message. */

import { TTS_QUEUE_DEPTH } from '../lib/config.js';

/* The reader can only ever speak one line at a time in real time, so on a
   channel busier than roughly one message every three seconds the queue is
   the thing deciding what gets heard. Too shallow and a burst is thrown away;
   too deep and the reader narrates the past while chat has moved on. Tunable
   from the environment because the right number depends on the channel; read
   through config.js so it arrives after dotenv rather than before it. */
const DEPTH = TTS_QUEUE_DEPTH;

const MAX_CHARS = 120;

/* Accounts never read out, whatever they say. KickBot is on nearly every
   channel and it announces follows, subs, hosts and timeouts, which is a
   steady drip of text that is already on screen and is not anybody talking.
   Matched on the lowercased name because the sender arrives as either a
   display name or a slug depending on which chat event carried it. Adding
   another bot here is one line. */
const MUTED_USERS = new Set(['kickbot']);

export function createQueue() {
  const items = [];

  let accepted = 0;
  let rejected = 0;
  let overflowed = 0;
  /* Counted apart from rejected so "the bot is being skipped" and "chat is
     being filtered" stay tellable apart on the status endpoint. */
  let muted = 0;

  return {
    /* Returns true if the message was queued. The only reasons left for a
       false are a muted bot and a message with nothing speakable in it, and
       both are counted so the status endpoint can show them. */
    push(username, text, now = Date.now()) {
      const user = String(username || '').trim();
      if (!user) { rejected++; return false; }

      if (MUTED_USERS.has(user.toLowerCase())) { muted++; return false; }

      const clean = speakable(text);
      if (!clean) { rejected++; return false; }

      /* Ring buffer: when it is full the oldest goes, not the newest. During a
         burst the recent lines are the ones still worth hearing. */
      if (items.length >= DEPTH) { items.shift(); overflowed++; }
      items.push({ user, text: clean, at: now });
      accepted++;
      return true;
    },

    shift() {
      return items.shift() || null;
    },

    get depth() {
      return items.length;
    },

    clear() {
      items.length = 0;
    },

    stats() {
      return { depth: items.length, accepted, rejected, overflowed, muted };
    }
  };
}

/* How a queued message is read out. Kept here next to the sanitiser because
   the two together decide everything the voice ever says.

   The name is only announced when the speaker has changed. Someone typing
   three lines in a row is one person talking, and "ethan says, ethan says,
   ethan says" costs about a second of speech each time for something the
   listener already knows. `lastUser` is whoever was last *spoken*, not
   whoever last posted, so a line dropped by the queue can never make the
   next one lose its name. Compared case-insensitively because the same
   sender arrives as a display name or a slug depending on the chat event. */
export function utteranceFor(item, lastUser = null) {
  const same = lastUser && lastUser.toLowerCase() === item.user.toLowerCase();
  return same ? item.text : `${item.user} says ${item.text}`;
}

/* ── making text speakable ───────────────────────────────────────────────── */

const EMOTE = /\[emote:\d+:([^\]]*)\]/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
/* Bare domains that never had a scheme. Deliberately narrow: it wants
   "kick.com/xqc" but not "e.g." or a decimal number. */
const BARE_DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|tv|gg|io|co|live|link|xyz|me)\b\S*/gi;

/* Returns the speakable form, or '' if there is nothing worth saying. */
export function speakable(raw) {
  let text = String(raw == null ? '' : raw);

  /* Commands are for bots. Checked before anything is stripped, so that
     "!drop" cannot be smuggled in behind an emote or a space. */
  if (/^\s*!/.test(text)) return '';

  /* Emotes read as their name: "[emote:37226:KEKW]" becomes "KEKW", which is
     what the person meant and what everyone else in chat sees. */
  text = text.replace(EMOTE, ' $1 ');

  /* A URL read aloud character by character is thirty seconds of nothing.
     Nobody can type one down off a stream anyway. */
  text = text.replace(URL, ' link ');
  text = text.replace(BARE_DOMAIN, ' link ');

  /* Control characters, zero width joiners and the rest of the invisible
     unicode that gets used to smuggle text past filters. Also strips the
     bidirectional overrides that can reorder what a moderator sees. */
  text = text.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, ' ');

  /* "aaaaaaaaa" and "!!!!!!!!!" are a tone of voice, not nine syllables. Two
     is enough to keep the tone without the reader getting stuck on it. */
  text = text.replace(/(.)\1{2,}/gu, '$1$1');

  text = text.replace(/\s+/g, ' ').trim();

  /* Nothing left worth reading. A message that was only an emoji or only
     punctuation lands here. */
  if (!/[\p{L}\p{N}]/u.test(text)) return '';

  /* And a message that was nothing but a link now reads as the bare word
     "link", which is a thing the reader would say for no reason. "look at
     this link" is worth hearing; "link" on its own is not, so it only counts
     as content when something else survived alongside it. */
  if (!/[\p{L}\p{N}]/u.test(text.replace(/\blink\b/gi, ' '))) return '';

  if (text.length > MAX_CHARS) {
    /* Cut on a word boundary when there is one nearby, so it trails off
       rather than stopping mid-syllable. */
    const cut = text.slice(0, MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    text = (space > MAX_CHARS - 24 ? cut.slice(0, space) : cut).trim();
  }

  return text;
}
