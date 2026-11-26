import { useEffect, useRef, useState } from "react";
import type { GroupTimelineResponse, SignalGroupLiveView } from "../types";
import { api, formatDateTime, formatUptime, redundancyText, severityText } from "../api";
import { SyncedTimeline, type SyncedTimelineHandle } from "../components/SyncedTimeline";
import { SafeRestartModal } from "../components/SafeRestartModal";

interface Props {
  groups: SignalGroupLiveView[];
  selectedGroupId: string;
  onSelectGroup: (id: string) => void;
  onBack: () => void;
  cleanView: boolean;
  onToggleCleanView: (on: boolean) => void;
  theme: "dark" | "light";
}

type DetailTab = "timeline" | "endpoints" | "events";

const PRESETS = [
  { label: "15m", sec: 15 * 60 },
  { label: "30m", sec: 30 * 60 },
  { label: "2h", sec: 2 * 3600 },
  { label: "6h", sec: 6 * 3600 },
  { label: "24h", sec: 24 * 3600 },
  { label: "7d", sec: 7 * 86400 },
];

export function TimelinePage({
  groups,
  selectedGroupId,
  onSelectGroup,
  onBack,
  cleanView,
  onToggleCleanView,
  theme,
}: Props) {
  const [detailTab, setDetailTab] = useState<DetailTab>("timeline");
  const [rangeSec, setRangeSec] = useState(30 * 60);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showBackupOverlay, setShowBackupOverlay] = useState(true);
  const [data, setData] = useState<GroupTimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [restartTarget, setRestartTarget] = useState<{
    nodeId: string;
    nodeName: string;
    channelId: string;
    signalName: string;
  } | null>(null);
  const chartRef = useRef<SyncedTimelineHandle>(null);

  const activeId = selectedGroupId || groups[0]?.id || "";

  async function loadTimeline(fromOverride?: number, toOverride?: number) {
    if (!activeId) return;
    setLoading(true);
    setError("");
    const now = Math.floor(Date.now() / 1000);
    const toTS = toOverride ?? now;
    const fromTS = fromOverride ?? toTS - rangeSec;
    try {
      const res = await api.timeline(activeId, fromTS, toTS);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, rangeSec]);

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

  const sev = data ? severityText(data.live_group.severity) : { label: "-", cls: "pill-idle", dot: "dot-idle" };

  return (
    <div>
      {!cleanView ? (
        <div className="toolbar-row">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <button type="button" className="btn" onClick={onBack}>
              ← 路由列表
            </button>
            <select
              className="select"
              value={activeId}
              onChange={(e) => onSelectGroup(e.target.value)}
              aria-label="切换路由"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} · {g.direction_label}
                </option>
              ))}
            </select>
            {data && (
              <>
                <span className={`pill ${sev.cls}`}>
                  <span className={`dot ${sev.dot}`} />
                  {sev.label}
                </span>
                <span className="pill pill-accent">{redundancyText(data.group.redundancy_type)}</span>
              </>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" className="btn" onClick={() => void loadTimeline()} disabled={loading}>
              {loading ? "加载中..." : "刷新"}
            </button>
            <button type="button" className="btn" onClick={handleExportPNG} disabled={!data || detailTab !== "timeline"}>
              导出 PNG
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setDetailTab("timeline");
                onToggleCleanView(true);
              }}
              disabled={!data}
            >
              快照视图
            </button>
          </div>
        </div>
      ) : (
        <div
          className="no-print toolbar-row"
          style={{
            padding: "8px 12px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>快照视图</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-xs" onClick={handleExportPNG}>
              导出 PNG
            </button>
            <button type="button" className="btn btn-xs btn-primary" onClick={() => onToggleCleanView(false)}>
              退出快照
            </button>
          </div>
        </div>
      )}

      {toast && <div className="notice notice-ok">{toast}</div>}
      {error && <div className="notice notice-err">{error}</div>}

      {data && (
        <>
          {/* Haivision Gateway 3-Stage Endpoint Topology Panel */}
          <section className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <span>{data.group.name}</span>
                <span className="pill pill-idle">{data.direction_label}</span>
                <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{data.event_name}</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                {formatDateTime(data.from_ts)} ~ {formatDateTime(data.to_ts)}
              </div>
            </div>

            <div className="topo-grid">
              {/* Source Column */}
              <div className="topo-box">
                <div className="topo-box-label">
                  <span>SOURCE · 发端</span>
                  <span>Caller</span>
                </div>
                {data.live_group.legs.map((leg) => (
                  <div key={`${leg.node_id}-${leg.channel_id}`} style={{ fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>
                      {leg.role === "primary" ? "[主] " : leg.role === "backup" ? "[备] " : ""}
                      {leg.src_device || "-"}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {leg.carrier || "-"} · {leg.sample.src_mbps.toFixed(2)} Mb/s
                      {leg.mode === "srt-relay" && leg.sample.src_rtt_ms > 0
                        ? ` · RTT ${leg.sample.src_rtt_ms.toFixed(0)}ms`
                        : ""}
                    </div>
                  </div>
                ))}
              </div>

              <div className="topo-arrow">→</div>

              {/* Gateway Column */}
              <div className="topo-box">
                <div className="topo-box-label">
                  <span>GATEWAY · 云端中转</span>
                  <span>{data.group.legs[0]?.mode === "udp-passthrough" ? "L4 UDP" : "SRT Relay"}</span>
                </div>
                {data.legs.map((lt) => {
                  const maxR = lt.samples.reduce((m, s) => Math.max(m, s.restart_count), 0);
                  const udpDrops = lt.host.reduce((sum, h) => sum + h.udp_rcvbuf_errors, 0);
                  return (
                    <div key={`${lt.leg.node_id}-${lt.leg.channel_id}`} style={{ fontSize: 12 }}>
                      <div className="mono" style={{ fontWeight: 600 }}>
                        {lt.leg.node_id} / {lt.leg.channel_id}{" "}
                        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                          (:{lt.leg.in_port}
                          {lt.leg.mode === "srt-relay" ? `→:${lt.leg.out_port}` : ""})
                        </span>
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: maxR === 0 && udpDrops === 0 ? "var(--ok)" : "var(--crit)" }}>
                        重启 {maxR} 次 · UDP 缓冲丢包 {udpDrops}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="topo-arrow">→</div>

              {/* Destination Column */}
              <div className="topo-box">
                <div className="topo-box-label">
                  <span>DESTINATION · 收端</span>
                  <span>{data.group.legs[0]?.mode === "udp-passthrough" ? "Listener" : "Caller"}</span>
                </div>
                {data.live_group.legs.map((leg) => (
                  <div key={`${leg.node_id}-${leg.channel_id}`} style={{ fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>
                      {leg.role === "primary" ? "[主] " : leg.role === "backup" ? "[备] " : ""}
                      {leg.dst_device || "-"}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {leg.sample.dst_mbps.toFixed(2)} Mb/s
                      {leg.mode === "srt-relay" && leg.sample.dst_rtt_ms > 0
                        ? ` · RTT ${leg.sample.dst_rtt_ms.toFixed(0)}ms`
                        : ""}
                      {leg.sample.path_medium && leg.sample.path_medium !== "-" ? ` · ${leg.sample.path_medium}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className={`status-strip sev-${data.live_group.severity}`}>
              <span>{data.live_group.summary}</span>
              {data.live_group.protected_by && (
                <span className="pill pill-ok">在播：{data.live_group.protected_by}</span>
              )}
            </div>
          </section>

          {/* Route Detail Tabs (HydraSRT RouteItem style) */}
          {!cleanView && (
            <div className="tab-bar" role="tablist">
              <button
                type="button"
                className={`tab-btn ${detailTab === "timeline" ? "active" : ""}`}
                onClick={() => setDetailTab("timeline")}
              >
                趋势监控
              </button>
              <button
                type="button"
                className={`tab-btn ${detailTab === "endpoints" ? "active" : ""}`}
                onClick={() => setDetailTab("endpoints")}
              >
                通道明细 ({data.live_group.legs.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${detailTab === "events" ? "active" : ""}`}
                onClick={() => setDetailTab("events")}
              >
                事件日志 ({data.events.length})
              </button>
            </div>
          )}

          {(detailTab === "timeline" || cleanView) && (
            <>
              {!cleanView && (
                <div className="toolbar-row">
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                    <div className="seg-group" role="group" aria-label="时间范围">
                      {PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          className={`seg-btn ${rangeSec === p.sec ? "active" : ""}`}
                          onClick={() => setRangeSec(p.sec)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {data.legs.length >= 2 && (
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={showBackupOverlay}
                          onChange={(e) => setShowBackupOverlay(e.target.checked)}
                        />
                        叠加备路曲线
                      </label>
                    )}
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                    <input
                      type="datetime-local"
                      className="input"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      aria-label="开始时间"
                    />
                    <span style={{ color: "var(--text-muted)" }}>~</span>
                    <input
                      type="datetime-local"
                      className="input"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      aria-label="结束时间"
                    />
                    <button type="button" className="btn btn-xs" onClick={applyCustomWindow}>
                      查询
                    </button>
                  </div>
                </div>
              )}

              <SyncedTimeline
                ref={chartRef}
                data={data}
                showBackupOverlay={showBackupOverlay}
                cleanView={cleanView}
                theme={theme}
              />
            </>
          )}

          {detailTab === "endpoints" && !cleanView && (
            <section className="panel">
              <div style={{ overflowX: "auto" }}>
                <table className="gw-table">
                  <thead>
                    <tr>
                      <th>角色 / 运营商</th>
                      <th>节点 / 容器</th>
                      <th>模式 / 端口</th>
                      <th>入 / 出码率</th>
                      <th>上 / 下 RTT</th>
                      <th>丢包 · 重传 · 丢弃 · NAK</th>
                      <th>TSBPD / 路径</th>
                      <th>进程 / 运行时长</th>
                      <th style={{ textAlign: "right" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.live_group.legs.map((leg) => {
                      const s = leg.sample;
                      return (
                        <tr key={`${leg.node_id}-${leg.channel_id}`}>
                          <td>
                            <strong>
                              {leg.role === "primary" ? "主" : leg.role === "backup" ? "备" : "单"}
                            </strong>{" "}
                            <span className="pill pill-idle">{leg.carrier || "-"}</span>
                          </td>
                          <td className="mono">
                            {leg.node_id} / {leg.channel_id}
                          </td>
                          <td className="mono">
                            {leg.mode === "udp-passthrough"
                              ? `UDP :${leg.in_port} → ${leg.target_addr || ":" + leg.out_port}`
                              : `SRT :${leg.in_port} → :${leg.out_port}`}
                          </td>
                          <td className="mono">
                            {s.src_mbps.toFixed(2)} / {s.dst_mbps.toFixed(2)} Mb/s
                          </td>
                          <td className="mono">
                            {leg.mode === "udp-passthrough"
                              ? "-"
                              : `${s.src_rtt_ms.toFixed(0)} / ${s.dst_rtt_ms.toFixed(0)} ms`}
                          </td>
                          <td className="mono">
                            {leg.mode === "udp-passthrough"
                              ? `重传 ${s.src_retrans} · NAK ${s.dst_nak_count}`
                              : `上 ${s.src_lost}/${s.src_retrans}/${s.src_dropped} · 下 ${s.dst_lost}/${s.dst_retrans}/${s.dst_dropped}`}
                          </td>
                          <td className="mono">
                            {s.src_tsbpd_ms > 0 ? `${s.src_tsbpd_ms.toFixed(0)}ms` : "-"} ·{" "}
                            <span className={`pill ${s.path_medium.includes("LO") ? "pill-warn" : "pill-idle"}`}>
                              {s.path_medium || "-"}
                            </span>
                          </td>
                          <td className="mono">
                            {s.process_state} · 重启 {s.restart_count} · {formatUptime(s.uptime_sec)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              onClick={() =>
                                setRestartTarget({
                                  nodeId: leg.node_id,
                                  nodeName: leg.node_name,
                                  channelId: leg.channel_id,
                                  signalName: data.group.name,
                                })
                              }
                            >
                              单路重启
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

          {(detailTab === "events" || cleanView) && (
            <section className="panel" style={{ marginTop: cleanView ? 12 : 0 }}>
              <div className="panel-head">
                <span className="panel-title">事件记录 ({data.events.length})</span>
              </div>
              {data.events.length === 0 ? (
                <div style={{ padding: 14, color: "var(--text-muted)", fontSize: 12 }}>当前时间窗无异常事件</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="gw-table">
                    <thead>
                      <tr>
                        <th>开始时间</th>
                        <th>恢复时间</th>
                        <th>节点 / 通道</th>
                        <th>状态</th>
                        <th>区段</th>
                        <th>详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.events.map((ev) => {
                        const evSev = severityText(ev.severity);
                        return (
                          <tr key={ev.id}>
                            <td className="mono">{formatDateTime(ev.start_ts)}</td>
                            <td className="mono">{ev.end_ts ? formatDateTime(ev.end_ts) : "持续中"}</td>
                            <td className="mono">
                              {ev.node_id}/{ev.channel_id}
                            </td>
                            <td>
                              <span className={`pill ${evSev.cls}`}>{evSev.label}</span>
                            </td>
                            <td className="mono">{ev.fault_layer}</td>
                            <td>{ev.summary}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {restartTarget && (
        <SafeRestartModal
          {...restartTarget}
          onClose={() => setRestartTarget(null)}
          onSuccess={(msg) => {
            setToast(msg);
            void loadTimeline();
          }}
        />
      )}
    </div>
  );
}
