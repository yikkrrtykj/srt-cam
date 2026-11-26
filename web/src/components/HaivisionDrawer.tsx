import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import type { GroupTimelineResponse, LegLiveView, SignalGroupLiveView } from "../types";
import { api, formatTime, formatUptime } from "../api";

interface Props {
  group: SignalGroupLiveView;
  theme: "dark" | "light";
  onOpenTimeline: (groupId: string) => void;
  onRestartLeg: (leg: LegLiveView) => void;
}

const WINDOWS = [
  { label: "15m", sec: 15 * 60 },
  { label: "30m", sec: 30 * 60 },
  { label: "2h", sec: 2 * 3600 },
];

function legDotClass(leg: LegLiveView): string {
  if (!leg.node_online) return "dot-crit";
  switch (leg.sample.fault_code) {
    case "HEALTHY":
      return "dot-ok";
    case "IDLE_EXPECTED_OFF":
      return "dot-idle";
    case "UPSTREAM_OFFLINE":
    case "DOWNSTREAM_OFFLINE":
    case "CLOUD_PROCESS_DOWN":
    case "NODE_UNREACHABLE":
      return "dot-crit";
    default:
      return "dot-warn";
  }
}

function statusDisplay(leg: LegLiveView): { label: string; color: string } {
  if (!leg.node_online) return { label: "Node Offline", color: "var(--crit)" };
  const s = leg.sample;
  switch (s.fault_code) {
    case "HEALTHY":
      return { label: "Streaming", color: "var(--ok)" };
    case "IDLE_EXPECTED_OFF":
      return { label: "Standby", color: "var(--text-muted)" };
    case "UPSTREAM_OFFLINE":
    case "DOWNSTREAM_OFFLINE":
    case "CLOUD_PROCESS_DOWN":
      return { label: "Offline", color: "var(--crit)" };
    default:
      return { label: "Degraded", color: "var(--warn)" };
  }
}

function toSeries<T extends { ts: number }>(
  items: T[],
  pick: (item: T) => number
): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (i > 0 && cur.ts - items[i - 1].ts > 30) {
      out.push([(items[i - 1].ts + 1) * 1000, null]);
    }
    out.push([cur.ts * 1000, pick(cur)]);
  }
  return out;
}

