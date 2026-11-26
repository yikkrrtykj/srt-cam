package storage

import (
	"context"
	"testing"

	"github.com/yikkrrtykj/srt-cam/internal/model"
)

func TestStoreInsertQueryAndPrune(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ctx := context.Background()
	base := int64(1700000000)

	// Insert 10 samples at 2s interval
	for i := int64(0); i < 10; i++ {
		ts := base + i*2
		host := model.HostSample{
			Timestamp:       ts,
			NodeID:          "vps-1",
			CPUPercent:      12.5,
			MemPercent:      35.0,
			UDPRcvbufErrors: 0,
		}
		ch := model.ChannelSample{
			Timestamp:      ts,
			NodeID:         "vps-1",
			ChannelID:      "srt-cam5",
			Mode:           model.ModeSRTRelay,
			ProcessState:   "running",
			SrcConnected:   true,
			SrcMbps:        12.0,
			SrcRTTMs:       42.0,
			DstConnected:   true,
			DstMbps:        12.0,
			DstRTTMs:       55.0,
			PathMedium:     "WAN",
			HasNativeStats: true,
			FaultCode:      model.FaultHealthy,
			FaultLayer:     "none",
		}
		if err := st.InsertSamples(ctx, host, []model.ChannelSample{ch}); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}

	got, err := st.QueryChannelTimeline(ctx, "vps-1", "srt-cam5", base, base+20, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 10 {
		t.Fatalf("got %d samples, want 10", len(got))
	}

	// Open & close a fault event
	evID, err := st.OpenFaultEvent(ctx, model.FaultEvent{
		StartTS:       base + 4,
		NodeID:        "vps-1",
		SignalGroupID: "ob-pgm",
		SignalName:    "OB-PGM",
		ChannelID:     "srt-cam5",
		Role:          "primary",
		Severity:      model.SeverityDegradedProtected,
		FaultCode:     model.FaultUpstreamOffline,
		FaultLayer:    "upstream",
		Summary:       "上游中断，备路兜底",
		ProtectedBy:   "vps-2/srt-cam5",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CloseFaultEvent(ctx, evID, base+12); err != nil {
		t.Fatal(err)
	}
	evs, err := st.QueryFaultEvents(ctx, "ob-pgm", base, base+20, 10)
	if err != nil || len(evs) != 1 || evs[0].EndTS != base+12 {
		t.Fatalf("unexpected fault events: %+v err=%v", evs, err)
	}

	// Audit log
	if err := st.InsertAudit(ctx, model.AuditEntry{
		Timestamp: base + 15,
		Username:  "admin",
		NodeID:    "vps-1",
		Action:    "restart_channel",
		Target:    "srt-cam5",
		Detail:    "safe single-channel restart",
	}); err != nil {
		t.Fatal(err)
	}
	audits, err := st.QueryAudit(ctx, 10)
	if err != nil || len(audits) != 1 || audits[0].Target != "srt-cam5" {
		t.Fatalf("unexpected audits: %+v err=%v", audits, err)
	}

	// Prune first half
	deleted, err := st.PruneOlderThan(ctx, base+10)
	if err != nil {
		t.Fatal(err)
	}
	if deleted < 10 {
		t.Fatalf("expected >=10 pruned rows, got %d", deleted)
	}
	gotAfter, err := st.QueryChannelTimeline(ctx, "vps-1", "srt-cam5", base, base+20, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotAfter) != 5 {
		t.Fatalf("after prune got %d samples, want 5", len(gotAfter))
	}
}
