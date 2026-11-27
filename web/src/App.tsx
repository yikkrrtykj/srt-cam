import { useCallback, useEffect, useState } from "react";
import { LogOut, Pencil, Radio } from "lucide-react";
import { Toaster, toast } from "sonner";
import type { AuthStatus, OverviewResponse } from "@/types";
import { api } from "@/api";
import { LoginPage } from "@/pages/LoginPage";
import { MonitorPage } from "@/pages/MonitorPage";
import { EventSheetPage } from "@/pages/EventSheetPage";
import { AlertsPage } from "@/pages/AlertsPage";
import { NodesPage } from "@/pages/NodesPage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TallyDot } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type NavTab = "monitor" | "sheet" | "alerts" | "nodes";

function parseHash(): { tab: NavTab; groupId: string; openDiagnosis: boolean } {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("timeline/")) {
    return {
      tab: "monitor",
      groupId: decodeURIComponent(hash.slice("timeline/".length)),
      openDiagnosis: true,
    };
  }
  if (hash === "timeline") return { tab: "monitor", groupId: "", openDiagnosis: true };
  if (hash === "sheet") return { tab: "sheet", groupId: "", openDiagnosis: false };
  if (hash === "alerts") return { tab: "alerts", groupId: "", openDiagnosis: false };
  if (hash === "nodes") return { tab: "nodes", groupId: "", openDiagnosis: false };
  return { tab: "monitor", groupId: "", openDiagnosis: false };
}

