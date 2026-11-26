import { useEffect, useRef, useState } from "react";
import type { GroupTimelineResponse, SignalGroupLiveView } from "../types";
import { api, formatDateTime, redundancyText, severityText } from "../api";
import { SyncedTimeline, type SyncedTimelineHandle } from "../components/SyncedTimeline";

interface Props {
  groups: SignalGroupLiveView[];
  selectedGroupId: string;
  onSelectGroup: (id: string) => void;
  screenshotMode: boolean;
  onToggleScreenshotMode: (on: boolean) => void;
}

const PRESETS = [
  { label: "15分钟", sec: 15 * 60 },
  { label: "30分钟", sec: 30 * 60 },
  { label: "2小时", sec: 2 * 3600 },
  { label: "6小时", sec: 6 * 3600 },
  { label: "24小时", sec: 24 * 3600 },
  { label: "7天", sec: 7 * 86400 },
];

export function TimelinePage({
  groups,
  selectedGroupId,
  onSelectGroup,
  screenshotMode,
  onToggleScreenshotMode,
}: Props) {
  const [rangeSec, setRangeSec] = useState(30 * 60);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showBackupOverlay, setShowBackupOverlay] = useState(true);
  const [data, setData] = useState<GroupTimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
      setError(err instanceof Error ? err.message : "加载时间轴失败");
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
      setError("结束时间必须晚于开始时间");
      return;
    }
    void loadTimeline(f, t);
  }

  function handleExportPNG() {
    if (!data || !chartRef.current) return;
    const headerLines = [
      `SRT-CAM 故障定界证据图 · ${data.group.name} (${data.direction_label})`,
      `场次：${data.event_name}  |  模式：${redundancyText(data.group.redundancy_type)}  |  区间：${formatDateTime(data.from_ts)} ~ ${formatDateTime(data.to_ts)}`,
      `自动定界结论：${data.live_group.summary}`,
    ];
    chartRef.current.exportEvidencePNG(headerLines);
  }

  const sev = data ? severityText(data.live_group.severity) : { label: "-", cls: "badge-idle" };

  return (
    <div>
      {!screenshotMode ? (
        <>
          <header className="page-header">
            <div>
              <h1>4 层同步时间轴 · 自动故障定界</h1>
              <p className="page-subtitle">
                上游入站 / 云端健康（0重启铁证）/ 下游出站 / 主备状态对比四层联动，支持 7 天 SQLite 历史回溯与一键证据截图
              </p>
            </div>
            <div className="header-actions">
              <button type="button" className="btn" onClick={() => void loadTimeline()} disabled={loading}>
                {loading ? "加载中..." : "刷新数据"}
              </button>
              <button type="button" className="btn" onClick={handleExportPNG} disabled={!data}>
                导出高清 PNG
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onToggleScreenshotMode(true)}
                disabled={!data}
              >
                进入证据截图模式
              </button>
            </div>
          </header>

          <div className="timeline-toolbar">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                信号组：
                <select
                  className="select"
                  style={{ marginLeft: 6 }}
                  value={activeId}
                  onChange={(e) => onSelectGroup(e.target.value)}
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.direction_label})
                    </option>
                  ))}
                </select>
              </label>

              <div className="range-pills" role="group" aria-label="快捷时间区间">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`range-pill ${rangeSec === p.sec ? "active" : ""}`}
                    onClick={() => setRangeSec(p.sec)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={showBackupOverlay}
                  onChange={(e) => setShowBackupOverlay(e.target.checked)}
                />
                主备双路同轴叠加对比
              </label>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <input
                type="datetime-local"
                className="input"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="自定义开始时间"
              />
              <span style={{ color: "var(--text-muted)" }}>至</span>
              <input
                type="datetime-local"
                className="input"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="自定义结束时间"
              />
              <button type="button" className="btn btn-sm" onClick={applyCustomWindow}>
                查询自定义区间
              </button>
            </div>
          </div>
        </>
      ) : (
        <div
          className="no-print"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
            padding: "8px 12px",
            background: "#f8fafc",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
          }}
        >
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            当前处于<strong>证据截图模式</strong>（已隐藏侧边栏与编辑控件，可直接整页截屏或导出 PNG 发给领导）
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={handleExportPNG}>
              导出高清 PNG
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onToggleScreenshotMode(false)}>
              退出截图模式
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice-bar notice-err">{error}</div>}

      {data && (
        <>
          <section className="evidence-banner">
            <div className="evidence-top-row">
              <div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <h2 style={{ margin: 0, fontSize: 18 }}>{data.group.name}</h2>
                  <span className={`badge ${sev.cls}`}>{sev.label}</span>
                  <span className="badge badge-brand">{data.direction_label}</span>
                  <span className="badge badge-idle">{redundancyText(data.group.redundancy_type)}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-secondary)" }}>
                  场次：{data.event_name}
                </div>
              </div>
              <div className="mono" style={{ textAlign: "right", fontSize: 12, color: "var(--text-secondary)" }}>
                <div>取证时间窗：{formatDateTime(data.from_ts)}</div>
                <div>至 {formatDateTime(data.to_ts)}</div>
              </div>
            </div>

            <div className={`evidence-verdict sev-${data.live_group.severity}`}>
              自动故障定界：{data.live_group.summary}
            </div>

            <div className="evidence-meta-grid">
              {data.legs.map((lt) => {
                const maxRestarts = lt.samples.reduce((m, s) => Math.max(m, s.restart_count), 0);
                const udpDrops = lt.host.reduce((sum, h) => sum + h.udp_rcvbuf_errors, 0);
                const role = lt.leg.role === "primary" ? "主路" : lt.leg.role === "backup" ? "备路" : "单路";
                return (
                  <div key={`${lt.leg.node_id}-${lt.leg.channel_id}`} className="evidence-leg-pill">
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <strong>
                        {role} · {lt.leg.carrier || "默认线路"} ({lt.leg.node_id}/{lt.leg.channel_id})
                      </strong>
                      <span className="mono" style={{ color: maxRestarts === 0 && udpDrops === 0 ? "var(--ok)" : "var(--crit)" }}>
                        容器重启 {maxRestarts} 次 · UDP丢包 {udpDrops}
                      </span>
                    </div>
                    <div style={{ color: "var(--text-secondary)" }}>
                      发：{lt.leg.src_device || "-"} → 收：{lt.leg.dst_device || "-"}
                    </div>
                    {lt.error && <div style={{ color: "var(--crit)" }}>节点读取异常：{lt.error}</div>}
                  </div>
                );
              })}
            </div>
          </section>

          <SyncedTimeline
            ref={chartRef}
            data={data}
            showBackupOverlay={showBackupOverlay}
            screenshotMode={screenshotMode}
          />

          <section className="signal-card" style={{ marginTop: 14 }}>
            <div className="signal-card-top">
              <strong style={{ fontSize: 14 }}>该时间窗内已记录的异常定界事件（SQLite 留证）</strong>
              <span className="badge badge-idle">{data.events.length} 条记录</span>
            </div>
            {data.events.length === 0 ? (
              <div style={{ padding: 14, color: "var(--text-muted)", fontSize: 13 }}>
                该时间窗内无异常中断或主备切换事件记录。
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>开始时间</th>
                      <th>恢复时间</th>
                      <th>节点 / 通道</th>
                      <th>级别</th>
                      <th>归因层级</th>
                      <th>自动故障定界摘要</th>
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
                            <span className={`badge ${evSev.cls}`}>{evSev.label}</span>
                          </td>
                          <td>{ev.fault_layer}</td>
                          <td>{ev.summary}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
