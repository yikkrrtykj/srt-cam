export type ChannelMode = "srt-relay" | "udp-passthrough";
export type Direction = "venue_to_hub" | "hub_to_venue";
export type RedundancyType = "single" | "dual_hardware" | "makito_bonding";
export type GroupSeverity =
  | "HEALTHY"
  | "IDLE"
  | "DEGRADED_PROTECTED"
  | "DEGRADED_SINGLE"
  | "CRITICAL_OUTAGE";

export interface ChannelSample {
  ts: number;
  node_id: string;
  channel_id: string;
  mode: ChannelMode;
  process_state: string;
  restart_count: number;
  uptime_sec: number;
  src_connected: boolean;
  src_mbps: number;
  src_rtt_ms: number;
  src_lost: number;
  src_retrans: number;
  src_dropped: number;
  src_tsbpd_ms: number;
  src_peer_ip: string;
  dst_connected: boolean;
  dst_mbps: number;
  dst_rtt_ms: number;
  dst_lost: number;
  dst_retrans: number;
  dst_dropped: number;
  dst_nak_count: number;
  dst_peer_ip: string;
  path_medium: string;
  has_native_stats: boolean;
  encrypted: boolean;
  fault_code: string;
  fault_layer: string;
  fault_summary: string;
}

export interface HostSample {
  ts: number;
  node_id: string;
  cpu_percent: number;
  mem_percent: number;
  net_rx_mbps: number;
  net_tx_mbps: number;
  udp_rcvbuf_errors: number;
  udp_in_errors: number;
  udp_sndbuf_errors: number;
  load1: number;
}

export interface NodeLiveStatus {
  node_id: string;
  display_name: string;
  region: string;
  public_ip: string;
  online: boolean;
  error?: string;
  updated_at: number;
  host: HostSample;
  channels: Record<string, ChannelSample>;
}

export interface LegConfig {
  role: string;
  node_id: string;
  channel_id: string;
  mode: ChannelMode;
  carrier: string;
  src_device: string;
  dst_device: string;
  in_port: number;
  out_port: number;
  target_addr?: string;
}

export interface SignalGroupConfig {
  id: string;
  name: string;
  direction: Direction;
  redundancy_type: RedundancyType;
  expected_active: boolean;
  notes?: string;
  legs: LegConfig[];
}

export interface EventSheet {
  event_name: string;
  sites: {
    venue: string;
    hub: string;
  };
  signal_groups: SignalGroupConfig[];
}

export interface LegLiveView {
  role: string;
  node_id: string;
  node_name: string;
  channel_id: string;
  mode: ChannelMode;
  carrier: string;
  src_device: string;
  dst_device: string;
  in_port: number;
  out_port: number;
  target_addr?: string;
  node_online: boolean;
  sample: ChannelSample;
  host: HostSample;
}

export interface SignalGroupLiveView {
  id: string;
  name: string;
  direction: Direction;
  direction_label: string;
  redundancy_type: RedundancyType;
  expected_active: boolean;
  notes?: string;
  severity: GroupSeverity;
  summary: string;
  protected_by?: string;
  legs: LegLiveView[];
}

export interface OverviewResponse {
  event_name: string;
  sites: { venue: string; hub: string };
  node_id: string;
  demo_mode: boolean;
  updated_at: number;
  nodes: NodeLiveStatus[];
  groups: SignalGroupLiveView[];
}

export interface FaultEvent {
  id: number;
  start_ts: number;
  end_ts: number;
  node_id: string;
  signal_group_id: string;
  signal_name: string;
  channel_id: string;
  role: string;
  severity: GroupSeverity;
  fault_code: string;
  fault_layer: string;
  summary: string;
  protected_by?: string;
}

export interface LegTimeline {
  leg: LegConfig;
  node_name: string;
  samples: ChannelSample[];
  host: HostSample[];
  error?: string;
}

export interface GroupTimelineResponse {
  event_name: string;
  from_ts: number;
  to_ts: number;
  group: SignalGroupConfig;
  direction_label: string;
  live_group: SignalGroupLiveView;
  legs: LegTimeline[];
  events: FaultEvent[];
}

export interface AuditEntry {
  id: number;
  ts: number;
  username: string;
  node_id: string;
  action: string;
  target: string;
  detail: string;
}

export interface AuthStatus {
  auth_enabled: boolean;
  authenticated: boolean;
  username: string;
  demo_mode: boolean;
  node_id: string;
  display_name: string;
}
