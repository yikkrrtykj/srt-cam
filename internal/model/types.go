package model

// ChannelMode identifies the data-plane mode of a channel leg.
type ChannelMode string

const (
	ModeSRTRelay       ChannelMode = "srt-relay"
	ModeUDPPassthrough ChannelMode = "udp-passthrough"
)

// Direction indicates whether a logical signal flows from remote venue to production hub or vice versa.
type Direction string

const (
	DirectionVenueToHub Direction = "venue_to_hub"
	DirectionHubToVenue Direction = "hub_to_venue"
)

// RedundancyType classifies how primary/backup legs protect a logical signal group.
type RedundancyType string

const (
	RedundancySingle        RedundancyType = "single"
	RedundancyDualHardware  RedundancyType = "dual_hardware"
	RedundancyMakitoBonding RedundancyType = "makito_bonding"
)

// FaultCode is the deterministic single-channel fault isolation classification.
type FaultCode string

const (
	FaultHealthy            FaultCode = "HEALTHY"
	FaultIdleExpectedOff    FaultCode = "IDLE_EXPECTED_OFF"
	FaultCloudProcessDown   FaultCode = "CLOUD_PROCESS_DOWN"
	FaultCloudUDPBufDrop    FaultCode = "CLOUD_UDP_BUF_DROP"
	FaultUpstreamOffline    FaultCode = "UPSTREAM_OFFLINE"
	FaultDownstreamOffline  FaultCode = "DOWNSTREAM_OFFLINE"
	FaultUpstreamDegraded   FaultCode = "UPSTREAM_DEGRADED"
	FaultDownstreamDegraded FaultCode = "DOWNSTREAM_DEGRADED"
	FaultTunnelLOWarning    FaultCode = "TUNNEL_LO_WARNING"
	FaultNoNativeStats      FaultCode = "NO_NATIVE_STATS"
	FaultNodeUnreachable    FaultCode = "NODE_UNREACHABLE"
)

// GroupSeverity classifies the combined health of a logical signal group (primary + backup).
type GroupSeverity string

const (
	SeverityHealthy           GroupSeverity = "HEALTHY"
	SeverityIdle              GroupSeverity = "IDLE"
	SeverityDegradedProtected GroupSeverity = "DEGRADED_PROTECTED"
	SeverityDegradedSingle    GroupSeverity = "DEGRADED_SINGLE"
	SeverityCriticalOutage    GroupSeverity = "CRITICAL_OUTAGE"
)

// ChannelSample is a single point-in-time telemetry snapshot for one physical channel leg.
// It powers Layer 1 (upstream), Layer 2 (process/host), Layer 3 (downstream), and Layer 4 (diagnosis).
type ChannelSample struct {
	Timestamp int64       `json:"ts"`
	NodeID    string      `json:"node_id"`
	ChannelID string      `json:"channel_id"` // e.g., "srt-cam1" or "srt-pass1"
	Mode      ChannelMode `json:"mode"`

	// Layer 2: container / process health
	ProcessState string `json:"process_state"` // running, exited, restarting, not_found
	RestartCount int    `json:"restart_count"`
	UptimeSec    int64  `json:"uptime_sec"`

	// Layer 1: upstream (Sender -> Cloud)
	SrcConnected  bool    `json:"src_connected"`
	SrcMbps       float64 `json:"src_mbps"`
	SrcRTTMs      float64 `json:"src_rtt_ms"`
	SrcPackets    int64   `json:"src_packets,omitempty"`
	SrcLost       int64   `json:"src_lost"`
	SrcRetrans    int64   `json:"src_retrans"`
	SrcDropped    int64   `json:"src_dropped"`
	SrcTSBPDMs    float64 `json:"src_tsbpd_ms"`
	SrcLinkBWMbps float64 `json:"src_link_bw_mbps,omitempty"`
	SrcPeerIP     string  `json:"src_peer_ip"`

	// Layer 3: downstream (Cloud -> Receiver)
	DstConnected  bool    `json:"dst_connected"`
	DstMbps       float64 `json:"dst_mbps"`
	DstRTTMs      float64 `json:"dst_rtt_ms"`
	DstPackets    int64   `json:"dst_packets,omitempty"`
	DstLost       int64   `json:"dst_lost"`
	DstRetrans    int64   `json:"dst_retrans"`
	DstDropped    int64   `json:"dst_dropped"`
	DstNAKCount   int64   `json:"dst_nak_count"`
	DstLinkBWMbps float64 `json:"dst_link_bw_mbps,omitempty"`
	DstPeerIP     string  `json:"dst_peer_ip"`

	// Path metadata & telemetry quality
	PathMedium     string `json:"path_medium"`      // WAN, LO, WAN+LO, -
	HasNativeStats bool   `json:"has_native_stats"` // true if Mode A JSON stats or Mode B passd stats observed
	Encrypted      bool   `json:"encrypted"`

	// Layer 4: single-channel automatic fault isolation
	FaultCode    FaultCode `json:"fault_code"`
	FaultLayer   string    `json:"fault_layer"`   // none, upstream, cloud, downstream, tunnel
	FaultSummary string    `json:"fault_summary"` // human-readable Chinese attribution text
}

