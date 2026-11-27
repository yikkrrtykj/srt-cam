import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelLogsResponse, GroupTimelineResponse, SignalGroupLiveView } from "../types";
import { api, formatDateTime, formatTime, formatUptime, redundancyText, severityText } from "../api";
import { SyncedTimeline, type SyncedTimelineHandle } from "../components/SyncedTimeline";
import { SignalHealthPanel, type LegWindowStats } from "../components/SignalHealthPanel";
import { RouteThumbnail } from "../components/RouteThumbnail";
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

type DetailTab = "timeline" | "endpoints" | "events" | "logs";

const PRESETS = [
  { label: "5分钟", sec: 5 * 60 },
  { label: "15分钟", sec: 15 * 60 },
  { label: "30分钟", sec: 30 * 60 },
  { label: "2小时", sec: 2 * 3600 },
  { label: "6小时", sec: 6 * 3600 },
  { label: "24小时", sec: 24 * 3600 },
  { label: "7天", sec: 7 * 86400 },
];

function faultLayerLabel(layer: string): string {
  switch (layer) {
    case "upstream":
      return "推流段";
    case "downstream":
      return "拉流段";
    case "cloud":
      return "中转服务器";
    case "tunnel":
      return "转发隧道";
    default:
      return "整路";
  }
}

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

  // Logs tab state
  const [logLegIdx, setLogLegIdx] = useState(0);
  const [logTail, setLogTail] = useState(300);
  const [hideStats, setHideStats] = useState(true);
  const [logKeyword, setLogKeyword] = useState("");
  const [logData, setLogData] = useState<ChannelLogsResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState("");

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

  async function loadLogs(targetData?: GroupTimelineResponse | null) {
    const src = targetData ?? data;
    if (!src || src.group.legs.length === 0) return;
    const idx = logLegIdx < src.group.legs.length ? logLegIdx : 0;
    const leg = src.group.legs[idx];
    setLogLoading(true);
    setLogError("");
    try {
      const res = await api.channelLogs(leg.node_id, leg.channel_id, logTail, hideStats);
      setLogData(res);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "日志加载失败");
    } finally {
      setLogLoading(false);
    }
  }

  useEffect(() => {
    setLogLegIdx(0);
    setLogData(null);
    void loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, rangeSec]);

  useEffect(() => {
    if (detailTab === "logs" && data) {
      void loadLogs(data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTab, data, logLegIdx, logTail, hideStats]);

  const filteredLogs = useMemo(() => {
    if (!logData) return [];
    const kw = logKeyword.trim().toLowerCase();
    if (!kw) return logData.lines;
    return logData.lines.filter((l) => l.text.toLowerCase().includes(kw) || l.level.includes(kw));
  }, [logData, logKeyword]);

  function copyLogs() {
    if (filteredLogs.length === 0) return;
    const text = filteredLogs
      .map((l) => `${l.ts ? l.ts + " " : ""}[${l.level.toUpperCase()}] ${l.text}`)
      .join("\n");
    void navigator.clipboard?.writeText(text).then(() => {
      setToast(`已复制 ${filteredLogs.length} 行日志`);
    });
  }

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

  const awaitingDown =
    !!data &&
    data.live_group.expected_active &&
    data.live_group.severity === "CRITICAL_OUTAGE" &&
    data.live_group.legs.length > 0 &&
    data.live_group.legs.every(
      (l) => l.node_online && l.sample.fault_code === "DOWNSTREAM_OFFLINE"
    );
  const sev = data
    ? awaitingDown
      ? { label: "待拉流", cls: "pill-warn", dot: "dot-warn" }
      : severityText(data.live_group.severity)
    : { label: "-", cls: "pill-idle", dot: "dot-idle" };

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
    <div>
      {!cleanView ? (
        <div className="toolbar-row">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <button type="button" className="btn" onClick={onBack}>
              ← 返回信号总览
            </button>
            <select
              className="select"
              value={activeId}
              onChange={(e) => onSelectGroup(e.target.value)}
              aria-label="切换信号"
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
              导出截图报告
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
              全屏快照
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
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>全屏快照模式</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-xs" onClick={handleExportPNG}>
              导出截图报告
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
          {/* Single-Signal Health Panel */}
          <section className="panel">
            <div className="panel-head">
              <div className="panel-title">
                {data.live_group.legs[0] && (
                  <RouteThumbnail leg={data.live_group.legs[0]} label={data.group.name} size="sm" />
                )}
                <span>{data.group.name}</span>
                <span className="pill pill-idle">{data.direction_label}</span>
                <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{data.event_name}</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                {formatDateTime(data.from_ts)} ~ {formatDateTime(data.to_ts)}
              </div>
            </div>

            <SignalHealthPanel
              group={data.live_group}
              legStats={legWindowStats}
              onRestartLeg={
                cleanView
                  ? undefined
                  : (leg) =>
                      setRestartTarget({
                        nodeId: leg.node_id,
                        nodeName: leg.node_name,
                        channelId: leg.channel_id,
                        signalName: data.group.name,
                      })
              }
            />

            <div className={`status-strip sev-${data.live_group.severity}`}>
              <span>{data.live_group.summary}</span>
              {data.live_group.protected_by && (
                <span className="pill pill-ok">在播：{data.live_group.protected_by}</span>
              )}
            </div>
          </section>

          {/* Route Detail Tabs */}
          {!cleanView && (
            <div className="tab-bar" role="tablist">
              <button
                type="button"
                className={`tab-btn ${detailTab === "timeline" ? "active" : ""}`}
                onClick={() => setDetailTab("timeline")}
              >
                历史趋势
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
                异常记录 ({data.events.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${detailTab === "logs" ? "active" : ""}`}
                onClick={() => setDetailTab("logs")}
              >
                通信记录
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
                      <th>主备 / 线路</th>
                      <th>服务器 / 通道号</th>
                      <th>传输模式 / 端口</th>
                      <th>推流 / 拉流码率</th>
                      <th>推流 / 拉流时延</th>
                      <th>丢包 · 重传 · 弃包</th>
                      <th>设定缓冲 / 路径</th>
                      <th>运行状态 / 时长</th>
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
                              ? `透传 :${leg.in_port} → ${leg.target_addr || ":" + leg.out_port}`
                              : `中转 :${leg.in_port} → :${leg.out_port}`}
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
                              ? `重传 ${s.src_retrans} · 请求重发 ${s.dst_nak_count} · 弃包 ${s.src_dropped}`
                              : `推 ${s.src_lost}/${s.src_retrans}/${s.src_dropped} · 拉 ${s.dst_lost}/${s.dst_retrans}/${s.dst_dropped}`}
                          </td>
                          <td className="mono">
                            {s.src_tsbpd_ms > 0 ? `${s.src_tsbpd_ms.toFixed(0)}ms` : "-"} ·{" "}
                            <span className={`pill ${s.path_medium.includes("LO") ? "pill-warn" : "pill-idle"}`}>
                              {s.path_medium || "-"}
                            </span>
                          </td>
                          <td className="mono">
                            {s.process_state === "running" ? "运行中" : s.process_state} · 重启 {s.restart_count} · {formatUptime(s.uptime_sec)}
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
                              重置通道
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
                <span className="panel-title">异常记录 ({data.events.length})</span>
              </div>
              {data.events.length === 0 ? (
                <div style={{ padding: 14, color: "var(--text-muted)", fontSize: 12 }}>当前时间范围内无异常记录</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="gw-table">
                    <thead>
                      <tr>
                        <th>发生时间</th>
                        <th>恢复时间</th>
                        <th>服务器 / 通道</th>
                        <th>级别</th>
                        <th>区段</th>
                        <th>异常说明</th>
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
                            <td>{faultLayerLabel(ev.fault_layer)}</td>
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

          {detailTab === "logs" && !cleanView && (
            <section className="panel">
              <div className="panel-head">
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <div className="seg-group" role="tablist" aria-label="选择主备通道">
                    {data.group.legs.map((leg, idx) => (
                      <button
                        key={`${leg.node_id}-${leg.channel_id}`}
                        type="button"
                        className={`seg-btn ${logLegIdx === idx ? "active" : ""}`}
                        onClick={() => setLogLegIdx(idx)}
                      >
                        {leg.role === "primary" ? "主" : leg.role === "backup" ? "备" : "单"} ({leg.node_id}/
                        {leg.channel_id})
                      </button>
                    ))}
                  </div>

                  <label className="switch" title="仅显示连接、断线与丢包事件，隐藏高频周期统计">
                    <input
                      type="checkbox"
                      checked={hideStats}
                      onChange={(e) => setHideStats(e.target.checked)}
                    />
                    仅看连接与异常
                  </label>

                  <select
                    className="select mono"
                    value={logTail}
                    onChange={(e) => setLogTail(Number(e.target.value))}
                    aria-label="行数"
                  >
                    <option value={100}>最近 100 条</option>
                    <option value={300}>最近 300 条</option>
                    <option value={800}>最近 800 条</option>
                  </select>

                  <input
                    className="input"
                    style={{ width: 185 }}
                    placeholder="搜索关键字（如断线、DROPPED）"
                    value={logKeyword}
                    onChange={(e) => setLogKeyword(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {logData && (
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      显示 {filteredLogs.length}/{logData.total_lines} · {formatTime(logData.fetched_at)}
                    </span>
                  )}
                  <button type="button" className="btn btn-xs" onClick={copyLogs} disabled={filteredLogs.length === 0}>
                    复制
                  </button>
                  <button type="button" className="btn btn-xs btn-primary" onClick={() => void loadLogs()} disabled={logLoading}>
                    {logLoading ? "读取中..." : "刷新记录"}
                  </button>
                </div>
              </div>

              {logError && (
                <div className="notice notice-err" style={{ margin: 12 }}>
                  {logError}
                </div>
              )}

              <div className="log-viewer">
                {logLoading && !logData ? (
                  <div style={{ padding: 16, color: "var(--text-muted)" }}>正在读取通信记录...</div>
                ) : filteredLogs.length === 0 ? (
                  <div style={{ padding: 16, color: "var(--text-muted)" }}>
                    当前无匹配记录（可取消勾选“仅看连接与异常”查看全部底层统计）
                  </div>
                ) : (
                  filteredLogs.map((line, i) => (
                    <div key={i} className={`log-row lvl-${line.level}`}>
                      <span className="log-ts">{line.ts || "-"}</span>
                      <span className={`log-lvl lvl-${line.level}`}>{line.level}</span>
                      <span className="log-text">{line.text}</span>
                    </div>
                  ))
                )}
              </div>
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
