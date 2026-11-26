package notify

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/storage"
)

type fakeSender struct {
	cards []FeishuCard
}

func (f *fakeSender) Send(_ context.Context, card FeishuCard) error {
	f.cards = append(f.cards, card)
	return nil
}

func TestAlertDebounceEscalationAndRecovery(t *testing.T) {
	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	fake := &fakeSender{}
	am := NewAlertManager("vps-1", true, config.FeishuConfig{
		Enabled:     true,
		DebounceSec: 10,
		CooldownSec: 180,
		WatchdogSec: 20,
	}, st, fake)

	ctx := context.Background()
	t0 := time.Date(2026, 11, 26, 20, 0, 0, 0, time.UTC)

	degraded := model.SignalGroupLiveView{
		ID:             "ob-pgm",
		Name:           "OB-PGM",
		DirectionLabel: "上海制作中心 → 海外现场",
		ExpectedActive: true,
		Severity:       model.SeverityDegradedProtected,
		Summary:        "主路电信中断，备路正常兜底",
		ProtectedBy:    "备路[vps-2/备用公网]",
		Legs: []model.LegLiveView{
			{Role: "primary", NodeID: "vps-1", ChannelID: "srt-cam5", NodeOnline: true, Sample: model.ChannelSample{FaultCode: model.FaultUpstreamOffline, FaultLayer: "upstream"}},
		},
	}

	// t0 and t0+5s: inside 10s debounce -> zero alerts
	am.Evaluate(ctx, t0, "测试场次", []model.SignalGroupLiveView{degraded}, true)
	am.Evaluate(ctx, t0.Add(5*time.Second), "测试场次", []model.SignalGroupLiveView{degraded}, true)
	if len(fake.cards) != 0 {
		t.Fatalf("expected 0 alerts during debounce, got %d", len(fake.cards))
	}

	// t0+11s: debounce crossed -> orange degraded card + fault_event persisted
	am.Evaluate(ctx, t0.Add(11*time.Second), "测试场次", []model.SignalGroupLiveView{degraded}, true)
	if len(fake.cards) != 1 || fake.cards[0].Template != "orange" {
		t.Fatalf("expected 1 orange card, got %+v", fake.cards)
	}

	// t0+20s: escalate to CRITICAL_OUTAGE -> immediate red card despite cooldown
	critical := degraded
	critical.Severity = model.SeverityCriticalOutage
	critical.ProtectedBy = ""
	critical.Summary = "主备双路全断"
	am.Evaluate(ctx, t0.Add(20*time.Second), "测试场次", []model.SignalGroupLiveView{critical}, true)
	if len(fake.cards) != 2 || fake.cards[1].Template != "red" {
		t.Fatalf("expected escalation red card, got %+v", fake.cards)
	}

	// t0+40s: recover -> green card + fault_event closed in SQLite
	healthy := degraded
	healthy.Severity = model.SeverityHealthy
	healthy.Summary = "主备双路全部正常通流"
	am.Evaluate(ctx, t0.Add(40*time.Second), "测试场次", []model.SignalGroupLiveView{healthy}, true)
	if len(fake.cards) != 3 || fake.cards[2].Template != "green" || !strings.Contains(fake.cards[2].Title, "[恢复]") {
		t.Fatalf("expected green recovery card, got %+v", fake.cards)
	}

	evs, err := st.QueryFaultEvents(ctx, "ob-pgm", t0.Unix()-10, t0.Unix()+100, 10)
	if err != nil || len(evs) != 1 || evs[0].EndTS != t0.Add(40*time.Second).Unix() {
		t.Fatalf("expected 1 closed fault_event in sqlite, got %+v err=%v", evs, err)
	}
}
