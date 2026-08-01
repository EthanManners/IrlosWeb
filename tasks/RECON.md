# TASK 0: recon findings

Read-only investigation of WEB and gpu-01, carried out 2026-07-30 ~05:31–05:40 UTC.
Nothing was changed on either host: no writes, no installs, no service changes, no
config edits. The only packets generated were `nc` connect probes and three UDP
datagrams per direction on port 51820, used to prove reachability (see Q-adjacent
section "Cross-host reachability").

Secrets found on disk (obs-websocket password, a third-party SRT stream key, Twitch
credentials) are deliberately **not reproduced here**, only their file locations. This
file is destined for git.

---

## Headline findings

Three things contradict `PROVISIONING_SPEC.md` badly enough to read first:

1. **Q1 is a yes.** sls accepts a brand new stream id with no restart, no reload and no
   config change. Spec section 2 option 1 is not just viable, it is already how the
   running relay behaves.
2. **This sls build cannot do SRT passphrases at all.** `passphrase` exists as a single
   unused struct field. The schema's `tenants.passphrase` and the "SRT pull URL built
   from stream id and passphrase" in section 8 step 6 have nothing to bind to. The
   stream id is the only available secret.
3. **Xvfb is not installed on gpu-01, and the existing OBS instances get hardware
   OpenGL from a real Xorg on `:0`.** The per-tenant Xvfb in section 7 is not a
   drop-in: Xvfb has no NVIDIA GLX, so OBS compositing would fall to software
   rendering unless the display strategy changes. This is the largest unresolved
   architectural item.

No customer is live right now (evidence under Q3 and "Live-state check"), and free
VRAM does fit another OBS instance, so neither of those stop-conditions is tripped.

---

## 1. Inventory

| | WEB | gpu-01 |
|---|---|---|
| ssh alias | `WEB` | `GPU` |
| hostname | `154-156-152-216.clients.gthost.com` | `GPU2` |
| ssh user | `root` | `administrator` (uid 1000), passwordless `sudo -i` |
| public IPv4 | 216.152.156.154/24 | 204.12.218.33/25 |
| public IPv6 | link-local only | `2001:4858:aaaa:68:ae1f:6bff:fe45:9198/64` |
| OS | Ubuntu 22.04.1 LTS | Ubuntu 22.04.5 LTS |
| kernel | 5.15.0-46-generic | 5.15.0-185-generic |
| systemd | 249 (249.11-0ubuntu3.4) | 249 (249.11-0ubuntu3.21) |
| node | v20.20.2, npm 10.8.2 | **not installed** |
| python3 | — | 3.10.12, pip3 present |
| CPU | 1 vCPU, Broadwell (QEMU) | 16 × Xeon E5-2667 v3 @ 3.20GHz |
| RAM | **969 MiB total, 553 MiB available, no swap** | 62 GiB total, 53 GiB available, no swap |
| disk | `/` 20G, 13G free (31% used) | `/` 210G, 168G free; `/sdb-disk` 938G, 682G free |
| load (1/5/15) | 0.15 / 0.08 / 0.02 | 1.41 / 1.28 / 1.18 |
| uptime | 96 days | 18 days |
| firewall | ufw inactive, iptables all-ACCEPT, **no rules** | ufw inactive, iptables all-ACCEPT except a fail2ban `f2b-sshd` chain (currently empty) |
| WireGuard | **not installed**, `/etc/wireguard` absent, module not loaded. `wireguard` 1.0.20210914-1ubuntu2 available in apt | **not installed**, same. `wireguard` + `wireguard-tools` available in apt |
| ephemeral port range | 32768–60999 | 32768–60999 |

WEB's 969 MiB with no swap is the tightest resource on either host. It currently runs
two node apps, nginx and sls in that envelope. Anything added there (the provisioning
worker, a WireGuard interface) has ~550 MiB to live in.

### Listening sockets

**WEB**

| proto | bind | port | process |
|---|---|---|---|
| udp | `*` | 8282 | `sls` (pid 4457) — SRT ingest |
| tcp | `*` | 8181 | `sls` (pid 4457) — HTTP stats |
| tcp | 0.0.0.0 + [::] | 80, 443 | nginx |
| tcp | 127.0.0.1 | 8787 | node — `momweb.service` |
| tcp | 127.0.0.1 | 8788 | node — `irlos-web.service` |
| tcp | 0.0.0.0 + [::] | 22 | sshd |

**gpu-01**

| proto | bind | port | process |
|---|---|---|---|
| tcp | `*` (v4+v6) | 5556 | `obs` pid 1721204 — obs-websocket, tenant Adrian |
| tcp | `*` (v4+v6) | 5557 | `obs` pid 2612 — obs-websocket, tenant Will |
| tcp | 0.0.0.0 + [::] | 5901 | `x11vnc` |
| tcp | [::] | 5900 | `x11vnc` |
| tcp | 0.0.0.0 + [::] | 22 | sshd |
| tcp/udp | 127.0.0.53 | 53 | systemd-resolved |

Both obs-websocket ports are bound to all interfaces on a host with no firewall.
See Risks.

### Running units of interest

**WEB**: `nginx`, `irlos-web`, `momweb`, plus stock Ubuntu. **sls is not a systemd
unit** — it is a bare `./sls` process, pid 4457, user `stream`, running 96 days, cwd
`/home/stream/srt-live-server/bin`. Nothing supervises it; nothing restarts it on
reboot that I can find under systemd.

