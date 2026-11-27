import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import * as echarts from "echarts";
import type { ChannelSample, GroupTimelineResponse, LegTimeline } from "@/types";
import { formatTime } from "@/api";

export interface SyncedTimelineHandle {
  exportReportPNG: (headerLines: string[]) => void;
}

interface Props {
  data: GroupTimelineResponse;
  showBackupOverlay: boolean;
  cleanView: boolean;
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
  { data, showBackupOverlay, cleanView },
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
      const imgs = charts.map((c) => {
        const img = new Image();
        img.src = c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#111316" });
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

        ctx.fillStyle = "#0A0B0D";
        ctx.fillRect(0, 0, width, totalH);

        ctx.fillStyle = "#111316";
        ctx.fillRect(0, 0, width, headerH);
        headerLines.forEach((line, idx) => {
          ctx.font = idx === 0 ? "bold 26px sans-serif" : "19px sans-serif";
          ctx.fillStyle = idx === 0 ? "#F1F3F6" : "#98A1B0";
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

    const axisLineColor = "#232730";
    const splitLineColor = "rgba(255,255,255,0.045)";
    const labelColor = "#757E8F";
    const legendColor = "#98A1B0";

    const visibleLegs = showBackupOverlay ? data.legs : data.legs.slice(0, 1);
    const primaryLeg = visibleLegs[0];
    const backupLeg = visibleLegs[1];

    const spanSec = Math.max(data.to_ts - data.from_ts, 300);
    const gapThresholdSec = Math.max(30, Math.ceil((spanSec / 600) * 3));

    const baseGrid = { left: 50, right: 48, top: 48, bottom: 24 };
    const commonTimeAxis = {
      type: "time" as const,
      min: data.from_ts * 1000,
      max: data.to_ts * 1000,
      axisLine: { lineStyle: { color: axisLineColor } },
      axisTick: { show: false },
      axisLabel: {
        color: labelColor,
        fontSize: 10.5,
        formatter: (v: number) => {
          const d = new Date(v);
          const pad = (n: number) => String(n).padStart(2, "0");
          if (spanSec >= 12 * 3600) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
          return formatTime(Math.floor(v / 1000));
        },
      },
    };

    const tooltipCommon = {
      trigger: "axis" as const,
      axisPointer: { type: "cross" as const, lineStyle: { color: "#4E5768", type: "dashed" as const } },
      backgroundColor: "rgba(17, 19, 24, 0.96)",
      borderColor: "#2C3240",
      textStyle: { color: "#F1F3F6", fontSize: 12 },
    };

    // Layer 1: Ingest
    const l1Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l1Series.push(
        {
          name: `${legLabel(primaryLeg)} 推流 Mb/s`,
          type: "line",
          showSymbol: false,
          itemStyle: { color: "#38BDF8" },
          lineStyle: { width: 1.8, color: "#38BDF8" },
          areaStyle: { color: "rgba(56, 189, 248, 0.08)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.src_mbps.toFixed(2))),
        },
        {
          name: `${legLabel(primaryLeg)} 时延 ms`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          itemStyle: { color: "#E2E8F0" },
          lineStyle: { width: 1.4, type: "dashed", color: "#E2E8F0" },
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
          itemStyle: { color: "#EF4444" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => s.src_dropped),
        }
      );
    }
    if (backupLeg) {
      l1Series.push({
        name: `${legLabel(backupLeg)} 推流 Mb/s`,
        type: "line",
        showSymbol: false,
        itemStyle: { color: "#22C55E" },
        lineStyle: { width: 1.8, color: "#22C55E" },
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
        { type: "value", name: "Mb/s", min: 0, splitLine: { lineStyle: { color: splitLineColor } }, axisLabel: { fontSize: 10.5, color: labelColor }, nameTextStyle: { color: labelColor } },
        { type: "value", name: "ms / 包", min: 0, max: (v: { max: number }) => Math.max(v.max, 10), splitLine: { show: false }, axisLabel: { fontSize: 10.5, color: labelColor }, nameTextStyle: { color: labelColor } },
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
          itemStyle: { color: "#94A3B8" },
          lineStyle: { width: 1.5, color: "#94A3B8" },
          data: toTimeSeries(primaryLeg.host, gapThresholdSec, (h) => Number(h.cpu_percent.toFixed(1))),
        },
        {
          name: `${primaryLeg.leg.node_id} 通道重启`,
          type: "line",
          step: "end",
          yAxisIndex: 1,
          showSymbol: false,
          itemStyle: { color: "#22C55E" },
          lineStyle: { width: 1.8, color: "#22C55E" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => s.restart_count),
        },
        {
          name: `${primaryLeg.leg.node_id} 系统缓冲丢包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 7,
          itemStyle: { color: "#EF4444" },
          data: toTimeSeries(primaryLeg.host, gapThresholdSec, (h) => h.udp_rcvbuf_errors),
        }
      );
    }
    if (backupLeg) {
      l2Series.push({
        name: `${backupLeg.leg.node_id} CPU%`,
        type: "line",
        showSymbol: false,
        itemStyle: { color: "#22C55E" },
        lineStyle: { width: 1.3, type: "dashed", color: "#22C55E" },
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
        { type: "value", name: "CPU%", min: 0, max: 100, splitLine: { lineStyle: { color: splitLineColor } }, axisLabel: { fontSize: 10.5, color: labelColor }, nameTextStyle: { color: labelColor } },
        { type: "value", name: "次 / 包", min: 0, max: (v: { max: number }) => Math.max(v.max, 5), minInterval: 1, splitLine: { show: false }, axisLabel: { fontSize: 10.5, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l2Series,
    });

    // Layer 3: Egress
    const l3Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      const isPass = primaryLeg.leg.mode === "udp-passthrough";
      l3Series.push(
        {
          name: `${legLabel(primaryLeg)} 拉流 Mb/s`,
          type: "line",
          showSymbol: false,
          itemStyle: { color: "#2DD4BF" },
          lineStyle: { width: 1.8, color: "#2DD4BF" },
          areaStyle: { color: "rgba(45, 212, 191, 0.08)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.dst_mbps.toFixed(2))),
        },
        {
          name: `${legLabel(primaryLeg)} 时延 ms`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          itemStyle: { color: "#F59E0B" },
          lineStyle: { width: 1.4, type: "dashed", color: "#F59E0B" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => Number(s.dst_rtt_ms.toFixed(1))),
        },
        {
          name: `${legLabel(primaryLeg)} ${isPass ? "请求重发" : "重传救回"}`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "rgba(245, 158, 11, 0.55)" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => (isPass ? s.dst_nak_count : s.dst_retrans)),
        },
        {
          name: `${legLabel(primaryLeg)} 未恢复弃包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 5,
          itemStyle: { color: "#EF4444" },
          data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => (isPass ? s.src_dropped : s.dst_dropped)),
        }
      );
    }
    if (backupLeg) {
      l3Series.push({
        name: `${legLabel(backupLeg)} 拉流 Mb/s`,
        type: "line",
        showSymbol: false,
        itemStyle: { color: "#22C55E" },
        lineStyle: { width: 1.8, color: "#22C55E" },
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
        { type: "value", name: "Mb/s", min: 0, splitLine: { lineStyle: { color: splitLineColor } }, axisLabel: { fontSize: 10.5, color: labelColor }, nameTextStyle: { color: labelColor } },
        { type: "value", name: "ms / 包", min: 0, max: (v: { max: number }) => Math.max(v.max, 10), splitLine: { show: false }, axisLabel: { fontSize: 10.5, color: labelColor }, nameTextStyle: { color: labelColor } },
      ],
      series: l3Series,
    });

    // Layer 4: Overall Status Band
    const l4Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l4Series.push({
        name: `${legLabel(primaryLeg)}`,
        type: "line",
        step: "end",
        showSymbol: false,
        itemStyle: { color: "#EF4444" },
        lineStyle: { width: 2, color: "#EF4444" },
        areaStyle: { color: "rgba(239, 68, 68, 0.14)" },
        data: toTimeSeries(primaryLeg.samples, gapThresholdSec, (s) => faultSeverityScore(s.fault_code)),
      });
    }
    if (backupLeg) {
      l4Series.push({
        name: `${legLabel(backupLeg)}`,
        type: "line",
        step: "end",
        showSymbol: false,
        itemStyle: { color: "#22C55E" },
        lineStyle: { width: 1.8, color: "#22C55E" },
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
      legend: { top: 4, left: 6, textStyle: { fontSize: 11, color: legendColor } },
      grid: { left: 50, right: 48, top: 40, bottom: cleanView ? 24 : 46 },
      xAxis: commonTimeAxis,
      yAxis: {
        type: "value",
        min: 0,
        max: 2,
        interval: 1,
        axisLabel: {
          fontSize: 10.5,
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
              height: 16,
              bottom: 6,
              borderColor: axisLineColor,
              backgroundColor: "#0D0F12",
              fillerColor: "rgba(255, 255, 255, 0.12)",
              handleStyle: { color: "#98A1B0", borderColor: "#4E5768" },
              textStyle: { color: labelColor },
            },
          ],
      series: l4Series,
    });

    const ro = new ResizeObserver(() => instances.forEach((c) => c.resize()));
    els.forEach((el) => el && ro.observe(el));
    return () => {
      ro.disconnect();
      instances.forEach((c) => c.dispose());
      chartsRef.current = [];
    };
  }, [data, showBackupOverlay, cleanView]);

  const layers = [
    { ref: layer1Ref, name: "推流段 · 发端 → 中转服务器", meta: "码率 / 往返时延 / 重传与弃包", h: 156 },
    { ref: layer2Ref, name: "中转服务器负载", meta: "CPU 占用 / 通道重启 / 系统缓冲丢包", h: 132 },
    { ref: layer3Ref, name: "拉流段 · 中转服务器 → 收端", meta: "码率 / 往返时延 / 重传与弃包", h: 156 },
    { ref: layer4Ref, name: "整路信号状态", meta: "正常 / 波动 / 中断 · 主备同轴对比", h: cleanView ? 124 : 156 },
  ];

  return (
    <div className="space-y-2.5">
      {layers.map((layer) => (
        <div
          key={layer.name}
          className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-[#1D212A] bg-[#14171C] px-3.5 py-1.5">
            <span className="text-[12px] font-medium text-[#E6E9EF]">{layer.name}</span>
            <span className="text-[11px] text-[#757E8F]">{layer.meta}</span>
          </div>
          <div ref={layer.ref} style={{ width: "100%", height: layer.h }} />
        </div>
      ))}
    </div>
  );
});
