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