**gpu-01**: `xorg`, `x11vnc`, `obs-adrian`, `obs-will`, `noalbs-adrian`, `noalbs-will`,
`fail2ban`, `snapd`/`lxd` (installed, no bridges up), plus stock Ubuntu.
`nvidia_gpu_exporter.service` exists and is **not running**.

---

## 2. WEB specifics

### sls configuration

- Binary and cwd: `/home/stream/srt-live-server/bin/sls`, cwd
  `/home/stream/srt-live-server/bin`. Invoked as `./sls` with no arguments, so the
  **live config is `/home/stream/srt-live-server/bin/sls.conf`**.
- There is a second, stale `sls.conf` at the repo root
  (`/home/stream/srt-live-server/sls.conf`). It is the upstream sample: port 8080,
  `latency 20`, `uplive.sls.com` domains, HLS recording. **It is not in use.** Do not
  read it as the production config.
- Source tree is the upstream `srt-live-server` C++ project, built in place
  (`slscore/`, `obj/`, `Makefile`).

Live config in full:

```
srt {
    worker_threads 1;
    worker_connections 200;
    http_port 8181;
    cors_header *;
    log_file /dev/stdout;

    server {
        listen 8282;
        latency 2000;
        domain_player play;
        domain_publisher live;
        default_sid play/stream/will;
        backlog 10;
        idle_streams_timeout 10;

        app {
            app_publisher stream;
            app_player stream;
        }
    }
}
```

- Ingest: UDP 8282. Stats: TCP 8181.
- `latency 2000` is milliseconds of SRT buffer.
- `log_file /dev/stdout` with no supervisor means **sls logs go nowhere persistent.**
- `cors_header *` and no auth on 8181.

### How existing customers' stream ids are defined

They are not defined in the config at all. The config declares only a *domain* and an
*app*:

- publish namespace: `live/stream/<name>` (`domain_publisher live` + `app_publisher stream`)
- play namespace: `play/stream/<name>` (`domain_player play` + `app_player stream`)

`<name>` appears nowhere in sls config. The only place a customer name is baked in is
`default_sid play/stream/will`, which is merely the fallback used when a connecting
client supplies an empty streamid.

The two observed real stream ids live outside sls:

- **Will**: publishes `live/stream/will`; his OBS pulls
  `srt://216.152.156.154:8282?streamid=play/stream/will`. Recorded in
  `/root/NOALBS/Will/config.json` (`publisher: live/stream/will`) on gpu-01 and in the
  OBS scene collection `Will.json`.
- **Adrian**: **does not use this relay.** His OBS pulls
  `srt://use.srt.belabox.net:4001?streamid=<redacted>&timeout=2000000`, i.e. BELABOX
  cloud. See Risks.

### The sls stats endpoint

- URL: `http://216.152.156.154:8181/stats` (also `http://127.0.0.1:8181/stats`).
  This is the only route; `/`, `/stat`, `/stats/` and `/sls/stat` all return 404.
- Query params, from `srt-live-server.cpp`: `?publisher=<key>` returns a single
  publisher, `?reset` clears interval counters.
- Currently returns, verbatim, with nothing publishing:

  ```json
  {"publishers":{},"status":"ok"}
  ```

- A publisher entry is keyed by `live/stream/<name>` and its fields come from
  `CSLSManager::create_json_stats_for_publisher` (`slscore/SLSManager.cpp:195`):

  ```
  pktRcvLoss, pktRcvDrop, bytesRcvLoss, bytesRcvDrop, mbpsRecvRate,   // interval
  rtt, msRcvBuf, mbpsBandwidth,                                       // instant
  bitrate,   // kbps, from role->get_bitrate()
  uptime     // seconds
  ```

  So the shape is `{"publishers": {"live/stream/will": { ...those 10 keys... }}, "status": "ok"}`.
  This matches what noalbs consumes via `"type": "SrtLiveServer"`.

- `?reset` is a mutating call on shared state: it zeroes the interval counters for
  whoever reads next. noalbs already polls this endpoint. Two independent readers using
  `?reset` will corrupt each other's bitrate readings.

### The express app

- Path `/opt/irlos-web`, unit `irlos-web.service`, **active (running)** since
  2026-07-29 04:40:45 UTC, MainPID 560250.
- `User=irlos`, `Group=irlos`, `WorkingDirectory=/opt/irlos-web`,
  `ExecStart=/usr/bin/node server/index.js`, `Restart=always`.
- Secrets via `EnvironmentFile=/etc/irlos-web.env`.
- Already hardened: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  `PrivateTmp`, `ReadWritePaths=/opt/irlos-web/data`.
- Listens on **127.0.0.1:8788**. Port 8787 is taken by `momweb.service`
  (Maria Manners shop, `/var/www/mariamannersart/server`, `User=www-data`).
- SQLite at `/opt/irlos-web/data/irlos.db`, WAL mode (`-shm` and `-wal` present),
  owned by `irlos:irlos`.
- Layout: `server/index.js`, `server/lib/`, `server/routes/`, `public/`, `deploy/`,
  plus `RUNBOOK.md` and `CLAUDE_CODE_PROMPT.md` checked out on the box.

Note `ProtectSystem=strict` + `ReadWritePaths=/opt/irlos-web/data` — a worker in this
process cannot write anywhere else on the filesystem without the unit being amended.

### nginx server blocks serving irlos.live

`/etc/nginx/sites-enabled/irlos.live -> /etc/nginx/sites-available/irlos.live`.
Three server blocks:

