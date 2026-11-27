import type { LegLiveView, SignalGroupLiveView } from "../types";
import { formatUptime } from "../api";

export interface LegWindowStats {
  maxRestarts: number;
  udpDrops: number;
}

interface Props {
  group: SignalGroupLiveView;
  legStats?: Record<string, LegWindowStats>;
  compact?: boolean;
  onOpenRoute?: (groupId: string) => void;
  onRestartLeg?: (leg: LegLiveView) => void;
}

function legStatusClass(leg: LegLiveView): { dot: string; tone: "ok" | "warn" | "crit" | "idle" } {
  if (!leg.node_online) return { dot: "dot-crit", tone: "crit" };
  switch (leg.sample.fault_code) {
    case "HEALTHY":
      return { dot: "dot-ok", tone: "ok" };
    case "IDLE_EXPECTED_OFF":
      return { dot: "dot-idle", tone: "idle" };
    case "DOWNSTREAM_OFFLINE":
      return { dot: "dot-warn", tone: "warn" };
    case "UPSTREAM_OFFLINE":
    case "CLOUD_PROCESS_DOWN":
    case "NODE_UNREACHABLE":
      return { dot: "dot-crit", tone: "crit" };
    default:
      return { dot: "dot-warn", tone: "warn" };
  }
}

function roleLabel(role: string): string {
  if (role === "primary") return "主路";
  if (role === "backup") return "备路";
  return "单路";
}

function connBadge(connected: boolean, mbps: number, awaiting = false): { label: string; cls: string } {
  if (connected && mbps >= 0.1) return { label: "正常", cls: "pill-ok" };
  if (awaiting) return { label: "待拉流", cls: "pill-warn" };
  if (connected) return { label: "待机", cls: "pill-idle" };
  return { label: "断开", cls: "pill-crit" };
}

