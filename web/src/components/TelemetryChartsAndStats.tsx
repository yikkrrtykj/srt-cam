import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import type {
  ChannelSample,
  GroupTimelineResponse,
  LegLiveView,
  NodeLiveStatus,
  SignalGroupLiveView,
} from "@/types";
import {
  api,
  formatBytes,
  formatPct,
  formatTime,
  formatUptime,
  resolveNodeHost,
} from "@/api";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";

interface Props {
  group: SignalGroupLiveView;
  nodes: NodeLiveStatus[];
  legIdx: number;
  layout: "wide" | "inspector";
}

const WINDOWS = [
  { label: "5分钟", short: "5m", sec: 5 * 60 },
  { label: "15分钟", short: "15m", sec: 15 * 60 },
  { label: "30分钟", short: "30m", sec: 30 * 60 },
  { label: "2小时", short: "2h", sec: 2 * 3600 },
  { label: "24小时", short: "24h", sec: 24 * 3600 },
];

// Broadcast instrument trace colors (no neon purple)
const COLOR_WHITE = "#E6E9EF";
const COLOR_CYAN = "#38BDF8";
const COLOR_TEAL = "#2DD4BF";
const COLOR_AMBER = "#F59E0B";
const COLOR_SLATE = "#64748B";
const COLOR_CRIMSON = "#EF4444";

function srcStatusText(leg: LegLiveView): { label: string; cls: string } {
  if (!leg.node_online) return { label: "服务器离线", cls: "text-[#F87171]" };
  const s = leg.sample;
  if (s.fault_code === "IDLE_EXPECTED_OFF") return { label: "待机", cls: "text-[#8B94A5]" };
  if (s.fault_code === "CLOUD_PROCESS_DOWN") return { label: "通道未启动", cls: "text-[#F87171]" };
  if (!s.src_connected && s.src_mbps < 0.1) return { label: "未连接", cls: "text-[#F87171]" };
  if (s.src_mbps < 0.1) return { label: "无信号", cls: "text-[#F87171]" };
  if (s.fault_code === "UPSTREAM_DEGRADED") return { label: "推流波动", cls: "text-[#FBBF24]" };
  return { label: "正常推流", cls: "text-[#4ADE80]" };
}