export function App() {
  const initial = parseHash();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [sseLive, setSseLive] = useState(false);
  const [tab, setTab] = useState<NavTab>(initial.tab);
  const [selectedGroupId, setSelectedGroupId] = useState<string>(initial.groupId);
  const [monitorSubTab, setMonitorSubTab] = useState<"realtime" | "diagnosis" | "logs">(
    initial.openDiagnosis ? "diagnosis" : "realtime"
  );
  const [cleanView, setCleanView] = useState(false);
  const [wallFullscreen, setWallFullscreen] = useState(false);

  // Quick project & site names popover state
  const [sitePopoverOpen, setSitePopoverOpen] = useState(false);
  const [editEventName, setEditEventName] = useState("");
  const [editVenue, setEditVenue] = useState("");
  const [editHub, setEditHub] = useState("");
  const [savingSites, setSavingSites] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const ov = await api.overview();
      setOverview(ov);
    } catch {
      // handled via SSE/auth
    }
  }, []);

  useEffect(() => {
    api.authStatus().then(setAuth).catch(() => {});
    const onHash = () => {
      const parsed = parseHash();
      setTab(parsed.tab);
      if (parsed.groupId) setSelectedGroupId(parsed.groupId);
      if (parsed.openDiagnosis) setMonitorSubTab("diagnosis");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    function onFsChange() {
      if (!document.fullscreenElement) {
        setWallFullscreen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && wallFullscreen) {
        setWallFullscreen(false);
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [wallFullscreen]);

  async function toggleWallFullscreen(next?: boolean) {
    const target = typeof next === "boolean" ? next : !wallFullscreen;
    setWallFullscreen(target);
    try {
      if (target && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else if (!target && document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // Keep clean TV viewport mode even if browser blocks native Fullscreen API
    }
  }

  useEffect(() => {
    if (!auth?.authenticated) return;
    void loadOverview();

    const es = new EventSource("/api/v1/stream", { withCredentials: true });
    es.addEventListener("overview", (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as OverviewResponse;
        setOverview(parsed);
        setSseLive(true);
      } catch {
        // ignore
      }
    });
    es.onerror = () => setSseLive(false);
    return () => {
      es.close();
      setSseLive(false);
    };
  }, [auth?.authenticated, loadOverview]);

  function navigate(nextTab: NavTab) {
    setCleanView(false);
    if (nextTab !== "monitor" && wallFullscreen) {
      void toggleWallFullscreen(false);
    }
    setTab(nextTab);
    window.location.hash = `#/${nextTab}`;
  }

  function openSiteQuickEdit(open: boolean) {
    setSitePopoverOpen(open);
    if (open && overview) {
      setEditEventName(overview.event_name || "");
      setEditVenue(overview.sites.venue || "");
      setEditHub(overview.sites.hub || "");
    }
  }

  async function saveQuickSites() {
    setSavingSites(true);
    try {
      const sheet = await api.getEventSheet();
      await api.saveEventSheet({
        ...sheet,
        event_name: editEventName.trim() || sheet.event_name,
        sites: {
          venue: editVenue.trim(),
          hub: editHub.trim(),
        },
      });
      setSitePopoverOpen(false);
      toast.success("项目与站点名称已更新");
      void loadOverview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingSites(false);
    }
  }

  async function handleLogout() {
    await api.logout();
    setOverview(null);
    setAuth((prev) => (prev ? { ...prev, authenticated: false, username: "" } : prev));
  }

  if (!auth) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#0A0B0D] text-[12.5px] text-[#7C8596]">
        正在连接播控服务...
      </main>
    );
  }

  if (auth.auth_enabled && !auth.authenticated) {
    return (
      <LoginPage
        nodeName={auth.display_name}
        onLoggedIn={(username) => setAuth({ ...auth, authenticated: true, username })}
      />
    );
  }

  const alertCount =
    overview?.groups.filter(
      (g) => g.enabled && g.expected_active && g.severity !== "HEALTHY" && g.severity !== "IDLE" && g.severity !== "STOPPED"
    ).length ?? 0;

  const isTvWallMode = wallFullscreen && tab === "monitor";
  const hideTopHeader = cleanView || isTvWallMode;

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className={cn(
          "flex flex-col bg-[#0A0B0D] text-[#F1F3F6]",
          isTvWallMode ? "h-screen overflow-hidden" : "min-h-screen"
        )}
      >
        {/* Thin 48px Hardware Top Navigation Bar (Hidden in TV Wall Fullscreen & Evidence Clean Mode) */}
        {!hideTopHeader && (
          <header className="sticky top-0 z-40 h-12 shrink-0 border-b border-[#1E222B] bg-[#111316] px-4 flex items-center justify-between gap-4">
            {/* Left: Brand + 4 Clean Underline Nav Tabs */}
            <div className="flex items-center gap-7 h-full">
              <button
                type="button"
                onClick={() => navigate("monitor")}
                className="flex items-center gap-2 text-[#F1F3F6] cursor-pointer"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded border border-[#2C3240] bg-[#181B22]">
                  <Radio className="h-3.5 w-3.5 text-[#E6E9EF]" />
                </span>
                <span className="text-[13.5px] font-semibold tracking-wide">SRT-CAM</span>
              </button>

              <nav className="flex items-center gap-6 h-full" aria-label="主导航">
                {(
                  [
                    { id: "monitor", label: "信号监看", badge: alertCount },
                    { id: "sheet", label: "通道配置", badge: 0 },
                    { id: "alerts", label: "告警设置", badge: 0 },
                    { id: "nodes", label: "服务器", badge: 0 },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={cn(
                      "relative h-full inline-flex items-center gap-1.5 text-[12.5px] font-medium transition-colors cursor-pointer",
                      tab === item.id
                        ? "text-[#F1F3F6] after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-[#F1F3F6]"
                        : "text-[#8B94A5] hover:text-[#D7DCE4]"
                    )}
                  >
                    {item.label}
                    {item.badge > 0 && (
                      <span className="tabular rounded bg-[#463315] px-1.5 py-0.2 text-[10px] font-medium text-[#FBBF24]">
                        {item.badge}
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            </div>

            {/* Right: Editable Project/Sites Pill + Live SSE Dot + Logout */}
            <div className="flex items-center gap-2.5">
              {overview?.demo_mode && (
                <span className="rounded border border-[#2C3240] bg-[#181B22] px-2 py-0.5 text-[11px] text-[#98A1B0]">
                  演示模式
                </span>
              )}

              {overview && (
                <Popover open={sitePopoverOpen} onOpenChange={openSiteQuickEdit}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="group inline-flex items-center gap-2 rounded-md border border-[#232730] bg-[#16181D] px-2.5 py-1 text-[12px] text-[#D7DCE4] transition-colors hover:border-[#363D4C] hover:text-white cursor-pointer"
                    >
                      <span className="max-w-[180px] truncate">
                        {overview.event_name || "默认项目"}
                      </span>
                      <Pencil className="h-3 w-3 text-[#656E7E] group-hover:text-[#CBD2DE]" />
                      <span className="h-3 w-px bg-[#282D38]" />
                      <span className="inline-flex items-center gap-1.5 text-[11.5px]">
                        <TallyDot tone={sseLive ? "ok" : "warn"} className="h-1.5 w-1.5" />
                        <span className={sseLive ? "text-[#4ADE80]" : "text-[#FBBF24]"}>
                          {sseLive ? "Live" : "重连"}
                        </span>
                      </span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[320px] space-y-3">
                    <div>
                      <div className="text-[13px] font-medium text-[#F1F3F6]">
                        自定义项目与站点名称
                      </div>
                      <div className="text-[11.5px] text-[#7C8596] mt-0.5">
                        修改后实时同步到播控台与飞书告警卡片
                      </div>
                    </div>
                    <div className="space-y-2.5">
                      <div className="space-y-1">
                        <label className="text-[11.5px] text-[#98A1B0]">项目 / 场次名称</label>
                        <Input
                          value={editEventName}
                          onChange={(e) => setEditEventName(e.target.value)}
                          placeholder="例如：赛事直播回传"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11.5px] text-[#98A1B0]">站点 A（现场端）</label>
                        <Input
                          value={editVenue}
                          onChange={(e) => setEditVenue(e.target.value)}
                          placeholder="例如：前方现场"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11.5px] text-[#98A1B0]">站点 B（制作中心端）</label>
                        <Input
                          value={editHub}
                          onChange={(e) => setEditHub(e.target.value)}
                          placeholder="例如：演播室"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setSitePopoverOpen(false)}
                        disabled={savingSites}
                      >
                        取消
                      </Button>
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={saveQuickSites}
                        disabled={savingSites}
                      >
                        {savingSites ? "保存中..." : "保存"}
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              {auth.auth_enabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleLogout}
                      aria-label="退出登录"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>退出登录 ({auth.username})</TooltipContent>
                </Tooltip>
              )}
            </div>
          </header>
        )}

        {/* Main Workspace */}
        <main className={cn("flex-1 min-h-0", isTvWallMode && "flex flex-col overflow-hidden")}>
          {!overview ? (
            <div className="p-6 text-[12.5px] text-[#7C8596]">正在连接中转服务器...</div>
          ) : tab === "monitor" ? (
            <MonitorPage
              overview={overview}
              selectedGroupId={selectedGroupId}
              onSelectGroupId={setSelectedGroupId}
              initialSubTab={monitorSubTab}
              cleanView={cleanView}
              onToggleCleanView={setCleanView}
              wallFullscreen={wallFullscreen}
              onToggleWallFullscreen={(next) => void toggleWallFullscreen(next)}
              onRefresh={() => void loadOverview()}
            />
          ) : tab === "sheet" ? (
            <EventSheetPage nodes={overview.nodes} onSaved={() => void loadOverview()} />
          ) : tab === "alerts" ? (
            <AlertsPage overview={overview} onRefreshOverview={() => void loadOverview()} />
          ) : (
            <NodesPage nodes={overview.nodes} onNodesChanged={() => void loadOverview()} />
          )}
        </main>
      </div>

      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "!bg-[#161920] !border-[#2C3240] !text-[#F1F3F6] !text-[12.5px]",
            description: "!text-[#98A1B0]",
          },
        }}
      />
    </TooltipProvider>
  );
}
