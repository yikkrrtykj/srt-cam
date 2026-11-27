export type ChannelMode = "srt-relay" | "udp-passthrough";
export type Direction = "venue_to_hub" | "hub_to_venue";
export type RedundancyType = "single" | "dual_hardware" | "makito_bonding";
export type GroupSeverity =
  | "HEALTHY"
  | "IDLE"
  | "STOPPED"
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
  src_packets?: number;
  src_lost: number;
  src_retrans: number;
  src_dropped: number;
  src_belated?: number;
  src_bytes?: number;
  src_buf_ms?: number;
  src_tsbpd_ms: number;
  src_link_bw_mbps?: number;
  src_max_bw_mbps?: number;
  src_reconnects?: number;
  src_peer_ip: string;
  dst_connected: boolean;
  dst_mbps: number;
  dst_rtt_ms: number;
  dst_packets?: number;
  dst_lost: number;
  dst_retrans: number;
  dst_dropped: number;
  dst_nak_count: number;
  dst_bytes?: number;
  dst_buf_ms?: number;
  dst_link_bw_mbps?: number;
  dst_max_bw_mbps?: number;
  dst_reconnects?: number;
  dst_peer_ip: string;
  path_medium: string;
  has_native_stats: boolean;
  encrypted: boolean;
  video_fps?: number;
  video_resolution?: string;
  video_codec?: string;
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
  enabled?: boolean;
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
  enabled: boolean;
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

export interface LogLine {
  ts?: string;
  level: "error" | "warn" | "connect" | "stats" | "info";
  is_stats: boolean;
  text: string;
}

export interface ChannelLogsResponse {
  node_id: string;
  channel_id: string;
  fetched_at: number;
  total_lines: number;
  lines: LogLine[];
}

export interface FeishuConfigView {
  enabled: boolean;
  webhook_masked: string;
  webhook_configured: boolean;
  secret_configured: boolean;
  debounce_sec: number;
  cooldown_sec: number;
  watchdog_sec: number;
  dashboard_base_url: string;
}

export interface ThresholdConfig {
  min_flow_mbps: number;
  high_rtt_ms: number;
  high_loss_per_sample: number;
  high_retrans: number;
  high_nak_lost: number;
  udp_buf_drop_trigger: number;
}

export interface AlertConfigView {
  feishu: FeishuConfigView;
  thresholds: ThresholdConfig;
  persistent: boolean;
}

export interface AlertConfigUpdate {
  feishu: {
    enabled: boolean;
    webhook_url: string;
    clear_webhook?: boolean;
    secret: string;
    clear_secret?: boolean;
    debounce_sec: number;
    cooldown_sec: number;
    watchdog_sec: number;
    dashboard_base_url: string;
  };
  thresholds: ThresholdConfig;
}

export interface LocalNodeView {
  node_id: string;
  display_name: string;
  region: string;
  public_ip: string;
  cluster_token: string;
}

export interface PeerNodeView {
  node_id: string;
  display_name: string;
  region: string;
  public_ip: string;
  api_url: string;
  token_configured: boolean;
}

export interface NodesConfigView {
  local: LocalNodeView;
  peers: PeerNodeView[];
}

export interface LocalNodeUpdate {
  display_name: string;
  region: string;
  public_ip: string;
}

export interface PeerNodeUpsert {
  node_id: string;
  display_name: string;
  region: string;
  public_ip: string;
  api_url: string;
  api_token: string;
}