1. `listen 80` for `irlos.live www.irlos.live` → 301 to `https://irlos.live$request_uri`.
2. `listen 443 ssl http2` for `irlos.live` — the real one:
   - certs `/etc/letsencrypt/live/irlos.live/{fullchain,privkey}.pem` (certbot)
   - `root /opt/irlos-web/public`, `index index.html`
   - `location /api/` → `proxy_pass http://127.0.0.1:8788`
   - `location /admin` → `proxy_pass http://127.0.0.1:8788`
   - `location /vendor/` 30d immutable; static asset regex 7d
   - `location /` → `try_files $uri $uri.html $uri/ =404`; `error_page 404 /404.html`
   - HSTS 63072000, `X-Content-Type-Options`, and a CSP with a comment saying it must
     stay in sync with helmet in `server/index.js`. CSP `connect-src 'self'` only.
3. `listen 443 ssl http2` for `www.irlos.live` → 301 to `https://irlos.live`.

Other sites on the same nginx: `ethanmanners` (ethanmanners.com, static) and
`mariamannersart` (mariamannersart.com, proxies to 127.0.0.1:8787).
`/etc/nginx/conf.d/` is empty.

The CSP `connect-src 'self'` matters for the control page: any polling endpoint must be
same-origin through `/api/`.

---

## 3. gpu-01 specifics

### GPU model, die, driver

- `NVIDIA GeForce GTX 1650`, PCI `02:00.0`, `[10de:1f82]` rev a1.
- **Die: TU117.** `lspci -nn` names it outright: `NVIDIA Corporation TU117 [GeForce GTX 1650]`.
  Device id `0x1F82`. So this is *not* one of the 2020 TU116/TU106 GDDR6 refresh parts.
- Consequence, as spec section 3 anticipated: **Volta-generation NVENC**, not Turing.
  `nvidia-smi -q` reports `Product Architecture: Turing` — that is the *GPU* arch and
  says nothing about the encoder block. Do not use that line to conclude the encoder is
  Turing.
- Driver 580.126.18, CUDA 13.0, VBIOS 90.17.3D.00.46.
- Persistence mode: Off. Power 21W / 75W, 47°C, GPU-Util 15%.
- `/dev/dri/card0` (`root:video`) and `/dev/dri/renderD128` (`root:render`) present.
  Groups `video` (gid 44) and `render` (gid 110) both exist and are **empty**.

### VRAM, and what holds it

Two samples 4 minutes apart were identical: **4096 MiB total, 599 MiB used, 3117 MiB free.**

Per-process framebuffer, from `nvidia-smi pmon -s um`:

| pid | process | fb MiB | note |
|---|---|---|---|
| 1516 | `/usr/lib/xorg/Xorg` | 150 | the single shared X server on `:0` |
| 1632 | `xfwm4` | 2 | XFCE window manager |
| 2612 | `obs` (Will) | 48 | SRT source failing, so nothing decoded |
| 2775 | `obs-browser-page` gpu-process (Will) | 60 | CEF browser sources |
| 1721204 | `obs` (Adrian) | 325 | decoding, `dec 8%`, type `C+G` |
| 1721274 | `obs-browser-page` gpu-process (Adrian) | 3 | |
| | **sum of attributed** | **588** | |

`nvidia-smi --query-compute-apps` lists only pid 1721204 / 325 MiB; the graphics-only
contexts do not appear there. Use `pmon -s um` for per-process VRAM on this box, not
`--query-compute-apps`.

Unattributed overhead: `4096 - 599 = 3497` but nvidia-smi reports `3117` free, so
**~380 MiB is driver/reserve that never shows up as a process.**

### How existing OBS instances are launched and supervised

systemd, one hand-written unit pair per customer, all as **root**. No templating, no
instanced units, no per-tenant unix user.

`/etc/systemd/system/obs-adrian.service` (obs-will is identical bar names):

```
[Unit]
Description=OBS (Adrian)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/tmp/.X11-unix/X0        # wait until X display :0 exists

[Service]
Type=simple
User=root
Environment=DISPLAY=:0
Environment=XAUTHORITY=/root/.Xauthority
Environment=XDG_RUNTIME_DIR=/tmp/runtime-root
ExecStartPre=/bin/bash -lc 'for i in {1..60}; do [ -S /tmp/.X11-unix/X0 ] && exit 0; sleep 1; done; exit 1'
ExecStart=/opt/stream/obs-adrian.sh
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/opt/stream/obs-adrian.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:0
export XAUTHORITY=/root/.Xauthority
export XDG_RUNTIME_DIR=/tmp/runtime-root
exec obs --multi --collection "Adrian" --profile "Adrian" --websocket_port 5556
```

Will's is the same with `Will` / `5557`.

**No hardening whatsoever**: no `NoNewPrivileges`, no `ProtectSystem`, no
`ProtectHome`, no `PrivateTmp`, no `MemoryMax`, no `CPUQuota`. Everything is root.

noalbs units are thinner: `ExecStart=/opt/stream/noalbs-<name>.sh` → `exec
/root/NOALBS/<Name>/launch.sh` → `cd` to the program dir and `./noalbs`. Also
`User=root`, `Restart=always`, no hardening. Binary is noalbs v2.16.1
(`noalbs-v2.16.1-x86_64-unknown-linux-musl.tar.gz` in `/root/NOALBS/`), one copy per
tenant directory. Per-tenant config `/root/NOALBS/<Name>/config.json` plus a `.env`.
Stale duplicates `/root/NOALBS/Adrian.json` and `/root/NOALBS/Will.json` sit one level
up and are not what the running processes read.