function dstStatusText(leg: LegLiveView): { label: string; cls: string } {
  if (!leg.node_online) return { label: "服务器离线", cls: "text-[#F87171]" };
  const s = leg.sample;
  if (s.fault_code === "IDLE_EXPECTED_OFF") return { label: "待机", cls: "text-[#8B94A5]" };
  if (s.fault_code === "CLOUD_PROCESS_DOWN") return { label: "通道未启动", cls: "text-[#F87171]" };
  if (s.fault_code === "DOWNSTREAM_OFFLINE") return { label: "待拉流", cls: "text-[#FBBF24]" };
  if (s.dst_mbps < 0.1) return { label: "未连接", cls: "text-[#F87171]" };
  if (s.fault_code === "DOWNSTREAM_DEGRADED") return { label: "拉流波动", cls: "text-[#FBBF24]" };
  return { label: "正在接收", cls: "text-[#4ADE80]" };
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

export function TelemetryChartsAndStats({ group, nodes, legIdx, layout }: Props) {
  const [windowSec, setWindowSec] = useState(5 * 60);
  const [timeline, setTimeline] = useState<GroupTimelineResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState("");

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
  const isPass = activeLeg?.mode === "udp-passthrough";

  useEffect(() => {
    let active = true;
    async function load() {
      const now = Math.floor(Date.now() / 1000);
      try {
        const res = await api.timeline(group.id, now - windowSec, now);
        if (active) setTimeline(res);
      } catch {
        // retain last snapshot
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

  useEffect(() => {
    const leftEl = leftChartRef.current;
    const rightEl = rightChartRef.current;
    if (!leftEl || !rightEl || !timeline || !activeLegHistory) return;

    const cLeft = echarts.init(leftEl);
    const cRight = echarts.init(rightEl);

    const splitColor = "rgba(255,255,255,0.045)";
    const axisColor = "#232730";
    const labelColor = "#757E8F";
    const tooltipStyle = {
      trigger: "axis" as const,
      confine: true,
      appendToBody: true,
      axisPointer: { type: "line" as const, lineStyle: { color: "#4E5768", type: "dashed" as const } },
      backgroundColor: "rgba(17, 19, 24, 0.96)",
      borderColor: "#2C3240",
      textStyle: { color: "#F1F3F6", fontSize: 11.5 },
    };

    const spanSec = Math.max(timeline.to_ts - timeline.from_ts, windowSec);
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
          if (spanSec >= 12 * 3600) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
          return formatTime(Math.floor(v / 1000));
        },
      },
    };

    const samples = activeLegHistory.samples;

    // Chart 1: Delay & Buffer (ms)
    const leftSeries: echarts.SeriesOption[] = [];
    if (!isPass) {
      if (showLatency) {
        leftSeries.push({
          name: "设定缓冲 (ms)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: COLOR_AMBER },
          lineStyle: { width: 1.5, color: COLOR_AMBER },
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
          itemStyle: { color: COLOR_WHITE },
          lineStyle: { width: 1.7, color: COLOR_WHITE },
          data: toSeries(samples, gapThresholdSec, (s) => Number(s.src_rtt_ms.toFixed(1))),
        });
      }
      if (showDstRtt) {
        leftSeries.push({
          name: "出站 RTT (ms)",
          type: "line",
          showSymbol: false,
          itemStyle: { color: COLOR_CYAN },
          lineStyle: { width: 1.3, type: "dashed", color: COLOR_CYAN },
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
          lineStyle: { width: 1.6, color: COLOR_AMBER },
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
      grid: { left: 38, right: 12, top: 12, bottom: 20 },
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

    // Chart 2: Bandwidth & Retransmit (Mb/s) + Dropped (pkt)
    const rightSeries: echarts.SeriesOption[] = [];
    if (showRate) {
      rightSeries.push({
        name: "实时码率 (Mb/s)",
        type: "line",
        showSymbol: false,
        itemStyle: { color: COLOR_TEAL },
        lineStyle: { width: 1.8, color: COLOR_TEAL },
        areaStyle: { color: "rgba(45, 212, 191, 0.08)" },
        data: toSeries(samples, gapThresholdSec, (s) => Number(s.src_mbps.toFixed(2))),
      });
    }
    if (showRetrans) {
      rightSeries.push({
        name: "重传带宽 (Mb/s)",
        type: "line",
        showSymbol: false,
        itemStyle: { color: COLOR_AMBER },
        lineStyle: { width: 1.5, color: COLOR_AMBER },
        data: toSeries(samples, gapThresholdSec, (s, dt) => calcRetransMbps(s, isPass, dt)),
      });
    }
    if (!isPass && showLinkBw) {
      rightSeries.push({
        name: "预估链路带宽 (Mb/s)",
        type: "line",
        showSymbol: false,
        itemStyle: { color: COLOR_SLATE },
        lineStyle: { width: 1.3, type: "dashed", color: COLOR_SLATE },
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
      grid: { left: 38, right: 30, top: 12, bottom: 20 },
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

    const ro = new ResizeObserver(() => {
      cLeft.resize();
      cRight.resize();
    });
    ro.observe(leftEl);
    ro.observe(rightEl);
    return () => {
      ro.disconnect();
      cLeft.dispose();
      cRight.dispose();
    };
  }, [
    timeline,
    activeLegHistory,
    windowSec,
    isPass,
    layout,
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

  const winSrcPackets = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_packets ?? 0), 0)
    : s.src_packets ?? 0;
  const winSrcBytes = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_bytes ?? 0), 0)
    : s.src_bytes ?? 0;
  const winSrcLost = hasHist ? histSamples.reduce((acc, x) => acc + x.src_lost, 0) : s.src_lost;
  const winSrcRetrans = hasHist ? histSamples.reduce((acc, x) => acc + x.src_retrans, 0) : s.src_retrans;
  const winSrcDropped = hasHist ? histSamples.reduce((acc, x) => acc + x.src_dropped, 0) : s.src_dropped;
  const winSrcBelated = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_belated ?? 0), 0)
    : s.src_belated ?? 0;
  const winSrcReconnects = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.src_reconnects ?? 0), 0)
    : s.src_reconnects ?? 0;

  const winDstPackets = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.dst_packets ?? 0), 0)
    : s.dst_packets ?? 0;
  const winDstBytes = hasHist
    ? histSamples.reduce((acc, x) => acc + (x.dst_bytes ?? 0), 0)
    : s.dst_bytes ?? 0;
  const winDstLost = hasHist ? histSamples.reduce((acc, x) => acc + x.dst_lost, 0) : s.dst_lost;
  const winDstRetrans = hasHist ? histSamples.reduce((acc, x) => acc + x.dst_retrans, 0) : s.dst_retrans;
  const winDstDropped = hasHist ? histSamples.reduce((acc, x) => acc + x.dst_dropped, 0) : s.dst_dropped;
  const winDstNak = hasHist ? histSamples.reduce((acc, x) => acc + x.dst_nak_count, 0) : s.dst_nak_count;
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
  const marginCls =
    marginPct > 100 ? "text-[#F87171]" : marginPct >= 75 ? "text-[#FBBF24]" : "text-[#4ADE80]";

  const maxRestarts = activeLegHistory
    ? activeLegHistory.samples.reduce((m, x) => Math.max(m, x.restart_count), s.restart_count)
    : s.restart_count;
  const udpDrops = activeLegHistory
    ? activeLegHistory.host.reduce((acc, h) => acc + h.udp_rcvbuf_errors, 0)
    : activeLeg.host.udp_rcvbuf_errors;

  const hostAddr = resolveNodeHost(nodes, activeLeg.node_id);
  const pushUrl = `srt://${hostAddr}:${activeLeg.in_port}`;
  const pullUrl = !isPass ? `srt://${hostAddr}:${activeLeg.out_port}` : "";

  async function copyUrl(key: string, label: string, text: string) {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      toast.success(`已复制${label}`);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? "" : cur)), 1500);
    } else {
      toast.error("复制失败，请手动复制");
    }
  }

  const showFaultNote =
    s.fault_code !== "HEALTHY" && s.fault_code !== "IDLE_EXPECTED_OFF" && Boolean(s.fault_summary);
  const isCritNote =
    s.fault_code === "UPSTREAM_OFFLINE" ||
    s.fault_code === "CLOUD_PROCESS_DOWN" ||
    s.fault_code === "NODE_UNREACHABLE";

  const legendBtn = (on: boolean, color: string, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-opacity cursor-pointer",
        on ? "text-[#C5CCD8] hover:text-[#F1F3F6]" : "text-[#586070] opacity-50 line-through"
      )}
    >
      <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      {label}
    </button>
  );

  // ==============================================================
  // INSPECTOR LAYOUT (Option A Multiviewer Right Docked Panel)
  // ==============================================================
  if (layout === "inspector") {
    return (
      <div className="space-y-3.5">
        {/* Time window segmented selector */}
        <div className="inline-flex w-full items-center rounded-md border border-[#232730] bg-[#0B0D10] p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.short}
              type="button"
              onClick={() => setWindowSec(w.sec)}
              className={cn(
                "flex-1 rounded-[4px] py-1 text-[11.5px] font-medium transition-colors cursor-pointer",
                windowSec === w.sec
                  ? "bg-[#222630] text-[#F1F3F6]"
                  : "text-[#7C8596] hover:text-[#D1D7E2]"
              )}
            >
              {w.short}
            </button>
          ))}
        </div>

        {/* Stacked Dual Charts */}
        <div className="space-y-3">
          <div className="rounded-md border border-[#1E222B] bg-[#0D0F12] p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
              <span className="text-[11.5px] font-medium text-[#C8CFD9]">
                {isPass ? "SRT 控制与丢包 · 包" : "时延与缓冲 · ms"}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {!isPass ? (
                  <>
                    {legendBtn(showRtt, COLOR_WHITE, "RTT", () => setShowRtt((v) => !v))}
                    {legendBtn(showRecvBuf, COLOR_TEAL, "缓冲", () => setShowRecvBuf((v) => !v))}
                    {legendBtn(showLatency, COLOR_AMBER, "上限", () => setShowLatency((v) => !v))}
                  </>
                ) : (
                  <>
                    {legendBtn(showRtt, COLOR_AMBER, "NAK", () => setShowRtt((v) => !v))}
                    {legendBtn(showLatency, COLOR_CRIMSON, "弃包", () => setShowLatency((v) => !v))}
                  </>
                )}
              </div>
            </div>
            <div ref={leftChartRef} className="w-full h-[142px]" />
          </div>

          <div className="rounded-md border border-[#1E222B] bg-[#0D0F12] p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
              <span className="text-[11.5px] font-medium text-[#C8CFD9]">码率与重传 · Mb/s</span>
              <div className="flex flex-wrap items-center gap-1">
                {legendBtn(showRate, COLOR_TEAL, "码率", () => setShowRate((v) => !v))}
                {legendBtn(showRetrans, COLOR_AMBER, "重传", () => setShowRetrans((v) => !v))}
                {legendBtn(showDropped, COLOR_CRIMSON, "弃包", () => setShowDropped((v) => !v))}
              </div>
            </div>
            <div ref={rightChartRef} className="w-full h-[142px]" />
          </div>
        </div>

        {/* Concise Ingest & Egress Summary + Copyable URLs */}
        <div className="space-y-3 border-t border-[#1E222B] pt-3">
          {/* Ingest block */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-medium text-[#E6E9EF]">推流端（入站）</span>
              <span className={cn("font-medium", srcSt.cls)}>{srcSt.label}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-md border border-[#1E222B] bg-[#0D0F12] px-2.5 py-2 text-[11px]">
              <div>
                <div className="text-[#6F7889]">码率</div>
                <div className="tabular text-[12px] font-medium text-[#F1F3F6]">{s.src_mbps.toFixed(2)} M</div>
              </div>
              <div>
                <div className="text-[#6F7889]">RTT</div>
                <div className="tabular text-[12px] font-medium text-[#F1F3F6]">
                  {!isPass && s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)} ms` : "-"}
                </div>
              </div>
              <div>
                <div className="text-[#6F7889]">丢包 / 弃包</div>
                <div className="tabular text-[12px] font-medium text-[#F1F3F6]">
                  {winSrcLost} /{" "}
                  <span className={winSrcDropped > 0 ? "text-[#F87171]" : "text-[#4ADE80]"}>
                    {winSrcDropped}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-md border border-[#1E222B] bg-[#0D0F12] px-2.5 py-1.5">
              <span className="text-[11px] text-[#757E8F] shrink-0">推流</span>
              <code className="tabular text-[11.5px] text-[#D7DCE4] truncate flex-1">{pushUrl}</code>
              <button
                type="button"
                onClick={() => void copyUrl("push", "推流地址", pushUrl)}
                className="inline-flex items-center gap-1 rounded border border-[#2A2F3A] bg-[#171A21] px-2 py-0.5 text-[10.5px] text-[#C8CFD9] hover:text-white hover:border-[#3A4150] cursor-pointer shrink-0"
              >
                {copiedKey === "push" ? <Check className="h-3 w-3 text-[#4ADE80]" /> : <Copy className="h-3 w-3" />}
                {copiedKey === "push" ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          {/* Egress block */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-medium text-[#E6E9EF]">拉流端（出站）</span>
              <span className={cn("font-medium", dstSt.cls)}>{dstSt.label}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-md border border-[#1E222B] bg-[#0D0F12] px-2.5 py-2 text-[11px]">
              <div>
                <div className="text-[#6F7889]">码率</div>
                <div className="tabular text-[12px] font-medium text-[#F1F3F6]">{s.dst_mbps.toFixed(2)} M</div>
              </div>
              <div>
                <div className="text-[#6F7889]">RTT</div>
                <div className="tabular text-[12px] font-medium text-[#F1F3F6]">
                  {!isPass && s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)} ms` : "-"}
                </div>
              </div>
              <div>
                <div className="text-[#6F7889]">丢包 / 弃包</div>
                <div className="tabular text-[12px] font-medium text-[#F1F3F6]">
                  {isPass ? winDstNak : winDstLost} /{" "}
                  <span className={(isPass ? winSrcDropped : winDstDropped) > 0 ? "text-[#F87171]" : "text-[#4ADE80]"}>
                    {isPass ? winSrcDropped : winDstDropped}
                  </span>
                </div>
              </div>
            </div>
            {!isPass && pullUrl && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-[#1E222B] bg-[#0D0F12] px-2.5 py-1.5">
                <span className="text-[11px] text-[#757E8F] shrink-0">拉流</span>
                <code className="tabular text-[11.5px] text-[#D7DCE4] truncate flex-1">{pullUrl}</code>
                <button
                  type="button"
                  onClick={() => void copyUrl("pull", "拉流地址", pullUrl)}
                  className="inline-flex items-center gap-1 rounded border border-[#2A2F3A] bg-[#171A21] px-2 py-0.5 text-[10.5px] text-[#C8CFD9] hover:text-white hover:border-[#3A4150] cursor-pointer shrink-0"
                >
                  {copiedKey === "pull" ? <Check className="h-3 w-3 text-[#4ADE80]" /> : <Copy className="h-3 w-3" />}
                  {copiedKey === "pull" ? "已复制" : "复制"}
                </button>
              </div>
            )}
          </div>
        </div>

        {showFaultNote && (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-[11.5px] leading-relaxed",
              isCritNote
                ? "border-[#542228] bg-[#251316] text-[#FCA5A5]"
                : "border-[#463315] bg-[#211A0E] text-[#FCD34D]"
            )}
          >
            {s.fault_summary}
          </div>
        )}
      </div>
    );
  }

  // ==============================================================
  // WIDE WORKSPACE LAYOUT (Option B Master-Detail Focus View)
  // ==============================================================
  return (
    <div className="space-y-4">
      {/* Charts Panel with Underline Time Window Tabs */}
      <div className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E222B] px-4 pt-2.5">
          <div className="flex items-center gap-5" role="group" aria-label="时间窗口">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setWindowSec(w.sec)}
                className={cn(
                  "relative pb-2.5 text-[12px] font-medium transition-colors cursor-pointer",
                  windowSec === w.sec
                    ? "text-[#F1F3F6] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:bg-[#F1F3F6]"
                    : "text-[#7C8596] hover:text-[#D1D7E2]"
                )}
              >
                {w.label}
              </button>
            ))}
          </div>

          <span className="tabular pb-2 text-[11px] text-[#6B7485]">
            {activeLeg.src_device || "发端"} → {activeLeg.node_id} (:{activeLeg.in_port}
            {!isPass ? ` / :${activeLeg.out_port}` : ""}) → {activeLeg.dst_device || "收端"}
          </span>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-[#1E222B]">
          {/* Left Chart */}
          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-[12px] font-medium text-[#D7DCE4]">
                {isPass ? "SRT 控制与丢包事件 · 包" : "传输时延与缓冲 · ms"}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {!isPass ? (
                  <>
                    {legendBtn(showRtt, COLOR_WHITE, "入站 RTT", () => setShowRtt((v) => !v))}
                    {legendBtn(showDstRtt, COLOR_CYAN, "出站 RTT", () => setShowDstRtt((v) => !v))}
                    {legendBtn(showRecvBuf, COLOR_TEAL, "接收缓冲", () => setShowRecvBuf((v) => !v))}
                    {legendBtn(showLatency, COLOR_AMBER, "设定缓冲", () => setShowLatency((v) => !v))}
                  </>
                ) : (
                  <>
                    {legendBtn(showRtt, COLOR_AMBER, "请求重发 (NAK)", () => setShowRtt((v) => !v))}
                    {legendBtn(showLatency, COLOR_CRIMSON, "未恢复弃包", () => setShowLatency((v) => !v))}
                  </>
                )}
              </div>
            </div>
            <div ref={leftChartRef} className="w-full h-[210px]" />
          </div>

          {/* Right Chart */}
          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-[12px] font-medium text-[#D7DCE4]">码率与重传丢包 · Mb/s</span>
              <div className="flex flex-wrap items-center gap-1">
                {legendBtn(showRate, COLOR_TEAL, "实时码率", () => setShowRate((v) => !v))}
                {legendBtn(showRetrans, COLOR_AMBER, "重传带宽", () => setShowRetrans((v) => !v))}
                {!isPass && legendBtn(showLinkBw, COLOR_SLATE, "预估链路带宽", () => setShowLinkBw((v) => !v))}
                {legendBtn(showDropped, COLOR_CRIMSON, "未恢复弃包", () => setShowDropped((v) => !v))}
              </div>
            </div>
            <div ref={rightChartRef} className="w-full h-[210px]" />
          </div>
        </div>
      </div>

      {/* Full Dual-Column Source & Destination Telemetry Tables (Borderless Hairline Style) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Source / Ingest */}
        <div className="rounded-lg border border-[#232730] bg-[#111316] p-4">
          <div className="mb-2.5 flex items-center justify-between">
            <h3 className="text-[12.5px] font-medium text-[#E6E9EF]">
              推流端统计（入站 · {winLabel}）
            </h3>
            <span className={cn("text-[12px] font-medium", srcSt.cls)}>{srcSt.label}</span>
          </div>
          <div className="divide-y divide-[#1C2028] text-[12px]">
            <StatRow label="发端来源 IP">
              <span className="tabular text-[#E6E9EF]">
                {s.src_peer_ip || "-"}
                {s.path_medium && s.path_medium !== "-" && (
                  <span className="ml-1.5 text-[11px] text-[#757E8F]">({s.path_medium})</span>
                )}
              </span>
            </StatRow>
            <StatRow label="入站码率">
              <span className="tabular text-[#F1F3F6] font-medium">{s.src_mbps.toFixed(2)} Mb/s</span>
            </StatRow>
            {!isPass && (
              <>
                <StatRow label="链路带宽 / 上限">
                  <span className="tabular text-[#E6E9EF]">
                    {linkBwMbps > 0 ? `${linkBwMbps.toFixed(1)} Mb/s` : "-"}
                    {maxBwMbps > 0 && <span className="ml-1 text-[#757E8F]">/ {maxBwMbps.toFixed(0)}</span>}
                  </span>
                </StatRow>
                <StatRow label="入站时延 RTT">
                  <span className="tabular text-[#E6E9EF]">
                    {s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)} ms` : "-"}
                    {srcRttRange && (
                      <span className="ml-1.5 text-[11px] text-[#757E8F]">
                        ({srcRttRange[0].toFixed(0)}–{srcRttRange[1].toFixed(0)})
                      </span>
                    )}
                  </span>
                </StatRow>
                <StatRow label="设定缓冲 / 当前缓冲">
                  <span className="tabular text-[#E6E9EF]">
                    {hasTSBPD ? (
                      <>
                        {s.src_tsbpd_ms.toFixed(0)} / {(s.src_buf_ms ?? 0).toFixed(0)} ms
                        <span className={cn("ml-1.5 text-[11px]", marginCls)}>
                          (4×RTT 占 {marginPct}%)
                        </span>
                      </>
                    ) : (
                      "-"
                    )}
                  </span>
                </StatRow>
              </>
            )}
            <StatRow label="累计收包 / 流量">
              <span className="tabular text-[#E6E9EF]">
                {winSrcPackets > 0 ? `${winSrcPackets.toLocaleString()} 包` : "-"}
                {winSrcBytes > 0 && <span className="ml-1.5 text-[#757E8F]">· {formatBytes(winSrcBytes)}</span>}
              </span>
            </StatRow>
            {!isPass ? (
              <>
                <StatRow label="网络丢包 / 重传救回">
                  <span className="tabular text-[#E6E9EF]">
                    {winSrcLost.toLocaleString()} ({formatPct(winSrcLost, winSrcPackets)}) /{" "}
                    {winSrcRetrans.toLocaleString()} ({formatPct(winSrcRetrans, winSrcPackets)})
                  </span>
                </StatRow>
                <StatRow label="未恢复弃包 / 迟到包">
                  <span
                    className={cn(
                      "tabular font-medium",
                      winSrcDropped > 0 ? "text-[#F87171]" : srcFlowing ? "text-[#4ADE80]" : "text-[#98A1B0]"
                    )}
                  >
                    {winSrcDropped.toLocaleString()}
                    <span className="ml-1.5 font-normal text-[#757E8F]">
                      / 迟到 {winSrcBelated.toLocaleString()}
                    </span>
                  </span>
                </StatRow>
              </>
            ) : (
              <StatRow label="透传加密模式">
                <span className="text-[#4ADE80]">
                  {s.encrypted ? "端到端 AES 加密透传" : "L4 原包直通透传"}
                </span>
              </StatRow>
            )}
            <StatRow label={isPass ? "握手次数" : "推流重连次数"}>
              <span className={cn("tabular", winSrcReconnects > 0 ? "text-[#FBBF24]" : "text-[#E6E9EF]")}>
                {winSrcReconnects} 次
              </span>
            </StatRow>
          </div>
        </div>

        {/* Destination / Egress & Server */}
        <div className="rounded-lg border border-[#232730] bg-[#111316] p-4">
          <div className="mb-2.5 flex items-center justify-between">
            <h3 className="text-[12.5px] font-medium text-[#E6E9EF]">
              拉流端与服务器（出站 · {winLabel}）
            </h3>
            <span className={cn("text-[12px] font-medium", dstSt.cls)}>{dstSt.label}</span>
          </div>
          <div className="divide-y divide-[#1C2028] text-[12px]">
            <StatRow label="收端连接 IP">
              <span className="tabular text-[#E6E9EF]">{s.dst_peer_ip || activeLeg.target_addr || "-"}</span>
            </StatRow>
            <StatRow label="出站码率">
              <span className="tabular text-[#F1F3F6] font-medium">{s.dst_mbps.toFixed(2)} Mb/s</span>
            </StatRow>
            {!isPass ? (
              <>
                <StatRow label="出站预估带宽">
                  <span className="tabular text-[#E6E9EF]">
                    {dstLinkBwMbps > 0 ? `${dstLinkBwMbps.toFixed(1)} Mb/s` : "-"}
                  </span>
                </StatRow>
                <StatRow label="出站时延 RTT">
                  <span className="tabular text-[#E6E9EF]">
                    {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)} ms` : "-"}
                    {dstRttRange && (
                      <span className="ml-1.5 text-[11px] text-[#757E8F]">
                        ({dstRttRange[0].toFixed(0)}–{dstRttRange[1].toFixed(0)})
                      </span>
                    )}
                  </span>
                </StatRow>
                <StatRow label="发送缓冲深度">
                  <span className="tabular text-[#E6E9EF]">
                    {s.dst_connected ? `${(s.dst_buf_ms ?? 0).toFixed(0)} ms` : "-"}
                  </span>
                </StatRow>
                <StatRow label="累计发包 / 流量">
                  <span className="tabular text-[#E6E9EF]">
                    {winDstPackets > 0 ? `${winDstPackets.toLocaleString()} 包` : "-"}
                    {winDstBytes > 0 && <span className="ml-1.5 text-[#757E8F]">· {formatBytes(winDstBytes)}</span>}
                  </span>
                </StatRow>
                <StatRow label="下行丢包 / 重传救回">
                  <span className="tabular text-[#E6E9EF]">
                    {winDstLost.toLocaleString()} ({formatPct(winDstLost, winDstPackets)}) /{" "}
                    {winDstRetrans.toLocaleString()}
                  </span>
                </StatRow>
                <StatRow label="下行未恢复弃包">
                  <span
                    className={cn(
                      "tabular font-medium",
                      winDstDropped > 0 ? "text-[#F87171]" : dstFlowing ? "text-[#4ADE80]" : "text-[#98A1B0]"
                    )}
                  >
                    {winDstDropped.toLocaleString()}
                  </span>
                </StatRow>
                <StatRow label="拉流重连次数">
                  <span className={cn("tabular", winDstReconnects > 0 ? "text-[#FBBF24]" : "text-[#E6E9EF]")}>
                    {winDstReconnects} 次
                  </span>
                </StatRow>
              </>
            ) : (
              <>
                <StatRow label="解码端请求重发 (NAK)">
                  <span className="tabular text-[#E6E9EF]">{winDstNak.toLocaleString()} 包</span>
                </StatRow>
                <StatRow label="ARQ 重传救回">
                  <span className="tabular text-[#E6E9EF]">{winSrcRetrans.toLocaleString()} 包</span>
                </StatRow>
                <StatRow label="未恢复弃包 (DropReq)">
                  <span
                    className={cn(
                      "tabular font-medium",
                      winSrcDropped > 0 ? "text-[#F87171]" : srcFlowing ? "text-[#4ADE80]" : "text-[#98A1B0]"
                    )}
                  >
                    {winSrcDropped.toLocaleString()} 包
                  </span>
                </StatRow>
              </>
            )}
            <StatRow label="中转服务器">
              <span
                className={cn(
                  "tabular",
                  maxRestarts === 0 && udpDrops === 0 ? "text-[#4ADE80]" : "text-[#F87171]"
                )}
              >
                {activeLeg.node_id} · 运行 {formatUptime(s.uptime_sec)} · 重启 {maxRestarts} · 系统丢包 {udpDrops}
              </span>
            </StatRow>
          </div>
        </div>
      </div>

      {showFaultNote && (
        <div
          className={cn(
            "rounded-md border px-3.5 py-2.5 text-[12px]",
            isCritNote
              ? "border-[#542228] bg-[#251316] text-[#FCA5A5]"
              : "border-[#463315] bg-[#211A0E] text-[#FCD34D]"
          )}
        >
          {s.fault_summary}
        </div>
      )}
    </div>
  );
}

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-[#8B94A5] shrink-0">{label}</span>
      <div className="text-right min-w-0 truncate">{children}</div>
    </div>
  );
}
