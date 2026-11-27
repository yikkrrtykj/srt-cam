import { useMemo, useState } from "react";
import type { LegLiveView, OverviewResponse, SignalGroupLiveView } from "../types";
import { api, redundancyText, severityText } from "../api";
import { SafeRestartModal } from "../components/SafeRestartModal";
import { RouteThumbnail } from "../components/RouteThumbnail";
import { HaivisionDrawer } from "../components/HaivisionDrawer";

interface Props {
  overview: OverviewResponse;
  theme: "dark" | "light";
  onOpenRoute: (groupId: string) => void;
  onRefresh: () => void;
}

type FilterTab = "all" | "venue_to_hub" | "hub_to_venue" | "attention";

interface RestartTarget {
  nodeId: string;
  nodeName: string;
  channelId: string;
  signalName: string;
}

function LockBadgeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.6" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <polygon points="12 3 2 8 12 13 22 8 12 3" />
      <polyline points="2 13 12 18 22 13" />
      <polyline points="2 18 12 23 22 18" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
    </svg>
  );
}

function primaryDisplayLeg(grp: SignalGroupLiveView): LegLiveView | undefined {
  return grp.legs.find((l) => l.role === "primary") ?? grp.legs[0];
}

function isAwaitingDownstream(grp: SignalGroupLiveView): boolean {
  return (
    grp.expected_active &&
    grp.severity === "CRITICAL_OUTAGE" &&
    grp.legs.length > 0 &&
    grp.legs.every((l) => l.node_online && l.sample.fault_code === "DOWNSTREAM_OFFLINE")
  );
}

