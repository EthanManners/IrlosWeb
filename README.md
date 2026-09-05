# irlos-web

The production site for [irlos.live](https://irlos.live): static pages served by nginx, plus a small Express server for Stripe Checkout, the webhook, and the admin page. GPL-3.0.

## layout

```
public/     static site: html, css, js, vendored three.js
server/     express app on 127.0.0.1:8787, /api and /admin
server/tts/ the chat reader: paced mixer, mp3 encoder, listener fan-out
deploy/     systemd unit and nginx config
reference/  the design drafts the site was built from
```

## local dev

Needs Node 20+, plus `build-essential` and `python3` for the `better-sqlite3` native build.

```
cp .env.example .env      # fill in Stripe test keys
npm install
npm run dev               # serves the whole site on http://localhost:8787
```

The express server serves `public/` directly in dev, so nginx is not needed locally. The SQLite database appears at `data/irlos.db` on first run.

### stripe

Create three prices in the Stripe dashboard (test mode first) and put their ids in `.env`:

- `STRIPE_PRICE_CLOUD`: $30/month recurring
- `STRIPE_PRICE_BACKPACK_FULL`: $1,000 one time
- `STRIPE_PRICE_BACKPACK_DEPOSIT`: $99 one time

Then forward webhooks:

```
stripe listen --forward-to localhost:8787/api/webhook
```

`stripe listen` prints a `whsec_...` secret. That is your `STRIPE_WEBHOOK_SECRET` for local dev. Pay with card `4242 4242 4242 4242` and watch the webhook return 200, the order land in `data/irlos.db`, and both emails go out (needs a local SMTP listener, or read the `[mail]` log lines).

The Billing Portal needs its configuration saved once in the Stripe dashboard (Settings, Billing Portal) or `/api/portal` will 400.

## chat reader (`/tts`)

Reads a Kick channel's chat aloud at `/tts`, as one continuous MP3 stream so it
survives an iPhone locking. Routes:

```
GET  /tts                     the page
GET  /tts/stream/:slug.mp3    the audio
GET  /tts/api/status/:slug    session state
GET  /tts/api/capacity/:slug  whether that channel would be refused a session
POST /tts/api/skip/:slug      skip the current utterance
```

It is a stream rather than a series of clips because iOS Safari suspends Web
Audio, Web Speech and any JS that would advance a playlist the moment the
screen locks. One `<audio>` element on an unbroken stream started by a tap is
the only thing that keeps running, so the server emits a timeline that never
ends and never gaps, dead chat included.

A session is one channel: a Kick websocket, a message queue, a long-lived
speech child, a mixer paced to a self-correcting 20ms deadline, an ffmpeg
encoder, and the set of responses being written to. It is built on the first
listener and dropped five minutes after the last one leaves.

The mixer and encoder start before the chatroom is even looked up. A bad
channel name, a Cloudflare challenge or a dead websocket all show up as silence
on a stream that is still running, never as a stream that fails to start: a
phone that is already playing keeps playing, and one that never started cannot
be restarted without another tap.

There is no spam filtering: no dedupe, no per-user rate limit, no language
filter. The channel wants a hectic chat, so everything anybody types is read.
Bot commands and links are skipped and emotes read as their name, all in
`speakable()` in `server/tts/queue.js`, which is about text that does not
survive being read aloud rather than about who is allowed to talk.

The one bound left is depth. A voice speaks one line at a time in real time,
so above roughly one message every three seconds the queue is what decides
what gets heard: it holds `TTS_QUEUE_DEPTH` messages (12) and drops the
oldest, so the reader stays current instead of narrating the past. Raising it
does not read more messages per minute, it only lengthens the lag before the
same overflow happens.

A run of messages from one person is announced once: `utteranceFor()` prefixes
`{user} says` only when the speaker has changed since the last line actually
spoken. Besides being what a listener wants, it is throughput — the prefix is
about a second of speech.

### the voice

**piper** with the **hfc_female medium** voice, which is a neural model and
sounds like a current screen reader rather than the 1990s concatenative sound
of the mbrola voices it replaced. Not packaged: it is the standalone
`2023.11.14` release, unpacked whole into `/opt/piper`, with the voice beside
it.

```
mkdir -p /opt/piper/voices
curl -L https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
  | tar xz -C /opt
curl -L -o /opt/piper/voices/en_US-hfc_female-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx
curl -L -o /opt/piper/voices/en_US-hfc_female-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json
apt install ffmpeg
```

Unpack it whole and leave it there. The binary finds its bundled onnxruntime
and `espeak-ng-data` through an `$ORIGIN` runpath, so copying `piper` out on
its own gives a binary that will not start. `PIPER_BIN` and `PIPER_MODEL`
default to those paths, so the box needs no environment for this; a dev machine
that installs elsewhere sets both in `.env`.

Measured on the box, which is one core and 969MB shared with two other sites:
**1.4s to load the model, then a real-time factor of 0.50**, 143MB resident
warm and 226MB at the peak of loading. That is comfortable for one session and
nothing like comfortable for two, so `TTS_MAX_SESSIONS` defaults to **1** under
piper and 8 under espeak. It caps concurrent *channels*; listeners on one
channel share its session and are capped separately at 20.

Reading speed is `PIPER_LENGTH_SCALE`, below 1 faster and above 1 slower.
Like `TTS_VOICE`, it is read from `/etc/irlos-web.env`, so changing it is one
line and `systemctl restart irlos-web` rather than a deploy.

A cap of one makes being refused a normal outcome rather than a corner case,
and a refusal is indistinguishable from a dropped network at the media element:
both are an `error` event and nothing else. So the page asks
`/tts/api/capacity/:slug` after a failure and says which one it was. That route
reserves nothing, because asking must not take the slot the caller wants, and
it answers `refused` rather than `full`: a channel that already has a session
is let in regardless of the count, which is the case of a listener reconnecting
to the channel they were already on.

`TTS_ENGINE=espeak-ng` is still there as the fallback, needs no model file, and
costs almost nothing to run:

```
apt install espeak-ng mbrola mbrola-us1 mbrola-us2 mbrola-us3
```

The mbrola voices are in multiverse, and `TTS_VOICE` picks between them:
`mb-us1` female, `mb-us2` and `mb-us3` the two males. `espeak-ng --voices=mb`
lists what is actually installed.

The only npm addition is `ws`, because `globalThis.WebSocket` does not exist on
the Node 20 the box runs, so the built in one would work in dev and throw in
production.

nginx buffers proxied responses by default, which puts tens of seconds of
latency on the stream, so `/tts/stream/` and `/tts/api/` have their own blocks
in `deploy/nginx.conf` with `proxy_buffering off`. Both are `^~` because a
regex location beats a plain prefix, and the extension matches further down the
file would otherwise get a say. `/tts/api/` needs its own block because
`location /api/` does not match a path that starts with `/tts`.

Three gotchas worth knowing before changing anything in here. Pusher delivers
the chat payload as a JSON-encoded *string* inside `data`, so it needs decoding
twice; read it once and every message looks empty. And the speech child emits
one continuous PCM stream with nothing in the bytes marking where one line ends
and the next begins, which is why exactly one line is ever in flight, and why
the end of a line has to be inferred from the child going quiet.

Where that inference happens is the whole latency story. It used to happen on
the quiet gate, so every message waited out the full gate before its first word
even though the first pipe read had already delivered about 1.5s of audio.
Now playback starts on a 250ms jitter buffer, the gate is per engine (150ms for
piper, 400ms for espeak, which genuinely does trickle), and whether the line has
*ended* is decided in `read()` at the moment the buffer runs dry, when all three
of "nothing written and awaited, nothing pending, quiet since" are actually
known. Deciding late is what makes the short gate safe. With the model also
loaded up front by `speech.warm()` instead of in front of the first message,
mean time to first audio on the box went from 2090ms to 1241ms.

One consequence worth keeping: a line whose first sentence is very short, like
`lol. what about the battery?`, will underrun between the two, because `lol.`
finishes playing while sentence two is still being inferred. It is audible as a
slightly long beat at the full stop and never as a glitch mid-word, since
sentences are the unit handed to piper. `stranded` on the status endpoint counts
audio that arrived with no line in flight, which outside of a skip means a
boundary was called wrong and a message lost its tail.

That inference is the third one, and it is why a line is handed to piper one
sentence at a time. piper infers a sentence at a time and emits each in a
burst, so the gap between two sentences of one message is however long the
second takes to infer, which at a real-time factor of 0.5 is seconds and looks
exactly like the end of the message. Write a whole line at once and
`lol. what about the battery?` plays `lol.`, runs dry while sentence two is
still being inferred, finalises, and discards the rest: the message is
truncated and nothing reports it. Measured, not theoretical — `first. second.
third. fourth. fifth.` came out as 2.5s of audio instead of 4.7s. espeak is
fast enough that a whole line clears one 400ms window, so it is still written
whole.

## deploy

Target: one box with nginx, node, postfix.

```
rsync repo to /opt/irlos-web, then on the box:
cd /opt/irlos-web && npm install --omit=dev
cp deploy/irlos-web.service /etc/systemd/system/
   # create /etc/irlos-web.env, mode 600, from .env.example with live values
cp deploy/nginx.conf /etc/nginx/sites-available/irlos.live
ln -s ../sites-available/irlos.live /etc/nginx/sites-enabled/
certbot --nginx -d irlos.live
useradd -r irlos && mkdir -p /opt/irlos-web/data && chown irlos: /opt/irlos-web/data
systemctl daemon-reload && systemctl enable --now irlos-web
nginx -t && systemctl reload nginx
curl https://irlos.live/api/health   # {"ok":true}
```

Point a production webhook endpoint (dashboard, `checkout.session.completed`) at `https://irlos.live/api/webhook` and put its signing secret in `/etc/irlos-web.env`.

## open items, blocking launch

1. **SHIP_DATE is unset.** Set the real ship window in `server/lib/config.js`. Every page and Checkout session renders it from there; until it is set, buy controls say TBD. Do not launch backpack sales without it: without a stated date the FTC Mail Order Rule defaults to 30 days.
2. **Contact email.** `CONTACT` in `public/js/chrome.js` is a placeholder. Set the real address.
3. **ISO release.** `public/download/index.html` has `ISO_URL` and `ISO_SHA256` placeholders for the real release link and checksum.
4. **Images.** `public/img/` needs `adrian.jpeg`, `will.jpg`, `nick.jpg` (avatars from the old repo) and `og.jpg` for link previews. Client names stay only with written permission on file.
5. **Backpack internals are an invented layout.** Positions, dimensions and explode vectors in the `PARTS` array in `public/js/backpack3d.js` must be corrected against the real build, and the component descriptions are placeholders to rewrite.
6. **Policy copy review.** `/terms/` and `/refunds/` state conservative defaults (cancel before ship for full refund, subscription runs to period end). Confirm they match what you actually offer.
7. **Real device pass.** Lighthouse 95+ on `/` and `/backpack`, and the backpack page held at 30fps on a mid-range Android. If it cannot, swap the canvas for a static render of the open state and keep the `<dl>`.
