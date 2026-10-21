# Field runbook — SRT bidirectional relay

## First response to a report

1. Ask which CAM, symptom (no picture / disconnect / black / freeze / artifacts), whether sending and receiving vMix are on, and whether that CAM is expected to be active.
2. `docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' srt-cam6` and `docker logs --since 2m --tail 60 srt-cam6`.
3. `sudo srt-status -s 6`: check sampled input/output. Counts reflect UDP packets matching these ports; they are not codec health, SRT handshake success, or measured network loss.
4. If input missing, verify upstream sender then capture only that channel; if output missing, verify receiver requests and logs. If both flow, request end-point SRT metrics and check video decode.

## Safe targeted diagnostics

```bash
# CAM6 input UDP from Shanghai
sudo timeout -s INT 10 tcpdump -ni any -l -c 30 'udp and port 21116'
# CAM6 SRT receiver side to Egypt
sudo timeout -s INT 10 tcpdump -ni any -l -c 30 'udp and port 11116'
# Socket buffer drops (compare values at two different times)
grep '^Udp:' /proc/net/snmp
sudo ss -uanmp | grep -E ':(21116|11116)[[:space:]]'
```

Reality on the same VPS can cause SRT UDP between `srt-live-transmit` and sing-box to appear on `lo`. Do not conclude a source is offline just because no corresponding media packets appear on `ens3`. `tcpdump` **0 captured** is not sufficient to infer the SRT source state, and `packets received by filter` is not media-packet count.

## Interpreting `srt-live-transmit` logs

- `Accepted SRT source connection`: sender had connected; not proof of current continuity.
- `received` grows: relay process accepted source bytes during the interval.
- `sent` grows: relay process delivered some bytes to target socket; not proof that receiving vMix decoded video.
- `lost` grows while `sent=0`: target may be absent; **not** a network loss-rate measurement.
- `RCV-DROPPED`: late/drop event on a SRT receiving socket. The Gateway has two separate SRT sessions; a receiver can show zero loss even when upstream video content has already been impaired.

## Planned improvements (not in v0.1)

Accurate per-SRT-session SRT stats (RTT, retransmit, skipped/late, session state) require verified `srt-live-transmit` statistics support and a planned config change. Do not silently turn the snapshot estimator into automated failover or restart logic. Future Feishu alerts require an event schedule/expected-active map and debouncing.

## Deployment acceptance

Before live-event approval: verify 10 listeners, correct firewall exposure, one real vMix push/pull per desired direction, bidirectional stability and end-to-end picture quality, recovery on sender and receiver disconnect, and failure behavior when VPS/relevant ISP is unavailable. Two VPS in different networks are needed for genuine primary/backup; this repo only deploys a **single** independent relay host per installation.

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
