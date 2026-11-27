import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Download, RefreshCw } from "lucide-react";
import type { GroupTimelineResponse, LegLiveView, SignalGroupLiveView } from "@/types";
import { api, faultLayerLabel, formatDateTime, redundancyText, severityMeta } from "@/api";
import { SyncedTimeline, type SyncedTimelineHandle } from "@/components/SyncedTimeline";
import { SignalHealthPanel, type LegWindowStats } from "@/components/SignalHealthPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  group: SignalGroupLiveView;
  cleanView: boolean;
  onToggleCleanView: (on: boolean) => void;
  onRestartLeg: (leg: LegLiveView) => void;
}

const PRESETS = [
  { label: "5分钟", sec: 5 * 60 },
  { label: "15分钟", sec: 15 * 60 },
  { label: "30分钟", sec: 30 * 60 },
  { label: "2小时", sec: 2 * 3600 },
  { label: "6小时", sec: 6 * 3600 },
  { label: "24小时", sec: 24 * 3600 },
  { label: "7天", sec: 7 * 86400 },
];

export function DiagnosisPanel({ group, cleanView, onToggleCleanView, onRestartLeg }: Props) {
  const [rangeSec, setRangeSec] = useState(30 * 60);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showBackupOverlay, setShowBackupOverlay] = useState(true);
  const [data, setData] = useState<GroupTimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const chartRef = useRef<SyncedTimelineHandle>(null);

  async function loadTimeline(fromOverride?: number, toOverride?: number) {
    setLoading(true);
    setError("");
    const now = Math.floor(Date.now() / 1000);
    const toTS = toOverride ?? now;
    const fromTS = fromOverride ?? toTS - rangeSec;
    try {
      const res = await api.timeline(group.id, fromTS, toTS);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载排障时间线失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, rangeSec]);

  function applyCustomWindow() {
    if (!customFrom || !customTo) return;
    const f = Math.floor(new Date(customFrom).getTime() / 1000);
    const t = Math.floor(new Date(customTo).getTime() / 1000);
    if (!Number.isFinite(f) || !Number.isFinite(t) || f >= t) {
      setError("结束时间需晚于开始时间");
      return;
    }
    void loadTimeline(f, t);
  }

  function handleExportPNG() {
    if (!data || !chartRef.current) return;
    const headerLines = [
      `${data.group.name} · ${data.direction_label} · ${redundancyText(data.group.redundancy_type)}`,
      `${data.event_name}  |  ${formatDateTime(data.from_ts)} ~ ${formatDateTime(data.to_ts)}`,
      `状态：${data.live_group.summary}`,
    ];
    chartRef.current.exportReportPNG(headerLines);
  }

  const legWindowStats = useMemo<Record<string, LegWindowStats>>(() => {
    if (!data) return {};
    const out: Record<string, LegWindowStats> = {};
    for (const lt of data.legs) {
      const key = `${lt.leg.node_id}/${lt.leg.channel_id}`;
      const maxRestarts = lt.samples.reduce((m, s) => Math.max(m, s.restart_count), 0);
      const udpDrops = lt.host.reduce((sum, h) => sum + h.udp_rcvbuf_errors, 0);
      out[key] = { maxRestarts, udpDrops };
    }
    return out;
  }, [data]);

  return (
    <div className="space-y-4">
      {/* Control Strip */}
      {!cleanView ? (
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-[#232730] bg-[#111316] px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center rounded-md border border-[#232730] bg-[#0B0D10] p-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setRangeSec(p.sec)}
                  className={cn(
                    "rounded-[4px] px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer",
                    rangeSec === p.sec
                      ? "bg-[#222630] text-[#F1F3F6]"
                      : "text-[#7C8596] hover:text-[#D1D7E2]"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {group.legs.length >= 2 && (
              <label className="inline-flex items-center gap-2 text-[12px] text-[#C8CFD9] cursor-pointer select-none">
                <Switch checked={showBackupOverlay} onCheckedChange={setShowBackupOverlay} />
                叠加备路曲线
              </label>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="datetime-local"
              className="h-7 w-[192px] text-[11.5px]"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="开始时间"
            />
            <span className="text-[#586070]">~</span>
            <Input
              type="datetime-local"
              className="h-7 w-[192px] text-[11.5px]"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="结束时间"
            />
            <Button variant="outline" size="xs" onClick={applyCustomWindow}>
              查询
            </Button>
            <Button variant="outline" size="xs" onClick={() => void loadTimeline()} disabled={loading}>
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </Button>
            <Button variant="outline" size="xs" onClick={handleExportPNG} disabled={!data}>
              <Download className="h-3 w-3" />
              导出报告
            </Button>
            <Button variant="secondary" size="xs" onClick={() => onToggleCleanView(true)} disabled={!data}>
              <Camera className="h-3 w-3" />
              全屏快照
            </Button>
          </div>
        </div>
      ) : (
        <div className="no-print flex items-center justify-between rounded-lg border border-[#2C3240] bg-[#14171C] px-4 py-2">
          <div className="flex items-center gap-3 text-[12px] text-[#C8CFD9]">
            <strong className="text-[#F1F3F6]">{group.name}</strong>
            <span>全屏快照模式</span>
            {data && (
              <span className="tabular text-[#8B94A5]">
                {formatDateTime(data.from_ts)} ~ {formatDateTime(data.to_ts)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="xs" onClick={handleExportPNG}>
              <Download className="h-3 w-3" />
              导出截图报告
            </Button>
            <Button variant="primary" size="xs" onClick={() => onToggleCleanView(false)}>
              退出快照
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-[#542228] bg-[#251316] px-3 py-2 text-[12px] text-[#F87171]">
          {error}
        </div>
      )}

      {/* 3-Stage Path Fault Isolation */}
      <SignalHealthPanel
        group={data?.live_group ?? group}
        legStats={legWindowStats}
        onRestartLeg={cleanView ? undefined : onRestartLeg}
      />

      {/* 4-Layer Synchronized Timeline */}
      {data && (
        <>
          <SyncedTimeline
            ref={chartRef}
            data={data}
            showBackupOverlay={showBackupOverlay}
            cleanView={cleanView}
          />

          {/* Recent Incident Table for this Signal */}
          <div className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#1E222B] bg-[#14171C] px-4 py-2">
              <span className="text-[12px] font-medium text-[#E6E9EF]">
                本路异常记录 ({data.events.length})
              </span>
              <span className="tabular text-[11px] text-[#757E8F]">
                {formatDateTime(data.from_ts)} ~ {formatDateTime(data.to_ts)}
              </span>
            </div>
            {data.events.length === 0 ? (
              <div className="px-4 py-5 text-center text-[12px] text-[#6B7485]">
                当前时间范围内无异常记录
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="border-b border-[#1E222B] text-[11px] text-[#757E8F]">
                    <tr>
                      <th className="px-4 py-2 font-medium">发生时间</th>
                      <th className="px-3 py-2 font-medium">恢复时间</th>
                      <th className="px-3 py-2 font-medium">服务器 / 通道</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">区段</th>
                      <th className="px-4 py-2 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1A1E26]">
                    {data.events.map((ev) => {
                      const sm = severityMeta(ev.severity);
                      return (
                        <tr key={ev.id} className="hover:bg-white/[0.02]">
                          <td className="tabular px-4 py-2 text-[#C8CFD9] whitespace-nowrap">
                            {formatDateTime(ev.start_ts)}
                          </td>
                          <td className="tabular px-3 py-2 text-[#8B94A5] whitespace-nowrap">
                            {ev.end_ts ? formatDateTime(ev.end_ts) : "持续中"}
                          </td>
                          <td className="tabular px-3 py-2 text-[#C8CFD9] whitespace-nowrap">
                            {ev.node_id}/{ev.channel_id}
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge tone={sm.tone}>{sm.label}</StatusBadge>
                          </td>
                          <td className="px-3 py-2 text-[#98A1B0] whitespace-nowrap">
                            {faultLayerLabel(ev.fault_layer)}
                          </td>
                          <td className="px-4 py-2 text-[#D3D8E0]">{ev.summary}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