export function HaivisionDrawer({ group, theme, onOpenTimeline, onRestartLeg }: Props) {
  const [legIdx, setLegIdx] = useState(0);
  const [windowSec, setWindowSec] = useState(15 * 60);
  const [timeline, setTimeline] = useState<GroupTimelineResponse | null>(null);

  // Interactive legend pill toggles (exact Haivision Gateway pattern)
  const [showRtt, setShowRtt] = useState(true);
  const [showDstRtt, setShowDstRtt] = useState(true);
  const [showLatency, setShowLatency] = useState(true);

  const [showRate, setShowRate] = useState(true);
  const [showRetrans, setShowRetrans] = useState(true);
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
    const timer = window.setInterval(() => void load(), 5000);
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

  // Render Left (DELAY / PACKET EVENTS) & Right (BANDWIDTH USE) Haivision charts
  useEffect(() => {
    const leftEl = leftChartRef.current;
    const rightEl = rightChartRef.current;
    if (!leftEl || !rightEl || !timeline || !activeLegHistory) return;

    const cLeft = echarts.init(leftEl);
    const cRight = echarts.init(rightEl);

    const isDark = theme === "dark";
    const splitColor = isDark ? "rgba(255,255,255,0.06)" : "#edf0f5";
    const axisColor = isDark ? "#333947" : "#cbd5e1";
    const labelColor = isDark ? "#7e8699" : "#64748b";
    const tooltipStyle = {
      trigger: "axis" as const,
      axisPointer: { type: "line" as const, lineStyle: { color: "#6e7c8e", type: "dashed" as const } },
      backgroundColor: isDark ? "rgba(18, 20, 26, 0.96)" : "rgba(15, 23, 42, 0.94)",
      borderColor: "#333947",
      textStyle: { color: "#e6edf3", fontSize: 12 },
    };

    const xAxis = {
      type: "time" as const,
      min: timeline.from_ts * 1000,
      max: timeline.to_ts * 1000,
      axisLine: { lineStyle: { color: axisColor } },
      axisTick: { show: false },
      axisLabel: {
        color: labelColor,
        fontSize: 10,
        formatter: (v: number) => formatTime(Math.floor(v / 1000)),
      },
    };

    const samples = activeLegHistory.samples;

    // Left Chart: DELAY (ms) for Mode A, or SRT Control Events (pkt) for Mode B
    const leftSeries: echarts.SeriesOption[] = [];
    if (!isPass) {
      if (showLatency) {
        leftSeries.push({
          name: "Latency (TSBPD)",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.8, color: "#e3b341" },
          data: toSeries(samples, (s) => Number(s.src_tsbpd_ms.toFixed(0))),
        });
      }
      if (showRtt) {
        leftSeries.push({
          name: "Round Trip (上行)",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.8, color: "#60a5fa" },
          data: toSeries(samples, (s) => Number(s.src_rtt_ms.toFixed(1))),
        });
      }
      if (showDstRtt) {
        leftSeries.push({
          name: "Down RTT (下行)",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.4, type: "dashed", color: "#94a3b8" },
          data: toSeries(samples, (s) => Number(s.dst_rtt_ms.toFixed(1))),
        });
      }
    } else {
      if (showRtt) {
        leftSeries.push({
          name: "NAK Lost",
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.8, color: "#e3b341" },
          data: toSeries(samples, (s) => s.dst_nak_count),
        });
      }
      if (showLatency) {
        leftSeries.push({
          name: "DropReq",
          type: "bar",
          barMaxWidth: 5,
          itemStyle: { color: "#f85149" },
          data: toSeries(samples, (s) => s.src_dropped),
        });
      }
    }

    cLeft.setOption({
      animation: false,
      tooltip: tooltipStyle,
      grid: { left: 42, right: 14, top: 14, bottom: 22 },
      xAxis,
      yAxis: {
        type: "value",
        min: 0,
        splitLine: { lineStyle: { color: splitColor } },
        axisLabel: { color: labelColor, fontSize: 10 },
      },
      series: leftSeries,
    });

    // Right Chart: BANDWIDTH USE (Mb/s) + Retransmit & Dropped
    const rightSeries: echarts.SeriesOption[] = [];
    if (showRate) {
      rightSeries.push({
        name: "Bitrate (Mb/s)",
        type: "line",
        showSymbol: false,
        lineStyle: { width: 2, color: "#6e8efb" },
        areaStyle: { color: "rgba(110, 142, 251, 0.08)" },
        data: toSeries(samples, (s) => Number(s.src_mbps.toFixed(2))),
      });
    }
    if (showRetrans) {
      rightSeries.push({
        name: "Retransmit (pkt)",
        type: "line",
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { width: 1.5, color: "#e3b341" },
        data: toSeries(samples, (s) => (isPass ? s.src_retrans : s.src_retrans + s.dst_retrans)),
      });
    }
    if (showDropped) {
      rightSeries.push({
        name: isPass ? "DropReq (pkt)" : "Dropped (pkt)",
        type: "bar",
        yAxisIndex: 1,
        barMaxWidth: 5,
        itemStyle: { color: "#f85149" },
        data: toSeries(samples, (s) => (isPass ? s.src_dropped : s.src_dropped + s.dst_dropped)),
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
    isPass,
    showRtt,
    showDstRtt,
    showLatency,
    showRate,
    showRetrans,
    showDropped,
  ]);

  if (!activeLeg) return null;

  const s = activeLeg.sample;
  const st = statusDisplay(activeLeg);
  const totalDropped = isPass ? s.src_dropped : s.src_dropped + s.dst_dropped;
  const totalLost = isPass ? s.dst_nak_count : s.src_lost + s.dst_lost;
  const totalRecovered = isPass ? s.src_retrans : s.src_retrans + s.dst_retrans;
  const flowing = activeLeg.node_online && s.src_mbps >= 0.1;

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

  return (
    <div className="hv-drawer" onClick={(e) => e.stopPropagation()}>
      {/* Subtle Drawer Control Strip */}
      <div className="hv-drawer-bar">
        <div className="hv-drawer-left">
          {group.legs.length >= 2 && (
            <div className="seg-group" role="tablist" aria-label="主备切换">
              {group.legs.map((leg, i) => (
                <button
                  key={`${leg.node_id}-${leg.channel_id}`}
                  type="button"
                  className={`seg-btn ${safeIdx === i ? "active" : ""}`}
                  onClick={() => setLegIdx(i)}
                >
                  <span className={`dot ${legDotClass(leg)}`} style={{ marginRight: 5 }} />
                  {leg.role === "primary" ? "主路" : leg.role === "backup" ? "备路" : "单路"}
                  {leg.carrier ? ` · ${leg.carrier}` : ""}
                </button>
              ))}
            </div>
          )}
          <span className="hv-path-hint mono">
            {s.src_peer_ip || activeLeg.src_device || "Source"} → {activeLeg.node_id}:{activeLeg.in_port}
            {!isPass ? `/${activeLeg.out_port}` : ""} → {s.dst_peer_ip || activeLeg.target_addr || activeLeg.dst_device || "Destination"}
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
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => onRestartLeg(activeLeg)}
          >
            重启
          </button>
          <button
            type="button"
            className="btn btn-xs btn-primary"
            onClick={() => onOpenTimeline(group.id)}
          >
            4层排障 / 日志 →
          </button>
        </div>
      </div>

      {/* Haivision Dual Side-by-Side Charts */}
      <div className="hv-charts-grid">
        <div className="hv-chart-card">
          <div className="hv-chart-title">
            {isPass ? "SRT HEADER EVENTS · pkt" : "DELAY · ms"}
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
                  <span className="hv-legend-dot" style={{ background: "#60a5fa" }} />
                  Round Trip
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showDstRtt ? "on" : ""}`}
                  onClick={() => setShowDstRtt((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: "#94a3b8" }} />
                  Down RTT
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showLatency ? "on" : ""}`}
                  onClick={() => setShowLatency((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: "#e3b341" }} />
                  Latency
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`hv-legend-pill ${showRtt ? "on" : ""}`}
                  onClick={() => setShowRtt((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: "#e3b341" }} />
                  NAK Lost
                </button>
                <button
                  type="button"
                  className={`hv-legend-pill ${showLatency ? "on" : ""}`}
                  onClick={() => setShowLatency((v) => !v)}
                >
                  <span className="hv-legend-dot" style={{ background: "#f85149" }} />
                  DropReq
                </button>
              </>
            )}
          </div>
        </div>

        <div className="hv-chart-card">
          <div className="hv-chart-title">BANDWIDTH USE · Mb/s</div>
          <div ref={rightChartRef} className="hv-chart-canvas" />
          <div className="hv-legend-bar">
            <button
              type="button"
              className={`hv-legend-pill ${showRate ? "on" : ""}`}
              onClick={() => setShowRate((v) => !v)}
            >
              <span className="hv-legend-dot" style={{ background: "#6e8efb" }} />
              Bitrate
            </button>
            <button
              type="button"
              className={`hv-legend-pill ${showRetrans ? "on" : ""}`}
              onClick={() => setShowRetrans((v) => !v)}
            >
              <span className="hv-legend-dot" style={{ background: "#e3b341" }} />
              Retransmit
            </button>
            <button
              type="button"
              className={`hv-legend-pill ${showDropped ? "on" : ""}`}
              onClick={() => setShowDropped((v) => !v)}
            >
              <span className="hv-legend-dot" style={{ background: "#f85149" }} />
              {isPass ? "DropReq" : "Dropped"}
            </button>
          </div>
        </div>
      </div>

      {/* Centered Minimal Haivision STATISTICS Table */}
      <div className="hv-stats-wrap">
        <div className="hv-stats-card">
          <div className="hv-chart-title">STATISTICS</div>
          <div className="hv-stats-rows">
            <div className="hv-stat-row">
              <span>Status</span>
              <strong style={{ color: st.color }}>{st.label}</strong>
            </div>
            <div className="hv-stat-row">
              <span>Uptime</span>
              <strong className="mono">{formatUptime(s.uptime_sec)}</strong>
            </div>
            <div className="hv-stat-row">
              <span>Bitrate</span>
              <strong className="mono">{s.src_mbps.toFixed(2)} Mb/s</strong>
            </div>
            <div className="hv-stat-row">
              <span>{isPass ? "Dropped (DropReq)" : "Dropped Packets"}</span>
              <strong
                className="mono"
                style={{
                  color:
                    totalDropped > 0
                      ? "var(--crit)"
                      : flowing
                      ? "var(--ok)"
                      : "var(--text-secondary)",
                }}
              >
                {totalDropped}
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>{isPass ? "NAK / Retransmit" : "Lost / Recovered"}</span>
              <strong className="mono">
                {totalLost} / {totalRecovered}
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>RTT</span>
              <strong className="mono">
                {isPass
                  ? "End-to-End"
                  : s.src_rtt_ms > 0
                  ? `${s.src_rtt_ms.toFixed(0)} / ${s.dst_rtt_ms.toFixed(0)} ms`
                  : "-"}
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>Latency (TSBPD)</span>
              <strong className="mono">
                {isPass ? (
                  "AES 加密透传"
                ) : hasTSBPD ? (
                  <>
                    {s.src_tsbpd_ms.toFixed(0)} ms{" "}
                    <span style={{ color: marginColor, fontSize: 11, fontWeight: 500 }}>
                      (4×RTT 占 {marginPct}%)
                    </span>
                  </>
                ) : (
                  "-"
                )}
              </strong>
            </div>
            <div className="hv-stat-row">
              <span>Gateway</span>
              <strong
                className="mono"
                style={{ color: maxRestarts === 0 && udpDrops === 0 ? "var(--ok)" : "var(--crit)" }}
              >
                {activeLeg.node_id} · {maxRestarts} 重启 · {udpDrops} UDP丢包
              </strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
