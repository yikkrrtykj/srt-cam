import { useCallback, useEffect, useState } from "react";
import type { AuthStatus, OverviewResponse } from "./types";
import { api } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { TimelinePage } from "./pages/TimelinePage";
import { EventSheetPage } from "./pages/EventSheetPage";
import { NodesPage } from "./pages/NodesPage";

type Tab = "overview" | "timeline" | "sheet" | "nodes";
type Theme = "dark" | "light";

function parseHash(): { tab: Tab; groupId: string } {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("timeline/")) {
    return { tab: "timeline", groupId: decodeURIComponent(hash.slice("timeline/".length)) };
  }
  if (hash === "timeline") return { tab: "timeline", groupId: "" };
  if (hash === "sheet") return { tab: "sheet", groupId: "" };
  if (hash === "nodes") return { tab: "nodes", groupId: "" };
  return { tab: "overview", groupId: "" };
}

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem("srt_cam_theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage restriction
  }
  return "dark";
}

function NavIcon({ kind }: { kind: Tab }) {
  const common = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 };
  if (kind === "overview") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    );
  }
  if (kind === "timeline") {
    return (
      <svg {...common}>
        <polyline points="3 17 9 11 13 15 21 7" />
        <polyline points="15 7 21 7 21 13" />
      </svg>
    );
  }
  if (kind === "sheet") {
    return (
      <svg {...common}>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <circle cx="4" cy="6" r="1" />
        <circle cx="4" cy="12" r="1" />
        <circle cx="4" cy="18" r="1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="4" width="20" height="6" rx="1" />
      <rect x="2" y="14" width="20" height="6" rx="1" />
      <circle cx="6" cy="7" r="1" />
      <circle cx="6" cy="17" r="1" />
    </svg>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [sseLive, setSseLive] = useState(false);
  const [tab, setTab] = useState<Tab>(() => parseHash().tab);
  const [selectedGroupId, setSelectedGroupId] = useState<string>(() => parseHash().groupId);
  const [cleanView, setCleanView] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("srt_cam_theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

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
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  function navigate(nextTab: Tab, groupId?: string) {
    setCleanView(false);
    setTab(nextTab);
    if (nextTab === "timeline") {
      const gid = groupId ?? selectedGroupId;
      if (gid) setSelectedGroupId(gid);
      window.location.hash = gid ? `#/timeline/${encodeURIComponent(gid)}` : "#/timeline";
    } else {
      window.location.hash = `#/${nextTab}`;
    }
  }

  async function handleLogout() {
    await api.logout();
    setOverview(null);
    setAuth((prev) => (prev ? { ...prev, authenticated: false, username: "" } : prev));
  }

  if (!auth) {
    return (
      <main className="login-wrap">
        <div className="panel" style={{ padding: 16 }}>连接中...</div>
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
      (g) => g.expected_active && (g.severity === "CRITICAL_OUTAGE" || g.severity === "DEGRADED_PROTECTED")
    ).length ?? 0;

  const activeRoute = overview?.groups.find((g) => g.id === (selectedGroupId || overview?.groups[0]?.id));

  return (
    <div className={`shell ${cleanView ? "clean-view" : ""}`}>
      {!cleanView && (
        <aside className="rail" aria-label="主导航">
          <div className="rail-brand">
            <span className="rail-logo">SRT</span>
            <span className="rail-name">SRT-CAM</span>
          </div>

          <nav className="rail-nav">
            <button
              type="button"
              className={`rail-item ${tab === "overview" ? "active" : ""}`}
              onClick={() => navigate("overview")}
            >
              <span className="rail-item-left">
                <NavIcon kind="overview" />
                <span>信号总览</span>
              </span>
              {alertCount > 0 && <span className="pill pill-warn">{alertCount}</span>}
            </button>

            <button
              type="button"
              className={`rail-item ${tab === "timeline" ? "active" : ""}`}
              onClick={() => navigate("timeline")}
            >
              <span className="rail-item-left">
                <NavIcon kind="timeline" />
                <span>信号详情</span>
              </span>
            </button>

            <button
              type="button"
              className={`rail-item ${tab === "sheet" ? "active" : ""}`}
              onClick={() => navigate("sheet")}
            >
              <span className="rail-item-left">
                <NavIcon kind="sheet" />
                <span>通道配置</span>
              </span>
            </button>

            <button
              type="button"
              className={`rail-item ${tab === "nodes" ? "active" : ""}`}
              onClick={() => navigate("nodes")}
            >
              <span className="rail-item-left">
                <NavIcon kind="nodes" />
                <span>服务器与记录</span>
              </span>
            </button>
          </nav>

          <div className="rail-footer">
            <div className="mono" style={{ fontSize: 11 }}>{auth.node_id}</div>
            <div>{auth.username}</div>
          </div>
        </aside>
      )}

      <div className="workspace">
        {!cleanView && (
          <header className="topbar">
            <div className="breadcrumb">
              <button type="button" className="breadcrumb-link" onClick={() => navigate("overview")}>
                SRT 信号网关
              </button>
              <span>/</span>
              {tab === "overview" && <span className="breadcrumb-current">信号总览</span>}
              {tab === "timeline" && (
                <>
                  <button type="button" className="breadcrumb-link" onClick={() => navigate("overview")}>
                    信号总览
                  </button>
                  <span>/</span>
                  <span className="breadcrumb-current">{activeRoute?.name || "信号详情"}</span>
                </>
              )}
              {tab === "sheet" && <span className="breadcrumb-current">通道配置</span>}
              {tab === "nodes" && <span className="breadcrumb-current">服务器与记录</span>}
              {overview?.event_name && (
                <span className="pill pill-idle" style={{ marginLeft: 6 }}>
                  {overview.event_name}
                </span>
              )}
              {overview?.demo_mode && <span className="pill pill-accent">演示模式</span>}
            </div>

            <div className="topbar-right">
              <span className={`pill ${sseLive ? "pill-ok" : "pill-warn"}`}>
                <span className={`dot ${sseLive ? "dot-ok" : "dot-warn"}`} />
                {sseLive ? "实时在线" : "重连中"}
              </span>
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? "浅色" : "深色播控"}
              </button>
              {auth.auth_enabled && (
                <button type="button" className="btn btn-xs" onClick={handleLogout}>
                  退出
                </button>
              )}
            </div>
          </header>
        )}

        <main className="content">
          {!overview ? (
            <div className="panel" style={{ padding: 16 }}>正在连接中转服务器...</div>
          ) : tab === "overview" ? (
            <OverviewPage
              overview={overview}
              theme={theme}
              onOpenRoute={(gid) => navigate("timeline", gid)}
              onRefresh={() => void loadOverview()}
            />
          ) : tab === "timeline" ? (
            <TimelinePage
              groups={overview.groups}
              selectedGroupId={selectedGroupId}
              onSelectGroup={(gid) => navigate("timeline", gid)}
              onBack={() => navigate("overview")}
              cleanView={cleanView}
              onToggleCleanView={setCleanView}
              theme={theme}
            />
          ) : tab === "sheet" ? (
            <EventSheetPage nodes={overview.nodes} onSaved={() => void loadOverview()} />
          ) : (
            <NodesPage nodes={overview.nodes} />
          )}
        </main>
      </div>
    </div>
  );
}
