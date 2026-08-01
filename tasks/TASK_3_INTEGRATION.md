# TASK 3: integration and end to end proof

Join the two parallel branches, swap the mock for the real agent, and prove a Stripe purchase produces a working tenant with nobody touching anything.

Run this only when TASK 1 and TASK 2 both report done.

Read first: `RECON.md`, `PROVISIONING_SPEC.md`, `CONTRACT_AGENT_API.md`, `AGENT_NOTES.md` (TASK 1), `PROTOTYPE_GAPS.md` (TASK 2).

Access: `ssh WEB` and `ssh GPU`. You are the only task with write access to both at once, which is why nothing else may be running while you work.

## Order of work

### 1. Contract audit, before merging anything

Compare TASK 1's real agent against TASK 2's mock, endpoint by endpoint, against `CONTRACT_AGENT_API.md`. Any divergence in field names, status codes, or error shapes gets found here, not at the first live purchase.

Then grep TASK 2's branch for leaked implementation detail: `obs`, `websocket`, `noalbs`, `scene_uuid`, `sceneName`. Anything found is a contract leak and gets fixed before merge.

**Report divergences before fixing them.** If the two sides disagree, which one is correct is a decision, not a cleanup.

### 2. Merge

Merge `feat/gpu-agent` and `feat/web-pipeline` into an integration branch. Resolve conflicts. The two should barely overlap by design, so heavy conflicts mean someone worked outside their boundary and that is worth reporting.

### 3. Real numbers

Update the `hosts` row for gpu-01 with the measured `vram_mb_per_tenant` and `tenant_max` from `AGENT_NOTES.md`. TASK 2 left placeholders.

### 4. Wire it up

- WireGuard up and stable between the boxes
- `AGENT_MODE=real`, agent address and bearer token in `/etc/irlos-web.env`, mode 600
- from WEB, curl the agent's `/health` and `/capacity` through the express app's client code, not just directly. The client is what has to work.
- one deliberate `systemctl restart irlos-web`. Then confirm the public site, the existing order flow, and the existing relay are all still fine.

### 5. Stripe test mode

Test products and prices. A **new, separate** test webhook endpoint pointing at `https://irlos.live/api/webhook`. Do not touch the live endpoint or any live product.

Send a test event from the dashboard first and confirm a 200. A 400 here is almost always the raw body problem, where `express.json()` consumed the body before the webhook route could verify the signature.

### 6. The end to end run

Buy Cloud with `4242 4242 4242 4242`. Watch the whole path. Verify every one of these:

- webhook returned 200 in under a second
- the job moved `queued` to `running` to `done`
- a tenant exists on GPU with all units active
- `/success` showed real progress rather than a spinner, and landed on ready
- the ingest URL rendered on `/success` actually works: push to it with ffmpeg and confirm the source appears in that tenant's OBS
- the control page shows live state, and start, stop, and scene switching all work
- VRAM moved by roughly the measured per-tenant delta
- **existing customer instances and the relay were never disturbed at any point**

### 7. Failure paths

A prototype that only works on the happy path is not proven.

- inject an agent failure, confirm the job retries on schedule and ends `failed`, and that `/success` shows failed rather than hanging
- restart `irlos-web` mid-provision, confirm the stale job reaper requeues it and provisioning completes
- replay the same Stripe event, confirm no second tenant
- provision until `tenant_max` is reached, confirm 409 `at_capacity` and that the job goes `blocked` rather than `failed`

### 8. Clean up

Destroy the test tenants. Confirm the GPU host is back to its starting state plus the agent. Leave the Stripe test objects in place, they are useful.

## Deliverables

Merged to `main`. Plus `PROVISIONING.md` covering: what was actually built, the real architecture as deployed rather than as specified, every divergence from the spec with the reason, the measured capacity numbers, how to run the end to end test again, and how to roll the whole thing back.

Consolidate `TEARDOWN_GPU.md` and anything from TASK 2 into one `TEARDOWN.md` that works top to bottom.

Update `PROTOTYPE_GAPS.md` with everything still missing before this can take real money: capacity gating, email, accounts, suspend and destroy, chat commands.

## Stop and ask if

- the real agent and the mock diverge in a way that means one side built the wrong thing
- merge conflicts suggest either task worked outside its boundary
- the end to end run fails in a way that implicates the architecture rather than a bug
- anything disturbs the relay or an existing customer instance, at which point stop immediately and report before doing anything else
- you need to change the relay config

Do not paper over a divergence to get a green run. A prototype that passes because the test was bent proves nothing.
