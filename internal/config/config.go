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
	Previews          []PreviewTarget  `json:"previews,omitempty"`
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

// PreviewTarget configures optional low-CPU keyframe thumbnail snapshots for a channel.
// InputURL can be an HTTP(S) JPEG/PNG snapshot URL (e.g., from Makito/vMix/MediaMTX) or a
// local MPEG-TS/UDP/SRT/RTSP preview feed grabbed via ffmpeg (-skip_frame nokey).
type PreviewTarget struct {
	ChannelID   string `json:"channel_id"`             // e.g., "srt-cam5"
	InputURL    string `json:"input_url"`              // e.g., "udp://127.0.0.1:29115" or "http://.../thumb.jpg"
	IntervalSec int    `json:"interval_sec,omitempty"` // default 5, min 3
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
	Enabled        *bool                `json:"enabled,omitempty"` // nil defaults to true for backward compatibility
	ExpectedActive bool                 `json:"expected_active"`
	Notes          string               `json:"notes,omitempty"`
	Legs           []LegConfig          `json:"legs"`
}

// BoolPtr allocates a pointer to a bool value.
func BoolPtr(v bool) *bool {
	return &v
}

// IsEnabled returns true when the stream switch is ON (nil defaults to true for legacy configs).
func (g SignalGroupConfig) IsEnabled() bool {
	return g.Enabled == nil || *g.Enabled
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

// SaveNodeConfig atomically writes NodeConfig to disk with 0600 permissions.
func SaveNodeConfig(path string, cfg NodeConfig) error {
	if path == "" {
		return nil
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
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
					InPort:    20000 + i,
					OutPort:   21000 + i,
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

// ValidateEventSheet enforces structural integrity plus cross-signal channel and port uniqueness per node.
func ValidateEventSheet(sheet EventSheet) error {
	if err := validateEventSheetStructure(sheet); err != nil {
		return err
	}
	usedChannels := make(map[string]string) // "node/channel" -> signal group name
	usedPorts := make(map[string]string)    // "node:port" -> owner description

	for _, g := range sheet.SignalGroups {
		seenInGroup := make(map[string]bool)
		for _, leg := range g.Legs {
			legKey := leg.NodeID + "/" + leg.ChannelID
			if seenInGroup[legKey] {
				return fmt.Errorf("信号「%s」的主备链路不能重复使用同一服务器的同一通道 (%s)", g.Name, legKey)
			}
			seenInGroup[legKey] = true

			if owner, exists := usedChannels[legKey]; exists {
				return fmt.Errorf("通道冲突：信号「%s」与「%s」不能同时使用同一服务器的同一通道 (%s)", g.Name, owner, legKey)
			}
			usedChannels[legKey] = g.Name

			if leg.InPort != 0 {
				if leg.InPort < 1 || leg.InPort > 65535 {
					return fmt.Errorf("信号「%s」的推流/监听端口 %d 超出有效范围 (1-65535)", g.Name, leg.InPort)
				}
				inPortKey := fmt.Sprintf("%s:%d", leg.NodeID, leg.InPort)
				if owner, exists := usedPorts[inPortKey]; exists {
					return fmt.Errorf("端口冲突：信号「%s」与%s不能在同一服务器 (%s) 上共用端口 %d", g.Name, owner, leg.NodeID, leg.InPort)
				}
				usedPorts[inPortKey] = fmt.Sprintf("信号「%s」", g.Name)
			}

			// For Mode A (srt-relay), out_port is also bound locally on the VPS and must be unique.
			// For Mode B (udp-passthrough), out_port is the remote studio decoder port, not bound on VPS.
			if leg.Mode == model.ModeSRTRelay && leg.OutPort != 0 {
				if leg.OutPort < 1 || leg.OutPort > 65535 {
					return fmt.Errorf("信号「%s」的拉流端口 %d 超出有效范围 (1-65535)", g.Name, leg.OutPort)
				}
				if leg.OutPort == leg.InPort {
					return fmt.Errorf("端口冲突：信号「%s」的推流端口与拉流端口不能相同 (%d)", g.Name, leg.OutPort)
				}
				outPortKey := fmt.Sprintf("%s:%d", leg.NodeID, leg.OutPort)
				if owner, exists := usedPorts[outPortKey]; exists {
					return fmt.Errorf("端口冲突：信号「%s」与%s不能在同一服务器 (%s) 上共用端口 %d", g.Name, owner, leg.NodeID, leg.OutPort)
				}
				usedPorts[outPortKey] = fmt.Sprintf("信号「%s」", g.Name)
			}
		}
	}
	return nil
}

func validateEventSheetStructure(sheet EventSheet) error {
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
		roleCounts := make(map[string]int)
		for lidx, leg := range g.Legs {
			if leg.NodeID == "" || leg.ChannelID == "" {
				return fmt.Errorf("signal_group %q leg[%d]: node_id and channel_id are required", g.ID, lidx)
			}
			if leg.Mode != model.ModeSRTRelay && leg.Mode != model.ModeUDPPassthrough {
				return fmt.Errorf("signal_group %q leg[%d]: invalid mode %q", g.ID, lidx, leg.Mode)
			}
			roleCounts[leg.Role]++
		}
		if len(g.Legs) == 2 && (roleCounts["primary"] != 1 || roleCounts["backup"] != 1) {
			return fmt.Errorf("信号「%s」双路配置必须为一主一备（不能同时为主路或同时为备路）", g.Name)
		}
	}
	return nil
}

// ValidateEditLock enforces Haivision-style stream lock rules: while a signal's stream switch
// is ON, transport parameters and deletion are blocked, while non-disruptive metadata (name,
// direction, alarm toggle, notes, carrier/device remarks) remain freely editable.
func ValidateEditLock(current, next EventSheet) error {
	nextByID := make(map[string]SignalGroupConfig, len(next.SignalGroups))
	for _, g := range next.SignalGroups {
		nextByID[g.ID] = g
	}
	for _, cur := range current.SignalGroups {
		ng, exists := nextByID[cur.ID]
		if !exists {
			if cur.IsEnabled() {
				return fmt.Errorf("信号「%s」正在运行，请先关闭流开关后再删除", cur.Name)
			}
			continue
		}
		if ng.IsEnabled() != cur.IsEnabled() {
			return fmt.Errorf("请通过流开关启停信号「%s」", cur.Name)
		}
		if !cur.IsEnabled() {
			continue
		}
		if ng.RedundancyType != cur.RedundancyType {
			return fmt.Errorf("信号「%s」正在运行，请先关闭流开关后再修改单路/主备架构", cur.Name)
		}
		if len(ng.Legs) != len(cur.Legs) {
			return fmt.Errorf("信号「%s」正在运行，请先关闭流开关后再增删主备链路", cur.Name)
		}
		for i := range cur.Legs {
			a, b := cur.Legs[i], ng.Legs[i]
			if a.Role != b.Role ||
				a.NodeID != b.NodeID ||
				a.ChannelID != b.ChannelID ||
				a.Mode != b.Mode ||
				a.InPort != b.InPort ||
				a.OutPort != b.OutPort ||
				a.TargetAddr != b.TargetAddr {
				return fmt.Errorf("信号「%s」正在运行，请先关闭流开关后再修改服务器、通道、模式或端口参数（名称和备注可直接修改）", cur.Name)
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
	if err := validateEventSheetStructure(sheet); err != nil {
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
	return s.writeSheet(next)
}

func (s *EventStore) writeSheet(next EventSheet) error {
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
	if err := s.writeSheet(cur); err != nil {
		return cur, err
	}
	return cur, nil
}

// SetEnabled toggles the Haivision-style stream power/lock state for a single signal group atomically.
func (s *EventStore) SetEnabled(groupID string, enabled bool) (EventSheet, error) {
	cur := s.Get()
	found := false
	for i := range cur.SignalGroups {
		if cur.SignalGroups[i].ID == groupID {
			cur.SignalGroups[i].Enabled = BoolPtr(enabled)
			found = true
			break
		}
	}
	if !found {
		return cur, fmt.Errorf("signal group %q not found", groupID)
	}
	if err := s.writeSheet(cur); err != nil {
		return cur, err
	}
	return cur, nil
}
