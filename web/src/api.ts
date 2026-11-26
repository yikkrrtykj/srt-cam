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

export function severityText(sev: string): { label: string; cls: string; dot: string } {
  switch (sev) {
    case "HEALTHY":
      return { label: "ON AIR", cls: "pill-ok", dot: "dot-ok" };
    case "DEGRADED_PROTECTED":
      return { label: "BACKUP", cls: "pill-warn", dot: "dot-warn" };
    case "DEGRADED_SINGLE":
      return { label: "DEGRADED", cls: "pill-warn", dot: "dot-warn" };
    case "CRITICAL_OUTAGE":
      return { label: "OFFLINE", cls: "pill-crit", dot: "dot-crit" };
    default:
      return { label: "STANDBY", cls: "pill-idle", dot: "dot-idle" };
  }
}

export function redundancyText(t: string): string {
  switch (t) {
    case "makito_bonding":
      return "Path Redundancy";
    case "dual_hardware":
      return "双机热备";
    default:
      return "单路";
  }
}
