import { spawn } from 'node:child_process';
import { SEAT_KNOWN_HOSTS, SEAT_SSH_KEY } from './config.js';

/* ICP to a seat's irlosd. The GPU host's authorized_keys pins our key to
   `irlosd bridge`, which joins the SSH channel to irlosd's ICP socket, so this
   is plain ICP framing (u32 big-endian length + JSON) over ssh's stdin/stdout.
   One connection per seat, opened on first use, closed after a quiet minute.
   ICP is strictly one request at a time per connection, so requests queue. */

const MAX_PAYLOAD = 16384;
const IDLE_MS = 60_000;

class SeatLink {
  constructor(target) {
    this.target = target;
    this.child = null;
    this.buf = Buffer.alloc(0);
    this.pending = null;
    this.queue = Promise.resolve();
    this.idle = null;
  }

  request(req, timeoutMs = 10_000) {
    const run = () => this.exchange(req, timeoutMs);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async exchange(req, timeoutMs) {
    clearTimeout(this.idle);
    if (!this.child) {
      this.open();
      const hello = await this.send({ op: 'hello', protocol_version: 1 }, timeoutMs);
      if (hello.ok !== true) {
        this.close();
        throw new Error(`handshake refused: ${hello.error?.code}`);
      }
    }
    const resp = await this.send(req, timeoutMs);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    return resp;
  }

  open() {
    const child = spawn('ssh', [
      '-T', '-F', '/dev/null', '-i', SEAT_SSH_KEY, '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${SEAT_KNOWN_HOSTS}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
      '-o', 'LogLevel=ERROR', this.target
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', (d) => console.error(`[seat ${this.target}]`, String(d).trim()));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(new Error('seat connection closed'));
    });
    this.child = child;
    this.buf = Buffer.alloc(0);
  }

  send(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(msg));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('seat did not answer in time'));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(Buffer.concat([head, body]));
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n < 2 || n > MAX_PAYLOAD) return this.close();
      if (this.buf.length < 4 + n) return;
      let msg;
      try {
        msg = JSON.parse(this.buf.subarray(4, 4 + n).toString('utf8'));
      } catch {
        return this.close();
      }
      this.buf = this.buf.subarray(4 + n);
      const p = this.pending;
      this.pending = null;
      if (p) {
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }

  fail(err) {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  close() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    this.fail(new Error('seat connection closed'));
  }
}

const links = new Map();

/* One ICP request to the seat at `target` (an ssh destination, user@host). */
export function icp(target, req) {
  if (!links.has(target)) links.set(target, new SeatLink(target));
  return links.get(target).request(req);
}
