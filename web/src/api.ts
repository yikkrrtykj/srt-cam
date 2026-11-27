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
  setSignalGroupEnabled: (groupId: string, enabled: boolean, force = false) =>
    reqJSON<{ ok: boolean; enabled: boolean; event_sheet: EventSheet }>(
      `/api/v1/signal-groups/${encodeURIComponent(groupId)}/enabled`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled, force }),
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

function formatAudioChannelsLabel(ch?: string): string {
  const v = (ch || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "stereo") return "立体声";
  if (v === "mono") return "单声道";
  return ch!.trim();
}

function compactResolution(res?: string): string {
  const v = (res || "").trim().toLowerCase();
  if (v === "3840x2160") return "4K";
  if (v === "1920x1080") return "1080p";
  if (v === "1280x720") return "720p";
  return (res || "").trim();
}

export function formatVideoFps(leg?: LegLiveView): {
  text: string;
  fullText: string;
  compactFullText: string;
  metaText: string;
  tooltip: string;
} {
  if (!leg || !leg.node_online) {
    return { text: "-", fullText: "-", compactFullText: "-", metaText: "", tooltip: "未检测到视频流" };
  }
  const s = leg.sample;
  if (!s.src_connected || s.src_mbps < 0.1) {
    return { text: "-", fullText: "-", compactFullText: "-", metaText: "", tooltip: "当前无视频信号" };
  }
  if (leg.mode === "udp-passthrough" || s.encrypted) {
    return {
      text: "-",
      fullText: "-",
      compactFullText: "-",
      metaText: "",
      tooltip: "加密透传模式不解密视频载荷，无法探测帧率",
    };
  }
  const fps = s.video_fps ?? 0;
  const metaParts = [s.video_resolution, s.video_codec].filter(Boolean);
  const metaText = metaParts.join(" · ");
  if (fps <= 0) {
    if (metaText) {
      const compactMeta = [compactResolution(s.video_resolution), s.video_codec]
        .filter(Boolean)
        .join(" · ");
      return {
        text: metaText,
        fullText: metaText,
        compactFullText: compactMeta || metaText,
        metaText,
        tooltip: metaText,
      };
    }
    return {
      text: "探测中",
      fullText: "探测中",
      compactFullText: "探测中",
      metaText: "",
      tooltip: "正在随缩略图探测视频帧率与分辨率",
    };
  }
  const fpsNum = Math.abs(fps - Math.round(fps)) < 0.05 ? String(Math.round(fps)) : fps.toFixed(2);
  const fullParts = [...metaParts, `${fpsNum} fps`];
  const compactParts = [compactResolution(s.video_resolution), s.video_codec, `${fpsNum}fps`].filter(Boolean);
  return {
    text: `${fpsNum} fps`,
    fullText: fullParts.join(" · "),
    compactFullText: compactParts.join(" · "),
    metaText,
    tooltip: fullParts.join(" · "),
  };
}

export function formatAudioSummary(leg?: LegLiveView): {
  text: string;
  fullText: string;
  compactFullText: string;
  metaText: string;
  tone: BroadcastTone;
  tooltip: string;
} {
  if (!leg || !leg.node_online) {
    return {
      text: "-",
      fullText: "-",
      compactFullText: "-",
      metaText: "",
      tone: "idle",
      tooltip: "未检测到音频流",
    };
  }
  const s = leg.sample;
  if (s.fault_code === "STREAM_STOPPED" || !s.src_connected || s.src_mbps < 0.1) {
    return {
      text: "-",
      fullText: "-",
      compactFullText: "-",
      metaText: "",
      tone: "idle",
      tooltip: "当前无音视频信号",
    };
  }
  if (leg.mode === "udp-passthrough" || s.encrypted) {
    return {
      text: "-",
      fullText: "-",
      compactFullText: "-",
      metaText: "",
      tone: "idle",
      tooltip: "加密透传模式不解密载荷，无法读取音频采样率与码率",
    };
  }

  const rate = s.audio_sample_rate ?? 0;
  const kbps = s.audio_bitrate_kbps ?? 0;
  const tracks = s.audio_tracks ?? 0;
  const videoProbed = (s.video_fps ?? 0) > 0 || !!s.video_codec || !!s.video_resolution;

  if (rate <= 0 && tracks === 0) {
    if (videoProbed) {
      return {
        text: "无音轨",
        fullText: "无音轨",
        compactFullText: "无音轨",
        metaText: "",
        tone: "warn",
        tooltip: "已检测到视频画面，但流中未发现音轨（请检查编码器音频开关）",
      };
    }
    return {
      text: "探测中",
      fullText: "探测中",
      compactFullText: "探测中",
      metaText: "",
      tone: "idle",
      tooltip: "正在随缩略图探测音频采样率与码率",
    };
  }

  const rateText =
    rate > 0
      ? rate % 1000 === 0
        ? `${rate / 1000}k`
        : `${(rate / 1000).toFixed(1)}k`
      : "";
  const kbpsText = kbps > 0 ? `${kbps}k` : "";
  const trackSuffix = tracks > 1 ? ` ×${tracks}` : "";
  const chLabel = formatAudioChannelsLabel(s.audio_channels);

  let text = "-";
  if (rateText && kbpsText) {
    text = `${rateText} · ${kbpsText}${trackSuffix}`;
  } else if (rateText) {
    text = `${rateText}${s.audio_codec ? ` ${s.audio_codec}` : ""}${trackSuffix}`;
  } else if (kbpsText) {
    text = `${kbpsText}${trackSuffix}`;
  } else if (s.audio_codec) {
    text = `${s.audio_codec}${trackSuffix}`;
  }

  const compactParts = [
    s.audio_codec,
    rateText,
    kbpsText ? `${kbpsText}${trackSuffix}` : "",
  ].filter(Boolean);
  if (!kbpsText && trackSuffix && compactParts.length > 0) {
    compactParts[compactParts.length - 1] += trackSuffix;
  }
  const compactFullText = compactParts.length > 0 ? compactParts.join(" · ") : text;
  const fullText = chLabel ? `${compactFullText} · ${chLabel}` : compactFullText;
  const metaText = [s.audio_codec, chLabel, tracks > 1 ? `${tracks}音轨` : ""]
    .filter(Boolean)
    .join(" · ");

  const tooltip =
    s.audio_detail ||
    [
      s.audio_codec,
      rate > 0 ? (rate % 1000 === 0 ? `${rate / 1000} kHz` : `${(rate / 1000).toFixed(1)} kHz`) : "",
      chLabel,
      kbps > 0 ? `${kbps} kb/s` : "码率未上报(VBR)",
    ]
      .filter(Boolean)
      .join(" · ");

  return { text, fullText, compactFullText, metaText, tone: "ok", tooltip };
}

