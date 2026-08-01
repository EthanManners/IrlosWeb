# IRLOS Cloud: automatic provisioning

Goal: a customer pays, and within roughly thirty seconds they have a running stream server, an OBS instance with default scenes, a pull from the relay, and a page where they can control it. No human in the loop.

**irlosd does not exist yet.** This provisions the stack that runs in production today, behind an interface shaped like ICP, so irlosd can replace the internals later without the web app noticing. Section 7 covers that.

---

## 1. End to end

```
Stripe checkout.session.completed
  -> WEB: verify signature, write order, enqueue provisioning job, return 200   (<1s)
  -> worker: pick up job, pick a host with free capacity, call that host's agent
  -> gpu-01 agent: allocate tenant, write configs, start units, report ready
  -> WEB: mark active, render credentials and ingest URL
  -> customer: control page shows live state, start, stop, scene switching
```

The customer sits on `/success`, polling `/api/provision/:session_id`, seeing real state: queued, provisioning, ready. Never a spinner with no information.

---

## 2. Topology

Settled, and it matches what already runs in production.

```
streamer --SRT push--> WEB (sls relay, public ingest)
                        |
                        +--SRT pull--> gpu-01 tenant OBS
tenant OBS --RTMP push--> twitch / kick
```

The streamer pushes to the relay on WEB. The tenant's OBS on gpu-01 **pulls** from that relay as an SRT caller. Consequences:

- **gpu-01 needs no public ingest ports and no public management surface.** The only public ingest is the relay on WEB, which already exists with customers pointed at it. Nothing about the customer-facing connection changes.
- One public ingest hostname forever, even as GPU hosts are added. When the relay moves to its own VPS, tenants follow by changing a pull URL, not by re-onboarding customers.
- The pull currently crosses the public internet. Move it inside WireGuard during this work. It takes tenant media off the public path for free, since the tunnel has to exist for the agent anyway.

### Provisioning is two-sided

A tenant needs a stream slot on the **relay** as well as a pull on the GPU host, so provisioning touches WEB, not only gpu-01.

**Adding a tenant must never restart the relay.** A restart drops every live customer on it. Before writing provisioning code, establish whether sls accepts a new stream id without a restart. If it does not, do not solve it with a reload. Two workable answers:

1. Configure the relay with an app that accepts any stream id, and treat the stream id itself as the tenant secret. Routing and authorization live in the database and at the pull side, and no relay config changes at provision time.
2. Pre-allocate a block of stream slots during a maintenance window and hand them out from the database as tenants arrive. Slower to scale, zero runtime risk.

Option 1 is better if sls supports it. Verify, do not assume.

### Machine roles

Build for more than one GPU host from the start.

```
WEB      nginx, express, sqlite, stripe, sls relay. Public.
gpu-01   per-tenant OBS. No public surface. Reached over WireGuard only.
```

```
wg0: 10.44.0.1  WEB
     10.44.0.11 gpu-01
```

The agent listens on `10.44.0.11:9443` only, bearer token per host, public interface denied.

Do not put an SSH key on WEB that can run commands on a GPU host. WEB is internet-facing and runs a payment integration. A six-endpoint agent is a far smaller blast radius than a shell.

---

## 3. Capacity: VRAM, not encoder sessions

gpu-01 is a GTX 1650, which changes the binding constraint.

TU117, 4GB VRAM, Volta-generation NVENC rather than Turing. Encode quality is around Pascal level, irrelevant here since Twitch and Kick both take H.264. The 2020 GDDR6 refresh put some 1650s on TU106 and TU116 dies with the newer Turing encoder, so confirm which die this one is.

**4GB of VRAM is the ceiling, not the 8-session NVENC cap.** Each tenant runs its own Xvfb display plus an OBS instance holding scene textures, compositing buffers, and an encoder session, with driver overhead taken off the top first. Realistic answer is 3 to 5 tenants, and the session limit is never reached.

So capacity is measured, not assumed:

