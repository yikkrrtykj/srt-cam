import { useMemo, useState } from "react";
import type { LegLiveView, OverviewResponse, SignalGroupLiveView } from "../types";
import { api, formatTime, redundancyText, severityText } from "../api";
import { SafeRestartModal } from "../components/SafeRestartModal";

interface Props {
  overview: OverviewResponse;
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

function legDotClass(leg: LegLiveView): string {
  if (!leg.node_online) return "dot-crit";
  switch (leg.sample.fault_code) {
    case "HEALTHY":
      return "dot-ok";
    case "IDLE_EXPECTED_OFF":
      return "dot-idle";
    case "UPSTREAM_OFFLINE":
    case "DOWNSTREAM_OFFLINE":
    case "CLOUD_PROCESS_DOWN":
    case "NODE_UNREACHABLE":
      return "dot-crit";
    default:
      return "dot-warn";
  }
}

export function OverviewPage({ overview, onOpenRoute, onRefresh }: Props) {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [query, setQuery] = useState("");
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testingFeishu, setTestingFeishu] = useState(false);

  const activeGroups = overview.groups.filter((g) => g.expected_active);
  const healthyCount = activeGroups.filter((g) => g.severity === "HEALTHY").length;
  const backupCount = activeGroups.filter((g) => g.severity === "DEGRADED_PROTECTED").length;
  const degradedCount = activeGroups.filter((g) => g.severity === "DEGRADED_SINGLE").length;
  const offlineCount = activeGroups.filter((g) => g.severity === "CRITICAL_OUTAGE").length;
  const onlineNodes = overview.nodes.filter((n) => n.online).length;

  const totalInMbps = overview.groups.reduce(
    (sum, g) => sum + g.legs.reduce((s, l) => s + l.sample.src_mbps, 0),
    0
  );
  const totalOutMbps = overview.groups.reduce(
    (sum, g) => sum + g.legs.reduce((s, l) => s + l.sample.dst_mbps, 0),
    0
  );
  const totalUDPDrops = overview.nodes.reduce((sum, n) => sum + n.host.udp_rcvbuf_errors, 0);
  const avgCPU =
    overview.nodes.length > 0
      ? overview.nodes.reduce((sum, n) => sum + n.host.cpu_percent, 0) / overview.nodes.length
      : 0;

