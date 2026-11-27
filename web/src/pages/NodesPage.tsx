import { useEffect, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
import type { AuditEntry, NodeLiveStatus } from "@/types";
import { api, auditActionText, formatDateTime, formatTime } from "@/api";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  nodes: NodeLiveStatus[];
}

export function NodesPage({ nodes }: Props) {
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadAudit() {
    setLoading(true);
    try {
      const res = await api.auditLogs();
      setAudits(res.entries);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAudit();
  }, []);

  return (
    <div className="mx-auto max-w-[1280px] p-4 lg:p-6 space-y-5">
      <div>
        <h1 className="text-[16px] font-semibold text-[#F1F3F6]">中转服务器与播控记录</h1>
        <p className="mt-0.5 text-[12px] text-[#8B94A5]">
          查看各中转服务器的实时负载、网卡收发带宽、内核 UDP 缓冲状态以及播控操作审计记录。
        </p>
      </div>

      {/* Relay Servers Table */}
      <section className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-[#98A1B0]" />
            <h2 className="text-[13px] font-medium text-[#F1F3F6]">
              中转服务器 ({nodes.length})
            </h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="border-b border-[#1E222B] text-[11px] text-[#757E8F]">
              <tr>
                <th className="px-4 py-2 font-medium">服务器</th>
                <th className="px-3 py-2 font-medium">机房 / 公网 IP</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">CPU / 内存</th>
                <th className="px-3 py-2 font-medium">实时带宽 (收 / 发)</th>
                <th className="px-3 py-2 font-medium">系统 UDP 丢包</th>
                <th className="px-4 py-2 font-medium text-right">最近刷新</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A1E26]">
              {nodes.map((n) => (
                <tr key={n.node_id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-[#F1F3F6]">{n.node_id}</div>
                    <div className="text-[11px] text-[#757E8F]">{n.display_name}</div>
                  </td>
                  <td className="tabular px-3 py-2.5">
                    <div className="text-[#D3D8E0]">{n.region || "-"}</div>
                    <div className="text-[11px] text-[#757E8F]">{n.public_ip || "-"}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge tone={n.online ? "ok" : "crit"} showDot>
                      {n.online ? "在线" : n.error || "离线"}
                    </StatusBadge>
                  </td>
                  <td className="tabular px-3 py-2.5 text-[#D3D8E0]">
                    {n.host.cpu_percent.toFixed(1)}% / {n.host.mem_percent.toFixed(1)}%
                  </td>
                  <td className="tabular px-3 py-2.5 text-[#D3D8E0]">
                    {n.host.net_rx_mbps.toFixed(1)} / {n.host.net_tx_mbps.toFixed(1)} Mb/s
                  </td>
                  <td className="tabular px-3 py-2.5">
                    <span className={n.host.udp_rcvbuf_errors > 0 ? "text-[#F87171]" : "text-[#4ADE80]"}>
                      {n.host.udp_rcvbuf_errors} / {n.host.udp_in_errors}
                    </span>
                  </td>
                  <td className="tabular px-4 py-2.5 text-right text-[#8B94A5]">
                    {formatTime(n.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Broadcast Operation Audit Logs */}
      <section className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-[#F1F3F6]">
            播控操作记录 ({audits.length})
          </h2>
          <Button variant="ghost" size="xs" onClick={() => void loadAudit()} disabled={loading}>
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
        {audits.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-[#6B7485]">暂无操作记录</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="border-b border-[#1E222B] text-[11px] text-[#757E8F]">
                <tr>
                  <th className="px-4 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">操作员</th>
                  <th className="px-3 py-2 font-medium">服务器</th>
                  <th className="px-3 py-2 font-medium">操作类型</th>
                  <th className="px-3 py-2 font-medium">目标</th>
                  <th className="px-4 py-2 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A1E26]">
                {audits.map((a) => (
                  <tr key={a.id} className="hover:bg-white/[0.02]">
                    <td className="tabular px-4 py-2 text-[#C8CFD9] whitespace-nowrap">
                      {formatDateTime(a.ts)}
                    </td>
                    <td className="px-3 py-2 text-[#D3D8E0] whitespace-nowrap">{a.username}</td>
                    <td className="tabular px-3 py-2 text-[#98A1B0] whitespace-nowrap">
                      {a.node_id}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge tone="idle">{auditActionText(a.action)}</StatusBadge>
                    </td>
                    <td className="tabular px-3 py-2 text-[#C8CFD9] whitespace-nowrap">
                      {a.target}
                    </td>
                    <td className="px-4 py-2 text-[#D3D8E0]">{a.detail}</td>
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
