import 'dotenv/config';

/* The one place the ship date lives. Every page and every payment renders it
   from here. Do not invent one: this is the window the FTC mail order rule
   holds you to, and it is stated at the point of sale. */
export const SHIP_DATE = 'January 2027';

/* Text shown wherever a ship date belongs while SHIP_DATE is null. */
export const SHIP_DATE_FALLBACK = 'TBD';

export function shipDateText() {
  return SHIP_DATE || SHIP_DATE_FALLBACK;
}

export const PORT = Number(process.env.PORT || 8787);
export const SITE_URL = process.env.SITE_URL || 'http://localhost:8787';

export const DB_PATH = process.env.DB_PATH || 'data/irlos.db';

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
/* The publishable key is not a secret, but it still comes from the environment
   so the live and test keys are never hard coded into a page. /api/config
   hands it to the checkout form. */
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
export const STRIPE_PRICE_CLOUD = process.env.STRIPE_PRICE_CLOUD || '';
export const STRIPE_PRICE_BACKPACK_FULL = process.env.STRIPE_PRICE_BACKPACK_FULL || '';

export const ADMIN_USER = process.env.ADMIN_USER || '';
export const ADMIN_PASS = process.env.ADMIN_PASS || '';

/* Chat reader. piper with the hfc_female medium voice is the default: it is a
   neural model and sounds like a present day screen reader rather than the
   concatenative mbrola voices, which are recognisably a 1990s sound. espeak-ng
   is kept as the fallback because it is packaged everywhere and needs no model
   file, so the reader still works on a machine where piper is not installed. */
export const TTS_ENGINE = process.env.TTS_ENGINE || 'piper';
/* espeak-ng only. mb-us1 is the US female mbrola voice; mb-us2 and mb-us3 are
   the two males, and all three need their own apt package. */
export const TTS_VOICE = process.env.TTS_VOICE || 'mb-us1';

/* Defaults are the layout piper is installed in on the box, so production is
   right without an env file. Dev machines that put it somewhere else set
   PIPER_BIN and PIPER_MODEL in .env. The binary is the standalone 2023.11.14
   release, which carries its own onnxruntime and espeak-ng-data beside it and
   finds them through an $ORIGIN runpath, so it must be run from its real
   directory rather than copied out of it. */
export const PIPER_BIN = process.env.PIPER_BIN || '/opt/piper/piper';
export const PIPER_MODEL = process.env.PIPER_MODEL ||
  '/opt/piper/voices/en_US-hfc_female-medium.onnx';
/* piper --output_raw is headerless, so unlike espeak there is no header to
   read the rate out of and it has to be declared. Every piper voice states its
   rate in the .onnx.json beside it; hfc_female medium is 22050. */
export const PIPER_RATE = Number(process.env.PIPER_RATE || 22050);
/* Phoneme duration multiplier. Below 1 is faster and above 1 is slower, and
   the model's own default is 1. Here so the reading speed can be tuned with a
   line in /etc/irlos-web.env and a restart rather than a deploy. */
export const PIPER_LENGTH_SCALE = Number(process.env.PIPER_LENGTH_SCALE || 1);

/* How many channels may be read at once. piper holds ~143MB resident per
   session and runs at roughly half of real time on the box's single core, so
   two of them would contend for that core and three would exhaust the memory.
   espeak costs almost nothing by comparison and can afford the old cap. */
/* Messages held for reading, oldest dropped when the queue is full. With no
   spam filtering left this is the only thing that ever drops a message, and
   it is a throughput bound, not a judgement: one voice speaks one line at a
   time in real time, so a deeper queue lengthens the lag rather than reading
   more per minute. */
export const TTS_QUEUE_DEPTH = Number(process.env.TTS_QUEUE_DEPTH || 12);

export const TTS_MAX_SESSIONS = Number(
  process.env.TTS_MAX_SESSIONS || (TTS_ENGINE === 'piper' ? 1 : 8)
);

export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || '';
export const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';

/* Warn loudly at boot about anything that will break a purchase. The server
   still starts so the static site and health check stay up. */
const needed = [
  'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_CLOUD', 'STRIPE_PRICE_BACKPACK_FULL',
  'SITE_URL', 'ADMIN_USER', 'ADMIN_PASS', 'OPERATOR_EMAIL'
];
for (const name of needed) {
  if (!process.env[name]) console.warn(`[config] ${name} is not set`);
}
if (!SHIP_DATE) console.warn('[config] SHIP_DATE is unset, buy controls will say TBD');
