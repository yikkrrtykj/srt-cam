import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import * as echarts from "echarts";
import type { GroupTimelineResponse, LegTimeline } from "../types";
import { formatTime } from "../api";

export interface SyncedTimelineHandle {
  exportEvidencePNG: (headerLines: string[]) => void;
}

interface Props {
  data: GroupTimelineResponse;
  showBackupOverlay: boolean;
  screenshotMode: boolean;
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
      return 1;
    default:
      return 2; // hard outage / process down / node unreachable
  }
}

function legLabel(lt: LegTimeline): string {
  const role = lt.leg.role === "primary" ? "主路" : lt.leg.role === "backup" ? "备路" : "单路";
  const carrier = lt.leg.carrier ? `·${lt.leg.carrier}` : "";
  return `${role}(${lt.leg.node_id}${carrier})`;
}

export const SyncedTimeline = forwardRef<SyncedTimelineHandle, Props>(function SyncedTimeline(
  { data, showBackupOverlay, screenshotMode },
  ref
) {
  const layer1Ref = useRef<HTMLDivElement>(null);
  const layer2Ref = useRef<HTMLDivElement>(null);
  const layer3Ref = useRef<HTMLDivElement>(null);
  const layer4Ref = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<echarts.ECharts[]>([]);

  useImperativeHandle(ref, () => ({
    exportEvidencePNG(headerLines: string[]) {
      const charts = chartsRef.current;
      if (charts.length === 0) return;
      const imgs = charts.map((c) => {
        const img = new Image();
        img.src = c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
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
        const headerH = 44 + headerLines.length * 34;
        const pad = 28;
        const gap = 16;
        const totalH = headerH + pad + imgs.reduce((acc, i) => acc + i.height + gap, 0) + pad;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = totalH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, totalH);

        // Header strip for leadership evidence
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(0, 0, width, headerH);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 26px sans-serif";
        headerLines.forEach((line, idx) => {
          ctx.font = idx === 0 ? "bold 28px sans-serif" : "20px sans-serif";
          ctx.fillStyle = idx === 0 ? "#ffffff" : "#cbd5e1";
          ctx.fillText(line, 32, 42 + idx * 34);
        });

        let y = headerH + pad;
        for (const img of imgs) {
          ctx.drawImage(img, 0, y);
          y += img.height + gap;
        }

        const link = document.createElement("a");
        link.download = `SRT-证据-${data.group.name}-${data.from_ts}.png`;
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

    const visibleLegs = showBackupOverlay ? data.legs : data.legs.slice(0, 1);
    const primaryLeg = visibleLegs[0];
    const backupLeg = visibleLegs[1];

    // Build shared sorted timestamp axis across all legs
    const tsSet = new Set<number>();
    visibleLegs.forEach((lt) => {
      lt.samples.forEach((s) => tsSet.add(s.ts));
      lt.host.forEach((h) => tsSet.add(h.ts));
    });
    const timestamps = Array.from(tsSet).sort((a, b) => a - b);
    const timeLabels = timestamps.map((ts) => formatTime(ts));

    const mapByTS = <T extends { ts: number }>(arr: T[]) => {
      const m = new Map<number, T>();
      arr.forEach((item) => m.set(item.ts, item));
      return m;
    };

    const pMap = primaryLeg ? mapByTS(primaryLeg.samples) : new Map();
    const bMap = backupLeg ? mapByTS(backupLeg.samples) : new Map();
    const pHostMap = primaryLeg ? mapByTS(primaryLeg.host) : new Map();
    const bHostMap = backupLeg ? mapByTS(backupLeg.host) : new Map();

    const baseGrid = { left: 58, right: 58, top: 34, bottom: 26 };
    const commonAxis = {
      type: "category" as const,
      data: timeLabels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisLabel: { color: "#64748b", fontSize: 11 },
    };

    const tooltipCommon = {
      trigger: "axis" as const,
      axisPointer: { type: "cross" as const, lineStyle: { color: "#94a3b8", type: "dashed" as const } },
      backgroundColor: "rgba(15, 23, 42, 0.94)",
      borderColor: "#334155",
      textStyle: { color: "#f8fafc", fontSize: 12 },
    };

    // Layer 1: Upstream (Sender -> Cloud)
    const l1Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l1Series.push(
        {
          name: `${legLabel(primaryLeg)} 入站码率(Mbps)`,
          type: "line",
          smooth: false,
          showSymbol: false,
          lineStyle: { width: 2.2, color: "#1d4ed8" },
          areaStyle: { color: "rgba(29, 78, 216, 0.08)" },
          data: timestamps.map((ts) => pMap.get(ts)?.src_mbps ?? null),
        },
        {
          name: `${legLabel(primaryLeg)} 上游RTT(ms)`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 1.5, type: "dashed", color: "#d97706" },
          data: timestamps.map((ts) => pMap.get(ts)?.src_rtt_ms ?? null),
        },
        {
          name: `${legLabel(primaryLeg)} 上游重传/丢弃`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 6,
          itemStyle: { color: "rgba(220, 38, 38, 0.65)" },
          data: timestamps.map((ts) => {
            const s = pMap.get(ts);
            return s ? s.src_retrans + s.src_dropped : null;
          }),
        }
      );
    }
    if (backupLeg) {
      l1Series.push({
        name: `${legLabel(backupLeg)} 入站码率(Mbps)`,
        type: "line",
        smooth: false,
        showSymbol: false,
        lineStyle: { width: 2, color: "#059669" },
        data: timestamps.map((ts) => bMap.get(ts)?.src_mbps ?? null),
      });
    }

    instances[0].setOption({
      animation: false,
      tooltip: tooltipCommon,
      legend: { top: 2, left: 8, textStyle: { fontSize: 11, color: "#475569" } },
      grid: baseGrid,
      xAxis: commonAxis,
      yAxis: [
        { type: "value", name: "Mbps", min: 0, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { fontSize: 11, color: "#64748b" } },
        { type: "value", name: "ms / 包", min: 0, splitLine: { show: false }, axisLabel: { fontSize: 11, color: "#64748b" } },
      ],
      series: l1Series,
    });

    // Layer 2: Cloud Node Health (CPU, UDP RcvbufErrors, Container RestartCount)
    const l2Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l2Series.push(
        {
          name: `${primaryLeg.leg.node_id} CPU(%)`,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 1.8, color: "#475569" },
          data: timestamps.map((ts) => {
            const h = pHostMap.get(ts);
            return h ? Number(h.cpu_percent.toFixed(1)) : null;
          }),
        },
        {
          name: `${primaryLeg.leg.node_id} 容器重启数`,
          type: "line",
          step: "end",
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 2, color: "#0f766e" },
          data: timestamps.map((ts) => pMap.get(ts)?.restart_count ?? null),
        },
        {
          name: `${primaryLeg.leg.node_id} 内核UDP缓冲丢包`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 8,
          itemStyle: { color: "#dc2626" },
          data: timestamps.map((ts) => pHostMap.get(ts)?.udp_rcvbuf_errors ?? null),
        }
      );
    }
    if (backupLeg) {
      l2Series.push({
        name: `${backupLeg.leg.node_id} CPU(%)`,
        type: "line",
        showSymbol: false,
        lineStyle: { width: 1.4, type: "dashed", color: "#059669" },
        data: timestamps.map((ts) => {
          const h = bHostMap.get(ts);
          return h ? Number(h.cpu_percent.toFixed(1)) : null;
        }),
      });
    }

    instances[1].setOption({
      animation: false,
      tooltip: tooltipCommon,
      legend: { top: 2, left: 8, textStyle: { fontSize: 11, color: "#475569" } },
      grid: baseGrid,
      xAxis: commonAxis,
      yAxis: [
        { type: "value", name: "CPU%", min: 0, max: 100, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { fontSize: 11, color: "#64748b" } },
        { type: "value", name: "重启 / 丢包", min: 0, minInterval: 1, splitLine: { show: false }, axisLabel: { fontSize: 11, color: "#64748b" } },
      ],
      series: l2Series,
    });

    // Layer 3: Downstream (Cloud -> Receiver)
    const l3Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l3Series.push(
        {
          name: `${legLabel(primaryLeg)} 出站码率(Mbps)`,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2.2, color: "#0284c7" },
          areaStyle: { color: "rgba(2, 132, 199, 0.08)" },
          data: timestamps.map((ts) => pMap.get(ts)?.dst_mbps ?? null),
        },
        {
          name: `${legLabel(primaryLeg)} 下游RTT(ms)`,
          type: "line",
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 1.5, type: "dashed", color: "#ea580c" },
          data: timestamps.map((ts) => pMap.get(ts)?.dst_rtt_ms ?? null),
        },
        {
          name: `${legLabel(primaryLeg)} 下游丢弃/NAK`,
          type: "bar",
          yAxisIndex: 1,
          barMaxWidth: 6,
          itemStyle: { color: "rgba(185, 28, 28, 0.72)" },
          data: timestamps.map((ts) => {
            const s = pMap.get(ts);
            return s ? s.dst_dropped + s.dst_nak_count : null;
          }),
        }
      );
    }
    if (backupLeg) {
      l3Series.push({
        name: `${legLabel(backupLeg)} 出站码率(Mbps)`,
        type: "line",
        showSymbol: false,
        lineStyle: { width: 2, color: "#059669" },
        data: timestamps.map((ts) => bMap.get(ts)?.dst_mbps ?? null),
      });
    }

    instances[2].setOption({
      animation: false,
      tooltip: tooltipCommon,
      legend: { top: 2, left: 8, textStyle: { fontSize: 11, color: "#475569" } },
      grid: baseGrid,
      xAxis: commonAxis,
      yAxis: [
        { type: "value", name: "Mbps", min: 0, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { fontSize: 11, color: "#64748b" } },
        { type: "value", name: "ms / 包", min: 0, splitLine: { show: false }, axisLabel: { fontSize: 11, color: "#64748b" } },
      ],
      series: l3Series,
    });

    // Layer 4: Automatic Fault Isolation Band + Primary/Backup Comparison + Shared Zoom Slider
    const l4Series: echarts.SeriesOption[] = [];
    if (primaryLeg) {
      l4Series.push({
        name: `${legLabel(primaryLeg)} 状态`,
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { width: 2.4, color: "#dc2626" },
        areaStyle: { color: "rgba(220, 38, 38, 0.14)" },
        data: timestamps.map((ts) => {
          const s = pMap.get(ts);
          return s ? faultSeverityScore(s.fault_code) : null;
        }),
      });
    }
    if (backupLeg) {
      l4Series.push({
        name: `${legLabel(backupLeg)} 状态`,
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { width: 2.2, color: "#059669" },
        data: timestamps.map((ts) => {
          const s = bMap.get(ts);
          return s ? faultSeverityScore(s.fault_code) : null;
        }),
      });
    }

    instances[3].setOption({
      animation: false,
      tooltip: {
        ...tooltipCommon,
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [];
          if (list.length === 0) return "";
          const idx = (list[0] as { dataIndex: number }).dataIndex;
          const ts = timestamps[idx];
          const pSample = pMap.get(ts);
          const bSample = bMap.get(ts);
          const lines = [`<strong>${formatTime(ts)}</strong>`];
          if (pSample) {
            lines.push(`主路(${primaryLeg.leg.node_id}): ${pSample.fault_summary}`);
          }
          if (bSample && backupLeg) {
            lines.push(`备路(${backupLeg.leg.node_id}): ${bSample.fault_summary}`);
          }
          return lines.join("<br/>");
        },
      },
      legend: { top: 2, left: 8, textStyle: { fontSize: 11, color: "#475569" } },
      grid: { left: 58, right: 58, top: 30, bottom: screenshotMode ? 24 : 52 },
      xAxis: commonAxis,
      yAxis: {
        type: "value",
        min: 0,
        max: 2,
        interval: 1,
        axisLabel: {
          fontSize: 11,
          color: "#475569",
          formatter: (v: number) => (v === 0 ? "正常" : v === 1 ? "抖动" : "中断"),
        },
        splitLine: { lineStyle: { color: "#f1f5f9" } },
      },
      dataZoom: screenshotMode
        ? []
        : [
            { type: "inside", xAxisIndex: 0 },
            { type: "slider", height: 20, bottom: 6, borderColor: "#cbd5e1" },
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
  }, [data, showBackupOverlay, screenshotMode]);

  return (
    <div className="layer-stack">
      <div className="layer-card">
        <div className="layer-head">
          <span className="layer-title">第 1 层 · 上游入站（发端设备 → 云端）</span>
          <span className="layer-desc">入站码率 / 上游 RTT / 上游重传与丢弃</span>
        </div>
        <div ref={layer1Ref} style={{ width: "100%", height: 175 }} />
      </div>

      <div className="layer-card">
        <div className="layer-head">
          <span className="layer-title">第 2 层 · 云端中转节点自身健康度（定责核心铁证）</span>
          <span className="layer-desc">宿主机 CPU / 容器累计重启数（平线=0重启）/ 内核 UDP 缓冲丢包</span>
        </div>
        <div ref={layer2Ref} style={{ width: "100%", height: 150 }} />
      </div>

      <div className="layer-card">
        <div className="layer-head">
          <span className="layer-title">第 3 层 · 下游出站（云端 → 收端设备）</span>
          <span className="layer-desc">出站码率 / 下游 RTT / 下游丢弃与 Mode B NAK 报丢</span>
        </div>
        <div ref={layer3Ref} style={{ width: "100%", height: 175 }} />
      </div>

      <div className="layer-card">
        <div className="layer-head">
          <span className="layer-title">第 4 层 · 自动故障定界与主备路径对比带</span>
          <span className="layer-desc">鼠标悬停查看任意秒的精确三段归因；拖动底部滑块四层同步缩放</span>
        </div>
        <div ref={layer4Ref} style={{ width: "100%", height: screenshotMode ? 140 : 175 }} />
      </div>
    </div>
  );
});
