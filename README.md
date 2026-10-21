# SRT CAM — 10-channel lightweight SRT relay

A lightweight Docker deployment of Haivision **SRT Tools `srt-live-transmit`** (not the commercial Haivision SRT Gateway) and a **read-only, on-demand** `srt-status` command. Based on the original field deployment document and 10-channel Compose configuration.

## Deployment (new Ubuntu/Debian VPS only)

```bash
git clone https://github.com/yikkrrtykj/srt-cam.git
cd srt-cam
sudo bash install.sh --dry-run
sudo bash install.sh
sudo srt-status -s 6
```

The installer checks for existing `srt-cam*` containers and bound SRT UDP ports before installation and **refuses to overwrite an existing relay**. An already-managed installation is left running on repeat execution. On an existing production VPS, install **only the diagnostic tool**:

```bash
git clone https://github.com/yikkrrtykj/srt-cam.git
cd srt-cam
sudo bash install.sh --status-only
sudo srt-status -s 6
```

> `install.sh` changes the host (apt packages, sysctl buffer maximums, image build, service creation, and inbound UFW UDP rules **only if UFW is already active**). Read it before deploying. It does **not** enable UFW or change your cloud-provider firewall. `--status-only` does not alter running relay containers, their sysctl or firewall. New deployments still require a real SRT sender and receiver for acceptance.

## Configuration

| Channel | SRT sender (Caller) sends to VPS | SRT receiver (Caller) pulls from VPS |
|---|---|---|
| 1 | UDP 21111 | UDP 11111 |
| 2 | UDP 21112 | UDP 11112 |
| … | … | … |
| 10 | UDP 21120 | UDP 11120 |

Both sides use Caller; server endpoints are Listener. Ten independent Docker containers `srt-cam1` through `srt-cam10`, using host networking. The original YAML is preserved at [`archive/docker-compose.original.yml`](archive/docker-compose.original.yml).

The default `srt-status.json` deliberately contains **no direction labels**. Assign labels only when the event's actual channel mapping is known, in `/etc/srt-status.json`. Set `expected_active` for channels scheduled for a test to distinguish idle from `CHECK NO TRAFFIC`. Existing files with exactly the old CAM6-only default are migrated automatically on `--status-only`; other custom files are preserved.

`sudo srt-status -s 6` shows estimated media-size UDP RX/TX by channel, and distinguishes local loopback (`LO`, e.g. sing-box) vs direct WAN (`WAN`) on the gateway. **These are UDP payload estimates, not video bitrates, SRT loss statistics, or proof of picture quality.** Underlying TCP Reality can mask packet loss from an SRT receiver, but introduce delay or freezes. `FLOW` means only sampled traffic was observed.

## Operational checks

```bash
docker ps --filter name=srt-cam
docker logs --since 2m --tail 60 srt-cam6
sudo srt-status -s 6
```

- No input: ask sender if vMix Output actually started; check sender → VPS UDP 2111x.
- Input with no output: ask receiver if vMix Input is connected; check VPS UDP 1111x. `bytes lost` in `srt-live-transmit` relay logs can reflect the absence of a target and is **not** network packet-loss percentage.
- Input and output but picture corrupted: inspect both **separate** SRT sessions, RTT, retransmits, late/skipped packets, codec and final vMix picture. A healthy server cannot establish where Internet packet loss occurs.
- Check actual expected-active list before treating `IDLE/UNKNOWN` as a failure.

The original [`srt中转网关.docx`](docs/srt中转网关.docx) is preserved verbatim; see [`docs/legacy-deployment.md`](docs/legacy-deployment.md) for its command-oriented Markdown transcription, and [`docs/runbook.md`](docs/runbook.md) for production notes and limitations.

## Native SRT protocol diagnostics (opt-in, one channel)

In a test/maintenance window, enable JSON counters on only CAM1, preserving 21111/11111 and the SRT URLs:

```bash
cd ~/srt-cam && git pull --ff-only
sudo bash install.sh --status-only
python3 scripts/enable-native-stats.py --cam 1              # dry run; no changes
sudo python3 scripts/enable-native-stats.py --cam 1 --apply # restart ONLY CAM1
sudo srt-status --srt 1 --minutes 2
```

**Interruption:** `--apply` backs up the ACTIVE Compose file (located from Docker labels), validates it, then force-recreates only CAM1. The original Compose project name is preserved. On failure it attempts to restore the original YAML/container. This is not a hot toggle; only do it during approved tests. The script refuses unfamiliar images, commands, and Compose layouts.

Native `-stats:3000` means **every 3000 media packets**, not milliseconds. Reports go as JSON to normal Docker logs. SOURCE (21111) is the SRT receiver, TARGET (11111) is the SRT sender. Both have independent RTT and loss recovery. Output includes per-report interval `packetsLost`, `packetsRetransmitted`, `packetsDropped` and RX `msTsbPdDelay`. Values are not Internet loss percentages, and `msTsbPdDelay` does not prove remote vMix configuration. Idle/legacy streams show `NO STATS`, not zero loss. No new ports, dashboard or permanent capture.

The original `srt-status -s 6` UDP estimate is unchanged.

## Security and compatibility

- Required UDP ingress: **11111–11120 and 21111–21120**. Restrict peer IPs using cloud firewall where possible.
- No dashboard, DB, persistent packet captures, proxy interception, external pings, or iperf3.
- Container image uses Ubuntu 22.04 + distro-provided `srt-tools`. On deployment, `docker build` needs internet access; runtime version should be verified in a test VPS.
- Tested for script syntax and offline parser fixtures; **not yet validated end-to-end on a VPS in this PR**.
