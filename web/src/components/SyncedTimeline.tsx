import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import * as echarts from "echarts";
import type { ChannelSample, GroupTimelineResponse, LegTimeline } from "../types";
import { formatTime } from "../api";

export interface SyncedTimelineHandle {
  exportReportPNG: (headerLines: string[]) => void;
}

interface Props {
  data: GroupTimelineResponse;
  showBackupOverlay: boolean;
  cleanView: boolean;
  theme: "dark" | "light";
}

const SYNC_GROUP = "srt-cam-4layer-sync";
const GAP_BREAK_SEC = 30;

function faultSeverityScore(code: string): number {
  switch (code) {
    case "HEALTHY":
      return 0;
    case "IDLE_EXPECTED_OFF":
    case "NO_NATIVE_STATS":
      return 0.5;
    case "TUNNEL_LO_WARNING":
    case "UPSTREAM_DEGRADED":
    case "DOWNSTREAM_DEGRADED":
      return 1;
    default:
      return 2;
  }
}

function legLabel(lt: LegTimeline): string {
  const role = lt.leg.role === "primary" ? "主" : lt.leg.role === "backup" ? "备" : "单";
  const carrier = lt.leg.carrier ? `·${lt.leg.carrier}` : "";
  return `${role}(${lt.leg.node_id}${carrier})`;
}

function toTimeSeries<T extends { ts: number }>(
  items: T[],
  pick: (item: T) => number
): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (i > 0 && cur.ts - items[i - 1].ts > GAP_BREAK_SEC) {
      out.push([(items[i - 1].ts + 1) * 1000, null]);
    }
    out.push([cur.ts * 1000, pick(cur)]);
  }
  return out;
}

function nearestSample(samples: ChannelSample[], targetSec: number): ChannelSample | undefined {
  if (samples.length === 0) return undefined;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts < targetSec) lo = mid + 1;
    else hi = mid;
  }
  const cand = samples[lo];
  if (lo > 0 && Math.abs(samples[lo - 1].ts - targetSec) < Math.abs(cand.ts - targetSec)) {
    return samples[lo - 1];
  }
  return cand;
}

