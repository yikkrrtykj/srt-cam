package config

import (
	"path/filepath"
	"testing"
)

func TestExampleConfigsValid(t *testing.T) {
	cfgPath := filepath.Join("..", "..", "deploy", "config.example.json")
	cfg, err := LoadNodeConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadNodeConfig(%s): %v", cfgPath, err)
	}
	if cfg.NodeID != "vps-1" || len(cfg.Peers) != 2 {
		t.Fatalf("unexpected example node config: node=%q peers=%d", cfg.NodeID, len(cfg.Peers))
	}

	evPath := filepath.Join("..", "..", "deploy", "event-sheet.example.json")
	store, err := NewEventStore(evPath, cfg.NodeID)
	if err != nil {
		t.Fatalf("NewEventStore(%s): %v", evPath, err)
	}
	sheet := store.Get()
	if len(sheet.SignalGroups) < 5 {
		t.Fatalf("expected bidirectional example groups, got %d", len(sheet.SignalGroups))
	}
	if err := ValidateEventSheet(sheet); err != nil {
		t.Fatalf("ValidateEventSheet failed: %v", err)
	}
}

func TestCrossGroupChannelAndPortConflictValidation(t *testing.T) {
	base := func() EventSheet {
		return EventSheet{
			EventName: "Conflict Test",
			Sites:     SitesConfig{Venue: "A", Hub: "B"},
			SignalGroups: []SignalGroupConfig{
				{
					ID: "g1", Name: "讯道 1", Direction: "venue_to_hub", RedundancyType: "single",
					Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam1", Mode: "srt-relay", InPort: 20001, OutPort: 21001}},
				},
				{
					ID: "g2", Name: "讯道 2", Direction: "venue_to_hub", RedundancyType: "single",
					Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam2", Mode: "srt-relay", InPort: 20002, OutPort: 21002}},
				},
			},
		}
	}

	// Valid distinct channels & ports on same node
	if err := ValidateEventSheet(base()); err != nil {
		t.Fatalf("expected valid sheet, got: %v", err)
	}

	// Same node + same channel across two different signals -> must fail
	dupChan := base()
	dupChan.SignalGroups[1].Legs[0].ChannelID = "srt-cam1"
	if err := ValidateEventSheet(dupChan); err == nil {
		t.Fatalf("expected error on duplicate channel across signals")
	}

	// Same node + same port across two different signals -> must fail
	dupPort := base()
	dupPort.SignalGroups[1].Legs[0].InPort = 20001
	if err := ValidateEventSheet(dupPort); err == nil {
		t.Fatalf("expected error on duplicate port across signals on same node")
	}

	// Same node + in_port colliding with another group's out_port -> must fail
	crossPort := base()
	crossPort.SignalGroups[1].Legs[0].InPort = 21001
	if err := ValidateEventSheet(crossPort); err == nil {
		t.Fatalf("expected error on in_port colliding with out_port on same node")
	}

	// Different nodes using same channel & ports -> must succeed
	diffNode := base()
	diffNode.SignalGroups[1].Legs[0].NodeID = "vps-2"
	diffNode.SignalGroups[1].Legs[0].ChannelID = "srt-cam1"
	diffNode.SignalGroups[1].Legs[0].InPort = 20001
	diffNode.SignalGroups[1].Legs[0].OutPort = 21001
	if err := ValidateEventSheet(diffNode); err != nil {
		t.Fatalf("expected different nodes to allow same channel/port, got: %v", err)
	}

	// Mode B remote out_port is NOT bound on VPS and must not collide with local relay ports
	modeB := base()
	modeB.SignalGroups[1].Legs[0] = LegConfig{
		Role: "single", NodeID: "vps-1", ChannelID: "srt-pass1", Mode: "udp-passthrough",
		InPort: 31111, OutPort: 20001, TargetAddr: "203.0.113.10:20001",
	}
	if err := ValidateEventSheet(modeB); err != nil {
		t.Fatalf("Mode B remote out_port should not collide with VPS local port, got: %v", err)
	}
}

func TestValidateEditLock(t *testing.T) {
	cur := EventSheet{
		EventName: "Lock Test",
		Sites:     SitesConfig{Venue: "A", Hub: "B"},
		SignalGroups: []SignalGroupConfig{
			{
				ID: "live", Name: "PGM", Direction: "venue_to_hub", RedundancyType: "single",
				Enabled: BoolPtr(true), ExpectedActive: true,
				Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam1", Mode: "srt-relay", Carrier: "电信", InPort: 20001, OutPort: 21001}},
			},
			{
				ID: "stopped", Name: "CAM2", Direction: "venue_to_hub", RedundancyType: "single",
				Enabled: BoolPtr(false), ExpectedActive: false,
				Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam2", Mode: "srt-relay", Carrier: "公网", InPort: 20002, OutPort: 21002}},
			},
		},
	}

	// Allowed: renaming running stream, changing remarks/alarm, and editing stopped stream's port/channel
	okNext := cur
	okNext.SignalGroups = []SignalGroupConfig{
		{
			ID: "live", Name: "主机位 PGM", Direction: "hub_to_venue", RedundancyType: "single",
			Enabled: BoolPtr(true), ExpectedActive: false, Notes: "已改备注",
			Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam1", Mode: "srt-relay", Carrier: "联通备注", InPort: 20001, OutPort: 21001}},
		},
		{
			ID: "stopped", Name: "CAM2", Direction: "venue_to_hub", RedundancyType: "single",
			Enabled: BoolPtr(false), ExpectedActive: false,
			Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam3", Mode: "srt-relay", Carrier: "公网", InPort: 20003, OutPort: 21003}},
		},
	}
	if err := ValidateEditLock(cur, okNext); err != nil {
		t.Fatalf("expected metadata edit on running + transport edit on stopped to succeed, got: %v", err)
	}

	// Blocked: changing running stream's channel/port
	badPort := cur
	badPort.SignalGroups = []SignalGroupConfig{
		{
			ID: "live", Name: "PGM", Direction: "venue_to_hub", RedundancyType: "single",
			Enabled: BoolPtr(true), ExpectedActive: true,
			Legs: []LegConfig{{Role: "single", NodeID: "vps-1", ChannelID: "srt-cam4", Mode: "srt-relay", Carrier: "电信", InPort: 20004, OutPort: 21004}},
		},
		cur.SignalGroups[1],
	}
	if err := ValidateEditLock(cur, badPort); err == nil {
		t.Fatalf("expected error when modifying channel/port of running stream")
	}

	// Blocked: deleting running stream
	badDel := cur
	badDel.SignalGroups = []SignalGroupConfig{cur.SignalGroups[1]}
	if err := ValidateEditLock(cur, badDel); err == nil {
		t.Fatalf("expected error when deleting running stream")
	}

	// Allowed: deleting stopped stream
	okDel := cur
	okDel.SignalGroups = []SignalGroupConfig{cur.SignalGroups[0]}
	if err := ValidateEditLock(cur, okDel); err != nil {
		t.Fatalf("expected deleting stopped stream to succeed, got: %v", err)
	}
}
