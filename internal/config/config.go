package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// NodeConfig holds per-VPS daemon settings (auth, storage, peers, Feishu, data-plane endpoints).
type NodeConfig struct {
	NodeID            string           `json:"node_id"`
	DisplayName       string           `json:"display_name"`
	Region            string           `json:"region"`
	PublicIP          string           `json:"public_ip"`
	ListenAddr        string           `json:"listen_addr"`
	DockerSocket      string           `json:"docker_socket"`
	DBPath            string           `json:"db_path"`
	RetentionDays     int              `json:"retention_days"`
	SampleIntervalSec int              `json:"sample_interval_sec"`
	ClusterToken      string           `json:"cluster_token"`
	PrimaryMonitorURL string           `json:"primary_monitor_url,omitempty"`
	IsPrimaryMonitor  bool             `json:"is_primary_monitor"`
	Auth              AuthConfig       `json:"auth"`
	Feishu            FeishuConfig     `json:"feishu"`
	Thresholds        ThresholdConfig  `json:"thresholds"`
	Peers             []PeerNodeConfig `json:"peers"`
	Passthroughs      []PassTarget     `json:"passthroughs"`
	DemoMode          bool             `json:"demo_mode,omitempty"`
}

// AuthConfig configures browser login credentials and session security.
type AuthConfig struct {
	Username      string `json:"username"`
	PasswordHash  string `json:"password_hash"` // bcrypt hash
	SessionSecret string `json:"session_secret"`
	CookieSecure  bool   `json:"cookie_secure"`
}

// FeishuConfig configures Feishu custom bot webhook notifications.
type FeishuConfig struct {
	Enabled         bool   `json:"enabled"`
	WebhookURL      string `json:"webhook_url"`
	Secret          string `json:"secret,omitempty"`
	DebounceSec     int    `json:"debounce_sec"`
	CooldownSec     int    `json:"cooldown_sec"`
	WatchdogSec     int    `json:"watchdog_sec"` // backup node triggers direct alert if primary unreachable
	DashboardBaseURL string `json:"dashboard_base_url,omitempty"`
}

// ThresholdConfig defines tunable thresholds for automatic fault isolation.
type ThresholdConfig struct {
	MinFlowMbps       float64 `json:"min_flow_mbps"`
	HighRTTMs         float64 `json:"high_rtt_ms"`
	HighLossPerSample int64   `json:"high_loss_per_sample"`
	HighRetrans       int64   `json:"high_retrans"`
	HighNAKLost       int64   `json:"high_nak_lost"`
	UDPBufDropTrigger int64   `json:"udp_buf_drop_trigger"`
}

// PeerNodeConfig points to another VPS running srt-camd for unified multi-node viewing.
type PeerNodeConfig struct {
	NodeID      string `json:"node_id"`
	DisplayName string `json:"display_name"`
	Region      string `json:"region"`
	PublicIP    string `json:"public_ip"`
	APIURL      string `json:"api_url"`
	APIToken    string `json:"api_token"`
}

// PassTarget configures a local Mode B srt-passd metrics endpoint to poll on this VPS.
type PassTarget struct {
	ChannelID  string `json:"channel_id"`  // e.g., "srt-pass1"
	MetricsURL string `json:"metrics_url"` // e.g., "http://127.0.0.1:19101/stats"
	Container  string `json:"container,omitempty"`
}

// EventSheet models a broadcast production's bidirectional signal routing & primary/backup pairing.
type EventSheet struct {
	EventName    string              `json:"event_name"`
	Sites        SitesConfig         `json:"sites"`
	SignalGroups []SignalGroupConfig `json:"signal_groups"`
}

// SitesConfig names the two production endpoints (e.g., Venue vs Remote Production Center).
type SitesConfig struct {
	Venue string `json:"venue"`
	Hub   string `json:"hub"`
}

// SignalGroupConfig represents one logical video feed (single or primary+backup pair across VPS nodes).
type SignalGroupConfig struct {
	ID             string               `json:"id"`
	Name           string               `json:"name"`
	Direction      model.Direction      `json:"direction"`
	RedundancyType model.RedundancyType `json:"redundancy_type"`
	ExpectedActive bool                 `json:"expected_active"`
	Notes          string               `json:"notes,omitempty"`
	Legs           []LegConfig          `json:"legs"`
}