OBS is **30.2.3**; obs-websocket is the bundled **5.5.2 (RPC version 1)**.

All OBS state lives in one root-owned tree, `/root/.config/obs-studio/`:
`basic/profiles/{Adrian,Testing,Will}` and
`basic/scenes/{Adrian,Will,Untitled}.json` (+ `.bak` siblings). Per-tenant separation
is by *profile and scene-collection name inside a single shared config directory* —
not by user, not by directory.

noalbs config shape (from `/root/NOALBS/Will/config.json`, secrets redacted):

```json
{
  "user": { "name": "Will", "passwordHash": null },
  "switcher": {
    "bitrateSwitcherEnabled": true,
    "triggers": { "low": 450, "rtt": 1500, "offline": 400 },
    "switchingScenes": { "normal": "Live", "low": "BRB", "offline": "BRB" },
    "streamServers": [{
      "streamServer": {
        "type": "SrtLiveServer",
        "statsUrl": "http://216.152.156.154:8181/stats",
        "publisher": "live/stream/will"
      },
      "name": "nginx", "priority": 1,
      "overrideScenes": { "normal": "Live", "low": "low", "offline": "BRB" },
      "enabled": true
    }]
  },
  "software": { "type": "Obs", "host": "204.12.218.33", "password": "<redacted>", "port": 5557 },
  "chat": { "platform": "Twitch", "username": "<redacted>", "admins": [...], "prefix": "!" },
  "optionalScenes": { "starting": "STARTING", "ending": "ENDING", "privacy": "PRIVACY", "refresh": "REFRESH" }
}
```

Required scene names are therefore load-bearing: `Live`, `BRB`, `low`, and optionally
`STARTING`, `ENDING`, `PRIVACY`, `REFRESH`. A scene-collection template must contain
them or noalbs switching fails.

Note `"host": "204.12.218.33"` — noalbs reaches OBS over the **public IP**, not
loopback, even though both are on the same machine.

### X display

**One shared X server on `:0`**, exactly as the production diagram says.

`/etc/systemd/system/xorg.service`:

```
[Unit]
Description=Start Xorg with XFCE
After=multi-user.target
[Service]
User=root
ExecStart=/usr/bin/startx -- :0
Restart=always
RestartSec=2
```

- `/tmp/.X11-unix/` contains **only `X0`**. No other display exists.
- `Xorg` pid 1516, `-auth /tmp/serverauth.DNwDysnCBi`, plus `xfwm4` — full XFCE session.
- OBS gets **hardware** OpenGL through it. From the OBS log:
  `Loading up OpenGL on adapter NVIDIA Corporation NVIDIA GeForce GTX 1650/PCIe/SSE2`,
  `OpenGL loaded successfully, version 3.3.0 NVIDIA 580.126.18`.
- **`Xvfb` is not installed.** `which Xvfb xvfb-run` finds nothing; only
  `/usr/bin/Xorg` and `/usr/bin/startx`. apt candidate is
  `2:21.1.4-2ubuntu1.7~22.04.16`.
- Both tenants render at base 1920x1080, output 1920x1080, 60/1 fps, NV12,
  Rec. 709/Partial.

Remote access to that display is `x11vnc.service`:
`x11vnc -display :0 -forever -shared -nopw -rfbport 5901 -listen 0.0.0.0`.
`-nopw` — no password, all interfaces. It is deliberately time-boxed:
`ExecStartPost` restarts `x11vnc-kill.timer`, an `OnActiveSec=15min` timer whose
service runs `systemctl stop x11vnc.service`. It was up at 05:31 during this recon and
had auto-stopped by 05:38.

### obs-websocket

Already in use, on **5556 (Adrian)** and **5557 (Will)**, set per instance via the
`--websocket_port` CLI flag, which overrides the config file
(`[obs-websocket] --websocket_port passed. Overriding WebSocket port with: 5557`).

The config file is shared by every instance —
`/root/.config/obs-studio/plugin_config/obs-websocket/config.json`:

```json
{ "alerts_enabled": false, "auth_required": true, "first_load": false,
  "server_enabled": true, "server_password": "<redacted, 16 chars>", "server_port": 4455 }
```

Two consequences:

- **Every OBS instance authenticates with the same password**, because there is one
  config file for all of them. The same value appears as `software.password` in both
  noalbs configs. Any tenant who learns it can drive every other tenant's OBS.
- The file exposes only `server_port` and `server_password`. **There is no bind-address
  setting.** The log confirms it binds wide: `Not locked to IPv4 bindings` /
  `Server started successfully on port 5557. Possible connect address: 204.12.218.33`.
  obs-websocket 5.5.2 cannot be confined to `127.0.0.1` by configuration.

### Unix users

`/etc/passwd` has exactly **one** non-system account: `administrator` (uid 1000,
`/home/administrator`, `/bin/bash`). There is no `irlos_*` user and no per-customer
user. Every tenant process runs as **root**.

Curiosity: `/root/NOALBS/Adrian/` and `/root/NOALBS/Will/` and several files inside are
owned by uid/gid **1001**, which has no `/etc/passwd` entry. Leftover from a deleted
account.

### Runtime available for an agent

`node` and `npm` are **absent** on gpu-01. Available: `python3` 3.10.12 and `pip3`.
No `cargo`, no `go`.

---

## Cross-host reachability

Both hosts have effectively open firewalls (WEB: no rules at all; gpu-01: policy ACCEPT
plus an empty fail2ban chain), and the provider does not appear to filter between them.