1. During the first hand-provision, record total VRAM used before and after. That delta is the per-tenant cost.
2. `hosts.tenant_max` is `(usable VRAM - headroom) / delta`, rounded down, leaving one slot free.
3. Store `vram_mb_per_tenant` on the host row so the number is visible rather than folklore.

Business consequence, because it changes pricing: four tenants at $30 is $120 a month against an $83 box. Thin, not the comfortable margin a session-count model implies. Two complementary ways out. More VRAM raises density far more than a better encoder does. And **relay-only tenants consume no GPU at all**, since passthrough with no re-encode never touches the card, so that tier packs almost without limit and is where the density actually lives.

Whatever the number is, the buy button closes when the last slot goes. Selling instant delivery that cannot be delivered instantly breaks the only promise this product makes.

---

## 4. Schema

The database has `orders` only today. Additive migration, `orders` untouched.

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  stripe_customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE hosts (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,          -- gpu-01
  wg_addr TEXT NOT NULL,              -- 10.44.0.11
  agent_token_ref TEXT NOT NULL,      -- env var NAME, never the token
  tenant_max INTEGER NOT NULL,        -- measured, see section 3
  vram_mb_per_tenant INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tenants (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,          -- 6 chars, becomes unix user and unit name
  user_id INTEGER NOT NULL REFERENCES users(id),
  host_id INTEGER REFERENCES hosts(id),
  stripe_subscription_id TEXT UNIQUE,
  stream_id TEXT UNIQUE,              -- relay stream id, also the tenant secret
  passphrase TEXT,
  studio_port INTEGER,                -- obs-websocket, loopback only
  display_num INTEGER,                -- Xvfb
  status TEXT NOT NULL,               -- provisioning | active | suspended | destroyed
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- provision | suspend | destroy
  tenant_id INTEGER REFERENCES tenants(id),
  payload TEXT NOT NULL,
  status TEXT NOT NULL,               -- queued | running | done | failed | blocked
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Never store an agent token in the database. Store the name of the env var holding it.

---

## 5. The webhook does not provision

It writes a job and returns. Stripe expects 200 within a few seconds and retries otherwise, so a webhook that waits on a machine spinning up gets retried mid-provision and you end up with two tenants for one customer.

```
POST /api/webhook
  checkout.session.completed
    if event.id already seen -> 200, stop
    upsert user by email + stripe_customer_id
    insert tenant (status: provisioning, slug: random 6 chars)
    insert job (kind: provision)
    return 200
```

A worker loop, same process is fine at this scale, polls `jobs` every second. Backoff on failure: 2s, 10s, 60s, 300s, then `failed` plus an alert. Jobs are idempotent and keyed on `stripe_subscription_id`, so a replay finds the existing tenant and does nothing.

**Stale job reaper.** The worker shares a process with the web app, so a restart mid-provision leaves a job stuck in `running` with nothing polling it. On boot and every 60 seconds after, move any `running` job older than 5 minutes back to `queued` and increment `attempts`. Without this, one deploy at the wrong moment silently strands a paying customer.

**Agent reconcile.** Rollback inside `/provision` only helps if the agent process survives to run it. On agent start, compare `/srv/irlos/tenants/*` against running `irlos-tenant@*` targets. Any tenant directory with no running target is an orphan from a crash. Report it, do not silently delete it.

---

## 6. Agent API

Small, boring, and the only thing WEB can ask for.

```
POST /provision      { slug, stream_id, passphrase }  -> { studio_port, display_num, status }
POST /suspend        { slug }                         -> { status }
POST /destroy        { slug }                         -> { status }
GET  /status/:slug                                    -> { status, units, uptime, bitrate, scene }
POST /control/:slug  { action, args }                 -> { ok, state }
GET  /capacity                                        -> { tenant_max, tenants, vram_used_mb }
GET  /health                                          -> { ok: true }
```

Bearer token in `Authorization`. Reject anything not arriving on the WireGuard interface. Rate limit. Log every call with the slug.

`/provision` is idempotent: an existing slug with running units returns its existing allocation with `status: ready` rather than erroring.

---

## 7. What actually gets provisioned, and the irlosd bootstrap

irlosd is not written. The prototype provisions the stack from the production diagram, per tenant:

```
relay on WEB  --SRT pull-->  OBS  --RTMP-->  twitch / kick
                              ^
                              |
                          noalbs (bitrate management)
```

Per tenant on gpu-01:

- **Xvfb** on its own display number. OBS on Linux wants a display server.
- **OBS** with a per-tenant profile and scene collection, obs-websocket bound to `127.0.0.1` on an allocated port. Scene collection template has the tenant's SRT pull URL substituted in.
- **noalbs** with a per-tenant config, reading publisher bitrate from the relay's stats endpoint and driving OBS through obs-websocket.

Units, all instanced on `%i`:

```
irlos-xvfb@.service      virtual display
irlos-obs@.service       Requires + After irlos-xvfb@%i
irlos-noalbs@.service    Requires + After irlos-obs@%i
irlos-tenant@.target     wants all three, this is what gets enabled and started
```

Harden each: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `ReadWritePaths=/srv/irlos/tenants/%i`, plus `MemoryMax` and `CPUQuota` so one tenant cannot starve the others.

Per tenant also: unix user `irlos_<slug>`, no shell, home `/srv/irlos/tenants/<slug>`, member of `video` and `render` for `/dev/dri`.

```
/srv/irlos/tenants/<slug>/
  obs/                 profile + scene collection
  noalbs/config.json
  recordings/
  logs/
```

### The bootstrap that matters

**Define `/control/:slug` in ICP terms now, and implement it against obs-websocket today.**

The web app and the control page speak only the agent's vocabulary: `start`, `stop`, `set_bitrate`, `set_scene`, `get_state`. Whether that reaches OBS through obs-websocket or reaches irlosd through a Unix socket is the agent's private business.

When irlosd exists, it absorbs noalbs and the OBS control path, `irlos-noalbs@.service` disappears, `irlosd@.service` appears, and the agent's internals change. The web app, the database, and the control page do not change at all. That is what makes this a bootstrap rather than a throwaway.

Do not let obs-websocket concepts leak into the web app or the database. No scene UUIDs, no obs-websocket request names, no port numbers in API responses beyond what the agent needs internally. The moment they leak, replacing the backend means rewriting the frontend.

---

## 8. Provisioning steps, in order

The agent runs these. Any failure rolls back everything before it, so a half-built tenant never lingers.

1. Validate slug against `^[a-z0-9]{6}$`. It becomes a unix username and a systemd unit name, so it is never interpolated unvalidated.
2. Check capacity against measured VRAM. Refuse with 409 rather than overcommit.
3. Allocate the lowest free display number and obs-websocket port.
4. `useradd -r -M -d /srv/irlos/tenants/<slug> -s /usr/sbin/nologin irlos_<slug>`, add to `video` and `render`.
5. Create the directory tree, chown, mode 750.
6. Render the OBS profile and scene collection from templates, substituting the SRT pull URL built from stream id and passphrase.
7. Render the noalbs config, substituting the relay stats endpoint and the obs-websocket port.
8. `systemctl enable --now irlos-tenant@<slug>.target`
9. Poll until OBS answers on obs-websocket and noalbs is running. Timeout 45s.
10. Return the allocation.

Rollback: stop and disable the target, `userdel`, remove the directory, free the display and port.

---

## 9. What the customer gets

Rendered on `/success` as soon as the agent reports ready:

- their ingest URL, pointing at the relay on WEB, with stream id and passphrase
- a link to the control page

The control page shows connection state, current bitrate, current scene, uptime, and offers start, stop, and scene switching. Every call goes to the agent's `/control/:slug`. The browser never talks to gpu-01 directly.

---

## 10. Cancellation

`customer.subscription.deleted` enqueues `suspend`, not `destroy`. Stop the units, keep the data, free the VRAM, mark `suspended`. A destroy job runs 30 days later.

State the 30 day window in the terms, on the cancel confirmation, and in the cancellation email. A customer who cancels by accident and loses their scene collection the same hour is a refund and a bad review. One who gets it back is a resubscribe.

`invoice.payment_failed` suspends only after Stripe finishes its retry schedule, not on the first failure.
