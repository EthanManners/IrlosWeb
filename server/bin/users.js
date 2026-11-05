#!/usr/bin/env node
/* Stream-control accounts and seats. Run on the box as the service user, from
   /opt/irlos-web, so the database stays writable by the service:

     sudo -u irlos node server/bin/users.js seat <name> <user@host>   add or move a seat
     sudo -u irlos node server/bin/users.js add <username> <seat>     new account, prints a temporary password
     sudo -u irlos node server/bin/users.js reset <username>          new temporary password, signs out everywhere
     sudo -u irlos node server/bin/users.js remove <username>
     sudo -u irlos node server/bin/users.js list
*/
import {
  addUser, allSeats, allUsers, removeUser, resetUser, seatByName, upsertSeat
} from '../lib/auth.js';

const [cmd, a, b] = process.argv.slice(2);
const die = (msg) => { console.error(msg); process.exit(1); };

if (process.getuid?.() === 0) die('Run this as the service user: sudo -u irlos node server/bin/users.js ...');

const USERNAME = /^[a-z0-9_.-]{2,32}$/i;

switch (cmd) {
  case 'seat':
    if (!a || !/^[\w.-]+@[\w.-]+$/.test(b || '')) die('usage: seat <name> <user@host>');
    upsertSeat(a, b);
    console.log(`seat ${a} -> ${b}`);
    break;
  case 'add': {
    if (!USERNAME.test(a || '') || !b) die('usage: add <username> <seat>');
    if (!seatByName(b)) die(`no seat named ${b}; add it first with: seat ${b} <user@host>`);
    const password = await addUser(a, b).catch((e) => die(String(e.message)));
    console.log(`${a} created on seat ${b}. Temporary password: ${password}`);
    console.log('They choose their own password the first time they sign in at https://irlos.live/go');
    break;
  }
  case 'reset': {
    const password = await resetUser(a || '');
    if (!password) die(`no user named ${a}`);
    console.log(`${a} reset. Temporary password: ${password}`);
    break;
  }
  case 'remove':
    if (!removeUser(a || '')) die(`no user named ${a}`);
    console.log(`${a} removed`);
    break;
  case 'list':
    console.table(allSeats());
    console.table(allUsers());
    break;
  default:
    die('usage: users.js seat|add|reset|remove|list (see the top of this file)');
}
