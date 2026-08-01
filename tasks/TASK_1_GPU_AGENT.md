# TASK 1: GPU host and the provisioning agent

Build the machine side. You own the GPU host and the WireGuard link between the two boxes. Another agent is building the web side in parallel against a mock of your API, so **`CONTRACT_AGENT_API.md` is binding**. Implement it exactly.

Read first: `RECON.md` (from TASK 0), `PROVISIONING_SPEC.md`, `CONTRACT_AGENT_API.md`.

Access: `ssh GPU`, and `ssh WEB` **only** for the WireGuard peer config and to curl your own endpoints for verification.

Branch: `feat/gpu-agent`. Do not commit to `main`.

## Boundaries

You may write to:

```
GPU: /opt/irlos-agent/
     /srv/irlos/tenants/
     /etc/systemd/system/irlos-{xvfb,obs,noalbs}@.service
     /etc/systemd/system/irlos-tenant@.target
     /etc/systemd/system/irlos-agent.service
     /etc/irlos-agent.env
     unix users matching irlos_*
     one additive ufw rule
BOTH: WireGuard config
```

You may not touch: the express app, nginx, the sls relay or its config, existing customer OBS instances, existing unix users, existing systemd units, ufw default policy or any existing rule, DNS, TLS.

Before editing any existing file: `cp path path.bak.$(date +%s)` and report it.

Write `TEARDOWN_GPU.md` as you go, appending the exact undo command for everything you create, in reverse order.

## irlosd does not exist

Do not try to run it, build it, or depend on it. You are provisioning the stack that exists today: Xvfb, OBS with obs-websocket, noalbs. Spec section 7 covers it.

**The thing that must be right:** your `/control/:slug` and `/status/:slug` responses use the generic vocabulary from the contract. `encoder`, not `obs`. `bitrate_manager`, not `noalbs`. Scenes by name, never by UUID. obs-websocket exists only inside your process. When irlosd replaces these internals later, your API does not change.

## Phase A: WireGuard and agent skeleton

WireGuard between WEB and GPU, using the range from `RECON.md`. Agent at `/opt/irlos-agent`, bound to the WireGuard address only. Bearer token in `/etc/irlos-agent.env`, mode 600, root owned. `irlos-agent.service` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`.

Implement `/health` and `/capacity` only. `/capacity` reports real measured VRAM, not constants.

One additive ufw rule allowing the agent port on `wg0`. Never change the default policy.

**CHECKPOINT A.** From WEB, curl both endpoints across the tunnel and show the output. Show that the agent port is closed on the public interface. Stop and wait.

## Phase B: provision one tenant by hand

The phase that determines whether the rest works. Manual commands, not a script. Slug `test01`.

Follow spec section 8: unix user, directory tree, OBS profile and scene collection rendered from templates with the SRT pull URL substituted, noalbs config with the relay stats endpoint and obs-websocket port, systemd units, start, verify.

**Record total VRAM before and after.** That delta is `vram_mb_per_tenant` and it sets `tenant_max` for this host. It is the number the business runs on, so measure it properly rather than estimating.

Done means:

- `irlos-tenant@test01.target` active, with Xvfb, OBS, and noalbs all running
- OBS answering on obs-websocket, loopback only
- a real push to the relay appears as a source in that tenant's OBS. Push with ffmpeg, a testsrc over SRT is fine
- noalbs reading publisher bitrate from the relay stats endpoint
- existing customer instances untouched, processes still up, VRAM moved by exactly your delta

Record every command in order in `PROVISION_TRANSCRIPT.md`.

**CHECKPOINT B.** Show the transcript, the VRAM delta, and verification output. Stop and wait. This transcript is the contract for phase C.

## Phase C: the full agent

Turn the transcript into the remaining endpoints: `/provision`, `/status/:slug`, `/control/:slug`, `/suspend`, `/destroy`.

Requirements:

- slug validated against `^[a-z0-9]{6}$` before it reaches any shell. It becomes a unix username and a systemd unit name, so never interpolate it unvalidated.
- `/provision` idempotent: existing slug with running units returns its allocation and 200, does not error
- complete rollback on failure at any step. Stop and disable the target, `userdel`, remove the directory, free the display and port.
- readiness polling with a 45 second timeout
- **reconcile on start:** compare `/srv/irlos/tenants/*` against running `irlos-tenant@*` targets. Report orphans from a crashed provision. Never auto-delete.
- 409 `at_capacity` rather than overcommitting VRAM
- every error shaped as the contract specifies

## Phase D: prove it

1. `/destroy` `test01`, then `/provision` it again through the API. Result must be identical to the hand-built one.
2. Provision a second tenant. Confirm no display or port collision, and VRAM moved by roughly the measured delta.
3. Exercise `/control/:slug` for all five actions against a running tenant.
4. Kill the agent mid-provision, restart it, confirm reconcile reports the orphan.
5. Destroy both test tenants. Confirm the host is back to its starting state, minus the agent itself.

**CHECKPOINT D.** Report results and the final `tenant_max` for gpu-01.

## Deliverables

On branch `feat/gpu-agent`: the agent, the systemd unit templates, the OBS profile and scene collection templates, the noalbs config template, `PROVISION_TRANSCRIPT.md`, `TEARDOWN_GPU.md`, and `AGENT_NOTES.md` recording what you built, the measured VRAM per tenant, the resulting `tenant_max`, and every place you diverged from the spec with the reason.

## Stop and ask if

- `RECON.md` contradicts the spec in a way that changes your approach
- you need any change to `CONTRACT_AGENT_API.md`. Do not change it unilaterally, another agent is building against it
- the existing display pattern does not extend to isolated tenants
- VRAM headroom will not fit a test tenant with margin
- you need to touch the relay, nginx, or the express app for any reason
- you are about to run `userdel`, `rm -rf`, or `systemctl stop` on anything you did not create

Never guess on a live box.
