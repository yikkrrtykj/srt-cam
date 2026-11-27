import { useEffect, useState } from "react";
import type { AuditEntry, NodeLiveStatus } from "../types";
import { api, auditActionText, formatDateTime, formatTime } from "../api";

interface Props {
  nodes: NodeLiveStatus[];
}

export function NodesPage({ nodes }: Props) {
  const [audits, setAudits] = useState<AuditEntry[]>([]);

  useEffect(() => {
    api
      .auditLogs()
      .then((res) => setAudits(res.entries))
      .catch(() => {});
  }, []);

  return (
    <div>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">中转服务器 ({nodes.length})</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="gw-table">
            <thead>
              <tr>
                <th>服务器</th>
                <th>机房 / 公网 IP</th>
                <th>在线状态</th>
                <th>CPU / 内存</th>
                <th>实时带宽 (收 / 发)</th>
                <th>系统收包丢包</th>
                <th>最近刷新</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.node_id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{n.node_id}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{n.display_name}</div>
                  </td>
                  <td className="mono">
                    <div>{n.region || "-"}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{n.public_ip || "-"}</div>
                  </td>
                  <td>
                    <span className={`pill ${n.online ? "pill-ok" : "pill-crit"}`}>
                      <span className={`dot ${n.online ? "dot-ok" : "dot-crit"}`} />
                      {n.online ? "在线" : n.error || "离线"}
                    </span>
                  </td>
                  <td className="mono">
                    {n.host.cpu_percent.toFixed(1)}% / {n.host.mem_percent.toFixed(1)}%
                  </td>
                  <td className="mono">
                    {n.host.net_rx_mbps.toFixed(1)} / {n.host.net_tx_mbps.toFixed(1)} Mb/s
                  </td>
                  <td className="mono">
                    <span style={{ color: n.host.udp_rcvbuf_errors > 0 ? "var(--crit)" : "var(--ok)" }}>
                      {n.host.udp_rcvbuf_errors} / {n.host.udp_in_errors}
                    </span>
                  </td>
                  <td className="mono">{formatTime(n.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">播控操作记录 ({audits.length})</span>
        </div>
        {audits.length === 0 ? (
          <div style={{ padding: 14, color: "var(--text-muted)", fontSize: 12 }}>暂无操作记录</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="gw-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作员</th>
                  <th>服务器</th>
                  <th>操作类型</th>
                  <th>目标通道</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{formatDateTime(a.ts)}</td>
                    <td>{a.username}</td>
                    <td className="mono">{a.node_id}</td>
                    <td>
                      <span className="pill pill-idle">{auditActionText(a.action)}</span>
                    </td>
                    <td className="mono">{a.target}</td>
                    <td>{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
