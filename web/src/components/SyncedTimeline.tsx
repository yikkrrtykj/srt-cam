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
    case "DOWNSTREAM_OFFLINE":
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
  gapThresholdSec: number,
  pick: (item: T) => number
): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (i > 0 && cur.ts - items[i - 1].ts > gapThresholdSec) {
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
      const bg = theme === "dark" ? "#20232a" : "#ffffff";
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

        ctx.fillStyle = theme === "dark" ? "#181a1f" : "#f0f2f5";
        ctx.fillRect(0, 0, width, totalH);

        ctx.fillStyle = "#121419";
        ctx.fillRect(0, 0, width, headerH);
        headerLines.forEach((line, idx) => {
          ctx.font = idx === 0 ? "bold 26px sans-serif" : "19px sans-serif";
          ctx.fillStyle = idx === 0 ? "#ffffff" : "#a7b0be";
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
    const axisLineColor = isDark ? "#383e4c" : "#cbd5e1";
    const splitLineColor = isDark ? "rgba(255,255,255,0.06)" : "#f1f5f9";
    const labelColor = isDark ? "#8b94a5" : "#64748b";
    const legendColor = isDark ? "#a7b0be" : "#475569";

    const visibleLegs = showBackupOverlay ? data.legs : data.legs.slice(0, 1);
    const primaryLeg = visibleLegs[0];
    const backupLeg = visibleLegs[1];

    const spanSec = Math.max(data.to_ts - data.from_ts, 300);
    const gapThresholdSec = Math.max(30, Math.ceil((spanSec / 600) * 3));

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
      axisPointer: { type: "cross" as const, lineStyle: { color: "#788294", type: "dashed" as const } },
      backgroundColor: isDark ? "rgba(20, 22, 28, 0.96)" : "rgba(15, 23, 42, 0.94)",
      borderColor: "#404756",
      textStyle: { color: "#eceff4", fontSize: 12 },
    };

    // Layer 1: Ingest (Source -> Gateway)
    const l1Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l1Series.push(
        {
          name: `${legLabel(primaryLeg)} 推流 Mb/s`,
          type: "line",
          showSymbol: false,
          itemStyle: { color: "#818cf8" },
          lineStyle: { width: 2, color: "#818cf8" },
          areaStyle: { color: "rgba(129, 140, 248, 0.10)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.src_mbps.toFixed(2))),
        },
        {
          name: `${legLabel(primaryLeg)} 时延 ms`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          itemStyle: { color: isDark ? "#e2e8f0" : "#1e293b" },
          lineStyle: { width: 1.5, type: "dashed", color: isDark ? "#e2e8f0" : "#1e293b" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.src_rtt_ms.toFixed(1))),
        },
        {
          name: `${legLabel(primaryLeg)} 重传救回`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "rgba(245, 158, 11, 0.65)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => s.src_retrans),
        },
        {
          name: `${legLabel(primaryLeg)} 未恢复弃包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "#ef4444" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => s.src_dropped),
        }
      );
    }
    if (backupLeg) {
      l1Series.push({
        name: `${legLabel(backupLeg)} 推流 Mb/s`,
        type: "line",
        showSymbol: false,
        itemStyle: { color: "#34d399" },
        lineStyle: { width: 1.9, color: "#34d399" },
        data: toTimeSeries(backupLeg.samples, gapThresholdSec, (s) => Number(s.src_mbps.toFixed(2))),
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
        { type: "value", name: "ms / 包", min: 0, max: (v: { max: number }) => Math.max(v.max, 10), splitLine: { show: false }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l1Series,
    });

    // Layer 2: Gateway Server Health
    const l2Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l2Series.push(
        {
          name: `${primaryLeg.leg.node_id} CPU%`,
          type: "line",
          showSymbol: false,
          itemStyle: { color: "#94a3b8" },
          lineStyle: { width: 1.6, color: "#94a3b8" },
          data: toTimeSeries(primaryLeg.host, gapThresholdSec, (h) => Number(h.cpu_percent.toFixed(1))),
        },
        {
          name: `${primaryLeg.leg.node_id} 通道重启`,
          type: "line",
          step: "end",
          yAxisIndex: 1,
          showSymbol: false,
          itemStyle: { color: "#34d399" },
          lineStyle: { width: 2, color: "#34d399" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => s.restart_count),
        },
        {
          name: `${primaryLeg.leg.node_id} 系统缓冲丢包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 7,
          itemStyle: { color: "#ef4444" },
          data: toTimeSeries(primaryLeg.host, gapThresholdSec, (h) => h.udp_rcvbuf_errors),
        }
      );
    }
    if (backupLeg) {
      l2Series.push({
        name: `${backupLeg.leg.node_id} CPU%`,
        type: "line",
        showSymbol: false,
        itemStyle: { color: "#34d399" },
        lineStyle: { width: 1.3, type: "dashed", color: "#34d399" },
        data: toTimeSeries(backupLeg.host, gapThresholdSec, (h) => Number(h.cpu_percent.toFixed(1))),
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
        { type: "value", name: "次 / 包", min: 0, max: (v: { max: number }) => Math.max(v.max, 5), minInterval: 1, splitLine: { show: false }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l2Series,
    });

    // Layer 3: Egress (Gateway -> Destination)
    const l3Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      const isPass = primaryLeg.leg.mode === "udp-passthrough";
      l3Series.push(
        {
          name: `${legLabel(primaryLeg)} 拉流 Mb/s`,
          type: "line",
          showSymbol: false,
          itemStyle: { color: "#38bdf8" },
          lineStyle: { width: 2, color: "#38bdf8" },
          areaStyle: { color: "rgba(56, 189, 248, 0.10)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.dst_mbps.toFixed(2))),
        },
        {
          name: `${legLabel(primaryLeg)} 时延 ms`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          itemStyle: { color: "#f59e0b" },
          lineStyle: { width: 1.4, type: "dashed", color: "#f59e0b" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.dst_rtt_ms.toFixed(1))),
        },
        {
          name: `${legLabel(primaryLeg)} ${isPass ? "请求重发" : "重传救回"}`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "rgba(245, 158, 11, 0.58)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => (isPass ? s.dst_nak_count : s.dst_retrans)),
        },
        {
          name: `${legLabel(primaryLeg)} 未恢复弃包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "#ef4444" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => (isPass ? s.src_dropped : s.dst_dropped)),
        }
      );
    }
    if (backupLeg) {
      l3Series.push({
        name: `${legLabel(backupLeg)} 拉流 Mb/s`,
        type: "line",
        showSymbol: false,
        itemStyle: { color: "#34d399" },
        lineStyle: { width: 1.9, color: "#34d399" },
        data: toTimeSeries(backupLeg.samples, gapThresholdSec, (s) => Number(s.dst_mbps.toFixed(2))),
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
        { type: "value", name: "ms / 包", min: 0, max: (v: { max: number }) => Math.max(v.max, 10), splitLine: { show: false }, axisLabel: { fontSize: 11, color: labelColor }, nameTextStyle: { color: labelColor } },
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
        itemStyle: { color: "#ef4444" },
        lineStyle: { width: 2.2, color: "#ef4444" },
        areaStyle: { color: "rgba(239, 68, 68, 0.16)" },
        data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => faultSeverityScore(s.fault_code)),
      });
    }
    if (backupLeg) {
      l4Series.push({
        name: `${legLabel(backupLeg)}`,
        type: "line",
        step: "end",
        showSymbol: false,
        itemStyle: { color: "#34d399" },
        lineStyle: { width: 2, color: "#34d399" },
        data: toTimeSeries(backupLeg.samples, gapThresholdSec, (s) => faultSeverityScore(s.fault_code)),
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
            if (pSample && Math.abs(pSample.ts - tsSec) <= gapThresholdSec) {
              lines.push(`${legLabel(primaryLeg)}: ${pSample.fault_summary}`);
            }
          }
          if (backupLeg) {
            const bSample = nearestSample(backupLeg.samples, tsSec);
            if (bSample && Math.abs(bSample.ts - tsSec) <= gapThresholdSec) {
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
          formatter: (v: number) => (v === 0 ? "正常" : v === 1 ? "波动" : "中断"),
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
              backgroundColor: isDark ? "#181a1f" : "#f8fafc",
              fillerColor: "rgba(91, 141, 239, 0.22)",
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
          <span className="layer-name">推流段 · 发端 → 中转服务器</span>
          <span className="layer-meta">码率 / 往返时延 / 重传与弃包</span>
        </div>
        <div ref={layer1Ref} style={{ width: "100%", height: 164 }} />
      </div>

      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">中转服务器负载</span>
          <span className="layer-meta">CPU 占用 / 通道重启 / 系统缓冲丢包</span>
        </div>
        <div ref={layer2Ref} style={{ width: "100%", height: 138 }} />
      </div>

      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">拉流段 · 中转服务器 → 收端</span>
          <span className="layer-meta">码率 / 往返时延 / 重传与弃包</span>
        </div>
        <div ref={layer3Ref} style={{ width: "100%", height: 164 }} />
      </div>

      <div className="layer-box">
        <div className="layer-bar">
          <span className="layer-name">整路信号状态</span>
          <span className="layer-meta">正常 / 波动 / 中断 · 主备同轴对比</span>
        </div>
        <div ref={layer4Ref} style={{ width: "100%", height: cleanView ? 128 : 164 }} />
      </div>
    </div>
  );
});
