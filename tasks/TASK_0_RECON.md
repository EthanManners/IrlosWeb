# TASK 0: recon and decisions

Read-only investigation of two production servers. **You will change nothing.** No writes, no installs, no service changes, no config edits. If you catch yourself about to run something that alters state, stop.

Access: `ssh WEB` and `ssh GPU`.

Read `PROVISIONING_SPEC.md` for context on what is being built.

## Why this task exists

Four other tasks are blocked on three answers that cannot be obtained from a document. Your only job is to get them, accurately, without touching anything.

## Inventory, both hosts

OS, kernel, systemd version, node version, free disk, free RAM, current load. What is running. What is listening. Whether WireGuard is installed. Whether the two hosts can reach each other, and on which ports, since the hosting provider may restrict it.

Use targeted commands. `ss -tulpn`, `systemctl list-units --state=running --no-pager`, `free -h`, `df -h`, `ls -la`. Do not `cat` files to check they exist.

## WEB specifics

- how sls is configured: config file location, ports, apps, how existing customers' stream ids are defined
- the sls stats endpoint: URL, format, what a publisher entry looks like
- where the express app lives, its service name and state
- the nginx server blocks currently serving irlos.live

## GPU specifics

- exact GPU model and **die** (TU117, TU116, or TU106), driver version
- total VRAM, currently used VRAM, and what is holding it
- how existing customer OBS instances are launched and supervised: systemd, screen, tmux, a script, manually
- which X display they use and how it is started
- whether obs-websocket is already in use, and on which ports
- which unix users the existing instances run as

## The three answers

Everything downstream reads from these. Give each one a direct answer plus the evidence.

### Q1. Can sls accept a new stream id without a restart?

The question that shapes provisioning. Adding a tenant must never restart the relay, because that drops every live customer.

If yes: explain the mechanism and what config, if any, still has to change.

If no: say so plainly and recommend which of the two fallbacks in spec section 2 fits this setup. Do not propose a reload as a solution.

### Q2. How do existing OBS instances get a display?

Shared X server, per-instance Xvfb, or headless. Report the existing pattern exactly, then say whether it extends to multiple isolated tenants or whether a new pattern is needed. The production diagram shows a single shared `:0` with XFCE, which works for one customer and does not extend, so confirm whether that is still the case.

### Q3. What is the real VRAM headroom?

This is the capacity constraint, not the NVENC session limit. Total, minus driver overhead, minus what existing instances hold. State how much is genuinely free.

Do not use `nvidia-smi --query-gpu=encoder.stats.sessionCount`. It is unreliable on GeForce and frequently returns zero with sessions active. Report encoder state from `nvidia-smi pmon -c 1` and `nvidia-smi -q -d ENCODER_STATS` and note where they disagree.

If free VRAM will not fit another OBS instance with margin, say so as the headline finding.

## Also propose

- a port range for obs-websocket, verified free
- a display number range, verified unused
- a WireGuard address range that collides with nothing on either host

Verified means you checked, not that the spec suggested it.

## Deliverable

One file, `RECON.md`, in the repo. Structure it as: inventory, WEB specifics, GPU specifics, the three answers, proposed ranges, and a final section titled **Risks and surprises** covering anything that contradicts `PROVISIONING_SPEC.md` or that the next tasks should know.

Keep it factual. No implementation plans, no code, no recommendations beyond what Q1 asks for.

## Stop and report immediately if

- you cannot reach either host
- free VRAM will not fit another OBS instance
- the two hosts cannot reach each other on any usable port
- anything suggests a customer is currently live
- you find something that makes the planned architecture unworkable

Do not attempt fixes. Report and stop.
