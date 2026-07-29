import nodemailer from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, OPERATOR_EMAIL } from './config.js';

/* Local postfix on ethanmanners.com. No TLS to localhost, auth only if set. */
const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
});

const FROM = SMTP_USER || `irlos@${SMTP_HOST}`;

/* A failed email must never fail the webhook: Stripe would retry the whole
   event and the order is already stored. Log it and move on. */
async function send(to, subject, text) {
  try {
    await transport.sendMail({ from: FROM, to, subject, text });
    return true;
  } catch (err) {
    console.error(`[mail] send to ${to} failed:`, err.message);
    return false;
  }
}

export function mailCustomer(email, subject, text) {
  return send(email, subject, text);
}

export function mailOperator(subject, text) {
  if (!OPERATOR_EMAIL) {
    console.error('[mail] OPERATOR_EMAIL unset, alert not sent:', subject);
    return Promise.resolve(false);
  }
  return send(OPERATOR_EMAIL, subject, text);
}