function dropTone(dropped: number, flowing: boolean): string {
  if (dropped > 0) return "loss-cell-crit";
  if (flowing) return "loss-cell-ok";
  return "";
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function SignalHealthPanel({
  group,
  legStats,
  compact = false,
  onOpenRoute,
  onRestartLeg,
}: Props) {
  return (
    <div className={`health-panel ${compact ? "is-compact" : ""}`}>
      <div className="health-legs">
        {group.legs.map((leg) => {
          const s = leg.sample;
          const key = `${leg.node_id}/${leg.channel_id}`;
          const st = legStatusClass(leg);
          const isPass = leg.mode === "udp-passthrough";
          const srcFlowing = s.src_mbps >= 0.1;
          const dstFlowing = s.dst_mbps >= 0.1;

          const win = legStats?.[key];
          const restarts = win ? Math.max(win.maxRestarts, s.restart_count) : s.restart_count;
          const udpDrops = win ? win.udpDrops : leg.host.udp_rcvbuf_errors;

          // SRT buffer margin: Haivision 4×RTT rule
          const hasTSBPD = !isPass && s.src_tsbpd_ms > 0;
          const fourXRTT = s.src_rtt_ms * 4;
          const marginPct = hasTSBPD ? Math.round((fourXRTT / s.src_tsbpd_ms) * 100) : 0;
          const marginLevel =
            marginPct > 100 ? "crit" : marginPct >= 75 ? "warn" : "ok";

          // Destination RTT bar (relative to 250ms high-RTT threshold)
          const dstRttPct = Math.min(100, Math.round((s.dst_rtt_ms / 250) * 100));
          const dstRttLevel =
            s.dst_rtt_ms >= 250 ? "crit" : s.dst_rtt_ms >= 100 ? "warn" : "ok";

          const srcBadge = connBadge(s.src_connected, s.src_mbps);
          const dstBadge = connBadge(
            s.dst_connected,
            s.dst_mbps,
            s.fault_code === "DOWNSTREAM_OFFLINE"
          );

          return (
            <div key={key} className={`health-leg-card tone-${st.tone}`}>
              <div className="health-leg-head">
                <div className="health-leg-ident">
                  <span className={`dot ${st.dot}`} />
                  <span className="health-leg-role">
                    {roleLabel(leg.role)}
                    {leg.carrier ? ` · ${leg.carrier}` : ""}
                  </span>
                  <span className="pill pill-idle">{isPass ? "加密透传" : "标准中转"}</span>
                  {s.encrypted && (
                    <span className="pill pill-accent" title="SRT 端到端加密传输">
                      <LockIcon />
                      加密
                    </span>
                  )}
                  {s.path_medium && s.path_medium !== "-" && (
                    <span className={`pill ${s.path_medium.includes("LO") ? "pill-warn" : "pill-idle"}`}>
                      {s.path_medium}
                    </span>
                  )}
                  {!leg.node_online && <span className="pill pill-crit">服务器离线</span>}
                </div>

                <div className="health-leg-right">
                  <span className={`health-fault-text tone-${st.tone}`}>{s.fault_summary || "-"}</span>
                  {onRestartLeg && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRestartLeg(leg);
                      }}
                    >
                      重置通道
                    </button>
                  )}
                </div>
              </div>

              <div className="health-flow-grid">
                {/* Stage 1: SOURCE */}
                <div className="health-stage">
                  <div className="health-stage-head">
                    <span>推流端 · 发端</span>
                    <span className={`pill ${srcBadge.cls}`}>{srcBadge.label}</span>
                  </div>

                  <div className="health-device">{leg.src_device || "发端编码器"}</div>
                  <div className="health-meta mono">
                    <span>IP {s.src_peer_ip || "-"}</span>
                    <span>{s.src_mbps.toFixed(2)} Mb/s</span>
                    {!isPass && <span>时延 {s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)}ms` : "-"}</span>}
                  </div>

                  {!isPass ? (
                    <>
                      <div className="margin-wrap">
                        <div className="margin-head">
                          <span>缓冲余量 (4×时延 / 设定缓冲)</span>
                          <span className={`mono margin-val-${hasTSBPD && srcFlowing ? marginLevel : "idle"}`}>
                            {hasTSBPD
                              ? `${fourXRTT.toFixed(0)} / ${s.src_tsbpd_ms.toFixed(0)}ms (${marginPct}%)`
                              : "暂无缓冲数据"}
                          </span>
                        </div>
                        <div className="margin-track" role="progressbar" aria-valuenow={Math.min(100, marginPct)} aria-valuemin={0} aria-valuemax={100}>
                          <div
                            className={`margin-fill fill-${hasTSBPD && srcFlowing ? marginLevel : "idle"}`}
                            style={{ width: `${hasTSBPD && srcFlowing ? Math.min(100, marginPct) : 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="loss-trio">
                        <div className="loss-cell">
                          <span className="loss-label">网络丢包</span>
                          <span className="loss-val mono">{s.src_lost}</span>
                        </div>
                        <div className={`loss-cell ${s.src_retrans > 0 && s.src_dropped === 0 ? "loss-cell-recovered" : ""}`}>
                          <span className="loss-label">重传救回</span>
                          <span className="loss-val mono">{s.src_retrans}</span>
                        </div>
                        <div className={`loss-cell ${dropTone(s.src_dropped, srcFlowing)}`}>
                          <span className="loss-label">未恢复弃包</span>
                          <span className="loss-val mono">{s.src_dropped}</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="pass-note">
                      <div>端到端加密直通透传 · 不解密视频载荷，由编解码器直接协商缓冲</div>
                      <div className="mono" style={{ marginTop: 4, color: "var(--text-secondary)" }}>
                        监听 :{leg.in_port} → 目标 {leg.target_addr || s.dst_peer_ip || "-"}
                      </div>
                    </div>
                  )}
                </div>

                <div className="health-arrow" aria-hidden="true">→</div>

                {/* Stage 2: GATEWAY */}
                <div className="health-stage health-stage-gw">
                  <div className="health-stage-head">
                    <span>中转服务器</span>
                    <span className="mono">{leg.node_id}</span>
                  </div>

                  <div className="health-device mono">
                    {leg.channel_id}{" "}
                    <span style={{ color: "var(--text-muted)", fontWeight: 400, fontSize: 11 }}>
                      (:{leg.in_port}
                      {!isPass ? `→:${leg.out_port}` : ""})
                    </span>
                  </div>

                  <div className="gw-kv-grid mono">
                    <div className="gw-kv">
                      <span>通道状态</span>
                      <strong style={{ color: s.process_state === "running" ? "var(--ok)" : "var(--crit)" }}>
                        {s.process_state === "running" ? "运行中" : s.process_state || "-"}
                      </strong>
                    </div>
                    <div className="gw-kv">
                      <span>异常重启</span>
                      <strong style={{ color: restarts === 0 ? "var(--ok)" : "var(--crit)" }}>
                        {restarts} 次
                      </strong>
                    </div>
                    <div className="gw-kv">
                      <span>持续运行</span>
                      <strong>{formatUptime(s.uptime_sec)}</strong>
                    </div>
                    <div className="gw-kv">
                      <span>系统缓冲丢包</span>
                      <strong style={{ color: udpDrops === 0 ? "var(--ok)" : "var(--crit)" }}>
                        {udpDrops}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="health-arrow" aria-hidden="true">→</div>

                {/* Stage 3: DESTINATION */}
                <div className="health-stage">
                  <div className="health-stage-head">
                    <span>拉流端 · 收端</span>
                    <span className={`pill ${dstBadge.cls}`}>{dstBadge.label}</span>
                  </div>

                  <div className="health-device">{leg.dst_device || "收端解码器"}</div>
                  <div className="health-meta mono">
                    <span>IP {s.dst_peer_ip || leg.target_addr || "-"}</span>
                    <span>{s.dst_mbps.toFixed(2)} Mb/s</span>
                    {!isPass && <span>时延 {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)}ms` : "-"}</span>}
                  </div>

                  {!isPass ? (
                    <>
                      <div className="margin-wrap">
                        <div className="margin-head">
                          <span>拉流时延 (告警阈值 250ms)</span>
                          <span className={`mono margin-val-${dstFlowing && s.dst_rtt_ms > 0 ? dstRttLevel : "idle"}`}>
                            {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)} ms` : "-"}
                          </span>
                        </div>
                        <div className="margin-track">
                          <div
                            className={`margin-fill fill-${dstFlowing && s.dst_rtt_ms > 0 ? dstRttLevel : "idle"}`}
                            style={{ width: `${dstFlowing && s.dst_rtt_ms > 0 ? dstRttPct : 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="loss-trio">
                        <div className="loss-cell">
                          <span className="loss-label">网络丢包</span>
                          <span className="loss-val mono">{s.dst_lost}</span>
                        </div>
                        <div className={`loss-cell ${s.dst_retrans > 0 && s.dst_dropped === 0 ? "loss-cell-recovered" : ""}`}>
                          <span className="loss-label">重传救回</span>
                          <span className="loss-val mono">{s.dst_retrans}</span>
                        </div>
                        <div className={`loss-cell ${dropTone(s.dst_dropped, dstFlowing)}`}>
                          <span className="loss-label">未恢复弃包</span>
                          <span className="loss-val mono">{s.dst_dropped}</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="margin-wrap">
                        <div className="margin-head">
                          <span>SRT 协议头监测（透传模式）</span>
                          <span className={`mono margin-val-${s.src_dropped > 0 ? "crit" : srcFlowing ? "ok" : "idle"}`}>
                            {s.src_dropped > 0 ? `弃包 ${s.src_dropped}` : srcFlowing ? "无弃包" : "-"}
                          </span>
                        </div>
                      </div>

                      <div className="loss-trio">
                        <div className="loss-cell">
                          <span className="loss-label">请求重发</span>
                          <span className="loss-val mono">{s.dst_nak_count}</span>
                        </div>
                        <div className={`loss-cell ${s.src_retrans > 0 && s.src_dropped === 0 ? "loss-cell-recovered" : ""}`}>
                          <span className="loss-label">重传救回</span>
                          <span className="loss-val mono">{s.src_retrans}</span>
                        </div>
                        <div className={`loss-cell ${dropTone(s.src_dropped, srcFlowing)}`}>
                          <span className="loss-label">未恢复弃包</span>
                          <span className="loss-val mono">{s.src_dropped}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {compact && onOpenRoute && (
        <div className="health-compact-foot">
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
            当前状态：{group.summary}
          </span>
          <button
            type="button"
            className="btn btn-xs btn-primary"
            onClick={(e) => {
              e.stopPropagation();
              onOpenRoute(group.id);
            }}
          >
            打开信号详情与通信记录 →
          </button>
        </div>
      )}
    </div>
  );
}
