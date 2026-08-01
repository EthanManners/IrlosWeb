# IRLOS work split

Six tasks. Two run in parallel, two are fully independent, two are sequential gates.

## Dependency graph

```
TASK_0_RECON  (read only, blocks everything on the infra side)
      |
      +-----------------------------+
      |                             |
TASK_1_GPU                    TASK_2_WEB
(GPU host + agent)            (express app, against a mock agent)
      |                             |
      +-----------------------------+
                    |
            TASK_3_INTEGRATION
                    |
                  done

TASK_4_STRIPE   independent, no server access, run any time
TASK_5_SITE     independent, no server access, run any time
```

## What runs in parallel

**TASK_1 and TASK_2 run at the same time**, by different agents, because `CONTRACT_AGENT_API.md` is frozen before either starts. TASK_1 builds the real agent. TASK_2 builds against a mock that returns the same shapes. Neither waits on the other. TASK_3 swaps the mock for the real thing.

**TASK_4 and TASK_5 have no dependencies at all.** Different agents, any time, no shell access to either server.

## Ownership, to stop agents colliding

Two live boxes and one repo, so write access is assigned, not shared.

| Task | May write to | Must not touch |
|---|---|---|
| 0 | nothing | everything |
| 1 | GPU host, WireGuard on both boxes, branch `feat/gpu-agent` | the express app, nginx, sls, the relay |
| 2 | branch `feat/web-pipeline` | GPU host, WireGuard, nginx, sls, the relay |
| 3 | both branches, `main`, one `irlos-web` restart | the relay config |
| 4 | Stripe dashboard, test mode only | any server, any live Stripe object |
| 5 | branch `feat/site`, static pages | any server, the express API, the database |

Branches merge at TASK_3. Nobody commits to `main` before then.

**Only TASK_1 gets write access to the GPU host, and only TASK_3 restarts anything on WEB.** If two agents are on the same host at once, one of them will allocate a port the other just took.

## Order to actually run them

1. TASK_0 alone. Read its output before anything else, because its three answers can change TASK_1's shape.
2. Freeze or amend `CONTRACT_AGENT_API.md` based on TASK_0's findings. Do this yourself, not with an agent. It is the interface, and it is the one decision that should not be delegated.
3. Fire TASK_1 and TASK_2 together. Fire TASK_4 and TASK_5 whenever.
4. TASK_3 when 1 and 2 both report done.

## Shared reading

Every task references `PROVISIONING_SPEC.md` for architecture. Tasks 1, 2 and 3 also need `CONTRACT_AGENT_API.md`. Task 5 needs `index-hybrid.html` and `backpack-3d.html`.

Do not paste the spec into task prompts. Put the files in the repo and reference them by name.
