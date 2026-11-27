package collector

import (
	"encoding/binary"
	"testing"
	"time"
)

func TestParseSRTLogsNativeFixtureAndStaleness(t *testing.T) {
	now := time.Date(2026, 10, 22, 1, 40, 10, 0, time.UTC)
	logs := "" +
		"2026-10-22T01:39:55Z Accepted SRT source connection from 198.51.100.20:51234\n" +
		"2026-10-22T01:39:56Z Accepted SRT target connection from 127.0.0.1:49876\n" +
		`2026-10-22T01:40:05Z {"sid":101,"link":{"rtt":190},"recv":{"packets":3000,"packetsLost":23,"packetsRetransmitted":20,"packetsDropped":3,"msTsbPdDelay":1000,"mbitRate":6.3},"send":{"packets":0}}` + "\n" +
		`2026-10-22T01:40:06Z {"sid":202,"link":{"rtt":69},"recv":{"packets":0},"send":{"packets":3000,"packetsLost":5,"packetsRetransmitted":5,"packetsDropped":0,"mbitRate":6.4}}` + "\n"

	got := ParseSRTLogs(logs, now, 20*time.Second)
	if !got.HasNativeStats {
		t.Fatalf("expected HasNativeStats=true")
	}
	if got.SrcMbps != 6.3 || got.SrcRTTMs != 190 || got.SrcDropped != 3 || got.SrcTSBPDMs != 1000 {
		t.Fatalf("unexpected source metrics: %+v", got)
	}
	if got.DstMbps != 6.4 || got.DstRTTMs != 69 || got.DstLost != 5 {
		t.Fatalf("unexpected target metrics: %+v", got)
	}
	if got.PathMedium != "WAN+LO" {
		t.Fatalf("PathMedium = %q, want WAN+LO", got.PathMedium)
	}

	// Advance time past stale window -> rates & RTT must decay to 0 so outages aren't hidden
	stale := ParseSRTLogs(logs, now.Add(45*time.Second), 20*time.Second)
	if stale.SrcMbps != 0 || stale.DstMbps != 0 || stale.SrcRTTMs != 0 {
		t.Fatalf("expected stale Mbps/RTT to decay to 0, got src=%.2f dst=%.2f rtt=%.1f", stale.SrcMbps, stale.DstMbps, stale.SrcRTTMs)
	}
}

func TestParseSRTLogsSinceDeduplicatesAndSums(t *testing.T) {
	t1 := time.Date(2026, 10, 22, 1, 40, 5, 0, time.UTC)
	t2 := t1.Add(1 * time.Second)
	t3 := t1.Add(2 * time.Second)
	logs := "" +
		`2026-10-22T01:40:05Z {"sid":101,"link":{"rtt":190,"bandwidth":48.5},"recv":{"packets":250,"packetsLost":2,"packetsRetransmitted":2,"packetsDropped":0,"msTsbPdDelay":1000,"mbitRate":3.1},"send":{"packets":0}}` + "\n" +
		`2026-10-22T01:40:06Z {"sid":101,"link":{"rtt":192,"bandwidth":49.0},"recv":{"packets":250,"packetsLost":3,"packetsRetransmitted":2,"packetsDropped":1,"msTsbPdDelay":1000,"mbitRate":3.4},"send":{"packets":0}}` + "\n" +
		`2026-10-22T01:40:07Z {"sid":101,"link":{"rtt":191,"bandwidth":50.2},"recv":{"packets":250,"packetsLost":1,"packetsRetransmitted":1,"packetsDropped":0,"msTsbPdDelay":1000,"mbitRate":3.5},"send":{"packets":0}}` + "\n"

	// Cursor at t1 -> must sum ONLY t2 + t3 (packets=500, lost=4, retrans=3, dropped=1)
	delta := ParseSRTLogsSince(logs, t3.Add(time.Second), 30*time.Second, t1, time.Time{})
	if delta.SrcPackets != 500 || delta.SrcLost != 4 || delta.SrcRetrans != 3 || delta.SrcDropped != 1 {
		t.Fatalf("unexpected delta after t1: %+v", delta)
	}
	if delta.SrcMbps != 3.5 || delta.SrcLinkBWMbps != 50.2 || !delta.SrcLastTS.Equal(t3) {
		t.Fatalf("unexpected live rates: mbps=%.2f bw=%.2f ts=%v", delta.SrcMbps, delta.SrcLinkBWMbps, delta.SrcLastTS)
	}

	// Re-polling same log with cursor at t3 -> packet deltas must be 0, while live rate remains 3.5
	repeat := ParseSRTLogsSince(logs, t3.Add(3*time.Second), 30*time.Second, t3, time.Time{})
	if repeat.SrcPackets != 0 || repeat.SrcLost != 0 || repeat.SrcRetrans != 0 || repeat.SrcDropped != 0 {
		t.Fatalf("expected zero duplicate deltas on repeat poll, got %+v", repeat)
	}
	if repeat.SrcMbps != 3.5 || repeat.SrcRTTMs != 191 || !repeat.SrcConnected {
		t.Fatalf("expected live rate preserved between reports, got %+v", repeat)
	}
	_ = t2
}

func TestDemuxDockerStream(t *testing.T) {
	line := []byte("2026-10-22T01:40:01Z hello\n")
	frame := make([]byte, 8+len(line))
	frame[0] = 1
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(line)))
	copy(frame[8:], line)

	if got := DemuxDockerStream(frame); got != string(line) {
		t.Fatalf("DemuxDockerStream = %q, want %q", got, string(line))
	}
}

func TestParseUDPSNMP(t *testing.T) {
	sample := `Ip: Forwarding DefaultTTL
Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors
Udp: 123456 2 7 987654 19 3 0
`
	inErr, rcvErr, sndErr := ParseUDPSNMP(sample)
	if inErr != 7 || rcvErr != 19 || sndErr != 3 {
		t.Fatalf("ParseUDPSNMP = (%d,%d,%d), want (7,19,3)", inErr, rcvErr, sndErr)
	}
}
