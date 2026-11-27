import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  LayoutGrid,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import type { LegLiveView, OverviewResponse, SignalGroupLiveView } from "@/types";
import {
  api,
  groupStatusMeta,
  legTone,
  redundancyText,
  resolveNodeHost,
} from "@/api";
import { RouteThumbnail } from "@/components/RouteThumbnail";
import { TelemetryChartsAndStats } from "@/components/TelemetryChartsAndStats";
import { DiagnosisPanel } from "@/components/DiagnosisPanel";
import { ChannelLogsPanel } from "@/components/ChannelLogsPanel";
import { SafeRestartModal } from "@/components/SafeRestartModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusBadge, TallyDot } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";

type ViewMode = "workbench" | "multiviewer";
type SubTab = "realtime" | "diagnosis" | "logs";
type FilterMode = "all" | "alerts" | "venue_to_hub" | "hub_to_venue";

interface Props {
  overview: OverviewResponse;
  selectedGroupId: string;
  onSelectGroupId: (id: string) => void;
  initialSubTab?: SubTab;
  cleanView: boolean;
  onToggleCleanView: (on: boolean) => void;
  onRefresh: () => void;
}

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem("srt_cam_monitor_view");
    if (v === "multiviewer" || v === "workbench") return v;
  } catch {
    // ignore storage errors
  }
  return "workbench";
}

function primaryLegOf(g: SignalGroupLiveView): LegLiveView | undefined {
  return g.legs[0];
}

function totalDropsOf(leg?: LegLiveView): number {
  if (!leg) return 0;
  const s = leg.sample;
  return leg.mode === "udp-passthrough" ? s.src_dropped : s.src_dropped + s.dst_dropped;
}

