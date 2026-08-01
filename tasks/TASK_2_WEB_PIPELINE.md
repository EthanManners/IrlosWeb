# TASK 2: web pipeline and control page

Build the whole customer-facing path from Stripe webhook to a working control page. **You will not touch either server's infrastructure and you do not need the GPU host to exist.** You build against a mock agent.

Read first: `PROVISIONING_SPEC.md`, `CONTRACT_AGENT_API.md`.

Branch: `feat/web-pipeline`. Do not commit to `main`.

## Why there is a mock

Another agent is building the real agent on the GPU host in parallel. `CONTRACT_AGENT_API.md` is frozen, so both sides can be built at once and joined later. You implement a mock returning exactly those shapes, develop against it, and a third task swaps in the real one.

**Do not change the contract.** If something in it does not work for you, stop and say so rather than adjusting it, because the other agent is building to the same document.

## Boundaries

You may write to: the express app, its migrations, its routes, its static pages, its tests. All on `feat/web-pipeline`.

You may not touch: the GPU host, WireGuard, nginx config, the sls relay, TLS, DNS, systemd units, or the live Stripe webhook endpoint. You may not `systemctl restart irlos-web` on the production box. Develop locally or in a dev copy.

## Scope

### 1. The mock agent

Implements every endpoint in the contract with in-memory state. Selected by `AGENT_MODE=mock`, defaulting to `real`.

It must:

- return `starting` from `/provision`, then flip to `ready` after a configurable delay, so the polling path is genuinely exercised instead of always seeing instant success
- support failure injection so the rollback and `failed` paths can be tested
- honour `tenant_max` so the capacity path is reachable
- stay in the repo permanently. It is how this app gets tested without a GPU host.

### 2. Migration

Additive. `users`, `hosts`, `tenants`, `jobs` per spec section 4. **`orders` is untouched**, it has real data in it.

Seed `hosts` with a gpu-01 row. Leave `tenant_max` as a placeholder and note it: TASK 1 measures the real number.

### 3. Webhook

`checkout.session.completed` upserts the user, inserts a `provisioning` tenant with a random 6-character slug, enqueues a provision job, returns 200. **It must not call the agent inline.** Stripe retries anything slow, and a retry landing mid-provision creates two tenants for one customer.

Idempotent on `event.id` and on `stripe_subscription_id`.

### 4. Worker

Polls `jobs` every second. Backoff on failure: 2s, 10s, 60s, 300s, then `failed`.

**Stale job reaper:** on boot and every 60 seconds, any `running` job older than 5 minutes returns to `queued` with `attempts` incremented. The worker shares a process with the web app, so a restart mid-provision otherwise strands a paying customer forever.

### 5. Status endpoint and /success

`GET /api/provision/:session_id` returns `queued`, `provisioning`, `ready`, or `failed`, plus the ingest URL when ready.

`/success` polls it and shows real state at each stage. Never a bare spinner. When ready, render the ingest URL, the stream credentials, and a link to the control page.

Credentials keyed by `session_id` is a prototype shortcut, not a launch pattern. Record it in `PROTOTYPE_GAPS.md`.

### 6. Control page

Plain and functional, using the existing design tokens. No new design work.

Shows: connection state, current bitrate, current scene, uptime. Controls: start, stop, switch scene.

Every call goes browser to express to agent `/control/:slug`. The browser never talks to the GPU host directly.

## The rule that makes this worth building

**Nothing implementation-specific may appear in your code.** No obs-websocket request names, no scene UUIDs, no OBS paths, no noalbs config fields. Scenes are addressed by name. Unit states are `xvfb`, `encoder`, `bitrate_manager`.

If the string `obs` appears anywhere in your code outside a comment, something leaked and the bootstrap is broken. irlosd is going to replace the agent's internals, and when it does, nothing you wrote should need changing.

## Out of scope

- capacity gating and waitlists. Build `GET /api/capacity` reading from `hosts`, but do not gate the buy button yet.
- transactional email, password reset, login links
- suspend and destroy flows, retention timers
- billing portal, plan changes
- visual design work

## Tests

Not optional, since the mock makes them cheap:

- webhook returns 200 in under a second and does not call the agent
- duplicate `event.id` is a no-op
- worker provisions, and a replay finds the existing tenant
- injected failure marks the job `failed` after the backoff schedule
- a job stuck in `running` is reaped and requeued
- `/api/provision/:session_id` reports each state correctly
- control actions reach the agent with the right shape

## Deliverables

On `feat/web-pipeline`: the migration, the webhook handler, the worker, the mock agent, the real agent client, `/api/provision/:session_id`, `/api/capacity`, `/success`, the control page, tests, and `PROTOTYPE_GAPS.md` listing every shortcut taken and what production needs instead.

## Stop and ask if

- something in `CONTRACT_AGENT_API.md` does not work. Do not amend it.
- the existing `orders` table or schema conflicts with the migration
- you need to touch the production box for any reason
- you find yourself needing to know how OBS or noalbs work. That is a signal the contract is leaking, and it is worth surfacing rather than working around.
