# TASK 5: finish the public site

Complete the customer-facing site. No server access, no database, no Stripe integration code, no knowledge of provisioning required.

Independent of every other task. Run any time.

Branch: `feat/site`. Do not commit to `main`.

Read first: `CLAUDE_CODE_PROMPT.md` sections 7 and 8 for copy rules and design tokens. Reference files: `index-hybrid.html` for the home page, `backpack-3d.html` for the working 3D prototype.

## Boundaries

You may write to: static pages, CSS, client-side JS, the 3D model code, legal pages.

You may not touch: the express app's API routes, the database or migrations, the Stripe integration, the webhook, the worker, the provisioning agent, nginx, or any server. Another agent owns those.

If a page needs data from the API, use the existing endpoints. Do not add new ones.

## Scope

### 1. Placeholders that must be filled

| Placeholder | What it needs |
|---|---|
| `SHIP_DATE` | Ask before guessing. It is a term of sale. |
| `CONTACT_EMAIL` | the ethanmanners.com address |
| `img/adrian.jpeg`, `img/will.jpg`, `img/nick.jpg` | copy from the `IRL.Monster-Website` repo, `assets/images/` |
| `img/og.jpg` | 1200x630 of the backpack. If no photo exists, render one from the 3D model. |
| `.iso` download URL | ask if it does not exist yet |

**Do not invent a ship date.** If it is not supplied, leave the placeholder and ship the backpack section as deposit-only, which is both the honest and the legal position.

### 2. The /backpack page

Integrate `backpack-3d.html`. Extract it to `js/backpack3d.js`, do not rebuild it, do not restyle it.

One change from the prototype: it autoplays on load because it is standalone. On `/backpack` the model sits below the fold, so trigger the sequence the first time the section enters the viewport, once only. A visitor arriving at a finished animation they never saw has been given nothing.

Hold these:

- procedural geometry only. No GLTF, no textures, no bloom. It reads as a technical drawing.
- components stay a data array. Adding or moving one means editing that array, never touching mesh construction.
- labels and the readout are HTML, projected from 3D anchors. Selectable, indexable, screen-reader readable. Never text drawn into the canvas.
- the plain `<dl>` below the canvas is the no-JS fallback, the reduced-motion fallback, and the SEO surface at once. Generate it and the 3D labels from one source so they cannot drift.
- `prefers-reduced-motion` renders the bag already open
- render loop pauses via IntersectionObserver and on `visibilitychange`
- serve Three.js from the site's own origin, not a CDN, so the CSP stays tight

**The internal layout is invented.** Pi at top, battery at bottom, modem and SSD flanking, antennas up the straps. Flag it in your report as needing correction against the real build. Do not silently present a guess as a spec.

**Budget check.** Three.js is roughly 600KB on a page whose buyer is deciding about $1,000, often on a phone. Test on a mid-range Android. If sustained frame rate is under 30, replace the canvas with a static render of the open state and keep the `<dl>`. The page must sell without WebGL.

### 3. Remaining pages

- `/cloud`: what the managed server is, what the control panel does, chat commands. Same design language.
- `/download`: the .iso, its checksum, flashing instructions, hardware compatibility.
- `/terms`, `/refunds`, `/privacy`. Refunds must state the deposit policy: $99 refundable until that customer's build starts.
- `404`, in voice, linking home.

### 4. Copy rules

Non-negotiable. The home page copy went through several passes to remove AI tells and yours must match it.

**Banned:** em dashes anywhere including `<title>`, alt text, and code comments. Three-beat lists that say one thing. Anaphora. "It's not X, it's Y". Performative honesty. The words actually, truly, simply, seamlessly, robust, powerful, cutting-edge, forever. Cute section headers. Exclamation marks.

**Required:** lowercase h1 and h2. Specific numbers over adjectives. Short declaratives, and if a sentence explains the previous sentence, delete one. First person singular where the operator speaks.

Voice reference, in ascending order of authority: the specs section of `index-hybrid.html`, then its package descriptions, then its hero.

### 5. Facts to preserve

- Streamer University: say IRLOS was used there. Never imply the event, Kai Cenat, or any platform endorsed it. Keep the footer disclaimer.
- Will used **IRLOS Cloud** at Streamer University, not a backpack. Adrian bought the first backpack ever built.
- Client names appear only with written permission on file. If permission for one is missing, that row comes out. Ask, do not assume.
- The backpack is single-SIM, single-modem. The specs section keeps saying so.
- Verified numbers: 500+ streams, 99.99% relay uptime. Four streamers. **Do not inflate any of these and do not add new metrics.**
- GPL-3.0. Paying buys assembly, hosting and support, never the right to run the software. Corresponding-source offer reachable from the footer.

## Checks before done

Lighthouse pass. Real mobile device, not a simulator. Keyboard navigation. Reduced-motion. And `grep -c ":"` across every file you touched, which must return zero.

## Deliverable

On `feat/site`: the pages, `js/backpack3d.js`, `SITE_NOTES.md` listing every placeholder still unfilled and every fact needing verification.

## Stop and ask if

- `SHIP_DATE` has not been supplied
- you cannot confirm written permission for a client name
- a client avatar is missing from the old repo
- the .iso does not exist yet
- frame rate on mobile forces the static fallback
