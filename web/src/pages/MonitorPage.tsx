import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  LayoutGrid,
  Lock,
  Maximize2,
  Minimize2,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  Search,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import type { LegLiveView, OverviewResponse, SignalGroupLiveView } from "@/types";
import {
  api,
  channelLossSummary,
  formatAudioSummary,
  formatVideoFps,
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
import { StopStreamDialog } from "@/components/StopStreamDialog";
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
  wallFullscreen: boolean;
  onToggleWallFullscreen: (next?: boolean) => void;
  onRefresh: () => void;
}

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem("srt_cam_monitor_view");
    if (v === "multiviewer" || v === "workbench") return v;
  } catch {
    // ignore storage errors
  }
  return "multiviewer";
}

function displayLegOf(g: SignalGroupLiveView): LegLiveView | undefined {
  if (g.legs.length <= 1) return g.legs[0];
  return g.legs.find((l) => l.node_online && l.sample.src_mbps >= 0.1) ?? g.legs[0];
}

function maxLiveFlowOf(g: SignalGroupLiveView): number {
  let max = 0;
  for (const leg of g.legs) {
    if (leg.node_online && leg.sample.src_mbps > max) {
      max = leg.sample.src_mbps;
    }
  }
  return max;
}

function computeWallGrid(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  if (count <= 12) return { cols: 4, rows: 3 };
  if (count <= 16) return { cols: 4, rows: 4 };
  const cols = Math.ceil(Math.sqrt(count));
  return { cols, rows: Math.ceil(count / cols) };
}