export interface ChannelLossSummary {
  text: string;
  tone: BroadcastTone;
  lost: number;
  drops: number;
  detail: string;
}

export function channelLossSummary(leg?: LegLiveView): ChannelLossSummary {
  if (!leg || !leg.node_online) {
    return { text: "-", tone: "idle", lost: 0, drops: 0, detail: "节点离线" };
  }
  const s = leg.sample;
  if (s.fault_code === "STREAM_STOPPED" || (!s.src_connected && s.src_mbps < 0.1)) {
    return { text: "0.0%", tone: "idle", lost: 0, drops: 0, detail: "当前无流传输" };
  }

  if (leg.mode === "udp-passthrough") {
    const lost = Math.max(s.src_lost, s.dst_nak_count);
    const drops = s.src_dropped;
    const total = (s.src_packets ?? 0) + lost;
    const pct = total > 0 ? ((drops > 0 ? drops : lost) / total) * 100 : 0;
    const pctStr = `${pct.toFixed(1)}%`;
    const detail = `透传：重传 ${s.src_retrans} · 请求重发 ${s.dst_nak_count} · 未恢复弃包 ${drops} / 总包 ${total}`;
    if (drops > 0) {
      return { text: `弃${drops} (${pctStr})`, tone: "crit", lost, drops, detail };
    }
    if (lost > 0 || s.src_retrans > 0) {
      return { text: `${lost} (${pctStr})`, tone: "warn", lost, drops, detail };
    }
    return { text: "0 (0.0%)", tone: "ok", lost: 0, drops: 0, detail };
  }

  const upTotal = (s.src_packets ?? 0) + s.src_lost;
  const downTotal = (s.dst_packets ?? 0) + s.dst_lost;
  const upPct = upTotal > 0 ? (s.src_lost / upTotal) * 100 : 0;
  const downPct = downTotal > 0 ? (s.dst_lost / downTotal) * 100 : 0;
  const drops = s.src_dropped + s.dst_dropped;
  const worstIsDown = downPct > upPct;
  const worstLost = worstIsDown ? s.dst_lost : s.src_lost;
  const worstPct = worstIsDown ? downPct : upPct;
  const dropBase = Math.max(upTotal, downTotal, 1);
  const dropPct = (drops / dropBase) * 100;

  const detail = `入站丢包 ${s.src_lost}/${upTotal} (${upPct.toFixed(2)}%) 弃包 ${s.src_dropped} · 出站丢包 ${s.dst_lost}/${downTotal} (${downPct.toFixed(2)}%) 弃包 ${s.dst_dropped}`;

  if (drops > 0) {
    return {
      text: `弃${drops} (${dropPct.toFixed(1)}%)`,
      tone: "crit",
      lost: s.src_lost + s.dst_lost,
      drops,
      detail,
    };
  }
  if (worstLost > 0) {
    return {
      text: `${worstLost} (${worstPct.toFixed(1)}%)`,
      tone: "warn",
      lost: s.src_lost + s.dst_lost,
      drops: 0,
      detail,
    };
  }
  return { text: "0 (0.0%)", tone: "ok", lost: 0, drops: 0, detail };
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
    case "start_signal_stream":
      return "启动信号流";
    case "stop_signal_stream":
      return "停止信号流";
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
    g.enabled &&
    g.legs.length > 0 &&
    g.legs.every((l) => l.node_online && l.sample.fault_code === "DOWNSTREAM_OFFLINE")
  );
}

export function groupStatusMeta(g: SignalGroupLiveView): { label: string; tone: BroadcastTone } {
  if (!g.enabled || g.severity === "STOPPED") {
    return { label: "已停止", tone: "idle" };
  }
  if (isGroupAwaitingDownstream(g)) {
    return { label: "待拉流", tone: "warn" };
  }
  if (
    g.severity === "DEGRADED_SINGLE" &&
    g.legs.some((l) => l.node_online && (l.sample.src_dropped > 0 || l.sample.dst_dropped > 0))
  ) {
    return { label: "严重丢包", tone: "crit" };
  }
  return severityMeta(g.severity);
}

export function severityMeta(sev: string): { label: string; tone: BroadcastTone } {
  switch (sev) {
    case "HEALTHY":
      return { label: "正常", tone: "ok" };
    case "STOPPED":
      return { label: "已停止", tone: "idle" };
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
  if (leg.sample.fault_code === "STREAM_STOPPED") return "idle";
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
