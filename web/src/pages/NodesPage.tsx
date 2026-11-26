import { useEffect, useState } from "react";
import type { AuditEntry, NodeLiveStatus } from "../types";
import { api, formatDateTime, formatTime } from "../api";

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
      <header className="page-header">
        <div>
          <h1>多 VPS 节点健康与操作审计</h1>
          <p className="page-subtitle">
            实时观测全部云端中转节点的宿主机资源、Linux 内核 UDP 缓冲区丢包（/proc/net/snmp）与单路重启审计记录
          </p>
        </div>
      </header>

      <section className="signal-card" style={{ marginBottom: 20 }}>
        <div className="signal-card-top">
          <strong>云端节点集群状态（共 {nodes.length} 台）</strong>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>节点 ID / 名称</th>
                <th>区域 / 公网 IP</th>
                <th>连通状态</th>
                <th>CPU / 内存</th>
                <th>宿主机网卡吞吐</th>
                <th>内核 UDP 丢包 (Rcvbuf / In)</th>
                <th>最近同步</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.node_id}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{n.node_id}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{n.display_name}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    <div>{n.region || "-"}</div>
                    <div style={{ color: "var(--text-muted)" }}>{n.public_ip || "-"}</div>
                  </td>
                  <td>
                    <span className={`badge ${n.online ? "badge-ok" : "badge-crit"}`}>
                      {n.online ? "在线" : `失联 (${n.error || "超时"})`}
                    </span>
                  </td>
                  <td className="mono">
                    CPU {n.host.cpu_percent.toFixed(1)}% · Mem {n.host.mem_percent.toFixed(1)}%
                  </td>
                  <td className="mono">
                    Rx {n.host.net_rx_mbps.toFixed(1)} / Tx {n.host.net_tx_mbps.toFixed(1)} Mb/s
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

      <section className="signal-card">
        <div className="signal-card-top">
          <strong>操作审计日志（单路重启 / 配置变更留痕）</strong>
          <span className="badge badge-idle">{audits.length} 条</span>
        </div>
        {audits.length === 0 ? (
          <div style={{ padding: 14, color: "var(--text-muted)", fontSize: 13 }}>暂无操作记录。</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>节点</th>
                  <th>动作</th>
                  <th>目标</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{formatDateTime(a.ts)}</td>
                    <td>{a.username}</td>
                    <td className="mono">{a.node_id}</td>
                    <td>
                      <span className="badge badge-idle">{a.action}</span>
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
