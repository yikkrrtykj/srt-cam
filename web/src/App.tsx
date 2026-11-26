import { useCallback, useEffect, useState } from "react";
import type { AuthStatus, OverviewResponse } from "./types";
import { api } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { TimelinePage } from "./pages/TimelinePage";
import { EventSheetPage } from "./pages/EventSheetPage";
import { NodesPage } from "./pages/NodesPage";

type Tab = "overview" | "timeline" | "sheet" | "nodes";

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

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [sseLive, setSseLive] = useState(false);
  const [tab, setTab] = useState<Tab>(() => parseHash().tab);
  const [selectedGroupId, setSelectedGroupId] = useState<string>(() => parseHash().groupId);
  const [screenshotMode, setScreenshotMode] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const ov = await api.overview();
      setOverview(ov);
    } catch {
      // handled by auth state or retry
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
        // ignore malformed frame
      }
    });
    es.onerror = () => setSseLive(false);
    return () => {
      es.close();
      setSseLive(false);
    };
  }, [auth?.authenticated, loadOverview]);

  function navigate(nextTab: Tab, groupId?: string) {
    setScreenshotMode(false);
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
      <main className="login-shell">
        <div className="kpi-card">正在连接 SRT-CAM 控制台...</div>
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

  const criticalCount =
    overview?.groups.filter((g) => g.expected_active && g.severity === "CRITICAL_OUTAGE").length ?? 0;

  return (
    <div className={`app-shell ${screenshotMode ? "evidence-fullscreen" : ""}`}>
      {!screenshotMode && (
        <aside className="sidebar" aria-label="主导航">
          <div className="brand-block">
            <div className="brand-title">SRT-CAM v2</div>
            <div className="brand-sub">{auth.display_name || auth.node_id}</div>
          </div>

          <nav className="nav-list">
            <button
              type="button"
              className={`nav-btn ${tab === "overview" ? "active" : ""}`}
              onClick={() => navigate("overview")}
            >
              <span>双向信号总览</span>
              {criticalCount > 0 && <span className="badge badge-crit">{criticalCount}</span>}
            </button>
            <button
              type="button"
              className={`nav-btn ${tab === "timeline" ? "active" : ""}`}
              onClick={() => navigate("timeline")}
            >
              <span>4 层同步时间轴</span>
            </button>
            <button
              type="button"
              className={`nav-btn ${tab === "sheet" ? "active" : ""}`}
              onClick={() => navigate("sheet")}
            >
              <span>场次信号表</span>
            </button>
            <button
              type="button"
              className={`nav-btn ${tab === "nodes" ? "active" : ""}`}
              onClick={() => navigate("nodes")}
            >
              <span>多 VPS 节点 & 审计</span>
            </button>
          </nav>

          <div className="sidebar-footer">
            <div className="sse-indicator">
              <span className={`dot ${sseLive ? "dot-ok" : "dot-warn"}`} />
              <span>{sseLive ? "实时推送已连接" : "正在重连推送..."}</span>
            </div>
            <div>当前用户：{auth.username}</div>
            {auth.auth_enabled && (
              <button type="button" className="btn btn-sm btn-ghost-dark" onClick={handleLogout}>
                退出登录
              </button>
            )}
          </div>
        </aside>
      )}

      <main className="main-area">
        {!overview ? (
          <div className="kpi-card">正在拉取节点实时数据...</div>
        ) : tab === "overview" ? (
          <OverviewPage
            overview={overview}
            onOpenTimeline={(gid) => navigate("timeline", gid)}
            onRefresh={() => void loadOverview()}
          />
        ) : tab === "timeline" ? (
          <TimelinePage
            groups={overview.groups}
            selectedGroupId={selectedGroupId}
            onSelectGroup={(gid) => navigate("timeline", gid)}
            screenshotMode={screenshotMode}
            onToggleScreenshotMode={setScreenshotMode}
          />
        ) : tab === "sheet" ? (
          <EventSheetPage onSaved={() => void loadOverview()} />
        ) : (
          <NodesPage nodes={overview.nodes} />
        )}
      </main>
    </div>
  );
}