export const SyncedTimeline = forwardRef<SyncedTimelineHandle, Props>(function SyncedTimeline(
  { data, showBackupOverlay, cleanView, theme },
  ref
) {
  const layer1Ref = useRef<HTMLDivElement>(null);
  const layer2Ref = useRef<HTMLDivElement>(null);
  const layer3Ref = useRef<HTMLDivElement>(null);
  const layer4Ref = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<echarts.ECharts[]>([]);

  useImperativeHandle(ref, () => ({
    exportReportPNG(headerLines: string[]) {
      const charts = chartsRef.current;
      if (charts.length === 0) return;
      const bg = theme === "dark" ? "#151b23" : "#ffffff";
      const imgs = charts.map((c) => {
        const img = new Image();
        img.src = c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
        return img;
      });
      Promise.all(
        imgs.map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) resolve();
              else img.onload = () => resolve();
            })
        )
      ).then(() => {
        const width = Math.max(...imgs.map((i) => i.width), 1600);
        const headerH = 44 + headerLines.length * 32;
        const pad = 24;
        const gap = 14;
        const totalH = headerH + pad + imgs.reduce((acc, i) => acc + i.height + gap, 0) + pad;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = totalH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.fillStyle = theme === "dark" ? "#0d1117" : "#f0f2f5";
        ctx.fillRect(0, 0, width, totalH);

        ctx.fillStyle = "#0a0e14";
        ctx.fillRect(0, 0, width, headerH);
        headerLines.forEach((line, idx) => {
          ctx.font = idx === 0 ? "bold 26px sans-serif" : "19px sans-serif";
          ctx.fillStyle = idx === 0 ? "#ffffff" : "#9aa7b8";
          ctx.fillText(line, 28, 40 + idx * 32);
        });

        let y = headerH + pad;
        for (const img of imgs) {
          ctx.drawImage(img, 0, y);
          y += img.height + gap;
        }

        const link = document.createElement("a");
        link.download = `SRT-${data.group.name}-${data.from_ts}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      });
    },
  }));

  useEffect(() => {
    const els = [layer1Ref.current, layer2Ref.current, layer3Ref.current, layer4Ref.current];
    if (els.some((el) => !el)) return;

    const instances = els.map((el) => echarts.init(el!));
    instances.forEach((c) => {
      c.group = SYNC_GROUP;
    });
    echarts.connect(SYNC_GROUP);
    chartsRef.current = instances;

    const isDark = theme === "dark";
    const axisLineColor = isDark ? "#2d3a4b" : "#cbd5e1";
    const splitLineColor = isDark ? "#1e2734" : "#f1f5f9";
    const labelColor = isDark ? "#8b949e" : "#64748b";
    const legendColor = isDark ? "#9aa7b8" : "#475569";

    const visibleLegs = showBackupOverlay ? data.legs : data.legs.slice(0, 1);
    const primaryLeg = visibleLegs[0];
    const backupLeg = visibleLegs[1];

    const baseGrid = { left: 54, right: 54, top: 32, bottom: 24 };
    const commonTimeAxis = {
      type: "time" as const,
      min: data.from_ts * 1000,
      max: data.to_ts * 1000,
      axisLine: { lineStyle: { color: axisLineColor } },
      axisLabel: {
        color: labelColor,
        fontSize: 11,
        formatter: (v: number) => formatTime(Math.floor(v / 1000)),
      },
    };

    const tooltipCommon = {
      trigger: "axis" as const,
      axisPointer: { type: "cross" as const, lineStyle: { color: "#6e7c8e", type: "dashed" as const } },
      backgroundColor: isDark ? "rgba(13, 17, 23, 0.96)" : "rgba(15, 23, 42, 0.94)",
      borderColor: "#324054",
      textStyle: { color: "#e6edf3", fontSize: 12 },
    };

    // Layer 1: Ingest (Source -> Gateway)
    const l1Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l1Series.push(
        {
          name: `${legLabel(primaryLeg)} 入站 Mb/s`,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2, color: "#2f81f7" },
          areaStyle: { color: "rgba(47, 129, 247, 0.10)" },
          data: toTimeSeries(primaryLeg.samples, (s) => Number(s.src_mbps.toFixed(2))),
        },
        {
          name: `${legLabel(primaryLeg)} RTT ms`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 1.4, type: "dashed", color: "#e3b341" },
          data: toTimeSeries(primaryLeg.samples, (s) => Number(s.src_rtt_ms.toFixed(1))),
        },
        {
          name: `${legLabel(primaryLeg)} 重传/丢弃`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "rgba(248, 81, 73, 0.72)" },
          data: toTimeSeries(primaryLeg.samples, (s) => s.src_retrans + s.src_dropped),
        }
      );
    }
    if (backupLeg) {
      l1Series.push({
        name: `${legLabel(backupLeg)} 入站 Mb/s`,
        type: "line",
        showSymbol: false,
        lineStyle: { width: 1.9, color: "#3fb950" },
        data: toTimeSeries(backupLeg.samples, (s) => Number(s.src_mbps.toFixed(2))),
      });
    }

    instances[0].setOption({
      animation: false,
      tooltip: tooltipCommon,
      legend: { top: 2, left: 6, textStyle: { fontSize: 11, color: legendColor } },
      grid: baseGrid,
      xAxis: commonTimeAxis,
      yAxis: [
        { type: "value", name: "Mb/s", min: 0, splitLine: { lineStyle: { color: splitLineColor } }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
        { type: "value", name: "ms / pkt", min: 0, splitLine: { show: false }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l1Series,
    });

    // Layer 2: Gateway Node Health
    const l2Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l2Series.push(
        {
          name: `${primaryLeg.leg.node_id} CPU%`,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.6, color: "#8b949e" },
          data: toTimeSeries(primaryLeg.host, (h) => Number(h.cpu_percent.toFixed(1))),
        },
        {
          name: `${primaryLeg.leg.node_id} 进程重启`,
          type: "line",
          step: "end",
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 2, color: "#3fb950" },
          data: toTimeSeries(primaryLeg.samples, (s) => s.restart_count),
        },
        {
          name: `${primaryLeg.leg.node_id} UDP 丢包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 7,
          itemStyle: { color: "#f85149" },
          data: toTimeSeries(primaryLeg.host, (h) => h.udp_rcvbuf_errors),
        }
      );
    }
    if (backupLeg) {
      l2Series.push({
        name: `${backupLeg.leg.node_id} CPU%`,
        type: "line",
        showSymbol: false,
        lineStyle: { width: 1.3, type: "dashed", color: "#3fb950" },
        data: toTimeSeries(backupLeg.host, (h) => Number(h.cpu_percent.toFixed(1))),
      });
    }

    instances[1].setOption({
      animation: false,
      tooltip: tooltipCommon,
      legend: { top: 2, left: 6, textStyle: { fontSize: 11, color: legendColor } },
      grid: baseGrid,
      xAxis: commonTimeAxis,
      yAxis: [
        { type: "value", name: "CPU%", min: 0, max: 100, splitLine: { lineStyle: { color: splitLineColor } }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
        { type: "value", name: "次 / 包", min: 0, minInterval: 1, splitLine: { show: false }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l2Series,
    });

    // Layer 3: Egress (Gateway -> Destination)
    const l3Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l3Series.push(
        {
          name: `${legLabel(primaryLeg)} 出站 Mb/s`,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2, color: "#38bdf8" },
          areaStyle: { color: "rgba(56, 189, 248, 0.10)" },
          data: toTimeSeries(primaryLeg.samples, (s) => Number(s.dst_mbps.toFixed(2))),
        },
        {
          name: `${legLabel(primaryLeg)} RTT ms`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 1.4, type: "dashed", color: "#f97316" },
          data: toTimeSeries(primaryLeg.samples, (s) => Number(s.dst_rtt_ms.toFixed(1))),
        },
        {
          name: `${legLabel(primaryLeg)} 丢弃 / NAK`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "rgba(248, 81, 73, 0.78)" },
          data: toTimeSeries(primaryLeg.samples, (s) => s.dst_dropped + s.dst_nak_count),
        }
      );
    }
    if (backupLeg) {
      l3Series.push({
        name: `${legLabel(backupLeg)} 出站 Mb/s`,
        type: "line",
        showSymbol: false,
        lineStyle: { width: 1.9, color: "#3fb950" },
        data: toTimeSeries(backupLeg.samples, (s) => Number(s.dst_mbps.toFixed(2))),
      });
    }

    instances[2].setOption({
      animation: false,
      tooltip: tooltipCommon,
      legend: { top: 2, left: 6, textStyle: { fontSize: 11, color: legendColor } },
      grid: baseGrid,
      xAxis: commonTimeAxis,
      yAxis: [
        { type: "value", name: "Mb/s", min: 0, splitLine: { lineStyle: { color: splitLineColor } }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
        { type: "value", name: "ms / pkt", min: 0, splitLine: { show: false }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l3Series,
    });

    // Layer 4: Path State Band
    const l4Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l4Series.push({
        name: `${legLabel(primaryLeg)}`,
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { width: 2.2, color: "#f85149" },
        areaStyle: { color: "rgba(248, 81, 73, 0.16)" },
        data: toTimeSeries(primaryLeg.samples, (s) => faultSeverityScore(s.fault_code)),
      });
    }
    if (backupLeg) {
      l4Series.push({
        name: `${legLabel(backupLeg)}`,
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { width: 2, color: "#3fb950" },
        data: toTimeSeries(backupLeg.samples, (s) => faultSeverityScore(s.fault_code)),
      });
    }

    instances[3].setOption({
      animation: false,
      tooltip: {
        ...tooltipCommon,
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [];
          if (list.length === 0) return "";
          const first = list[0] as { value?: [number, number] };
          const ms = first.value?.[0];
          if (!ms) return "";
          const tsSec = Math.floor(ms / 1000);
          const lines = [`<strong>${formatTime(tsSec)}</strong>`];
          if (primaryLeg) {
            const pSample = nearestSample(primaryLeg.samples, tsSec);
            if (pSample && Math.abs(pSample.ts - tsSec) <= GAP_BREAK_SEC) {
              lines.push(`${legLabel(primaryLeg)}: ${pSample.fault_summary}`);
            }
          }
          if (backupLeg) {
            const bSample = nearestSample(backupLeg.samples, tsSec);
            if (bSample && Math.abs(bSample.ts - tsSec) <= GAP_BREAK_SEC) {
              lines.push(`${legLabel(backupLeg)}: ${bSample.fault_summary}`);
            }
          }
          return lines.join("<br/>");
        },
      },
      legend: { top: 2, left: 6, textStyle: { fontSize: 11, color: legendColor } },
      grid: { left: 54, right: 54, top: 28, bottom: cleanView ? 24 : 50 },
      xAxis: commonTimeAxis,
      yAxis: {
        type: "value",
        min: 0,
        max: 2,
        interval: 1,
        axisLabel: {
          fontSize: 11,
          color: labelColor,
          formatter: (v: number) => (v === 0 ? "OK" : v === 1 ? "WARN" : "DOWN"),
        },
        splitLine: { lineStyle: { color: splitLineColor } },
      },
      dataZoom: cleanView
        ? []
        : [
            { type: "inside", xAxisIndex: 0 },
            {
              type: "slider",
              height: 18,
              bottom: 6,
              borderColor: axisLineColor,
              backgroundColor: isDark ? "#0d1117" : "#f8fafc",
              fillerColor: "rgba(47, 129, 247, 0.22)",
              textStyle: { color: labelColor },
            },
          ],
      series: l4Series,
    });

    const onResize = () => instances.forEach((c) => c.resize());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      instances.forEach((c) => c.dispose());
      chartsRef.current = [];
    };
  }, [data, showBackupOverlay, cleanView, theme]);

  return (
    <div className="layer-stack">
      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">入站 · Source → Gateway</span>
          <span className="layer-meta">Bitrate / RTT / Retrans & Drop</span>
        </div>
        <div ref={layer1Ref} style={{ width: "100%", height: 164 }} />
      </div>

      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">节点 · Gateway Host</span>
          <span className="layer-meta">CPU / Restarts / UDP RcvbufErrors</span>
        </div>
        <div ref={layer2Ref} style={{ width: "100%", height: 138 }} />
      </div>

      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">出站 · Gateway → Destination</span>
          <span className="layer-meta">Bitrate / RTT / Drop & NAK</span>
        </div>
        <div ref={layer3Ref} style={{ width: "100%", height: 164 }} />
      </div>

      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">状态 · Path Health</span>
          <span className="layer-meta">OK / WARN / DOWN · 主备同轴对比</span>
        </div>
        <div ref={layer4Ref} style={{ width: "100%", height: cleanView ? 128 : 164 }} />
      </div>
    </div>
  );
});