export function MonitorPage({
  overview,
  selectedGroupId,
  onSelectGroupId,
  initialSubTab = "realtime",
  cleanView,
  onToggleCleanView,
  wallFullscreen,
  onToggleWallFullscreen,
  onRefresh,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());
  const [subTab, setSubTab] = useState<SubTab>(initialSubTab);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [legIdx, setLegIdx] = useState(0);
  const [busyToggleId, setBusyToggleId] = useState<string | null>(null);
  const [powerBusyId, setPowerBusyId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [stopConfirm, setStopConfirm] = useState<{
    groupId: string;
    signalName: string;
    activeMbps: number;
  } | null>(null);
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

  useEffect(() => {
    if (!hasMultipleDirections && (filter === "venue_to_hub" || filter === "hub_to_venue")) {
      setFilter("all");
    }
  }, [hasMultipleDirections, filter]);

  const alertGroupsCount = useMemo(
    () =>
      overview.groups.filter(
        (g) =>
          g.enabled &&
          g.expected_active &&
          g.severity !== "HEALTHY" &&
          g.severity !== "IDLE" &&
          g.severity !== "STOPPED"
      ).length,
    [overview.groups]
  );

  const onlineGroupsCount = useMemo(
    () =>
      overview.groups.filter(
        (g) => g.enabled && g.legs.some((l) => l.node_online && l.sample.src_mbps >= 0.1)
      ).length,
    [overview.groups]
  );

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return overview.groups.filter((g) => {
      if (filter === "alerts") {
        if (
          !(
            g.enabled &&
            g.expected_active &&
            g.severity !== "HEALTHY" &&
            g.severity !== "IDLE" &&
            g.severity !== "STOPPED"
          )
        ) {
          return false;
        }
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
      toast.success(`${g.name} 已${checked ? "开启断流告警" : "关闭断流告警"}`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换告警状态失败");
    } finally {
      setBusyToggleId(null);
    }
  }

  async function executePowerChange(groupId: string, signalName: string, enable: boolean, force = false) {
    setPowerBusyId(groupId);
    try {
      await api.setSignalGroupEnabled(groupId, enable, force);
      setStopConfirm(null);
      toast.success(enable ? `已启动「${signalName}」` : `已停止「${signalName}」`);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "切换流开关失败";
      if (!enable && !force && msg.includes("二次确认")) {
        const g = overview.groups.find((item) => item.id === groupId);
        setStopConfirm({
          groupId,
          signalName,
          activeMbps: g ? Math.max(maxLiveFlowOf(g), 0.1) : 0.1,
        });
      } else {
        toast.error(msg);
      }
    } finally {
      setPowerBusyId(null);
    }
  }

  function handleTogglePower(g: SignalGroupLiveView, nextEnable: boolean) {
    if (!nextEnable) {
      const mbps = maxLiveFlowOf(g);
      if (mbps >= 0.1) {
        setStopConfirm({ groupId: g.id, signalName: g.name, activeMbps: mbps });
        return;
      }
    }
    void executePowerChange(g.id, g.name, nextEnable, false);
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

  function openInWorkbench(groupId: string) {
    if (wallFullscreen) {
      onToggleWallFullscreen(false);
    }
    onSelectGroupId(groupId);
    setSubTab("realtime");
    setViewMode("workbench");
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
  const activeFps = formatVideoFps(activeLeg);
  const activeAudio = formatAudioSummary(activeLeg);
  const activeLoss = channelLossSummary(activeLeg);
  const isPass = activeLeg?.mode === "udp-passthrough";
  const hostAddr = activeLeg ? resolveNodeHost(overview.nodes, activeLeg.node_id) : "";
  const pushUrl = activeLeg ? `srt://${hostAddr}:${activeLeg.in_port}` : "";
  const pullUrl = activeLeg && !isPass ? `srt://${hostAddr}:${activeLeg.out_port}` : "";

  const isTvWall = wallFullscreen && viewMode === "multiviewer";
  const wallGrid = computeWallGrid(filtered.length);
  const wallFitToViewport = filtered.length > 0 && filtered.length <= 16;
  const compactWallTile = wallGrid.rows >= 3 || wallGrid.cols >= 4;
  const wallGridStyle = {
    "--wall-cols": String(wallGrid.cols),
    "--wall-rows": String(wallGrid.rows),
    "--wall-gap": isTvWall ? "8px" : "10px",
    "--wall-umd": compactWallTile ? "64px" : "76px",
  } as CSSProperties;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        isTvWall ? "h-screen w-screen bg-[#08090B]" : "h-[calc(100vh-48px)]"
      )}
    >
      {/* Subtle Hover-Reveal Exit Pill in TV Wall Fullscreen Mode */}
      {isTvWall && (
        <div
          data-testid="tv-wall-exit-pill"
          className="fixed right-3 top-3 z-50 flex items-center gap-2 rounded-md border border-[#2C3240]/90 bg-[#0E1014]/85 px-2.5 py-1.5 backdrop-blur-sm opacity-35 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200 shadow-lg"
        >
          <span className="tabular text-[11px] text-[#98A1B0]">
            在播 <strong className="text-[#E6E9EF] font-medium">{onlineGroupsCount}</strong>/{overview.groups.length}
          </span>
          <span className="h-3 w-px bg-[#282D38]" />
          <button
            type="button"
            onClick={() => onToggleWallFullscreen(false)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-[#E6E9EF] hover:bg-[#232834] transition-colors cursor-pointer"
            aria-label="退出全屏"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            退出全屏
          </button>
        </div>
      )}

      {/* Compact Broadcast Control Toolbar (Hidden in TV Wall Fullscreen) */}
      {!isTvWall && (
        <div
          data-testid="monitor-toolbar"
          className="shrink-0 flex flex-wrap items-center justify-between gap-2.5 border-b border-[#1E222B] bg-[#0E1014] px-4 py-2"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            {/* View Mode Toggle: Multiviewer Wall vs Workbench */}
            <div className="inline-flex items-center rounded-md border border-[#232730] bg-[#0A0B0D] p-0.5">
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

          {/* Right: Search + Status Summary + Fullscreen (wall) + Refresh */}
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

            {viewMode === "multiviewer" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onToggleWallFullscreen()}
                    aria-label="切换全屏监看"
                  >
                    {wallFullscreen ? (
                      <Minimize2 className="h-3.5 w-3.5" />
                    ) : (
                      <Maximize2 className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">{wallFullscreen ? "退出全屏" : "全屏监看"}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>全屏无边框电视墙监看（按 ESC 或悬停右上角退出）</TooltipContent>
              </Tooltip>
            )}

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
      )}

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
           WORKBENCH: MASTER-DETAIL DIAGNOSTICS & LIVE TELEMETRY
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
                  const leg = displayLegOf(g);
                  const st = groupStatusMeta(g);
                  const selected = activeGroup?.id === g.id;
                  const s = leg?.sample;
                  const isFlowing = g.enabled && !!leg?.node_online && (s?.src_mbps ?? 0) >= 0.1;
                  const fps = formatVideoFps(leg);
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
                              {fps.text !== "-" && fps.text !== "探测中" ? ` · ${fps.text}` : ""}
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
                {/* Signal Focus Header Card */}
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

                        <div className="flex flex-wrap items-center gap-3">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <label
                                className={cn(
                                  "inline-flex items-center gap-2 rounded-md border px-2 py-0.5 text-[11.5px] font-medium cursor-pointer select-none",
                                  activeGroup.enabled
                                    ? "border-[#1E4631] bg-[#0F241A] text-[#4ADE80]"
                                    : "border-[#2B313D] bg-[#101318] text-[#8B94A5]"
                                )}
                              >
                                <Switch
                                  checked={activeGroup.enabled}
                                  disabled={powerBusyId === activeGroup.id}
                                  onCheckedChange={(checked) =>
                                    handleTogglePower(activeGroup, checked)
                                  }
                                />
                                {activeGroup.enabled ? (
                                  <span className="inline-flex items-center gap-1">
                                    <Lock className="h-3 w-3" />
                                    流开关
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    <Unlock className="h-3 w-3" />
                                    已停止
                                  </span>
                                )}
                              </label>
                            </TooltipTrigger>
                            <TooltipContent>
                              {activeGroup.enabled
                                ? "通道运行中并锁定传输参数，关闭将停止底层转发容器"
                                : "通道已停止，开启将启动底层转发容器并锁定传输参数"}
                            </TooltipContent>
                          </Tooltip>

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

                      {/* 6 Clean Hardware KPI Readouts */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
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
                          label="视频"
                          value={activeFps.text}
                          sub={activeFps.metaText}
                        />
                        <KpiCell
                          label="音频"
                          value={activeAudio.text}
                          sub={activeAudio.metaText}
                          tone={activeAudio.tone === "warn" ? "warn" : "neutral"}
                        />
                        <KpiCell
                          label="丢包率"
                          value={activeLoss.text}
                          tone={
                            activeLoss.tone === "crit"
                              ? "crit"
                              : activeLoss.tone === "warn"
                              ? "warn"
                              : "neutral"
                          }
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
                        disabled={!activeGroup.enabled}
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
           FULL-WIDTH BROADCAST MULTIVIEWER WALL (1-SCREEN TV MATRIX FIT)
           ================================================================ */
        <div
          data-testid="wall-viewport"
          className={cn(
            "flex-1 min-h-0 flex flex-col",
            isTvWall ? "p-2 bg-[#08090B]" : "p-2.5 lg:p-3 bg-[#0A0B0D]",
            wallFitToViewport ? "overflow-y-auto md:overflow-hidden" : "overflow-y-auto"
          )}
        >
          {filtered.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[12.5px] text-[#6B7485]">
              无匹配信号
            </div>
          ) : (
            <div
              className={cn(
                wallFitToViewport
                  ? "tv-wall-stage flex-1 min-h-0 w-full"
                  : "w-full",
                wallFitToViewport && !isTvWall && filtered.length === 1 && "max-w-[1060px] mx-auto"
              )}
            >
              <div
                className={cn(
                  wallFitToViewport
                    ? "tv-wall-grid grid grid-cols-1 gap-2.5"
                    : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5 gap-2.5"
                )}
                style={wallFitToViewport ? wallGridStyle : undefined}
              >
                {filtered.map((g) => {
                  const leg = displayLegOf(g);
                  const st = groupStatusMeta(g);
                  const selected = activeGroup?.id === g.id;
                  const s = leg?.sample;
                  const flowing = g.enabled && !!leg?.node_online && (s?.src_mbps ?? 0) >= 0.1;
                  const fps = formatVideoFps(leg);
                  const audio = formatAudioSummary(leg);
                  const loss = channelLossSummary(leg);
                  const rttText =
                    flowing && leg && leg.mode !== "udp-passthrough" && s && s.src_rtt_ms > 0
                      ? `${s.src_rtt_ms.toFixed(0)} ms`
                      : "-";
                  const borderTone =
                    st.tone === "crit"
                      ? "border-[#5E2326]"
                      : st.tone === "warn"
                      ? "border-[#4D3B16]"
                      : selected && !isTvWall
                      ? "border-[#D8DDE6] ring-1 ring-[#D8DDE6]/40"
                      : "border-[#232730] hover:border-[#3A4150]";

                  return (
                    <div
                      key={g.id}
                      data-testid="wall-tile"
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectGroupId(g.id)}
                      onDoubleClick={() => openInWorkbench(g.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openInWorkbench(g.id);
                      }}
                      className={cn(
                        "group flex flex-col min-h-0 overflow-hidden rounded-md bg-[#111316] text-left transition-all cursor-pointer border select-none",
                        wallFitToViewport && "md:h-full",
                        borderTone
                      )}
                    >
                      {/* Live 16:9 Preview Monitor (fills remaining tile height without clipping UMD) */}
                      <div
                        className={cn(
                          "relative w-full bg-[#0B0D11] overflow-hidden",
                          wallFitToViewport && "md:flex-1 md:min-h-0"
                        )}
                      >
                        {leg && (
                          <RouteThumbnail
                            leg={leg}
                            label={g.name}
                            variant="wall"
                            className={wallFitToViewport ? undefined : "md:aspect-video md:h-auto"}
                          />
                        )}
                        {g.legs.length >= 2 && leg && leg !== g.legs[0] && (
                          <span className="absolute left-2 top-2 rounded bg-[#0A0B0D]/80 border border-[#3A4150] px-1.5 py-0.5 text-[10px] font-medium text-[#FBBF24]">
                            备路画面
                          </span>
                        )}
                      </div>

                      {/* Row 1: Broadcast UMD Title + Dual-Leg Tally + Detail Jump */}
                      <div
                        className={cn(
                          "shrink-0 flex items-center justify-between gap-2 border-t border-[#1E222B] bg-[#13161C]",
                          compactWallTile ? "px-2 py-1" : "px-3 py-1.5"
                        )}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <TallyDot tone={st.tone} />
                          <span
                            className={cn(
                              "truncate font-semibold text-[#F1F3F6]",
                              compactWallTile ? "text-[11.5px]" : "text-[12.5px]"
                            )}
                          >
                            {g.name}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
                              st.tone === "ok"
                                ? "bg-[#112B1E] text-[#4ADE80]"
                                : st.tone === "warn"
                                ? "bg-[#2C210E] text-[#FBBF24]"
                                : st.tone === "crit"
                                ? "bg-[#311316] text-[#F87171]"
                                : "bg-[#1A1D24] text-[#7C8596]"
                            )}
                          >
                            {st.label}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {g.legs.length >= 2 && (
                            <div className="inline-flex items-center gap-1 text-[10px] text-[#8B94A5]">
                              {g.legs.map((l, idx) => (
                                <span
                                  key={`${l.node_id}-${l.channel_id}-${idx}`}
                                  className="inline-flex items-center gap-1 rounded bg-[#0E1015] border border-[#232730] px-1 py-0.5"
                                >
                                  <TallyDot tone={legTone(l)} className="h-1.5 w-1.5" />
                                  {l.role === "backup" ? "备" : "主"}
                                </span>
                              ))}
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openInWorkbench(g.id);
                            }}
                            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-[#7C8596] hover:bg-[#1F2430] hover:text-[#F1F3F6] transition-colors cursor-pointer"
                          >
                            详情
                            <ArrowUpRight className="h-3 w-3" />
                          </button>
                        </div>
                      </div>

                      {/* Row 2: OBS-Style Crisp 5-Column Direct Telemetry Strip (码率 / 视频 / 音频 / 丢包率 / 时延) */}
                      <div
                        data-testid="wall-telemetry-strip"
                        className="shrink-0 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.75fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.65fr)] divide-x divide-[#1C2029] border-t border-[#1A1E26] bg-[#0D0F13]"
                      >
                        <WallMetricCell
                          label="码率"
                          value={s ? `${s.src_mbps.toFixed(1)} Mb/s` : "-"}
                          tone={flowing ? "active" : "idle"}
                          compact={compactWallTile}
                        />
                        <WallMetricCell
                          label="视频"
                          value={compactWallTile ? fps.compactFullText : fps.fullText}
                          tone={
                            fps.text !== "-" && fps.text !== "探测中"
                              ? "active"
                              : "idle"
                          }
                          compact={compactWallTile}
                        />
                        <WallMetricCell
                          label="音频"
                          value={compactWallTile ? audio.compactFullText : audio.fullText}
                          tone={
                            audio.tone === "warn"
                              ? "warn"
                              : audio.tone === "ok"
                              ? "active"
                              : "idle"
                          }
                          compact={compactWallTile}
                        />
                        <WallMetricCell
                          label="丢包率"
                          value={loss.text}
                          tone={
                            loss.tone === "crit"
                              ? "crit"
                              : loss.tone === "warn"
                              ? "warn"
                              : flowing
                              ? "ok"
                              : "idle"
                          }
                          compact={compactWallTile}
                        />
                        <WallMetricCell
                          label="时延"
                          value={rttText}
                          tone={
                            flowing && s && s.src_rtt_ms >= 250
                              ? "warn"
                              : flowing
                              ? "active"
                              : "idle"
                          }
                          compact={compactWallTile}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
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

      <StopStreamDialog
        open={!!stopConfirm}
        signalName={stopConfirm?.signalName ?? ""}
        activeMbps={stopConfirm?.activeMbps ?? 0}
        busy={!!stopConfirm && powerBusyId === stopConfirm.groupId}
        onCancel={() => setStopConfirm(null)}
        onConfirm={() => {
          if (stopConfirm) {
            void executePowerChange(stopConfirm.groupId, stopConfirm.signalName, false, true);
          }
        }}
      />
    </div>
  );
}

function WallMetricCell({
  label,
  value,
  tone = "idle",
  compact = false,
}: {
  label: string;
  value: string;
  tone?: "active" | "ok" | "warn" | "crit" | "idle";
  compact?: boolean;
}) {
  const valCls =
    tone === "crit"
      ? "text-[#F87171] font-semibold"
      : tone === "warn"
      ? "text-[#FBBF24] font-medium"
      : tone === "ok"
      ? "text-[#4ADE80]"
      : tone === "active"
      ? "text-[#E6E9EF]"
      : "text-[#636C7C]";

  return (
    <div className={cn("min-w-0", compact ? "px-1.5 py-1" : "px-2 py-1.5")}>
      <div
        className={cn(
          "leading-none text-[#687182]",
          compact ? "text-[9.5px]" : "text-[10px]"
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "tabular truncate leading-tight",
          compact ? "mt-0.5 text-[10.5px]" : "mt-1 text-[11px]",
          valCls
        )}
      >
        {value}
      </div>
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
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: "neutral" | "warn" | "crit";
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[#757E8F]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          className={cn(
            "tabular text-[18px] font-semibold tracking-tight leading-none",
            tone === "crit"
              ? "text-[#F87171]"
              : tone === "warn"
              ? "text-[#FBBF24]"
              : "text-[#F1F3F6]"
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[11.5px] text-[#7C8596]">{unit}</span>}
      </div>
      {sub && (
        <div className="tabular mt-1 truncate text-[10.5px] text-[#7C8596] leading-tight">
          {sub}
        </div>
      )}
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