// HostSample captures Layer 2 VPS host health including Linux kernel UDP socket buffer drops.
type HostSample struct {
	Timestamp       int64   `json:"ts"`
	NodeID          string  `json:"node_id"`
	CPUPercent      float64 `json:"cpu_percent"`
	MemPercent      float64 `json:"mem_percent"`
	NetRxMbps       float64 `json:"net_rx_mbps"`
	NetTxMbps       float64 `json:"net_tx_mbps"`
	UDPRcvbufErrors int64   `json:"udp_rcvbuf_errors"` // delta since previous sample
	UDPInErrors     int64   `json:"udp_in_errors"`     // delta since previous sample
	UDPSndbufErrors int64   `json:"udp_sndbuf_errors"` // delta since previous sample
	Load1           float64 `json:"load1"`
}

// FaultEvent records a persistent incident or recovery window for timeline overlays & evidence export.
type FaultEvent struct {
	ID            int64         `json:"id"`
	StartTS       int64         `json:"start_ts"`
	EndTS         int64         `json:"end_ts"` // 0 if ongoing
	NodeID        string        `json:"node_id"`
	SignalGroupID string        `json:"signal_group_id"`
	SignalName    string        `json:"signal_name"`
	ChannelID     string        `json:"channel_id"`
	Role          string        `json:"role"` // primary, backup, single
	Severity      GroupSeverity `json:"severity"`
	FaultCode     FaultCode     `json:"fault_code"`
	FaultLayer    string        `json:"fault_layer"`
	Summary       string        `json:"summary"`
	ProtectedBy   string        `json:"protected_by,omitempty"`
}

// AuditEntry logs operator actions such as safe single-channel restarts or config updates.
type AuditEntry struct {
	ID        int64  `json:"id"`
	Timestamp int64  `json:"ts"`
	Username  string `json:"username"`
	NodeID    string `json:"node_id"`
	Action    string `json:"action"`
	Target    string `json:"target"`
	Detail    string `json:"detail"`
}

// NodeLiveStatus is the payload exchanged between peer VPS nodes and served to the web dashboard.
type NodeLiveStatus struct {
	NodeID      string                   `json:"node_id"`
	DisplayName string                   `json:"display_name"`
	Region      string                   `json:"region"`
	PublicIP    string                   `json:"public_ip"`
	Online      bool                     `json:"online"`
	Error       string                   `json:"error,omitempty"`
	UpdatedAt   int64                    `json:"updated_at"`
	Host        HostSample               `json:"host"`
	Channels    map[string]ChannelSample `json:"channels"`
}

// LegLiveView combines static event-sheet metadata with live telemetry for one physical leg.
type LegLiveView struct {
	Role        string        `json:"role"` // primary, backup, single
	NodeID      string        `json:"node_id"`
	NodeName    string        `json:"node_name"`
	ChannelID   string        `json:"channel_id"`
	Mode        ChannelMode   `json:"mode"`
	Carrier     string        `json:"carrier"`
	SrcDevice   string        `json:"src_device"`
	DstDevice   string        `json:"dst_device"`
	InPort      int           `json:"in_port"`
	OutPort     int           `json:"out_port"`
	TargetAddr  string        `json:"target_addr,omitempty"`
	NodeOnline  bool          `json:"node_online"`
	Sample      ChannelSample `json:"sample"`
	Host        HostSample    `json:"host"`
}

// SignalGroupLiveView is the top-level card shown in the bidirectional overview & timeline header.
type SignalGroupLiveView struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Direction       Direction      `json:"direction"`
	DirectionLabel  string         `json:"direction_label"`
	RedundancyType  RedundancyType `json:"redundancy_type"`
	ExpectedActive  bool           `json:"expected_active"`
	Notes           string         `json:"notes,omitempty"`
	Severity        GroupSeverity  `json:"severity"`
	Summary         string         `json:"summary"`
	ProtectedBy     string         `json:"protected_by,omitempty"`
	Legs            []LegLiveView  `json:"legs"`
}