  // HydraSRT-style Attention List: only routes requiring operator attention
  const attentionRoutes = useMemo(
    () =>
      overview.groups.filter(
        (g) =>
          g.expected_active &&
          (g.severity === "CRITICAL_OUTAGE" ||
            g.severity === "DEGRADED_PROTECTED" ||
            g.severity === "DEGRADED_SINGLE")
      ),
    [overview.groups]
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

      {/* Top Operations Summary Strip (HydraSRT Dashboard pattern) */}
      <section className="metrics-row" aria-label="系统指标">
        <div className="metric-tile">
          <div className="metric-head">
            <span>路由状态</span>
            <span className="mono">{activeGroups.length}/{overview.groups.length} 监控</span>
          </div>
          <div className="metric-val mono">
            <span style={{ color: "var(--ok)" }}>{healthyCount}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 15 }}> / {activeGroups.length}</span>
          </div>
          <div className="metric-sub mono">
            <span>正常 {healthyCount}</span>
            <span style={{ color: backupCount + degradedCount > 0 ? "var(--warn)" : undefined }}>
              备路/抖动 {backupCount + degradedCount}
            </span>
            <span style={{ color: offlineCount > 0 ? "var(--crit)" : undefined }}>
              中断 {offlineCount}
            </span>
          </div>
        </div>

        <div className="metric-tile">
          <div className="metric-head">
            <span>主备冗余</span>
            <span>Failover</span>
          </div>
          <div
            className="metric-val"
            style={{
              color:
                offlineCount > 0
                  ? "var(--crit)"
                  : backupCount > 0
                  ? "var(--warn)"
                  : "var(--ok)",
            }}
          >
            {offlineCount > 0
              ? `${offlineCount} 路中断`
              : backupCount > 0
              ? `${backupCount} 路备路在播`
              : "全部主备就绪"}
          </div>
          <div className="metric-sub">
            <span>备路接管 {backupCount}</span>
            <span>抖动 {degradedCount}</span>
          </div>
        </div>

        <div className="metric-tile">
          <div className="metric-head">
            <span>汇总流量</span>
            <span className="mono">SRT + UDP</span>
          </div>
          <div className="metric-val mono">{totalInMbps.toFixed(1)} Mb/s</div>
          <div className="metric-sub mono">
            <span>入 {totalInMbps.toFixed(1)} Mb/s</span>
            <span>出 {totalOutMbps.toFixed(1)} Mb/s</span>
          </div>
        </div>

        <div className="metric-tile">
          <div className="metric-head">
            <span>中转节点</span>
            <span className="mono">{formatTime(overview.updated_at)}</span>
          </div>
          <div className="metric-val mono">
            {onlineNodes} / {overview.nodes.length}
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginLeft: 8 }}>
              在线
            </span>
          </div>
          <div className="metric-sub mono">
            <span>均载 CPU {avgCPU.toFixed(1)}%</span>
            <span style={{ color: totalUDPDrops > 0 ? "var(--crit)" : "var(--ok)" }}>
              UDP 丢包 {totalUDPDrops}
            </span>
          </div>
        </div>
      </section>

      {/* Attention List (HydraSRT signature operations panel) */}
      {attentionRoutes.length > 0 && (
        <section className={`panel attention-panel ${offlineCount > 0 ? "has-crit" : ""}`}>
          <div className="panel-head">
            <span className="panel-title">
              <span className={`dot ${offlineCount > 0 ? "dot-crit" : "dot-warn"}`} />
              需关注路由 ({attentionRoutes.length})
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="gw-table">
              <thead>
                <tr>
                  <th style={{ width: 92 }}>状态</th>
                  <th style={{ width: 130 }}>路由</th>
                  <th style={{ width: 160 }}>方向</th>
                  <th>当前状态摘要</th>
                  <th style={{ width: 80, textAlign: "right" }}>查看</th>
                </tr>
              </thead>
              <tbody>
                {attentionRoutes.map((grp) => {
                  const sev = severityText(grp.severity);
                  return (
                    <tr key={grp.id} className="clickable">
                      <td>
                        <span className={`pill ${sev.cls}`}>{sev.label}</span>
                      </td>
                      <td>
                        <button type="button" className="route-link" onClick={() => onOpenRoute(grp.id)}>
                          {grp.name}
                        </button>
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>{grp.direction_label}</td>
                      <td>{grp.summary}</td>
                      <td style={{ textAlign: "right" }}>
                        <button type="button" className="btn btn-xs btn-primary" onClick={() => onOpenRoute(grp.id)}>
                          详情
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Main Routes Table (Haivision SRT Gateway + HydraSRT style) */}
      <section className="panel">
        <div className="panel-head">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
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
                仅异常 ({attentionRoutes.length})
              </button>
            </div>
            <input
              className="input"
              style={{ width: 200 }}
              placeholder="搜索信号 / 设备 / 节点 / 运营商"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={handleTestFeishu}
              disabled={testingFeishu}
            >
              {testingFeishu ? "发送中..." : "测试飞书"}
            </button>
            <button type="button" className="btn" onClick={onRefresh}>
              刷新
            </button>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="gw-table">
            <thead>
              <tr>
                <th style={{ width: 92 }}>状态</th>
                <th style={{ width: 170 }}>路由 / 模式</th>
                <th>传输路径（Source → Gateway → Destination）</th>
                <th style={{ width: 120 }}>码率 (Mb/s)</th>
                <th style={{ width: 160 }}>RTT / 丢包</th>
                <th style={{ width: 72 }}>告警</th>
                <th style={{ width: 118, textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--text-muted)" }}>
                    无匹配路由
                  </td>
                </tr>
              ) : (
                filteredGroups.map((grp) => {
                  const sev = severityText(grp.severity);
                  return (
                    <tr key={grp.id} className="clickable" onClick={() => onOpenRoute(grp.id)}>
                      <td>
                        <span className={`pill ${sev.cls}`}>
                          <span className={`dot ${sev.dot}`} />
                          {sev.label}
                        </span>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="route-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenRoute(grp.id);
                          }}
                        >
                          {grp.name}
                        </button>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          {grp.direction_label} · {redundancyText(grp.redundancy_type)}
                        </div>
                      </td>

                      <td>
                        <div className="leg-flow-list">
                          {grp.legs.map((leg) => {
                            const roleTag =
                              leg.role === "primary" ? "主" : leg.role === "backup" ? "备" : "单";
                            return (
                              <div key={`${leg.node_id}-${leg.channel_id}`} className="leg-flow-row">
                                <span className={`dot ${legDotClass(leg)}`} />
                                <span className="pill pill-idle" style={{ padding: "0 5px", fontSize: 10 }}>
                                  {roleTag}
                                  {leg.carrier ? `·${leg.carrier}` : ""}
                                </span>
                                <span className="flow-hop">{leg.src_device || "Source"}</span>
                                <span className="flow-sep">→</span>
                                <span className="flow-node mono">
                                  {leg.node_id}:{leg.in_port}
                                  {leg.mode === "udp-passthrough" ? " UDP" : `/${leg.out_port}`}
                                </span>
                                <span className="flow-sep">→</span>
                                <span className="flow-hop">{leg.dst_device || "Destination"}</span>
                                {leg.sample.path_medium.includes("LO") && (
                                  <span className="pill pill-warn" style={{ padding: "0 5px", fontSize: 10 }}>
                                    LO
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>

                      <td className="mono">
                        <div className="leg-flow-list">
                          {grp.legs.map((leg) => (
                            <div key={`${leg.node_id}-${leg.channel_id}`}>
                              {leg.sample.src_mbps.toFixed(1)}
                              <span style={{ color: "var(--text-muted)" }}> / </span>
                              {leg.sample.dst_mbps.toFixed(1)}
                            </div>
                          ))}
                        </div>
                      </td>

                      <td className="mono">
                        <div className="leg-flow-list">
                          {grp.legs.map((leg) => {
                            const s = leg.sample;
                            if (leg.mode === "udp-passthrough") {
                              return (
                                <div key={`${leg.node_id}-${leg.channel_id}`} style={{ fontSize: 11 }}>
                                  <span style={{ color: "var(--text-muted)" }}>Pass</span> · 重传 {s.src_retrans} · NAK{" "}
                                  {s.dst_nak_count}
                                </div>
                              );
                            }
                            return (
                              <div key={`${leg.node_id}-${leg.channel_id}`} style={{ fontSize: 11 }}>
                                {s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)}` : "-"}/
                                {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)}ms` : "-"}
                                <span style={{ color: "var(--text-muted)" }}> · </span>
                                <span
                                  style={{
                                    color: s.src_dropped + s.dst_dropped > 0 ? "var(--crit)" : "var(--text-secondary)",
                                  }}
                                >
                                  弃 {s.src_dropped}/{s.dst_dropped}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </td>

                      <td onClick={(e) => e.stopPropagation()}>
                        <label className="switch" title="开启后异常触发飞书告警">
                          <input
                            type="checkbox"
                            checked={grp.expected_active}
                            onChange={() => handleToggleActive(grp)}
                          />
                        </label>
                      </td>

                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          onClick={() => onOpenRoute(grp.id)}
                        >
                          详情
                        </button>{" "}
                        {grp.legs[0] && (
                          <button
                            type="button"
                            className="btn btn-xs"
                            title={`重启 ${grp.legs[0].node_id}/${grp.legs[0].channel_id}`}
                            onClick={() =>
                              setRestartTarget({
                                nodeId: grp.legs[0].node_id,
                                nodeName: grp.legs[0].node_name,
                                channelId: grp.legs[0].channel_id,
                                signalName: grp.name,
                              })
                            }
                          >
                            重启
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

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