export function OverviewPage({ overview, theme, onOpenRoute, onRefresh }: Props) {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    const relay = overview.groups.find(
      (g) => g.expected_active && g.legs.some((l) => l.mode === "srt-relay")
    );
    return relay?.id ?? overview.groups[0]?.id ?? null;
  });
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testingFeishu, setTestingFeishu] = useState(false);

  const activeGroups = overview.groups.filter((g) => g.expected_active);
  const healthyCount = activeGroups.filter((g) => g.severity === "HEALTHY").length;
  const attentionCount = activeGroups.filter(
    (g) =>
      g.severity === "CRITICAL_OUTAGE" ||
      g.severity === "DEGRADED_PROTECTED" ||
      g.severity === "DEGRADED_SINGLE"
  ).length;
  const offlineCount = activeGroups.filter(
    (g) => g.severity === "CRITICAL_OUTAGE" && !isAwaitingDownstream(g)
  ).length;
  const totalMbps = overview.groups.reduce(
    (sum, g) => sum + g.legs.reduce((s, l) => s + l.sample.src_mbps, 0),
    0
  );

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return overview.groups.filter((g) => {
      if (filter === "venue_to_hub" && g.direction !== "venue_to_hub") return false;
      if (filter === "hub_to_venue" && g.direction !== "hub_to_venue") return false;
      if (
        filter === "attention" &&
        !(
          g.expected_active &&
          (g.severity === "CRITICAL_OUTAGE" ||
            g.severity === "DEGRADED_PROTECTED" ||
            g.severity === "DEGRADED_SINGLE")
        )
      ) {
        return false;
      }
      if (!q) return true;
      const hay = [
        g.name,
        g.notes ?? "",
        ...g.legs.flatMap((l) => [l.node_id, l.channel_id, l.carrier, l.src_device, l.dst_device]),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [overview.groups, filter, query]);

  async function handleToggleActive(grp: SignalGroupLiveView) {
    try {
      await api.toggleExpectedActive(grp.id, !grp.expected_active);
      onRefresh();
    } catch (err) {
      setToast({ kind: "err", text: err instanceof Error ? err.message : "操作失败" });
    }
  }

  async function handleTestFeishu() {
    setTestingFeishu(true);
    setToast(null);
    try {
      await api.testFeishu();
      setToast({ kind: "ok", text: "飞书测试消息已发送" });
    } catch (err) {
      setToast({ kind: "err", text: err instanceof Error ? err.message : "发送失败" });
    } finally {
      setTestingFeishu(false);
    }
  }

  const venueName = overview.sites.venue || "现场";
  const hubName = overview.sites.hub || "制作中心";

  return (
    <div>
      {toast && (
        <div className={`notice ${toast.kind === "ok" ? "notice-ok" : "notice-err"}`}>{toast.text}</div>
      )}

      {/* Compact Haivision-style Top Control Bar */}
      <div className="hv-toolbar">
        <div className="hv-toolbar-left">
          <div className="seg-group" role="tablist" aria-label="方向筛选">
            <button
              type="button"
              className={`seg-btn ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              全部 ({overview.groups.length})
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === "venue_to_hub" ? "active" : ""}`}
              onClick={() => setFilter("venue_to_hub")}
            >
              {venueName} → {hubName}
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === "hub_to_venue" ? "active" : ""}`}
              onClick={() => setFilter("hub_to_venue")}
            >
              {hubName} → {venueName}
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === "attention" ? "active" : ""}`}
              onClick={() => setFilter("attention")}
            >
              异常 ({attentionCount})
            </button>
          </div>

          <input
            className="input"
            style={{ width: 190 }}
            placeholder="搜索信号 / 节点..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="hv-toolbar-right">
          <span className="hv-summary-chip mono">
            <span className={`dot ${offlineCount > 0 ? "dot-crit" : attentionCount > 0 ? "dot-warn" : "dot-ok"}`} />
            <span>
              {healthyCount}/{activeGroups.length} 正常
            </span>
            <span className="hv-pipe">|</span>
            <span>{totalMbps.toFixed(0)} Mb/s</span>
          </span>
          <button
            type="button"
            className="btn btn-xs"
            onClick={handleTestFeishu}
            disabled={testingFeishu}
          >
            {testingFeishu ? "发送中..." : "测试飞书"}
          </button>
          <button type="button" className="btn btn-xs" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </div>

      {/* Haivision SRT Gateway Clean Route Card Stack */}
      <div className="hv-list">
        {filteredGroups.length === 0 ? (
          <div className="panel" style={{ padding: 28, textAlign: "center", color: "var(--text-muted)" }}>
            无匹配路由
          </div>
        ) : (
          filteredGroups.map((grp) => {
            const leg = primaryDisplayLeg(grp);
            const awaitingDown = isAwaitingDownstream(grp);
            const sev = awaitingDown
              ? { label: "待拉流", cls: "pill-warn", dot: "dot-warn" }
              : severityText(grp.severity);
            const isOpen = expandedId === grp.id;

            const s = leg?.sample;
            const isPass = leg?.mode === "udp-passthrough";
            const totalDropped = s
              ? isPass
                ? s.src_dropped
                : s.src_dropped + s.dst_dropped
              : 0;
            const flowing = !!(leg?.node_online && s && s.src_mbps >= 0.1);
            const protoText = isPass ? "TS over SRT (Pass)" : "TS over SRT";
            const endpointText = leg
              ? `${leg.node_id} :${leg.in_port}${!isPass ? `→:${leg.out_port}` : ""}`
              : "-";

            const statusColor = awaitingDown
              ? "var(--warn)"
              : grp.severity === "HEALTHY"
              ? "var(--ok)"
              : grp.severity === "CRITICAL_OUTAGE"
              ? "var(--crit)"
              : grp.severity === "IDLE"
              ? "var(--idle)"
              : "var(--warn)";

            return (
              <section
                key={grp.id}
                className={`hv-card sev-${grp.severity} ${awaitingDown ? "is-awaiting" : ""} ${isOpen ? "is-open" : ""}`}
              >
                <div
                  className="hv-card-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => setExpandedId(isOpen ? null : grp.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpandedId(isOpen ? null : grp.id);
                    }
                  }}
                >
                  {/* 16:9 Live Keyframe Thumbnail */}
                  {leg && <RouteThumbnail leg={leg} label={grp.name} />}

                  {/* Minimal 2-Line Haivision Route Identity */}
                  <div className="hv-card-main">
                    <div className="hv-card-title-row">
                      <span className="hv-status-icon" style={{ color: statusColor }}>
                        {s?.encrypted ? (
                          <LockBadgeIcon />
                        ) : (
                          <span className={`dot ${sev.dot}`} />
                        )}
                      </span>
                      <span className="hv-card-name">{grp.name}</span>
                      {grp.severity !== "HEALTHY" && (
                        <span className={`pill ${sev.cls}`}>{sev.label}</span>
                      )}
                      {awaitingDown && (
                        <span className="hv-sub-tag" style={{ color: "var(--warn)" }}>
                          入站正常 · 等待收端拉流
                        </span>
                      )}
                      {grp.protected_by && (
                        <span className="hv-sub-tag">{grp.protected_by} 在播</span>
                      )}
                    </div>

                    <div className="hv-card-meta mono">
                      <span>{protoText}</span>
                      <span className="hv-pipe">|</span>
                      <span>{endpointText}</span>
                      <span className="hv-pipe">|</span>
                      <span>{s ? `${s.src_mbps.toFixed(1)} Mb/s` : "-"}</span>
                      {!isPass && s && s.src_rtt_ms > 0 && (
                        <>
                          <span className="hv-pipe">|</span>
                          <span>{s.src_rtt_ms.toFixed(0)} ms</span>
                        </>
                      )}
                      <span className="hv-pipe">|</span>
                      <span
                        style={{
                          color:
                            totalDropped > 0
                              ? "var(--crit)"
                              : flowing
                              ? "var(--ok)"
                              : "var(--text-muted)",
                          fontWeight: totalDropped > 0 ? 700 : 500,
                        }}
                      >
                        {totalDropped > 0 ? `弃包 ${totalDropped}` : "0 弃包"}
                      </span>
                      {grp.legs.length >= 2 && (
                        <>
                          <span className="hv-pipe">|</span>
                          <span>{redundancyText(grp.redundancy_type)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Quiet Haivision Right Action Icons */}
                  <div className="hv-card-actions" onClick={(e) => e.stopPropagation()}>
                    <label className="switch" title={grp.expected_active ? "已开启飞书告警" : "待机（不触发告警）"}>
                      <input
                        type="checkbox"
                        checked={grp.expected_active}
                        onChange={() => handleToggleActive(grp)}
                      />
                    </label>

                    <button
                      type="button"
                      className={`hv-icon-btn ${isOpen ? "is-active" : ""}`}
                      title={isOpen ? "收起实时曲线与统计" : "展开实时曲线与统计"}
                      aria-label="统计曲线"
                      onClick={() => setExpandedId(isOpen ? null : grp.id)}
                    >
                      <ChartIcon />
                    </button>

                    <button
                      type="button"
                      className="hv-icon-btn"
                      title="4层排障时间轴 / 原始日志 / 导出报告"
                      aria-label="4层排障"
                      onClick={() => onOpenRoute(grp.id)}
                    >
                      <LayersIcon />
                    </button>

                    {leg && (
                      <button
                        type="button"
                        className="hv-icon-btn"
                        title={`安全重启 ${leg.node_id}/${leg.channel_id}`}
                        aria-label="重启通道"
                        onClick={() =>
                          setRestartTarget({
                            nodeId: leg.node_id,
                            nodeName: leg.node_name,
                            channelId: leg.channel_id,
                            signalName: grp.name,
                          })
                        }
                      >
                        <RestartIcon />
                      </button>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <HaivisionDrawer
                    group={grp}
                    theme={theme}
                    onOpenTimeline={onOpenRoute}
                    onRestartLeg={(targetLeg) =>
                      setRestartTarget({
                        nodeId: targetLeg.node_id,
                        nodeName: targetLeg.node_name,
                        channelId: targetLeg.channel_id,
                        signalName: grp.name,
                      })
                    }
                  />
                )}
              </section>
            );
          })
        )}
      </div>

      {restartTarget && (
        <SafeRestartModal
          {...restartTarget}
          onClose={() => setRestartTarget(null)}
          onSuccess={(msg) => {
            setToast({ kind: "ok", text: msg });
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
