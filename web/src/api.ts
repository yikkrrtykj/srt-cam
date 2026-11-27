import type {
  AlertConfigUpdate,
  AlertConfigView,
  AuditEntry,
  AuthStatus,
  ChannelLogsResponse,
  EventSheet,
  FaultEvent,
  GroupTimelineResponse,
  LegLiveView,
  LocalNodeUpdate,
  NodesConfigView,
  OverviewResponse,
  PeerNodeUpsert,
  SignalGroupLiveView,
} from "./types";

async function reqJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `请求失败 (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  authStatus: () => reqJSON<AuthStatus>("/api/v1/auth/status"),
  login: (username: string, password: string) =>
    reqJSON<{ ok: boolean; username: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => reqJSON<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
  overview: () => reqJSON<OverviewResponse>("/api/v1/overview"),
  timeline: (groupId: string, fromTS: number, toTS: number) =>
    reqJSON<GroupTimelineResponse>(
      `/api/v1/timeline/${encodeURIComponent(groupId)}?from=${fromTS}&to=${toTS}`
    ),
  events: (groupId?: string) => {
    const q = groupId ? `?group_id=${encodeURIComponent(groupId)}` : "";
    return reqJSON<{ events: FaultEvent[] }>(`/api/v1/events${q}`);
  },
  getEventSheet: () => reqJSON<EventSheet>("/api/v1/event-sheet"),
  saveEventSheet: (sheet: EventSheet) =>
    reqJSON<EventSheet>("/api/v1/event-sheet", {
      method: "PUT",
      body: JSON.stringify(sheet),
    }),
  toggleExpectedActive: (groupId: string, expectedActive: boolean) =>
    reqJSON<{ ok: boolean; event_sheet: EventSheet }>(
      `/api/v1/signal-groups/${encodeURIComponent(groupId)}/expected-active`,
      {
        method: "PATCH",
        body: JSON.stringify({ expected_active: expectedActive }),
      }
    ),
  restartChannel: (nodeId: string, channelId: string, confirmChannelId: string) =>
    reqJSON<{ ok: boolean }>(
      `/api/v1/channels/${encodeURIComponent(nodeId)}/${encodeURIComponent(channelId)}/restart`,
      {
        method: "POST",
        body: JSON.stringify({ confirm_channel_id: confirmChannelId }),
      }
    ),
  channelLogs: (nodeId: string, channelId: string, tail: number, hideStats: boolean) =>
    reqJSON<ChannelLogsResponse>(
      `/api/v1/channels/${encodeURIComponent(nodeId)}/${encodeURIComponent(channelId)}/logs?tail=${tail}&hide_stats=${hideStats ? "1" : "0"}`
    ),
  auditLogs: () => reqJSON<{ entries: AuditEntry[] }>("/api/v1/audit"),
  getAlertConfig: () => reqJSON<AlertConfigView>("/api/v1/alerts/config"),
  saveAlertConfig: (payload: AlertConfigUpdate) =>
    reqJSON<AlertConfigView>("/api/v1/alerts/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  testFeishu: () => reqJSON<{ ok: boolean }>("/api/v1/alerts/test", { method: "POST" }),
  getNodesConfig: () => reqJSON<NodesConfigView>("/api/v1/nodes/config"),
  updateLocalNode: (payload: LocalNodeUpdate) =>
    reqJSON<NodesConfigView>("/api/v1/nodes/local", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  upsertPeerNode: (payload: PeerNodeUpsert) =>
    reqJSON<NodesConfigView>("/api/v1/nodes/peers", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deletePeerNode: (nodeId: string) =>
    reqJSON<NodesConfigView>(`/api/v1/nodes/peers/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
    }),
};

export function formatTime(unixSec: number): string {
  if (!unixSec) return "-";
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(unixSec: number): string {
  if (!unixSec) return "-";
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatUptime(sec: number): string {
  if (!sec || sec <= 0) return "-";
  const days = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}天${hrs}时`;
  if (hrs > 0) return `${hrs}时${mins}分`;
  return `${mins}分`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "-";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatPct(part: number, total: number): string {
  if (!total || total <= 0 || !part || part <= 0) return "0.00%";
  const pct = (part / total) * 100;
  return pct >= 10 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

export function resolveNodeHost(nodes: { node_id: string; public_ip: string }[], nodeId: string): string {
  const found = nodes.find((n) => n.node_id === nodeId);
  if (found?.public_ip) return found.public_ip;
  if (typeof window !== "undefined" && window.location.hostname) {
    return window.location.hostname;
  }
  return "<服务器IP>";
}

export function auditActionText(action: string): string {
  switch (action) {
    case "safe_single_restart":
    case "restart_channel":
      return "重置信号通道";
    case "update_event_sheet":
      return "保存通道配置";
    case "toggle_expected_active":
      return "切换断流告警";
    case "update_alert_config":
      return "修改告警设置";
    case "test_feishu_alert":
    case "test_feishu":
      return "发送测试飞书";
    case "update_local_node":
      return "更新本机信息";
    case "upsert_peer_node":
      return "添加/编辑服务器";
    case "delete_peer_node":
      return "移除远端服务器";
    default:
      return action;
  }
}

export function faultLayerLabel(layer: string): string {
  switch (layer) {
    case "upstream":
      return "推流段";
    case "downstream":
      return "拉流段";
    case "cloud":
      return "中转服务器";
    case "tunnel":
      return "转发隧道";
    default:
      return "整路";
  }
}

export type BroadcastTone = "ok" | "warn" | "crit" | "idle";

export function isGroupAwaitingDownstream(g: SignalGroupLiveView): boolean {
  return (
    g.expected_active &&
    g.severity === "CRITICAL_OUTAGE" &&
    g.legs.length > 0 &&
    g.legs.every((l) => l.node_online && l.sample.fault_code === "DOWNSTREAM_OFFLINE")
  );
}

export function groupStatusMeta(g: SignalGroupLiveView): { label: string; tone: BroadcastTone } {
  if (isGroupAwaitingDownstream(g)) {
    return { label: "待拉流", tone: "warn" };
  }
  return severityMeta(g.severity);
}

export function severityMeta(sev: string): { label: string; tone: BroadcastTone } {
  switch (sev) {
    case "HEALTHY":
      return { label: "正常在播", tone: "ok" };
    case "DEGRADED_PROTECTED":
      return { label: "备路接管", tone: "warn" };
    case "DEGRADED_SINGLE":
      return { label: "信号波动", tone: "warn" };
    case "CRITICAL_OUTAGE":
      return { label: "信号中断", tone: "crit" };
    default:
      return { label: "待机", tone: "idle" };
  }
}

export function legTone(leg: LegLiveView): BroadcastTone {
  if (!leg.node_online) return "crit";
  switch (leg.sample.fault_code) {
    case "HEALTHY":
      return "ok";
    case "IDLE_EXPECTED_OFF":
      return "idle";
    case "DOWNSTREAM_OFFLINE":
      return "warn";
    case "UPSTREAM_OFFLINE":
    case "CLOUD_PROCESS_DOWN":
    case "NODE_UNREACHABLE":
      return "crit";
    default:
      return "warn";
  }
}

export function redundancyText(t: string): string {
  switch (t) {
    case "makito_bonding":
      return "单机双路无缝";
    case "dual_hardware":
      return "双机热备";
    default:
      return "单路传输";
  }
}
