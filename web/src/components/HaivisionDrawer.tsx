import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import type {
  ChannelSample,
  GroupTimelineResponse,
  LegLiveView,
  NodeLiveStatus,
  SignalGroupLiveView,
} from "../types";
import {
  api,
  formatBytes,
  formatPct,
  formatTime,
  formatUptime,
  resolveNodeHost,
} from "../api";

interface Props {
  group: SignalGroupLiveView;
  nodes: NodeLiveStatus[];
  theme: "dark" | "light";
  legIdx: number;
  onSelectLeg: (idx: number) => void;
}

const WINDOWS = [
  { label: "5分钟", sec: 5 * 60 },
  { label: "15分钟", sec: 15 * 60 },
  { label: "30分钟", sec: 30 * 60 },
  { label: "2小时", sec: 2 * 3600 },
  { label: "24小时", sec: 24 * 3600 },
];

const COLOR_PERIWINKLE = "#818cf8";
const COLOR_AMBER = "#f59e0b";
const COLOR_TEAL = "#2dd4bf";
const COLOR_SLATE = "#64748b";
const COLOR_CRIMSON = "#ef4444";

function legDotClass(leg: LegLiveView): string {
  if (!leg.node_online) return "dot-crit";
  switch (leg.sample.fault_code) {
    case "HEALTHY":
      return "dot-ok";
    case "IDLE_EXPECTED_OFF":
      return "dot-idle";
    case "DOWNSTREAM_OFFLINE":
      return "dot-warn";
    case "UPSTREAM_OFFLINE":
    case "CLOUD_PROCESS_DOWN":
    case "NODE_UNREACHABLE":
      return "dot-crit";
    default:
      return "dot-warn";
  }
}

function srcStatusText(leg: LegLiveView): { label: string; color: string } {
  if (!leg.node_online) return { label: "服务器离线", color: "var(--crit)" };
  const s = leg.sample;
  if (s.fault_code === "IDLE_EXPECTED_OFF") return { label: "待机", color: "var(--text-muted)" };
  if (s.fault_code === "CLOUD_PROCESS_DOWN") return { label: "通道未启动", color: "var(--crit)" };
  if (!s.src_connected && s.src_mbps < 0.1) return { label: "未连接", color: "var(--crit)" };
  if (s.src_mbps < 0.1) return { label: "无信号", color: "var(--crit)" };
  if (s.fault_code === "UPSTREAM_DEGRADED") return { label: "推流波动", color: "var(--warn)" };
  return { label: "正常推流", color: "var(--ok)" };
}

function dstStatusText(leg: LegLiveView): { label: string; color: string } {
  if (!leg.node_online) return { label: "服务器离线", color: "var(--crit)" };
  const s = leg.sample;
  if (s.fault_code === "IDLE_EXPECTED_OFF") return { label: "待机", color: "var(--text-muted)" };
  if (s.fault_code === "CLOUD_PROCESS_DOWN") return { label: "通道未启动", color: "var(--crit)" };
  if (s.fault_code === "DOWNSTREAM_OFFLINE") return { label: "待拉流", color: "var(--warn)" };
  if (s.dst_mbps < 0.1) return { label: "未连接", color: "var(--crit)" };
  if (s.fault_code === "DOWNSTREAM_DEGRADED") return { label: "拉流波动", color: "var(--warn)" };
  return { label: "正在接收", color: "var(--ok)" };
}

function toSeries<T extends { ts: number }>(
  items: T[],
  gapThresholdSec: number,
  pick: (item: T, dtSec: number) => number
): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const dtSec = i > 0 ? Math.max(cur.ts - items[i - 1].ts, 2) : 2;
    if (i > 0 && cur.ts - items[i - 1].ts > gapThresholdSec) {
      out.push([(items[i - 1].ts + 1) * 1000, null]);
    }
    out.push([cur.ts * 1000, pick(cur, dtSec)]);
  }
  return out;
}