// LegConfig binds one physical channel on a specific VPS node to a logical signal group.
type LegConfig struct {
	Role       string            `json:"role"`       // primary, backup, single
	NodeID     string            `json:"node_id"`    // matches NodeConfig.NodeID or Peer.NodeID
	ChannelID  string            `json:"channel_id"` // e.g., "srt-cam5" or "srt-pass1"
	Mode       model.ChannelMode `json:"mode"`
	Carrier    string            `json:"carrier"`    // e.g., "电信", "联通", "备用公网"
	SrcDevice  string            `json:"src_device"` // e.g., "上海Encoder#1(主) Out1"
	DstDevice  string            `json:"dst_device"` // e.g., "印尼Decoder#1(主) In9"
	InPort     int               `json:"in_port"`
	OutPort    int               `json:"out_port"`
	TargetAddr string            `json:"target_addr,omitempty"` // Mode B remote decoder IP:port
}

// DirectionLabel formats a human-readable Chinese direction string from site names.
func (e EventSheet) DirectionLabel(dir model.Direction) string {
	venue := e.Sites.Venue
	if venue == "" {
		venue = "现场"
	}
	hub := e.Sites.Hub
	if hub == "" {
		hub = "制作中心"
	}
	if dir == model.DirectionHubToVenue {
		return hub + " → " + venue
	}
	return venue + " → " + hub
}

// DefaultNodeConfig returns safe defaults suitable for a standalone VPS.
func DefaultNodeConfig() NodeConfig {
	return NodeConfig{
		NodeID:            "vps-1",
		DisplayName:       "VPS-1 (主节点)",
		Region:            "Singapore",
		ListenAddr:        "127.0.0.1:8080",
		DockerSocket:      "/var/run/docker.sock",
		DBPath:            "/var/lib/srt-cam/telemetry.db",
		RetentionDays:     7,
		SampleIntervalSec: 2,
		IsPrimaryMonitor:  true,
		Auth: AuthConfig{
			Username: "admin",
		},
		Feishu: FeishuConfig{
			DebounceSec: 10,
			CooldownSec: 180,
			WatchdogSec: 20,
		},
		Thresholds: ThresholdConfig{
			MinFlowMbps:       0.10,
			HighRTTMs:         250,
			HighLossPerSample: 20,
			HighRetrans:       30,
			HighNAKLost:       20,
			UDPBufDropTrigger: 10,
		},
	}
}

// LoadNodeConfig reads and validates a NodeConfig JSON file.
func LoadNodeConfig(path string) (NodeConfig, error) {
	cfg := DefaultNodeConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read node config %q: %w", path, err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse node config %q: %w", path, err)
	}
	if cfg.NodeID == "" {
		return cfg, errors.New("node_id must not be empty")
	}
	if cfg.SampleIntervalSec < 1 {
		cfg.SampleIntervalSec = 2
	}
	if cfg.RetentionDays < 1 {
		cfg.RetentionDays = 7
	}
	if cfg.Feishu.DebounceSec < 1 {
		cfg.Feishu.DebounceSec = 10
	}
	if cfg.Feishu.CooldownSec < 10 {
		cfg.Feishu.CooldownSec = 180
	}
	if cfg.Feishu.WatchdogSec < 5 {
		cfg.Feishu.WatchdogSec = 20
	}
	if cfg.Thresholds.MinFlowMbps <= 0 {
		cfg.Thresholds.MinFlowMbps = 0.10
	}
	if cfg.Thresholds.HighRTTMs <= 0 {
		cfg.Thresholds.HighRTTMs = 250
	}
	return cfg, nil
}

// DefaultEventSheet returns a clean 10-channel default sheet matching existing srt-cam1..10.
func DefaultEventSheet(nodeID string) EventSheet {
	if nodeID == "" {
		nodeID = "vps-1"
	}
	groups := make([]SignalGroupConfig, 0, 10)
	for i := 1; i <= 10; i++ {
		dir := model.DirectionVenueToHub
		if i >= 5 {
			dir = model.DirectionHubToVenue
		}
		groups = append(groups, SignalGroupConfig{
			ID:             fmt.Sprintf("cam%d", i),
			Name:           fmt.Sprintf("CAM%d", i),
			Direction:      dir,
			RedundancyType: model.RedundancySingle,
			ExpectedActive: false,
			Legs: []LegConfig{
				{
					Role:      "single",
					NodeID:    nodeID,
					ChannelID: fmt.Sprintf("srt-cam%d", i),
					Mode:      model.ModeSRTRelay,
					InPort:    21110 + i,
					OutPort:   11110 + i,
				},
			},
		})
	}
	return EventSheet{
		EventName: "默认 10 路场次",
		Sites: SitesConfig{
			Venue: "现场",
			Hub:   "远程制作中心",
		},
		SignalGroups: groups,
	}
}

