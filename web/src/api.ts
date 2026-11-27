import type {
  AuditEntry,
  AuthStatus,
  ChannelLogsResponse,
  EventSheet,
  FaultEvent,
  GroupTimelineResponse,
  OverviewResponse,
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
  testFeishu: () => reqJSON<{ ok: boolean }>("/api/v1/alerts/test", { method: "POST" }),
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
    case "restart_channel":
      return "重置信号通道";
    case "update_event_sheet":
      return "保存通道配置";
    case "toggle_expected_active":
      return "切换告警监控";
    case "test_feishu":
      return "测试飞书通知";
    default:
      return action;
  }
}

export function severityText(sev: string): { label: string; cls: string; dot: string } {
  switch (sev) {
    case "HEALTHY":
      return { label: "正常在播", cls: "pill-ok", dot: "dot-ok" };
    case "DEGRADED_PROTECTED":
      return { label: "备路接管", cls: "pill-warn", dot: "dot-warn" };
    case "DEGRADED_SINGLE":
      return { label: "信号波动", cls: "pill-warn", dot: "dot-warn" };
    case "CRITICAL_OUTAGE":
      return { label: "信号中断", cls: "pill-crit", dot: "dot-crit" };
    default:
      return { label: "待机", cls: "pill-idle", dot: "dot-idle" };
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
