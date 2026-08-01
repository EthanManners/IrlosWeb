# Agent API contract

**Frozen interface.** TASK_1 implements this on the GPU host. TASK_2 builds a mock returning these exact shapes. If either side needs a change, it stops and the change is agreed before continuing. Silent divergence here is the one thing that makes the parallel split fail.

Transport: HTTP over WireGuard. `Authorization: Bearer <token>`. JSON in, JSON out. Reject any request not arriving on the WireGuard interface.

Errors are always `{ "error": "<machine_readable_code>", "detail": "<human string>" }` with an appropriate status. Codes used: `bad_slug`, `at_capacity`, `not_found`, `not_ready`, `unauthorized`, `internal`.

---

## GET /health

```json
{ "ok": true, "agent_version": "0.1.0", "host": "gpu-01" }
```

## GET /capacity

```json
{
  "host": "gpu-01",
  "tenant_max": 4,
  "tenants_active": 1,
  "slots_free": 3,
  "vram_total_mb": 4096,
  "vram_used_mb": 1180,
  "vram_mb_per_tenant": 720
}
```

`tenant_max` is measured, not configured from a guess. See spec section 3.

## POST /provision

```json
{ "slug": "a7f3k2", "stream_id": "a7f3k2_9x2b", "passphrase": "..." }
```

201 on success, 200 if the tenant already exists and is running, which makes it safe to retry:

```json
{ "slug": "a7f3k2", "status": "ready", "studio_port": 4456, "display_num": 11 }
```

`status` is one of `ready`, `starting`, `failed`.

409 `at_capacity` when full. 400 `bad_slug` when the slug fails `^[a-z0-9]{6}$`.

Must be idempotent, must roll back completely on failure at any step, must not leave a half-built tenant.

## GET /status/:slug

```json
{
  "slug": "a7f3k2",
  "status": "ready",
  "units": { "xvfb": "active", "encoder": "active", "bitrate_manager": "active" },
  "uptime_s": 4210,
  "streaming": true,
  "bitrate_kbps": 5800,
  "scene": "live",
  "scenes": ["live", "brb", "starting"],
  "ingest_connected": true
}
```

Note the unit names are **generic**: `xvfb`, `encoder`, `bitrate_manager`. Not `obs`, not `noalbs`. Those are today's implementations of those roles and they are going to be replaced by irlosd. The web app must never learn their real names.

404 `not_found` for an unknown slug.

## POST /control/:slug

```json
{ "action": "set_scene", "args": { "scene": "brb" } }
```

Actions, and only these:

| action | args | effect |
|---|---|---|
| `start` | none | begin streaming to the configured output |
| `stop` | none | stop streaming |
| `set_scene` | `{ "scene": "<name>" }` | switch active scene by name |
| `set_bitrate` | `{ "kbps": 4500 }` | set the encoder target bitrate |
| `get_state` | none | same body as `/status/:slug` |

Response:

```json
{ "ok": true, "state": { ...same shape as /status/:slug... } }
```

409 `not_ready` if the tenant is not up. 400 for an unknown action or a scene name that does not exist.

**Scenes are addressed by name, never by id or UUID.** Names are stable across backends. Anything backend-specific stays inside the agent.

## POST /suspend

```json
{ "slug": "a7f3k2" }
```
```json
{ "slug": "a7f3k2", "status": "suspended" }
```

Stops units, keeps the tenant directory and data, frees VRAM. Idempotent.

## POST /destroy

```json
{ "slug": "a7f3k2" }
```
```json
{ "slug": "a7f3k2", "status": "destroyed" }
```

Stops and disables units, removes the unix user, removes the tenant directory, frees the display number and port. Idempotent: destroying something already gone returns 200.

---

## Rules that make the bootstrap work

1. **This vocabulary is ICP-shaped on purpose.** `start`, `stop`, `set_scene`, `set_bitrate`, `get_state`. When irlosd exists it will speak these concepts natively and the agent becomes a thin passthrough. Today the agent translates them to obs-websocket calls.

2. **Nothing implementation-specific crosses this boundary.** No obs-websocket request names, no scene UUIDs, no OBS profile paths, no noalbs config fields, no port numbers beyond `studio_port` which the web app stores and never interprets. If TASK_2's code contains the string `obs`, something leaked.

3. **The web app never calls the GPU host directly from a browser.** All control traffic goes browser to express to agent.

4. **Adding a field is fine. Renaming or removing one is a contract change** and stops both tasks until agreed.

---

## Mock for TASK_2

TASK_2 builds a mock implementing every endpoint above with in-memory state. It must:

- return `starting` from `/provision`, then flip to `ready` after a configurable delay, so the `/success` polling path gets exercised properly rather than always seeing instant success
- support a failure injection flag so rollback and the `failed` path can be tested
- honour `tenant_max` so the capacity path is reachable
- be selected by an env var, `AGENT_MODE=mock` or `AGENT_MODE=real`, defaulting to real

Keep the mock in the repo after integration. It is how the web app gets tested without a GPU host.