// ValidateEventSheet enforces structural integrity before saving or loading.
func ValidateEventSheet(sheet EventSheet) error {
	seenGroups := make(map[string]bool)
	for idx, g := range sheet.SignalGroups {
		if g.ID == "" {
			return fmt.Errorf("signal_groups[%d]: id is required", idx)
		}
		if seenGroups[g.ID] {
			return fmt.Errorf("duplicate signal_group id %q", g.ID)
		}
		seenGroups[g.ID] = true
		if g.Name == "" {
			return fmt.Errorf("signal_group %q: name is required", g.ID)
		}
		if g.Direction != model.DirectionVenueToHub && g.Direction != model.DirectionHubToVenue {
			return fmt.Errorf("signal_group %q: invalid direction %q", g.ID, g.Direction)
		}
		if len(g.Legs) == 0 {
			return fmt.Errorf("signal_group %q: at least one leg is required", g.ID)
		}
		for lidx, leg := range g.Legs {
			if leg.NodeID == "" || leg.ChannelID == "" {
				return fmt.Errorf("signal_group %q leg[%d]: node_id and channel_id are required", g.ID, lidx)
			}
			if leg.Mode != model.ModeSRTRelay && leg.Mode != model.ModeUDPPassthrough {
				return fmt.Errorf("signal_group %q leg[%d]: invalid mode %q", g.ID, lidx, leg.Mode)
			}
		}
	}
	return nil
}

// EventStore manages thread-safe access and atomic persistence for event-sheet.json.
type EventStore struct {
	mu    sync.RWMutex
	path  string
	sheet EventSheet
}

// NewEventStore loads an event sheet from path, or creates defaults if the file does not exist.
func NewEventStore(path, defaultNodeID string) (*EventStore, error) {
	if path == "" {
		return &EventStore{sheet: DefaultEventSheet(defaultNodeID)}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &EventStore{path: path, sheet: DefaultEventSheet(defaultNodeID)}, nil
		}
		return nil, fmt.Errorf("read event sheet %q: %w", path, err)
	}
	var sheet EventSheet
	if err := json.Unmarshal(data, &sheet); err != nil {
		return nil, fmt.Errorf("parse event sheet %q: %w", path, err)
	}
	if err := ValidateEventSheet(sheet); err != nil {
		return nil, fmt.Errorf("validate event sheet %q: %w", path, err)
	}
	return &EventStore{path: path, sheet: sheet}, nil
}

// Get returns a deep-enough copy of the current EventSheet.
func (s *EventStore) Get() EventSheet {
	s.mu.RLock()
	defer s.mu.RUnlock()
	raw, _ := json.Marshal(s.sheet)
	var cp EventSheet
	_ = json.Unmarshal(raw, &cp)
	return cp
}

// Save validates and atomically writes the new EventSheet to disk.
func (s *EventStore) Save(next EventSheet) error {
	if err := ValidateEventSheet(next); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path != "" {
		if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
			return err
		}
		tmp := s.path + ".tmp"
		if err := os.WriteFile(tmp, raw, 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, s.path); err != nil {
			return err
		}
	}
	s.sheet = next
	return nil
}

// SetExpectedActive toggles expected_active for a single signal group atomically.
func (s *EventStore) SetExpectedActive(groupID string, active bool) (EventSheet, error) {
	cur := s.Get()
	found := false
	for i := range cur.SignalGroups {
		if cur.SignalGroups[i].ID == groupID {
			cur.SignalGroups[i].ExpectedActive = active
			found = true
			break
		}
	}
	if !found {
		return cur, fmt.Errorf("signal group %q not found", groupID)
	}
	if err := s.Save(cur); err != nil {
		return cur, err
	}
	return cur, nil
}
