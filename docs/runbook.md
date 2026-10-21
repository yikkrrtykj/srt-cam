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