| direction | port | method | result |
|---|---|---|---|
| gpu-01 → WEB | tcp 8181 | `nc -z` | **open** (and already in production use — noalbs pid 425459 held an established connection to `216.152.156.154:8181`) |
| gpu-01 → WEB | tcp 22 | `nc -z` | open |
| gpu-01 → WEB | tcp 8282 | `nc -z` | connection **refused** — expected, sls listens on UDP 8282 only. Refused, not dropped, so the path is clear |
| gpu-01 → WEB | tcp 9443 | `nc -z` | connection **refused** → nothing listening, but **path is open and unfiltered** |
| WEB → gpu-01 | tcp 22 | `nc -z` | open |
| WEB → gpu-01 | tcp 5556 | `nc -z` | **open** — a tenant's obs-websocket is reachable from off-host |
| WEB → gpu-01 | tcp 5901 | `nc -z` | refused (x11vnc had been auto-stopped by its timer) |
| WEB → gpu-01 | tcp 9443 | `nc -z` | **refused → path open and unfiltered** |
| WEB → gpu-01 | **udp 51820** | 3 datagrams, `tcpdump` on gpu-01 | **3 packets captured** at `204.12.218.33.51820` |
| gpu-01 → WEB | **udp 51820** | 3 datagrams, `tcpdump` on WEB | **3 packets captured** at `216.152.156.154.51820` |

The distinction that matters: `9443` answers *refused*, not *timeout*. A provider-level
block would drop and time out. The RST proves the SYN reached the host kernel, so
binding an agent on 9443 needs no provider involvement.

**UDP 51820 is proven to traverse in both directions**, so WireGuard can be brought up
from either side. Neither host currently has WireGuard installed.

The SRT pull path gpu-01 → WEB:8282 is not directly provable while no stream exists,
but it is the mechanism Will's OBS uses in production and the TCP probe to the same
port/host was refused rather than dropped.

---

## Live-state check

**No customer is live.** Four independent confirmations:

1. `GET http://127.0.0.1:8181/stats` → `{"publishers":{},"status":"ok"}`. No publisher
   is connected to the relay.
2. Will's OBS log is looping
   `MP: Failed to open media: 'srt://216.152.156.154:8282?streamid=play/stream/will'`
   every ~10 s, which is exactly the symptom of no upstream publisher.
3. No RTMP output is running. Will's log shows the last `Output 'adv_stream': stopping`
   with `Total frames output: 404538` — a finished session, not a current one. Adrian's
   OBS log (started 05:18:49 today) has NVENC probe lines and **no** `rtmp://` connect
   and no `adv_stream` at all.
4. `ss -tnp` on gpu-01 shows no connection to any RTMP ingest on 1935; the only
   outbound streaming-adjacent sockets are noalbs → Twitch IRC on 6697 and noalbs →
   the sls stats endpoint.

Worth flagging anyway: **somebody was working on gpu-01 minutes before this recon.**
Adrian's OBS (pid 1721204) had 14 minutes of uptime when first sampled, its log begins
05:18:49, a `Testing` OBS profile was created 05:19, `Adrian.json` /
`Adrian.json.bak` and the obs-websocket `config.json` were all written 05:18, Will's
video settings were toggled 1280x720@30 → 1920x1080@60 at 05:17:55–05:18:12, and
x11vnc was up. Treat gpu-01 as a host with a human on it, not an idle box.

---

## The three answers

### Q1. Can sls accept a new stream id without a restart? — **Yes.**

Unambiguously yes, and no config change is needed either.

**Mechanism**, traced in `slscore/SLSListener.cpp` (`CSLSListener::handler`):

1. The streamid is read off the socket (`SRTO_STREAMID`, line 373) and parsed into
   three parts — host/domain, app, stream name — by `libsrt_parse_sid` (line 389),
   which fills `h`, `sls_app` and `r`. If the streamid is empty, `default_sid` is
   substituted (line 381–385).
2. **Only the domain and app are validated against the config.** Line 420 builds
   `key_app = "<host>/<app>"`, then `m_map_publisher->get_uplive(key_app)` (line 429)
   and `get_ca(app_uplive)` (line 516) look it up in the parsed config. If the app is
   unknown, the connection is refused.
3. The **stream name is never checked against anything.** It is concatenated into a
   runtime map key, `key_stream_name = app_uplive + "/" + stream_name` (lines 431, 515).
4. For a publisher, a fresh `CSLSPublisher` is constructed on the spot (line 534),
   registered with `m_map_data->add(key_stream_name)` (line 554) and
   `m_map_publisher->set_push_2_pushlisher(key_stream_name, pub)` (line 563), and
   pushed onto the role list. The only rejection path is the `get_publisher` lookup at
   line 525 and its check at line 526: refused iff a publisher for that exact key
   **already exists**.
5. Players resolve symmetrically: `play/stream/<name>` maps through `get_uplive` to the
   same `live/stream/<name>` data key.

So stream ids are pure runtime state in an in-memory map, created on first publish. The
config enumerates namespaces, never streams. `sls.conf` contains no stream list to
edit — the only customer name in it, `default_sid play/stream/will`, is just an
empty-streamid fallback.

**What still has to change at provision time: nothing on the relay.** Not the config,
not a reload, not a restart. A tenant is provisioned entirely by (a) recording the
chosen stream id in the database, (b) handing the streamer
`srt://216.152.156.154:8282?streamid=live/stream/<id>`, and (c) pointing the tenant's
OBS media source at `srt://216.152.156.154:8282?streamid=play/stream/<id>`. This is
**spec section 2 option 1**, and it is already the relay's behaviour rather than a
change to it.