function legRetransMbps(mbps: number, pkts: number, retrans: number, dtSec: number): number {
  if (retrans <= 0) return 0;
  if (pkts > 0 && mbps > 0) {
    return (mbps * retrans) / pkts;
  }
  return (retrans * 1360 * 8) / (Math.max(dtSec, 2) * 1e6);
}

function calcRetransMbps(s: ChannelSample, isPass: boolean, dtSec: number): number {
  const srcVal = legRetransMbps(s.src_mbps, s.src_packets ?? 0, s.src_retrans, dtSec);
  if (isPass) return Number(srcVal.toFixed(3));
  const dstVal = legRetransMbps(s.dst_mbps, s.dst_packets ?? 0, s.dst_retrans, dtSec);
  return Number((srcVal + dstVal).toFixed(3));
}

function calcMinMaxPositive(samples: ChannelSample[], pick: (s: ChannelSample) => number): [number, number] | null {
  let minV = Infinity;
  let maxV = 0;
  for (const s of samples) {
    const v = pick(s);
    if (v > 0) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (!Number.isFinite(minV) || maxV <= 0) return null;
  return [minV, maxV];
}

export function HaivisionDrawer({ group, nodes, theme, legIdx, onSelectLeg }: Props) {
  const [windowSec, setWindowSec] = useState(5 * 60);
  const [timeline, setTimeline] = useState<GroupTimelineResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState("");

  // Interactive legend pill toggles (Haivision Gateway style)
  const [showRtt, setShowRtt] = useState(true);
  const [showDstRtt, setShowDstRtt] = useState(true);
  const [showLatency, setShowLatency] = useState(true);
  const [showRecvBuf, setShowRecvBuf] = useState(true);

  const [showRate, setShowRate] = useState(true);
  const [showRetrans, setShowRetrans] = useState(true);
  const [showLinkBw, setShowLinkBw] = useState(false);
  const [showDropped, setShowDropped] = useState(true);

  const leftChartRef = useRef<HTMLDivElement>(null);
  const rightChartRef = useRef<HTMLDivElement>(null);

  const safeIdx = legIdx < group.legs.length ? legIdx : 0;
  const activeLeg = group.legs[safeIdx];

  useEffect(() => {
    let active = true;
    async function load() {
      const now = Math.floor(Date.now() / 1000);
      try {
        const res = await api.timeline(group.id, now - windowSec, now);
        if (active) setTimeline(res);
      } catch {
        // keep last timeline snapshot
      }
    }
    void load();
    const pollMs = windowSec >= 6 * 3600 ? 15000 : 5000;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [group.id, windowSec]);

  const activeLegHistory = useMemo(() => {
    if (!timeline || !activeLeg) return null;
    return (
      timeline.legs.find(
        (l) => l.leg.node_id === activeLeg.node_id && l.leg.channel_id === activeLeg.channel_id
      ) ?? timeline.legs[safeIdx] ?? null
    );
  }, [timeline, activeLeg, safeIdx]);

  const isPass = activeLeg?.mode === "udp-passthrough";
  const rttLineColor = theme === "dark" ? "#e2e8f0" : "#1e293b";

  // Render Left (DELAY & BUFFER) & Right (BANDWIDTH USE) Haivision charts
  useEffect(() => {
    const leftEl = leftChartRef.current;
    const rightEl = rightChartRef.current;
    if (!leftEl || !rightEl || !timeline || !activeLegHistory) return;

    const cLeft = echarts.init(leftEl);
    const cRight = echarts.init(rightEl);

    const isDark = theme === "dark";
    const splitColor = isDark ? "rgba(255,255,255,0.06)" : "#edf0f5";
    const axisColor = isDark ? "#383e4c" : "#cbd5e1";
    const labelColor = isDark ? "#8b94a5" : "#64748b";
    const tooltipStyle = {
      trigger: "axis" as const,
      axisPointer: { type: "line" as const, lineStyle: { color: "#788294", type: "dashed" as const } },
      backgroundColor: isDark ? "rgba(20, 22, 28, 0.96)" : "rgba(15, 23, 42, 0.94)",
      borderColor: "#404756",
      textStyle: { color: "#eceff4", fontSize: 12 },
    };

    const spanSec = Math.max(timeline.to_ts - timeline.from_ts, windowSec);
    // Keep 2h / 24h downsampled buckets connected smoothly without false gaps
    const gapThresholdSec = Math.max(30, Math.ceil((spanSec / 600) * 3));

    const xAxis = {
      type: "time" as const,
      min: timeline.from_ts * 1000,
      max: timeline.to_ts * 1000,
      axisLine: { lineStyle: { color: axisColor } },
      axisTick: { show: false },
      axisLabel: {
        color: labelColor,
        fontSize: 10,
        formatter: (v: number) => {
          const d = new Date(v);
          const pad = (n: number) => String(n).padStart(2, "0");
          if (spanSec >= 12 * 3600) {
            return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
          }
          return formatTime(Math.floor(v / 1000));
        },
      },
    };

    const samples = activeLegHistory.samples;

    // Left Chart: DELAY & BUFFER (ms) for Mode A, or SRT Control Events (pkt) for Mode B
    const leftSeries: echarts.SeriesOption[] = [];
    if (!isPass) {
      if (showLatency) {
        leftSeries.push({
          name: "设定缓冲 (ms)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: COLOR_AMBER },
          lineStyle: { width: 1.8, color: COLOR_AMBER },
          data: toSeries(samples, gapThresholdSec, (s) => Number(s.src_tsbpd_ms.toFixed(0))),
        });
      }
      if (showRecvBuf) {
        leftSeries.push({
          name: "接收缓冲 (ms)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: COLOR_TEAL },
          lineStyle: { width: 1.5, color: COLOR_TEAL },
          data: toSeries(samples, gapThresholdSec, (s) => Number((s.src_buf_ms ?? 0).toFixed(1))),
        });
      }
      if (showRtt) {
        leftSeries.push({
          name: "入站 RTT (ms)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: rttLineColor },
          lineStyle: { width: 1.8, color: rttLineColor },
          data: toSeries(samples, gapThresholdSec, (s) => Number(s.src_rtt_ms.toFixed(1))),
        });
      }
      if (showDstRtt) {
        leftSeries.push({
          name: "出站 RTT (ms)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: COLOR_PERIWINKLE },
          lineStyle: { width: 1.4, type: "dashed", color: COLOR_PERIWINKLE },
          data: toSeries(samples, gapThresholdSec, (s) => Number(s.dst_rtt_ms.toFixed(1))),
        });
      }
    } else {
      if (showRtt) {
        leftSeries.push({
          name: "解码端请求重发 (包)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: COLOR_AMBER },
          lineStyle: { width: 1.8, color: COLOR_AMBER },
          data: toSeries(samples, gapThresholdSec, (s) => s.dst_nak_count),
        });
      }
      if (showLatency) {
        leftSeries.push({
          name: "未恢复弃包 (包)",
          type: "bar",
          barMaxWidth: 5,
          itemStyle: { color: COLOR_CRIMSON },
          data: toSeries(samples, gapThresholdSec, (s) => s.src_dropped),
        });
      }
    }

    cLeft.setOption({
      animation: false,
      tooltip: tooltipStyle,
      grid: { left: 44, right: 14, top: 14, bottom: 22 },
      xAxis,
      yAxis: {
        type: "value",
        min: 0,
        ...(isPass ? { max: (v: { max: number }) => Math.max(v.max, 10), minInterval: 1 } : {}),
        splitLine: { lineStyle: { color: splitColor } },
        axisLabel: { color: labelColor, fontSize: 10 },
      },
      series: leftSeries,
    });

    // Right Chart: BANDWIDTH USE (Mb/s) — Bitrate, Retransmit Rate (Mb/s), optional Link BW + Dropped (pkt)
    const rightSeries: echarts.SeriesOption[] = [];
    if (showRate) {
      rightSeries.push({
        name: "实时码率 (Mb/s)",
        type: "line",
        showSymbol: false,
        itemStyle: { color: COLOR_PERIWINKLE },
        lineStyle: { width: 2, color: COLOR_PERIWINKLE },
        areaStyle: { color: "rgba(129, 140, 248, 0.10)" },
        data: toSeries(samples, gapThresholdSec, (s) => Number(s.src_mbps.toFixed(2))),
      });
    }
    if (showRetrans) {
      rightSeries.push({
        name: "重传带宽 (Mb/s)",
        type: "line",
        showSymbol: false,
        itemStyle: { color: COLOR_AMBER },
        lineStyle: { width: 1.6, color: COLOR_AMBER },
        data: toSeries(samples, gapThresholdSec, (s, dt) => calcRetransMbps(s, isPass, dt)),
      });
    }
    if (!isPass && showLinkBw) {
      rightSeries.push({
        name: "预估链路带宽 (Mb/s)",
        type: "line",
        showSymbol: false,
        itemStyle: { color: COLOR_SLATE },
        lineStyle: { width: 1.4, type: "dashed", color: COLOR_SLATE },
        data: toSeries(samples, gapThresholdSec, (s) => Number((s.src_link_bw_mbps ?? 0).toFixed(1))),
      });
    }
    if (showDropped) {
      rightSeries.push({
        name: "未恢复弃包 (包)",
        type: "bar",
        yAxisIndex: 1,
        barMaxWidth: 5,
        itemStyle: { color: COLOR_CRIMSON },
        data: toSeries(samples, gapThresholdSec, (s) =>
          isPass ? s.src_dropped : s.src_dropped + s.dst_dropped
        ),
      });
    }

    cRight.setOption({
      animation: false,
      tooltip: tooltipStyle,
      grid: { left: 42, right: 34, top: 14, bottom: 22 },
      xAxis,
      yAxis: [
        {
          type: "value",
          min: 0,
          splitLine: { lineStyle: { color: splitColor } },
          axisLabel: { color: labelColor, fontSize: 10 },
        },
        {
          type: "value",
          min: 0,
          max: (v: { max: number }) => Math.max(v.max, 10),
          minInterval: 1,
          splitLine: { show: false },
          axisLabel: { color: labelColor, fontSize: 10 },
        },
      ],
      series: rightSeries,
    });

    const onResize = () => {
      cLeft.resize();
      cRight.resize();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cLeft.dispose();
      cRight.dispose();
    };
  }, [
    timeline,
    activeLegHistory,
    theme,
    windowSec,
    isPass,
    rttLineColor,
    showRtt,
    showDstRtt,
    showLatency,
    showRecvBuf,
    showRate,
    showRetrans,
    showLinkBw,
    showDropped,
  ]);

  if (!activeLeg) return null;

  const s = activeLeg.sample;
  const srcSt = srcStatusText(activeLeg);
  const dstSt = dstStatusText(activeLeg);
  const winLabel = WINDOWS.find((w) => w.sec === windowSec)?.label ?? "5分钟";
  const histSamples = activeLegHistory?.samples ?? [];
  const hasHist = histSamples.length > 0;

  // Source (Ingest) window cumulative metrics
  const winSrcPackets = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_packets ?? 0), 0)
    : s.src_packets ?? 0;
  const winSrcBytes = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_bytes ?? 0), 0)
    : s.src_bytes ?? 0;
  const winSrcLost = hasHist
    ? histSamples.reduce((acc, x) => acc + x.src_lost, 0)
    : s.src_lost;
  const winSrcRetrans = hasHist
    ? histSamples.reduce((acc, x) => acc + x.src_retrans, 0)
    : s.src_retrans;
  const winSrcDropped = hasHist
    ? histSamples.reduce((acc, x) => acc + x.src_dropped, 0)
    : s.src_dropped;
  const winSrcBelated = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_belated ?? 0), 0)
    : s.src_belated ?? 0;
  const winSrcReconnects = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_reconnects ?? 0), 0)
    : s.src_reconnects ?? 0;

  // Destination (Egress) window cumulative metrics
  const winDstPackets = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.dst_packets ?? 0), 0)
    : s.dst_packets ?? 0;
  const winDstBytes = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.dst_bytes ?? 0), 0)
    : s.dst_bytes ?? 0;
  const winDstLost = hasHist
    ? histSamples.reduce((acc, x) => acc + x.dst_lost, 0)
    : s.dst_lost;
  const winDstRetrans = hasHist
    ? histSamples.reduce((acc, x) => acc + x.dst_retrans, 0)
    : s.dst_retrans;
  const winDstDropped = hasHist
    ? histSamples.reduce((acc, x) => acc + x.dst_dropped, 0)
    : s.dst_dropped;
  const winDstNak = hasHist
    ? histSamples.reduce((acc, x) => acc + x.dst_nak_count, 0)
    : s.dst_nak_count;
  const winDstReconnects = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.dst_reconnects ?? 0), 0)
    : s.dst_reconnects ?? 0;

  const srcRttRange = calcMinMaxPositive(histSamples, (x) => x.src_rtt_ms);
  const dstRttRange = calcMinMaxPositive(histSamples, (x) => x.dst_rtt_ms);

  const srcFlowing = activeLeg.node_online && s.src_mbps >= 0.1;
  const dstFlowing = activeLeg.node_online && s.dst_mbps >= 0.1;
  const linkBwMbps = s.src_link_bw_mbps ?? 0;
  const maxBwMbps = s.src_max_bw_mbps ?? 0;
  const dstLinkBwMbps = s.dst_link_bw_mbps ?? 0;

  const hasTSBPD = !isPass && s.src_tsbpd_ms > 0;
  const marginPct = hasTSBPD ? Math.round(((s.src_rtt_ms * 4) / s.src_tsbpd_ms) * 100) : 0;
  const marginColor =
    marginPct > 100 ? "var(--crit)" : marginPct >= 75 ? "var(--warn)" : "var(--ok)";

  const maxRestarts = activeLegHistory
    ? activeLegHistory.samples.reduce((m, x) => Math.max(m, x.restart_count), s.restart_count)
    : s.restart_count;
  const udpDrops = activeLegHistory
    ? activeLegHistory.host.reduce((acc, h) => acc + h.udp_rcvbuf_errors, 0)
    : activeLeg.host.udp_rcvbuf_errors;

  const hostAddr = resolveNodeHost(nodes, activeLeg.node_id);
  const pushUrl = `srt://${hostAddr}:${activeLeg.in_port}`;
  const pullUrl = !isPass ? `srt://${hostAddr}:${activeLeg.out_port}` : "";

  async function copyUrl(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? "" : cur)), 1500);
    } catch {
      // ignore clipboard restriction
    }
  }

  const showFaultNote =
    s.fault_code !== "HEALTHY" && s.fault_code !== "IDLE_EXPECTED_OFF" && Boolean(s.fault_summary);
  const isCritNote =
    s.fault_code === "UPSTREAM_OFFLINE" ||
    s.fault_code === "CLOUD_PROCESS_DOWN" ||
    s.fault_code === "NODE_UNREACHABLE";

  return (
    <div className="hv-drawer" onClick={(e) => e.stopPropagation()}>
      {/* Clean Drawer Bar: Leg selector + Time Window only (no duplicate card buttons) */}
      <div className="hv-drawer-bar">
        <div className="hv-drawer-left">
          {group.legs.length >= 2 && (
            <div className="seg-group" role="tablist" aria-label="主备切换">
              {group.legs.map((leg, i) => (
                <button
                  key={`${leg.node_id}-${leg.channel_id}`}
                  type="button"
                  className={`seg-btn ${safeIdx === i ? "active" : ""}`}
                  onClick={() => onSelectLeg(i)}
                >
                  <span className={`dot ${legDotClass(leg)}`} style={{ marginRight: 5 }} />
                  {leg.role === "primary" ? "主路" : leg.role === "backup" ? "备路" : "单路"}
                  {leg.carrier ? ` · ${leg.carrier}` : ""}
                </button>
              ))}
            </div>
          )}
          <span className="hv-path-hint mono">
            {activeLeg.src_device || "发端"} → {activeLeg.node_id} (:{activeLeg.in_port}
            {!isPass ? ` / :${activeLeg.out_port}` : ""}) → {activeLeg.dst_device || "收端"}
          </span>
        </div>

        <div className="hv-drawer-right">
          <div className="seg-group" role="group" aria-label="时间窗口">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                className={`seg-btn ${windowSec === w.sec ? "active" : ""}`}
                onClick={() => setWindowSec(w.sec)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Haivision Dual Side-by-Side Charts */}
      <div className="hv-charts-grid">
        <div className="hv-chart-card">
          <div className="hv-chart-title">
            {isPass ? "SRT 控制与丢包事件 · 包" : "传输时延与缓冲 · ms"}
          </div>
          <div ref={leftChartRef} className="hv-chart-canvas" />
          <div className="hv-legend-bar">
            {!isPass ? (
              <>
                <button
                  type="button"
                  className={`hv-legend-pill ${showRtt ? "on" : ""}`}
                  onClick={() => setShowRtt((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: rttLineColor }} />
                  入站 RTT
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showDstRtt ? "on" : ""}`}
                  onClick={() => setShowDstRtt((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: COLOR_PERIWINKLE }} />
                  出站 RTT
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showRecvBuf ? "on" : ""}`}
                  onClick={() => setShowRecvBuf((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: COLOR_TEAL }} />
                  接收缓冲
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showLatency ? "on" : ""}`}
                  onClick={() => setShowLatency((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: COLOR_AMBER }} />
                  设定缓冲
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`hv-legend-pill ${showRtt ? "on" : ""}`}
                  onClick={() => setShowRtt((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: COLOR_AMBER }} />
                  请求重发 (NAK)
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showLatency ? "on" : ""}`}
                  onClick={() => setShowLatency((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: COLOR_CRIMSON }} />
                  未恢复弃包
                </button>
              </>
            )}
          </div>
        </div>

        <div className="hv-chart-card">
          <div className="hv-chart-title">码率与重传丢包 · Mb/s</div>
          <div ref={rightChartRef} className="hv-chart-canvas" />
          <div className="hv-legend-bar">
            <button
              type="button"
              className={`hv-legend-pill ${showRate ? "on" : ""}`}
              onClick={() => setShowRate((v) => !v)}
            >
              <span className="hv-legend-dot" style={{ background: COLOR_PERIWINKLE }} />
              实时码率
            </button>
            <button
              type="button"
              className={`hv-legend-pill ${showRetrans ? "on" : ""}`}
              onClick={() => setShowRetrans((v) => !v)}
            >
              <span className="hv-legend-dot" style={{ background: COLOR_AMBER }} />
              重传带宽
            </button>
            {!isPass && (
              <button
                type="button"
                className={`hv-legend-pill ${showLinkBw ? "on" : ""}`}
                onClick={() => setShowLinkBw((v) => !v)}
              >
                <span className="hv-legend-dot" style={{ background: COLOR_SLATE }} />
                预估链路带宽
              </button>
            )}
            <button
              type="button"
              className={`hv-legend-pill ${showDropped ? "on" : ""}`}
              onClick={() => setShowDropped((v) => !v)}
            >
              <span className="hv-legend-dot" style={{ background: COLOR_CRIMSON }} />
              未恢复弃包
            </button>
          </div>
        </div>
      </div>

      {/* Complete Haivision-style 2-Column Source & Destination Statistics */}
      <div className="hv-stats-grid">
        {/* Left Card: Ingest / Source */}
        <div className="hv-stats-card">
          <div className="hv-chart-title">推流端统计（入站 · {winLabel}）</div>
          <div className="hv-stats-rows">
            <div className="hv-stat-row">
              <span>推流状态</span>
              <strong style={{ color: srcSt.color }}>{srcSt.label}</strong>
            </div>
            <div className="hv-stat-row">
              <span>推流地址 (Caller)</span>
              <strong className="mono">
                <span>{pushUrl}</span>
                <button
                  type="button"
                  className="hv-copy-btn"
                  onClick={() => void copyUrl("push", pushUrl)}
                >
                  {copiedKey === "push" ? "已复制" : "复制"}
                </button>
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>发端来源 IP</span>
              <strong className="mono">
                {s.src_peer_ip || "-"}
                {s.path_medium && s.path_medium !== "-" && (
                  <span className="hv-stat-sub">({s.path_medium})</span>
                )}
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>入站码率</span>
              <strong className="mono">{s.src_mbps.toFixed(2)} Mb/s</strong>
            </div>
            {!isPass && (
              <>
                <div className="hv-stat-row">
                  <span>链路带宽 / 上限</span>
                  <strong className="mono">
                    {linkBwMbps > 0 ? `${linkBwMbps.toFixed(1)} Mb/s` : "-"}
                    {maxBwMbps > 0 && <span className="hv-stat-sub">/ {maxBwMbps.toFixed(0)}</span>}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>入站时延 RTT</span>
                  <strong className="mono">
                    {s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)} ms` : "-"}
                    {srcRttRange && (
                      <span className="hv-stat-sub">
                        ({srcRttRange[0].toFixed(0)}–{srcRttRange[1].toFixed(0)})
                      </span>
                    )}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>设定缓冲 / 当前缓冲</span>
                  <strong className="mono">
                    {hasTSBPD ? (
                      <>
                        {s.src_tsbpd_ms.toFixed(0)} / {(s.src_buf_ms ?? 0).toFixed(0)} ms
                        <span style={{ color: marginColor, fontSize: 11, fontWeight: 500 }}>
                          (4×RTT 占 {marginPct}%)
                        </span>
                      </>
                    ) : (
                      "-"
                    )}
                  </strong>
                </div>
              </>
            )}
            <div className="hv-stat-row">
              <span>累计收包 / 流量</span>
              <strong className="mono">
                {winSrcPackets > 0 ? `${winSrcPackets.toLocaleString()} 包` : "-"}
                {winSrcBytes > 0 && <span className="hv-stat-sub">· {formatBytes(winSrcBytes)}</span>}
              </strong>
            </div>
            {!isPass ? (
              <>
                <div className="hv-stat-row">
                  <span>网络丢包 / 重传救回</span>
                  <strong className="mono">
                    {winSrcLost.toLocaleString()} ({formatPct(winSrcLost, winSrcPackets)}) /{" "}
                    {winSrcRetrans.toLocaleString()} ({formatPct(winSrcRetrans, winSrcPackets)})
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>未恢复弃包 / 迟到包</span>
                  <strong
                    className="mono"
                    style={{
                      color:
                        winSrcDropped > 0
                          ? "var(--crit)"
                          : srcFlowing
                          ? "var(--ok)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {winSrcDropped.toLocaleString()}
                    <span className="hv-stat-sub">/ 迟到 {winSrcBelated.toLocaleString()}</span>
                  </strong>
                </div>
              </>
            ) : (
              <div className="hv-stat-row">
                <span>透传加密模式</span>
                <strong style={{ color: "var(--ok)" }}>
                  {s.encrypted ? "端到端 AES 加密透传" : "L4 原包直通透传"}
                </strong>
              </div>
            )}
            <div className="hv-stat-row">
              <span>{isPass ? "握手次数" : "推流重连次数"}</span>
              <strong
                className="mono"
                style={{ color: winSrcReconnects > 0 ? "var(--warn)" : "var(--text-primary)" }}
              >
                {winSrcReconnects} 次
              </strong>
            </div>
          </div>
        </div>

        {/* Right Card: Egress / Destination & Server */}
        <div className="hv-stats-card">
          <div className="hv-chart-title">拉流端与服务器（出站 · {winLabel}）</div>
          <div className="hv-stats-rows">
            <div className="hv-stat-row">
              <span>拉流状态</span>
              <strong style={{ color: dstSt.color }}>{dstSt.label}</strong>
            </div>
            <div className="hv-stat-row">
              <span>{isPass ? "解码目标地址" : "拉流地址 (Caller)"}</span>
              <strong className="mono">
                {!isPass ? (
                  <>
                    <span>{pullUrl}</span>
                    <button
                      type="button"
                      className="hv-copy-btn"
                      onClick={() => void copyUrl("pull", pullUrl)}
                    >
                      {copiedKey === "pull" ? "已复制" : "复制"}
                    </button>
                  </>
                ) : (
                  <span>{activeLeg.target_addr || s.dst_peer_ip || "-"}</span>
                )}
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>收端连接 IP</span>
              <strong className="mono">{s.dst_peer_ip || activeLeg.target_addr || "-"}</strong>
            </div>
            <div className="hv-stat-row">
              <span>出站码率</span>
              <strong className="mono">{s.dst_mbps.toFixed(2)} Mb/s</strong>
            </div>
            {!isPass ? (
              <>
                <div className="hv-stat-row">
                  <span>出站预估带宽</span>
                  <strong className="mono">
                    {dstLinkBwMbps > 0 ? `${dstLinkBwMbps.toFixed(1)} Mb/s` : "-"}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>出站时延 RTT</span>
                  <strong className="mono">
                    {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)} ms` : "-"}
                    {dstRttRange && (
                      <span className="hv-stat-sub">
                        ({dstRttRange[0].toFixed(0)}–{dstRttRange[1].toFixed(0)})
                      </span>
                    )}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>发送缓冲深度</span>
                  <strong className="mono">
                    {s.dst_connected ? `${(s.dst_buf_ms ?? 0).toFixed(0)} ms` : "-"}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>累计发包 / 流量</span>
                  <strong className="mono">
                    {winDstPackets > 0 ? `${winDstPackets.toLocaleString()} 包` : "-"}
                    {winDstBytes > 0 && <span className="hv-stat-sub">· {formatBytes(winDstBytes)}</span>}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>下行丢包 / 重传救回</span>
                  <strong className="mono">
                    {winDstLost.toLocaleString()} ({formatPct(winDstLost, winDstPackets)}) /{" "}
                    {winDstRetrans.toLocaleString()}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>下行未恢复弃包</span>
                  <strong
                    className="mono"
                    style={{
                      color:
                        winDstDropped > 0
                          ? "var(--crit)"
                          : dstFlowing
                          ? "var(--ok)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {winDstDropped.toLocaleString()}
                  </strong>
                </div>
                <div className="hv-stat-row">
                  <span>拉流重连次数</span>
                  <strong
                    className="mono"
                    style={{ color: winDstReconnects > 0 ? "var(--warn)" : "var(--text-primary)" }}
                  >
                    {winDstReconnects} 次
                  </strong>
                </div>
              </>
            ) : (
              <>
                <div className="hv-stat-row">
                  <span>解码端请求重发 (NAK)</span>
                  <strong className="mono">{winDstNak.toLocaleString()} 包</strong>
                </div>
                <div className="hv-stat-row">
                  <span>ARQ 重传救回</span>
                  <strong className="mono">{winSrcRetrans.toLocaleString()} 包</strong>
                </div>
                <div className="hv-stat-row">
                  <span>未恢复弃包 (DropReq)</span>
                  <strong
                    className="mono"
                    style={{
                      color:
                        winSrcDropped > 0
                          ? "var(--crit)"
                          : srcFlowing
                          ? "var(--ok)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {winSrcDropped.toLocaleString()} 包
                  </strong>
                </div>
              </>
            )}
            <div className="hv-stat-row">
              <span>中转服务器</span>
              <strong
                className="mono"
                style={{ color: maxRestarts === 0 && udpDrops === 0 ? "var(--ok)" : "var(--crit)" }}
              >
                {activeLeg.node_id} · 运行 {formatUptime(s.uptime_sec)} · 重启 {maxRestarts} · 系统丢包 {udpDrops}
              </strong>
            </div>
          </div>
        </div>
      </div>

      {showFaultNote && (
        <div className={`hv-stat-note ${isCritNote ? "is-crit" : ""}`}>{s.fault_summary}</div>
      )}
    </div>
  );
}
