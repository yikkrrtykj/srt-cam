import { useState } from "react";
import type { OverviewResponse, SignalGroupLiveView } from "../types";
import { api, formatTime, formatUptime, redundancyText, severityText } from "../api";
import { SafeRestartModal } from "../components/SafeRestartModal";

interface Props {
  overview: OverviewResponse;
  onOpenTimeline: (groupId: string) => void;
  onRefresh: () => void;
}

interface RestartTarget {
  nodeId: string;
  nodeName: string;
  channelId: string;
  signalName: string;
}

export function OverviewPage({ overview, onOpenTimeline, onRefresh }: Props) {
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testingFeishu, setTestingFeishu] = useState(false);

  const venueToHub = overview.groups.filter((g) => g.direction === "venue_to_hub");
  const hubToVenue = overview.groups.filter((g) => g.direction === "hub_to_venue");

  const activeGroups = overview.groups.filter((g) => g.expected_active);
  const protectedCount = activeGroups.filter((g) => g.severity === "DEGRADED_PROTECTED").length;
  const criticalCount = activeGroups.filter((g) => g.severity === "CRITICAL_OUTAGE").length;
  const onlineNodes = overview.nodes.filter((n) => n.online).length;

  async function handleToggleActive(grp: SignalGroupLiveView) {
    try {
      await api.toggleExpectedActive(grp.id, !grp.expected_active);
      setToast({
        kind: "ok",
        text: `已将 ${grp.name} 设为「${!grp.expected_active ? "本场开播（开启告警）" : "待机（静默）"}」`,
      });
      onRefresh();
    } catch (err) {
      setToast({ kind: "err", text: err instanceof Error ? err.message : "切换失败" });
    }
  }

  async function handleTestFeishu() {
    setTestingFeishu(true);
    try {
      await api.testFeishu();
      setToast({ kind: "ok", text: "已向飞书群发送连通测试卡片，请查看飞书消息。" });
    } catch (err) {
      setToast({ kind: "err", text: err instanceof Error ? err.message : "发送失败" });
    } finally {
      setTestingFeishu(false);
    }
  }

  function renderGroupCard(grp: SignalGroupLiveView) {
    const sev = severityText(grp.severity);
    return (
      <article key={grp.id} className="signal-card">
        <div className="signal-card-top">
          <div className="signal-identity">
            <span className="signal-name">{grp.name}</span>
            <span className={`badge ${sev.cls}`}>{sev.label}</span>
            <span className="badge badge-brand">{redundancyText(grp.redundancy_type)}</span>
            {grp.notes && (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{grp.notes}</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label className="toggle-label" title="勾选后，该信号中断将触发自动故障定界与飞书告警">
              <input
                type="checkbox"
                checked={grp.expected_active}
                onChange={() => handleToggleActive(grp)}
              />
              本场开播
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onOpenTimeline(grp.id)}
            >
              4 层同步时间轴 / 留证
            </button>
          </div>
        </div>

        <div className={`signal-summary-bar sev-${grp.severity}`}>
          <span>
            <strong>自动定界：</strong>
            {grp.summary}
          </span>
          {grp.protected_by && (
            <span className="badge badge-ok">兜底：{grp.protected_by}</span>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>角色 / 运营商</th>
                <th>云端节点 & 通道</th>
                <th>模式</th>
                <th>发端 → 收端设备</th>
                <th>入 / 出码率</th>
                <th>上游 / 下游 RTT</th>
                <th>丢包 · 重传 · NAK</th>
                <th>路径 / 云端状态</th>
                <th style={{ textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {grp.legs.map((leg) => {
                const s = leg.sample;
                const roleLabel =
                  leg.role === "primary" ? "主路" : leg.role === "backup" ? "备路" : "单路";
                const legBad =
                  !leg.node_online ||
                  (s.fault_code !== "HEALTHY" &&
                    s.fault_code !== "IDLE_EXPECTED_OFF" &&
                    s.fault_code !== "TUNNEL_LO_WARNING");
                return (
                  <tr key={`${leg.node_id}-${leg.channel_id}`}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          className={`dot ${
                            !leg.node_online || s.fault_code === "UPSTREAM_OFFLINE" || s.fault_code === "CLOUD_PROCESS_DOWN"
                              ? "dot-crit"
                              : legBad
                              ? "dot-warn"
                              : s.fault_code === "IDLE_EXPECTED_OFF"
                              ? "dot-idle"
                              : "dot-ok"
                          }`}
                        />
                        <strong>{roleLabel}</strong>
                        {leg.carrier && <span className="badge badge-idle">{leg.carrier}</span>}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      <div>
                        <strong>{leg.node_id}</strong> / {leg.channel_id}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {leg.mode === "udp-passthrough"
                          ? `UDP :${leg.in_port} → ${leg.target_addr || ":" + leg.out_port}`
                          : `入 :${leg.in_port} / 出 :${leg.out_port}`}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${leg.mode === "udp-passthrough" ? "badge-brand" : "badge-idle"}`}>
                        {leg.mode === "udp-passthrough" ? "Mode B 透传" : "Mode A 中转"}
                      </span>
                    </td>
                    <td>
                      <div className="device-stack">
                        <span>发：{leg.src_device || "-"}</span>
                        <span className="device-arrow">收：{leg.dst_device || "-"}</span>
                      </div>
                    </td>
                    <td className="mono">
                      <div>入 {s.src_mbps.toFixed(2)} Mb/s</div>
                      <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                        出 {s.dst_mbps.toFixed(2)} Mb/s
                      </div>
                    </td>
                    <td className="mono">
                      {leg.mode === "udp-passthrough" ? (
                        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>端到端透传</span>
                      ) : (
                        <>
                          <div>上 {s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)}ms` : "-"}</div>
                          <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                            下 {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)}ms` : "-"}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {leg.mode === "udp-passthrough" ? (
                        <div>
                          重传 {s.src_retrans} · NAK {s.dst_nak_count}
                        </div>
                      ) : (
                        <>
                          <div>
                            上 丢{s.src_lost}/重{s.src_retrans}/弃{s.src_dropped}
                          </div>
                          <div style={{ color: "var(--text-secondary)" }}>
                            下 丢{s.dst_lost}/重{s.dst_retrans}/弃{s.dst_dropped}
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
                        <div>
                          <span
                            className={`badge ${
                              s.path_medium.includes("LO") ? "badge-warn" : "badge-idle"
                            }`}
                          >
                            {s.path_medium || "-"}
                          </span>{" "}
                          <span className="mono" style={{ color: "var(--text-secondary)" }}>
                            {s.process_state}
                          </span>
                        </div>
                        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                          重启 {s.restart_count} 次 · 运行 {formatUptime(s.uptime_sec)}
                        </span>
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          setRestartTarget({
                            nodeId: leg.node_id,
                            nodeName: leg.node_name,
                            channelId: leg.channel_id,
                            signalName: grp.name,
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
      </article>
    );
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>{overview.event_name || "双向 SRT 信号总览"}</h1>
          <p className="page-subtitle">
            {overview.sites.venue || "现场"} ↔ {overview.sites.hub || "远程制作中心"} · 最近采样{" "}
            <span className="mono">{formatTime(overview.updated_at)}</span>
            {overview.demo_mode && " · 当前为离线演示模式（模拟 3 VPS 双向与电信/联通主备切换）"}
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn"
            onClick={handleTestFeishu}
            disabled={testingFeishu}
          >
            {testingFeishu ? "发送中..." : "测试飞书告警"}
          </button>
          <button type="button" className="btn" onClick={onRefresh}>
            立即刷新
          </button>
        </div>
      </header>

      {toast && (
        <div className={`notice-bar ${toast.kind === "ok" ? "notice-ok" : "notice-err"}`}>
          {toast.text}
        </div>
      )}

      <section className="kpi-grid" aria-label="关键运行指标">
        <div className="kpi-card">
          <div className="kpi-label">本场开播信号组</div>
          <div className="kpi-value">{activeGroups.length} / {overview.groups.length}</div>
          <div className="kpi-hint">仅勾选“本场开播”的信号触发飞书告警</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">单路异常 · 备路兜底中</div>
          <div className="kpi-value" style={{ color: protectedCount > 0 ? "var(--warn)" : "var(--ok)" }}>
            {protectedCount}
          </div>
          <div className="kpi-hint">主备冗余生效，直播画面未中断</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">紧急断播 / 双路全断</div>
          <div className="kpi-value" style={{ color: criticalCount > 0 ? "var(--crit)" : "var(--ok)" }}>
            {criticalCount}
          </div>
          <div className="kpi-hint">点击对应信号可立即进入 4 层时间轴定责</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">云端中转节点在线</div>
          <div className="kpi-value">{onlineNodes} / {overview.nodes.length}</div>
          <div className="kpi-hint">支持任意 N 台 VPS 聚合观测与各自独立兜底告警</div>
        </div>
      </section>

      <section className="dir-section">
        <div className="dir-header">
          <h2 className="dir-title">
            <span>{overview.sites.venue || "现场"} → {overview.sites.hub || "远程制作中心"}</span>
            <span className="badge badge-idle">{venueToHub.length} 组信号</span>
          </h2>
        </div>
        <div className="group-list">
          {venueToHub.length === 0 ? (
            <div className="kpi-card" style={{ color: "var(--text-muted)" }}>
              暂无该方向的信号配置，可在「场次信号表」中添加。
            </div>
          ) : (
            venueToHub.map(renderGroupCard)
          )}
        </div>
      </section>

      <section className="dir-section">
        <div className="dir-header">
          <h2 className="dir-title">
            <span>{overview.sites.hub || "远程制作中心"} → {overview.sites.venue || "现场"}</span>
            <span className="badge badge-idle">{hubToVenue.length} 组信号</span>
          </h2>
        </div>
        <div className="group-list">
          {hubToVenue.length === 0 ? (
            <div className="kpi-card" style={{ color: "var(--text-muted)" }}>
              暂无返送方向的信号配置，可在「场次信号表」中添加。
            </div>
          ) : (
            hubToVenue.map(renderGroupCard)
          )}
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