Two caveats that follow from the same code, both material:

- **There is no authentication of any kind.** Any app-valid streamid is accepted. Since
  the stream name is unconstrained, the stream id genuinely is the only secret, so it
  must be long and random — a guessable id lets anyone publish into a tenant, and the
  first publisher to claim a key owns it (line 525 rejects the *second* comer, so an
  attacker who connects first locks the paying customer out).
- **This build cannot do SRT passphrases.** `grep -rni passphrase` across `slscore/`
  and the top-level sources returns exactly one hit, the declaration `char *passphrase;`
  in `slscore/SLSSrt.hpp:53`. It is never assigned from config and `SRTO_PASSPHRASE` is
  never set. There is no `passphrase` directive in the config grammar. Anything in the
  downstream design that builds a pull URL "from stream id and passphrase" has no
  mechanism behind it here.

Also relevant to ordering: OBS's media source retries the pull every ~10 s forever
(Will's log proves it). A tenant can be fully provisioned before its streamer ever
connects; there is no start-order constraint between relay and tenant.

### Q2. How do existing OBS instances get a display? — **One shared X server on `:0`.**

The production diagram is **still accurate**. A single `Xorg :0` (pid 1516) started by
`xorg.service` via `/usr/bin/startx -- :0`, running a full XFCE session with `xfwm4`.
Both OBS instances attach to it through `DISPLAY=:0` and
`XAUTHORITY=/root/.Xauthority`, guarded by a `ConditionPathExists=/tmp/.X11-unix/X0`
and a 60-second `ExecStartPre` wait loop. `/tmp/.X11-unix/` contains only `X0`. Not
per-instance Xvfb, not headless.

**It does not extend to multiple isolated tenants.** Concretely:

- All tenants share one X server, so any tenant's process can read every other
  tenant's window contents, keystrokes and clipboard. X11 has no intra-display
  isolation. With `x11vnc -shared -nopw` attached, that surface reaches the network too.
- All tenants run as **root** against one `XAUTHORITY`, so there is no boundary to
  enforce even if X had one.
- All tenants share **one** `/root/.config/obs-studio/` tree. Isolation is by profile
  name only. Whichever instance saves last rewrites shared files — the `.bak` siblings
  next to `Adrian.json` and `Will.json`, both touched 05:18 today, are that mechanism
  in action.
- One config directory means one obs-websocket `config.json`, hence **one shared
  password for every tenant** (see Risks).
- A crash or restart of `xorg.service` (`Restart=always`) takes down every tenant's
  display at once.

**A new pattern is needed**, and the per-tenant-Xvfb pattern in spec section 7 is not a
drop-in for one specific reason: today's OBS gets *hardware* OpenGL from the NVIDIA
driver on `:0` (`OpenGL loaded successfully, version 3.3.0 NVIDIA 580.126.18`). Xvfb
provides no NVIDIA GLX, so OBS on Xvfb would fall back to software rendering
(llvmpipe) for compositing unless something else supplies hardware GL. On top of that,
**Xvfb is not even installed** on gpu-01. This is the single largest open
architectural question of the recon; it is flagged in Risks rather than solved here,
since Q2 asks only for the existing pattern and whether it extends.

### Q3. What is the real VRAM headroom? — **3117 MiB free of 4096 MiB, but measured with nothing encoding.**

Direct answer, from two identical samples four minutes apart:

```
total          4096 MiB
used            599 MiB
free           3117 MiB   <- nvidia-smi's own figure
driver/reserve  ~380 MiB  (4096 - 599 = 3497, yet only 3117 is reported free)
```

Attributed to processes: 588 MiB — Xorg 150, xfwm4 2, OBS(Will) 48,
CEF-gpu(Will) 60, OBS(Adrian) 325, CEF-gpu(Adrian) 3.

**Genuinely free right now: 3117 MiB.** So free VRAM *does* fit another OBS instance
with margin, and this is **not** the headline blocker. The headline blockers are Q1's
missing passphrase support and Q2's display model.

The important caveat, stated plainly so nobody plans against this number:

> These 3117 MiB were measured while **no tenant was streaming** — no publisher on the
> relay, no NVENC session, no RTMP output anywhere. This is close to a two-tenant
> **idle** baseline, not a working figure.

The evidence for how much that understates things is inside the sample itself: Will's
OBS, whose SRT source is failing and which therefore decodes nothing, holds **48 MiB**;
Adrian's, which is actively decoding, holds **325 MiB** — a ~6.8× spread between an
idle and a partly-working instance, and *neither* is encoding or compositing a live
1080p60 program. A fully-live tenant additionally carries an NVENC session, scene
textures and compositing buffers at 1920x1080 60fps NV12.

Per-tenant cost under load is therefore **unmeasured, and cannot be measured
read-only.** Spec section 3's plan — record total VRAM used before and after the first
hand-provision, and store the delta as `vram_mb_per_tenant` — remains the only way to
get the real number. Do not seed `hosts.tenant_max` from the idle figures above.

Two further items reduce usable headroom below 3117 MiB in the planned architecture:

- Per-tenant Xvfb replaces one shared 150 MiB Xorg with N display servers. Xvfb itself
  is a software framebuffer in system RAM, but the split changes the accounting and,
  if hardware GL is retained some other way, adds per-display GPU allocations.
- Every OBS instance here spawns a CEF browser subsystem; the gpu-process alone took
  60 MiB for Will and 3 MiB for Adrian. Scene templates containing browser sources
  carry that per tenant.

### On the encoder-session counters, as asked

The two sources **disagree, and the task's warning is confirmed on this box.**

- `nvidia-smi -q -d ENCODER_STATS` reports:
  `Active Sessions : 0`, `Average FPS : 0`, `Average Latency : 0`.
- `nvidia-smi pmon -c 1` reports `enc` as `-` for every process, but shows pid 1721204
  as type `C+G` with `dec 8%` and `sm 15% / mem 6%` — i.e. that process holds a compute
  context and is actively using the **decoder**.

They are reconcilable here rather than contradictory: nothing is in fact encoding right
now, so 0 active encode sessions is arguably correct. What `ENCODER_STATS` fails to
convey is that the GPU is not idle — it is decoding — and `pmon` is the only one of
the two that shows it. The pmon `enc`/`dec` columns are the trustworthy view of
encoder/decoder state on this GeForce part. `--query-gpu=encoder.stats.sessionCount`
was not used, per instruction.

---

## Proposed ranges

All three verified against live state on both hosts, not taken from the spec.

### obs-websocket port range: **5570–5599** (30 ports, loopback intent)

- In use today: 5556, 5557. Also present on the box: 5900, 5901 (x11vnc), 22, 53.
- `ss -tulpn` filtered to 5500–6000 on gpu-01 returns **only 5556 and 5557**. 5570–5599
  is entirely clear, and leaves 5558–5569 as a gap above the existing pair.
- Deliberately **below** the ephemeral range (32768–60999 on both hosts), so an
  allocated studio port can never collide with an outbound socket. A range chosen
  inside 32768+ would intermittently fail to bind.
- Avoids 5900–5910, i.e. the VNC block, so adding displays later cannot collide.
- Caveat carried from GPU specifics: obs-websocket 5.5.2 has no bind-address option, so
  "loopback only" is not achievable through obs-websocket config alone at these ports.

### Display number range: **:101–:199**

- Only `:0` exists — `/tmp/.X11-unix/` contains exactly one socket, `X0`.
- Starting at 101 leaves `:0`–`:9` for the existing shared Xorg and any future
  interactive session, and steers clear of `:1`–`:5`, the displays conventionally
  implied by the 5901+ VNC ports already in use.
- X display `:N` has no TCP port implication here (Xorg is not listening on 6000+;
  nothing in `ss -tulpn` occupies the 6000–6100 block), so the range collides with
  nothing even if `-listen tcp` were ever enabled.

### WireGuard address range: **10.44.0.0/24** — the spec's suggestion, and it is clear

- WEB: interfaces are `lo` and `eth0` (216.152.156.154/24) only. Routes are the default
  via 216.152.156.1 and 216.152.156.0/24. **No 10.x, 172.16–31.x or 192.168.x anywhere.**
- gpu-01: interfaces are `lo`, `eth0` (204.12.218.33/25), and `eth1` **DOWN**. Routes
  cover only 204.12.218.0/25, the gateway, and a DHCP-injected 8.8.8.8 host route. No
  private ranges, and although snap `lxd` is installed, **no lxd bridge exists** —
  `ip -brief addr` shows no `lxdbr0` and no `docker0`.
- So `10.44.0.1` (WEB) and `10.44.0.11` (gpu-01) collide with nothing on either host.
- Reachability for the tunnel itself is proven above: UDP 51820 traverses both
  directions.
- One caveat: gpu-01's `eth1` is DOWN and unconfigured. If it is ever brought up by
  DHCP it could theoretically land in a private range; worth a glance before committing.

---

## Risks and surprises

Ordered by how much they affect the next tasks.

1. **No SRT passphrase support in this sls build.** Contradicts the spec directly:
   `tenants.passphrase` (section 4), `/provision { slug, stream_id, passphrase }`
   (section 6), and "substituting the SRT pull URL built from stream id and
   passphrase" (section 8 step 6). Evidence: one unused `char *passphrase;` at
   `slscore/SLSSrt.hpp:53`, no config directive, `SRTO_PASSPHRASE` never set. Either the
   passphrase becomes a stored-but-unused column, or sls is rebuilt/replaced — a
   decision the next task owner needs to make consciously rather than discover.

2. **The relay has no authentication at all, and first-publisher-wins.** Any streamid
   in the `live/stream/*` namespace is accepted. `SLSListener.cpp:526` rejects a
   *second* publisher for a key, so whoever connects first owns it — an attacker who
   guesses or learns a tenant's id can both inject video and lock the paying customer
   out. Stream ids must be long and randomly generated, and the 6-char slug in the spec
   (`^[a-z0-9]{6}$`, ~2 billion) is **not** adequate as a stream id even if it is fine
   as a unix username. Keep `slug` and `stream_id` as separate values with different
   entropy.

3. **Xvfb is not installed, and the current OBS gets hardware OpenGL from Xorg on `:0`.**
   The per-tenant-Xvfb design in section 7 cannot simply be applied: Xvfb offers no
   NVIDIA GLX, so compositing would silently move to software rendering (llvmpipe) on
   a box with 16 cores but a 4 GB card whose value is hardware encode. Needs a decided
   approach — Xvfb and accept software compositing, or per-tenant real Xorg screens, or
   OBS with EGL/headless — before any provisioning code is written.

4. **One shared obs-websocket password across all tenants, on publicly bound ports.**
   `/root/.config/obs-studio/plugin_config/obs-websocket/config.json` is a single file
   for every instance, so `server_password` is identical for Adrian and Will and for
   any future tenant. obs-websocket 5.5.2 exposes only `server_port` and
   `server_password` — **no bind address** — and the log confirms `Not locked to IPv4
   bindings`. Both hosts have no firewall. I verified from WEB that
   `204.12.218.33:5556` accepts connections from off-host. This is a live exposure
   today, and it directly blocks the spec's "obs-websocket bound to `127.0.0.1` on an
   allocated port": that cannot be achieved by obs-websocket configuration and will
   need either firewall rules or a network namespace per tenant.

5. **Adrian is not a relay tenant at all.** His OBS pulls from
   `srt://use.srt.belabox.net:4001?streamid=<redacted>`, i.e. BELABOX cloud, not from
   WEB. So of the two existing customers only Will traverses the sls relay, and the
   `{"publishers":{}}` stats response is not evidence about Adrian's stream in either
   direction. Any capacity or bitrate model that reads the relay stats endpoint is
   blind to tenants like Adrian. The topology diagram in section 2 does not describe
   half of the current customer base.

6. **The `?reset` parameter on `/stats` mutates shared state.** noalbs already polls
   that endpoint. If provisioning or monitoring code also calls `/stats?reset`, the two
   readers will zero each other's interval counters and both will see wrong bitrates.
   Read `/stats` without `reset`.

7. **sls is unsupervised and unlogged.** It is a bare `./sls` as user `stream`, pid
   4457, up 96 days, with no systemd unit (`sls.service` does not exist) and
   `log_file /dev/stdout` going nowhere persistent. If it dies, every customer drops
   and nothing restarts it; there will be no log to explain why. The whole "never
   restart the relay" requirement rests on a process that nothing is currently keeping
   alive. Note also that a future `sls.service` would itself be a restart.

8. **WEB has 969 MiB RAM, 553 MiB available, and no swap.** It already carries nginx,
   sls and two node apps. The provisioning worker (spec section 5 puts it in the
   `irlos-web` process), a WireGuard interface, and SQLite WAL all have to fit in that.
   Also `irlos-web.service` runs `ProtectSystem=strict` with
   `ReadWritePaths=/opt/irlos-web/data` only — a worker cannot write outside that path
   without amending the unit. And 1 vCPU means the worker's polling loop competes with
   request handling.

9. **No node runtime on gpu-01.** The agent in section 6 has no JS runtime to run on;
   only `python3` 3.10.12 and `pip3` are present. Either install node or write the
   agent in python. Nothing in the spec picks one.

10. **Nothing on gpu-01 is hardened, and everything is root.** No per-tenant unix user
    exists (`administrator` uid 1000 is the only non-system account), the `video` and
    `render` groups are both **empty**, and the OBS/noalbs units carry none of
    `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `MemoryMax` or
    `CPUQuota`. Section 7's model is a wholesale change from current practice, not an
    increment — and there is no existing tenant it can be validated against without
    migrating Adrian and Will.

11. **Per-tenant OBS state is not isolated on disk.** One `/root/.config/obs-studio/`
    tree holds all profiles and scene collections; separation is by name only. The
    `.bak` files next to `Adrian.json` and `Will.json` show instances rewriting that
    shared tree. Moving to `/srv/irlos/tenants/<slug>/obs/` means giving each OBS its
    own config root (e.g. per-user `HOME`), which the current `User=root` +
    `--profile`/`--collection` pattern does not do.

12. **x11vnc runs `-nopw -listen 0.0.0.0` on a firewall-less host.** Unauthenticated
    access to the shared `:0` — hence to every tenant's OBS GUI. Mitigated only by the
    15-minute `x11vnc-kill.timer`, which I watched fire between 05:31 and 05:38. It was
    running when this recon started.

13. **A human was on gpu-01 minutes before this recon.** Adrian's OBS restarted 05:18
    today, a `Testing` OBS profile was created 05:19, obs-websocket `config.json` was
    written 05:18, Will's video settings were toggled at 05:17:55, and x11vnc was up.
    Coordinate before touching that box — its state at any later moment may differ from
    this snapshot.

14. **Small things worth knowing.** (a) `/home/stream/srt-live-server/sls.conf` is a
    stale upstream sample and is **not** the live config; the live one is `bin/sls.conf`
    — reading the wrong one gives you port 8080 and `uplive.sls.com`. (b) `nvidia-smi -q`
    prints `Product Architecture: Turing` for what is a TU117 with a *Volta-generation*
    NVENC block; that line is about the GPU, not the encoder. (c) Files under
    `/root/NOALBS/{Adrian,Will}/` are owned by orphaned uid/gid **1001**. (d) Stale
    `/root/NOALBS/Adrian.json` and `Will.json` sit beside the real per-tenant
    `config.json` files and are not read by the running processes. (e) noalbs reaches
    OBS over gpu-01's **public IP** (`"host": "204.12.218.33"`) rather than loopback.
    (f) `nvidia_gpu_exporter.service` is installed but not running, so there is no
    historical VRAM telemetry to mine for the per-tenant figure Q3 could not measure.
    (g) `irlos-web` is on **8788**, not 8787 — `momweb.service` holds 8787 on this box.
    (h) noalbs requires scenes named `Live`, `BRB`, `low` and optionally `STARTING`,
    `ENDING`, `PRIVACY`, `REFRESH`; a scene-collection template missing them breaks
    switching.