export function MonitorPage({
  overview,
  selectedGroupId,
  onSelectGroupId,
  initialSubTab = "realtime",
  cleanView,
  onToggleCleanView,
  onRefresh,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());
  const [subTab, setSubTab] = useState<SubTab>(initialSubTab);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [legIdx, setLegIdx] = useState(0);
  const [busyToggleId, setBusyToggleId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [restartTarget, setRestartTarget] = useState<{
    nodeId: string;
    nodeName: string;
    channelId: string;
    signalName: string;
  } | null>(null);

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  useEffect(() => {
    try {
      localStorage.setItem("srt_cam_monitor_view", viewMode);
    } catch {
      // ignore
    }
  }, [viewMode]);

  const hasVenueToHub = overview.groups.some((g) => g.direction === "venue_to_hub");
  const hasHubToVenue = overview.groups.some((g) => g.direction === "hub_to_venue");
  const hasMultipleDirections = hasVenueToHub && hasHubToVenue;

  // Reset direction filter if signals no longer span both directions
  useEffect(() => {
    if (!hasMultipleDirections && (filter === "venue_to_hub" || filter === "hub_to_venue")) {
      setFilter("all");
    }
  }, [hasMultipleDirections, filter]);

  const alertGroupsCount = useMemo(
    () =>
      overview.groups.filter(
        (g) => g.expected_active && g.severity !== "HEALTHY" && g.severity !== "IDLE"
      ).length,
    [overview.groups]
  );

  const onlineGroupsCount = useMemo(
    () =>
      overview.groups.filter((g) =>
        g.legs.some((l) => l.node_online && l.sample.src_mbps >= 0.1)
      ).length,
    [overview.groups]
  );

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return overview.groups.filter((g) => {
      if (filter === "alerts") {
        if (!(g.expected_active && g.severity !== "HEALTHY" && g.severity !== "IDLE")) return false;
      } else if (filter === "venue_to_hub" || filter === "hub_to_venue") {
        if (g.direction !== filter) return false;
      }
      if (!kw) return true;
      return (
        g.name.toLowerCase().includes(kw) ||
        g.summary.toLowerCase().includes(kw) ||
        g.legs.some(
          (l) =>
            l.channel_id.toLowerCase().includes(kw) ||
            l.node_id.toLowerCase().includes(kw) ||
            l.src_device.toLowerCase().includes(kw) ||
            l.dst_device.toLowerCase().includes(kw) ||
            l.carrier.toLowerCase().includes(kw)
        )
      );
    });
  }, [overview.groups, filter, search]);

  const activeGroup = useMemo(() => {
    if (filtered.length === 0) return overview.groups[0] ?? null;
    return filtered.find((g) => g.id === selectedGroupId) ?? filtered[0];
  }, [filtered, overview.groups, selectedGroupId]);

  useEffect(() => {
    setLegIdx(0);
  }, [activeGroup?.id]);

  // Keyboard ↑ / ↓ quick signal switching in Workbench mode
  useEffect(() => {
    if (viewMode !== "workbench" || cleanView || filtered.length <= 1) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const idx = filtered.findIndex((g) => g.id === activeGroup?.id);
      if (idx < 0) return;
      const next =
        e.key === "ArrowDown"
          ? filtered[(idx + 1) % filtered.length]
          : filtered[(idx - 1 + filtered.length) % filtered.length];
      if (next) onSelectGroupId(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewMode, cleanView, filtered, activeGroup?.id, onSelectGroupId]);

  async function handleToggleAlarm(g: SignalGroupLiveView, checked: boolean) {
    setBusyToggleId(g.id);
    try {
      await api.toggleExpectedActive(g.id, checked);
      toast.success(`${g.name} 已${checked ? "开启断流告警" : "设为待机（关闭告警）"}`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换告警状态失败");
    } finally {
      setBusyToggleId(null);
    }
  }

  async function copyAddress(key: string, label: string, text: string) {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      toast.success(`已复制${label}`);
      window.setTimeout(() => setCopiedKey((c) => (c === key ? "" : c)), 1500);
    } else {
      toast.error("复制失败");
    }
  }

  // Fullscreen evidence snapshot mode
  if (cleanView && activeGroup) {
    return (
      <div className="p-4 max-w-[1600px] mx-auto">
        <DiagnosisPanel
          group={activeGroup}
          cleanView
          onToggleCleanView={onToggleCleanView}
          onRestartLeg={(leg) =>
            setRestartTarget({
              nodeId: leg.node_id,
              nodeName: leg.node_name,
              channelId: leg.channel_id,
              signalName: activeGroup.name,
            })
          }
        />
      </div>
    );
  }

  const venueName = overview.sites.venue || "现场";
  const hubName = overview.sites.hub || "制作中心";

  const activeLeg =
    activeGroup && activeGroup.legs.length > 0
      ? activeGroup.legs[legIdx < activeGroup.legs.length ? legIdx : 0]
      : undefined;
  const activeStatus = activeGroup ? groupStatusMeta(activeGroup) : null;
  const isPass = activeLeg?.mode === "udp-passthrough";
  const hostAddr = activeLeg ? resolveNodeHost(overview.nodes, activeLeg.node_id) : "";
  const pushUrl = activeLeg ? `srt://${hostAddr}:${activeLeg.in_port}` : "";
  const pullUrl = activeLeg && !isPass ? `srt://${hostAddr}:${activeLeg.out_port}` : "";

  // Responsive Multiviewer Grid columns tuned to signal count
  const wallGridCols =
    filtered.length <= 1
      ? "grid-cols-1 max-w-[780px]"
      : filtered.length <= 4
      ? "grid-cols-1 sm:grid-cols-2"
      : filtered.length <= 9
      ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
      : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] overflow-hidden">
      {/* Compact Broadcast Control Toolbar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2.5 border-b border-[#1E222B] bg-[#0E1014] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* View Mode Toggle: Workbench (Option B) vs Multiviewer (Option A) */}
          <div className="inline-flex items-center rounded-md border border-[#232730] bg-[#0A0B0D] p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("workbench")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer",
                viewMode === "workbench"
                  ? "bg-[#222630] text-[#F1F3F6]"
                  : "text-[#7C8596] hover:text-[#D1D7E2]"
              )}
            >
              <PanelLeft className="h-3.5 w-3.5" />
              工作台
            </button>
            <button
              type="button"
              onClick={() => setViewMode("multiviewer")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer",
                viewMode === "multiviewer"
                  ? "bg-[#222630] text-[#F1F3F6]"
                  : "text-[#7C8596] hover:text-[#D1D7E2]"
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              多画面墙
            </button>
          </div>

          <div className="h-4 w-px bg-[#232730]" />

          {/* Smart Filters — direction filters only shown when both directions exist */}
          <div className="inline-flex items-center gap-1">
            <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>
              全部 <span className="tabular opacity-70">{overview.groups.length}</span>
            </FilterPill>
            <FilterPill active={filter === "alerts"} onClick={() => setFilter("alerts")}>
              异常
              {alertGroupsCount > 0 && (
                <span className="tabular ml-0.5 rounded bg-[#463315] px-1 text-[10px] text-[#FBBF24]">
                  {alertGroupsCount}
                </span>
              )}
            </FilterPill>
            {hasMultipleDirections && (
              <>
                <FilterPill
                  active={filter === "venue_to_hub"}
                  onClick={() => setFilter("venue_to_hub")}
                >
                  {venueName} → {hubName}
                </FilterPill>
                <FilterPill
                  active={filter === "hub_to_venue"}
                  onClick={() => setFilter("hub_to_venue")}
                >
                  {hubName} → {venueName}
                </FilterPill>
              </>
            )}
          </div>
        </div>

        {/* Right: Search + Status Summary + Refresh */}
        <div className="flex items-center gap-2.5">
          <div className="hidden md:flex items-center gap-3 text-[11.5px] text-[#7C8596] tabular">
            <span>
              在播 <strong className="text-[#E6E9EF] font-medium">{onlineGroupsCount}</strong>/{overview.groups.length}
            </span>
          </div>

          <div className="relative w-[190px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5F6878]" />
            <Input
              className="h-7 pl-8 text-[12px]"
              placeholder="搜索信号 / 通道"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="xs" onClick={onRefresh} aria-label="刷新信号数据">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>立即刷新信号状态</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Empty State */}
      {overview.groups.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <div className="max-w-sm space-y-2">
            <div className="text-[14px] font-medium text-[#E6E9EF]">尚未配置直播信号通道</div>
            <p className="text-[12px] text-[#8B94A5]">
              请前往顶部“通道配置”页面添加 SRT 推流与拉流通道。
            </p>
          </div>
        </div>
      ) : viewMode === "workbench" ? (
        /* ================================================================
           OPTION B: SWISS PRECISION MASTER-DETAIL WORKBENCH (DEFAULT)
           ================================================================ */
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left Signal List Sidebar */}
          <aside className="w-[268px] shrink-0 border-r border-[#1E222B] bg-[#0D0F12] flex flex-col min-h-0">
            <div className="flex items-center justify-between px-3 py-2 text-[11px] text-[#6B7485] border-b border-[#191D25]">
              <span>信号列表 ({filtered.length})</span>
              <span className="hidden sm:inline">↑↓ 切换</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-[#6B7485]">无匹配信号</div>
              ) : (
                filtered.map((g) => {
                  const leg = primaryLegOf(g);
                  const st = groupStatusMeta(g);
                  const selected = activeGroup?.id === g.id;
                  const s = leg?.sample;
                  const isFlowing = !!leg?.node_online && (s?.src_mbps ?? 0) >= 0.1;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => onSelectGroupId(g.id)}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-md border p-2 text-left transition-colors cursor-pointer",
                        selected
                          ? "border-[#323846] bg-[#181B22]"
                          : "border-transparent bg-transparent hover:bg-[#14171D]"
                      )}
                    >
                      {leg && <RouteThumbnail leg={leg} label={g.name} variant="mini" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <TallyDot tone={st.tone} />
                          <span
                            className={cn(
                              "truncate text-[12.5px] font-medium",
                              selected ? "text-[#F1F3F6]" : "text-[#CFD5DF]"
                            )}
                          >
                            {g.name}
                          </span>
                        </div>
                        <div className="tabular mt-0.5 truncate text-[11px] text-[#7C8596]">
                          {isFlowing && s ? (
                            <>
                              {s.src_mbps.toFixed(1)} Mb/s
                              {leg.mode !== "udp-passthrough" && s.src_rtt_ms > 0
                                ? ` · ${s.src_rtt_ms.toFixed(0)}ms`
                                : ""}
                            </>
                          ) : (
                            <span>{st.label}</span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Right Focus Workspace */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4 lg:p-5 space-y-4 bg-[#0A0B0D]">
            {activeGroup && activeLeg && activeStatus && (
              <>
                {/* Signal Focus Header Card (Matches Option B Mockup) */}
                <div className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
                  <div className="p-4 flex flex-col lg:flex-row lg:items-center gap-4">
                    {/* 16:9 Preview Monitor */}
                    <RouteThumbnail leg={activeLeg} label={activeGroup.name} variant="hero" />

                    {/* Title + Big Tabular KPIs + Copyable URL Chips */}
                    <div className="flex-1 min-w-0 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h1 className="text-[16px] font-semibold tracking-tight text-[#F1F3F6]">
                            {activeGroup.name}
                          </h1>
                          <StatusBadge tone={activeStatus.tone} showDot>
                            {activeStatus.label}
                          </StatusBadge>
                          {hasMultipleDirections && (
                            <span className="rounded border border-[#232730] bg-[#16191F] px-2 py-0.5 text-[11px] text-[#8B94A5]">
                              {activeGroup.direction_label}
                            </span>
                          )}
                          {activeGroup.redundancy_type !== "single" && (
                            <span className="rounded border border-[#232730] bg-[#16191F] px-2 py-0.5 text-[11px] text-[#8B94A5]">
                              {redundancyText(activeGroup.redundancy_type)}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-3">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <label className="inline-flex items-center gap-2 text-[12px] text-[#B8C0CE] cursor-pointer select-none">
                                <Switch
                                  checked={activeGroup.expected_active}
                                  disabled={busyToggleId === activeGroup.id}
                                  onCheckedChange={(checked) =>
                                    void handleToggleAlarm(activeGroup, checked)
                                  }
                                />
                                断流告警
                              </label>
                            </TooltipTrigger>
                            <TooltipContent>
                              开启后，本路信号异常或中断时自动记录并推送飞书告警
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>

                      {/* 4 Clean Hardware KPI Readouts */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <KpiCell
                          label="入站码率"
                          value={activeLeg.sample.src_mbps.toFixed(1)}
                          unit="Mb/s"
                        />
                        <KpiCell
                          label="出站码率"
                          value={activeLeg.sample.dst_mbps.toFixed(1)}
                          unit="Mb/s"
                        />
                        <KpiCell
                          label="往返时延"
                          value={
                            !isPass && activeLeg.sample.src_rtt_ms > 0
                              ? activeLeg.sample.src_rtt_ms.toFixed(0)
                              : "-"
                          }
                          unit={!isPass && activeLeg.sample.src_rtt_ms > 0 ? "ms" : ""}
                        />
                        <KpiCell
                          label="未恢复弃包"
                          value={String(totalDropsOf(activeLeg))}
                          tone={totalDropsOf(activeLeg) > 0 ? "crit" : "neutral"}
                        />
                      </div>

                      {/* Copyable Push & Pull SRT Addresses */}
                      <div className="flex flex-wrap items-center gap-2">
                        <AddressChip
                          tag="推流"
                          url={pushUrl}
                          copied={copiedKey === "hdr-push"}
                          onCopy={() => void copyAddress("hdr-push", "推流地址", pushUrl)}
                        />
                        {pullUrl && (
                          <AddressChip
                            tag="拉流"
                            url={pullUrl}
                            copied={copiedKey === "hdr-pull"}
                            onCopy={() => void copyAddress("hdr-pull", "拉流地址", pullUrl)}
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Sub-Navigation Bar: Realtime | Diagnosis | Logs + Leg Switcher + Reset */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1E222B] bg-[#13161B] px-4">
                    <div className="flex items-center gap-6" role="tablist">
                      {(
                        [
                          { id: "realtime", label: "实时监看" },
                          { id: "diagnosis", label: "历史趋势" },
                          { id: "logs", label: "通信记录" },
                        ] as const
                      ).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="tab"
                          aria-selected={subTab === t.id}
                          onClick={() => setSubTab(t.id)}
                          className={cn(
                            "relative py-2.5 text-[12.5px] font-medium transition-colors cursor-pointer",
                            subTab === t.id
                              ? "text-[#F1F3F6] after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-[#F1F3F6]"
                              : "text-[#7C8596] hover:text-[#D1D7E2]"
                          )}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2 py-1.5">
                      {activeGroup.legs.length >= 2 && (
                        <div className="inline-flex items-center rounded-md border border-[#232730] bg-[#0B0D10] p-0.5">
                          {activeGroup.legs.map((leg, i) => (
                            <button
                              key={`${leg.node_id}-${leg.channel_id}`}
                              type="button"
                              onClick={() => setLegIdx(i)}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-[4px] px-2.5 py-0.5 text-[11.5px] font-medium transition-colors cursor-pointer",
                                legIdx === i
                                  ? "bg-[#222630] text-[#F1F3F6]"
                                  : "text-[#7C8596] hover:text-[#D1D7E2]"
                              )}
                            >
                              <TallyDot tone={legTone(leg)} className="h-1.5 w-1.5" />
                              {leg.role === "primary" ? "主路" : leg.role === "backup" ? "备路" : "单路"}
                              {leg.carrier ? ` · ${leg.carrier}` : ""}
                            </button>
                          ))}
                        </div>
                      )}

                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          setRestartTarget({
                            nodeId: activeLeg.node_id,
                            nodeName: activeLeg.node_name,
                            channelId: activeLeg.channel_id,
                            signalName: activeGroup.name,
                          })
                        }
                      >
                        <RotateCcw className="h-3 w-3" />
                        重置通道
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Inline Workspace Body — ZERO Page Jumps */}
                {subTab === "realtime" && (
                  <TelemetryChartsAndStats
                    group={activeGroup}
                    nodes={overview.nodes}
                    legIdx={legIdx}
                    layout="wide"
                  />
                )}
                {subTab === "diagnosis" && (
                  <DiagnosisPanel
                    group={activeGroup}
                    cleanView={false}
                    onToggleCleanView={onToggleCleanView}
                    onRestartLeg={(leg) =>
                      setRestartTarget({
                        nodeId: leg.node_id,
                        nodeName: leg.node_name,
                        channelId: leg.channel_id,
                        signalName: activeGroup.name,
                      })
                    }
                  />
                )}
                {subTab === "logs" && (
                  <ChannelLogsPanel group={activeGroup} legIdx={legIdx} />
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        /* ================================================================
           OPTION A: BROADCAST MULTIVIEWER WALL + RIGHT DOCKED INSPECTOR
           ================================================================ */
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden bg-[#0A0B0D]">
          {/* Left Multiviewer Wall */}
          <div className="flex-1 min-w-0 overflow-y-auto p-3.5">
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-[12.5px] text-[#6B7485]">无匹配信号</div>
            ) : (
              <div className={cn("grid gap-2.5", wallGridCols)}>
                {filtered.map((g) => {
                  const leg = primaryLegOf(g);
                  const st = groupStatusMeta(g);
                  const selected = activeGroup?.id === g.id;
                  const s = leg?.sample;
                  const drops = totalDropsOf(leg);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => onSelectGroupId(g.id)}
                      className={cn(
                        "group flex flex-col overflow-hidden rounded-md bg-[#111316] text-left transition-all cursor-pointer border",
                        selected
                          ? "border-[#E4E7EC] ring-1 ring-[#E4E7EC]/60"
                          : "border-[#232730] hover:border-[#3A4150]"
                      )}
                    >
                      {leg && <RouteThumbnail leg={leg} label={g.name} variant="wall" />}
                      {/* Broadcast UMD Strip */}
                      <div className="flex items-center justify-between gap-2 border-t border-[#1E222B] bg-[#121419] px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <TallyDot tone={st.tone} />
                          <span className="truncate text-[12px] font-medium text-[#F1F3F6]">
                            {g.name}
                          </span>
                        </div>
                        <div className="tabular flex items-center gap-2.5 shrink-0 text-[11px] text-[#98A1B0]">
                          <span>{s ? `${s.src_mbps.toFixed(1)} Mb/s` : "-"}</span>
                          {leg?.mode !== "udp-passthrough" && (
                            <span>{s && s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)} ms` : "-"}</span>
                          )}
                          <span className={drops > 0 ? "text-[#F87171] font-medium" : "text-[#7C8596]"}>
                            {drops} 弃包
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Docked Precision Inspector (Matches Option A Mockup) */}
          {activeGroup && activeLeg && activeStatus && (
            <aside className="w-full lg:w-[376px] xl:w-[404px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#1E222B] bg-[#111316] flex flex-col min-h-0">
              <div className="shrink-0 flex items-center justify-between gap-2 border-b border-[#1E222B] px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <TallyDot tone={activeStatus.tone} />
                  <h2 className="truncate text-[14px] font-semibold text-[#F1F3F6]">
                    {activeGroup.name}
                  </h2>
                  <StatusBadge tone={activeStatus.tone}>{activeStatus.label}</StatusBadge>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setSubTab("diagnosis");
                          setViewMode("workbench");
                        }}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        趋势
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>切换到工作台查看历史趋势与通信记录</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          setRestartTarget({
                            nodeId: activeLeg.node_id,
                            nodeName: activeLeg.node_name,
                            channelId: activeLeg.channel_id,
                            signalName: activeGroup.name,
                          })
                        }
                        aria-label="重置通道"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>重置当前信号通道</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
                {/* Dual-leg switcher + Alarm toggle row */}
                <div className="flex items-center justify-between gap-2">
                  {activeGroup.legs.length >= 2 ? (
                    <div className="inline-flex items-center rounded-md border border-[#232730] bg-[#0B0D10] p-0.5">
                      {activeGroup.legs.map((leg, i) => (
                        <button
                          key={`${leg.node_id}-${leg.channel_id}`}
                          type="button"
                          onClick={() => setLegIdx(i)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-[4px] px-2 py-0.5 text-[11px] font-medium cursor-pointer",
                            legIdx === i
                              ? "bg-[#222630] text-[#F1F3F6]"
                              : "text-[#7C8596] hover:text-[#D1D7E2]"
                          )}
                        >
                          <TallyDot tone={legTone(leg)} className="h-1.5 w-1.5" />
                          {leg.role === "primary" ? "主路" : "备路"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="tabular text-[11.5px] text-[#7C8596]">
                      {activeLeg.node_id} / {activeLeg.channel_id}
                    </span>
                  )}

                  <label className="inline-flex items-center gap-2 text-[11.5px] text-[#B8C0CE] cursor-pointer select-none">
                    <Switch
                      checked={activeGroup.expected_active}
                      disabled={busyToggleId === activeGroup.id}
                      onCheckedChange={(checked) => void handleToggleAlarm(activeGroup, checked)}
                    />
                    断流告警
                  </label>
                </div>

                <TelemetryChartsAndStats
                  group={activeGroup}
                  nodes={overview.nodes}
                  legIdx={legIdx}
                  layout="inspector"
                />
              </div>
            </aside>
          )}
        </div>
      )}

      {restartTarget && (
        <SafeRestartModal
          {...restartTarget}
          onClose={() => setRestartTarget(null)}
          onSuccess={(msg) => {
            toast.success(msg);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer",
        active
          ? "bg-[#20242D] text-[#F1F3F6]"
          : "text-[#7C8596] hover:bg-[#15181F] hover:text-[#CFD5DF]"
      )}
    >
      {children}
    </button>
  );
}

function KpiCell({
  label,
  value,
  unit,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "neutral" | "crit";
}) {
  return (
    <div>
      <div className="text-[11px] text-[#757E8F]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          className={cn(
            "tabular text-[20px] font-semibold tracking-tight leading-none",
            tone === "crit" ? "text-[#F87171]" : "text-[#F1F3F6]"
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[11.5px] text-[#7C8596]">{unit}</span>}
      </div>
    </div>
  );
}

function AddressChip({
  tag,
  url,
  copied,
  onCopy,
}: {
  tag: string;
  url: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="group inline-flex items-center gap-2 rounded-md border border-[#232730] bg-[#0D0F12] px-2.5 py-1 text-left transition-colors hover:border-[#3A4150] cursor-pointer max-w-full"
    >
      <span className="text-[10.5px] text-[#757E8F] shrink-0">{tag}</span>
      <code className="tabular text-[11.5px] text-[#D7DCE4] truncate">{url}</code>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-[#4ADE80]" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-[#6B7485] group-hover:text-[#E6E9EF]" />
      )}
    </button>
  );
}
