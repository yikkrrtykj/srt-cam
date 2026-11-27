import { useEffect, useState } from "react";
import { Check, Copy, Pencil, Plus, RefreshCw, Server, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AuditEntry, NodeLiveStatus, NodesConfigView, PeerNodeView } from "@/types";
import { api, auditActionText, formatDateTime, formatTime } from "@/api";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  nodes: NodeLiveStatus[];
  onNodesChanged: () => void;
}

function shQuote(val: string): string {
  return `'${val.replace(/'/g, `'\\''`)}'`;
}

function extractPort(apiURL: string): string {
  try {
    const u = new URL(apiURL);
    if (u.port) return u.port;
    return u.protocol === "https:" ? "443" : "80";
  } catch {
    return "18080";
  }
}

function buildPeerInstallCmd(opts: {
  nodeId: string;
  displayName: string;
  region: string;
  publicIP: string;
  apiURL: string;
  clusterToken: string;
}): string {
  const id = opts.nodeId.trim() || "vps-2";
  const name = opts.displayName.trim() || id;
  const port = extractPort(opts.apiURL.trim());
  const args = [
    `--node-id ${shQuote(id)}`,
    `--name ${shQuote(name)}`,
  ];
  if (opts.region.trim()) args.push(`--region ${shQuote(opts.region.trim())}`);
  if (opts.publicIP.trim()) args.push(`--public-ip ${shQuote(opts.publicIP.trim())}`);
  args.push(`--port ${port}`);
  if (opts.clusterToken.trim()) {
    args.push(`--cluster-token ${shQuote(opts.clusterToken.trim())}`);
  }
  args.push("--up");
  return [
    `git clone https://github.com/yikkrrtykj/srt-cam.git ~/srt-cam 2>/dev/null || (cd ~/srt-cam && git pull --ff-only origin main)`,
    `cd ~/srt-cam && docker build -f deploy/Dockerfile.camd -t srt-camd:v2 . && bash scripts/init-v2-node.sh ${args.join(" ")}`,
  ].join("\n");
}

export function NodesPage({ nodes, onNodesChanged }: Props) {
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [nodesCfg, setNodesCfg] = useState<NodesConfigView | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");

  // Edit local node dialog state
  const [localDialogOpen, setLocalDialogOpen] = useState(false);
  const [localName, setLocalName] = useState("");
  const [localRegion, setLocalRegion] = useState("");
  const [localIP, setLocalIP] = useState("");
  const [savingLocal, setSavingLocal] = useState(false);

  // Add / Edit peer server dialog state
  const [peerDialogOpen, setPeerDialogOpen] = useState(false);
  const [editingPeerId, setEditingPeerId] = useState<string | null>(null);
  const [peerNodeId, setPeerNodeId] = useState("");
  const [peerName, setPeerName] = useState("");
  const [peerRegion, setPeerRegion] = useState("");
  const [peerIP, setPeerIP] = useState("");
  const [peerURL, setPeerURL] = useState("");
  const [peerToken, setPeerToken] = useState("");
  const [savingPeer, setSavingPeer] = useState(false);

  async function loadAll() {
    setLoading(true);
    try {
      const [auditRes, cfgRes] = await Promise.all([api.auditLogs(), api.getNodesConfig()]);
      setAudits(auditRes.entries);
      setNodesCfg(cfgRes);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function copyText(key: string, label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success(`已复制${label}`);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? "" : cur)), 1600);
    } catch {
      toast.error("复制失败");
    }
  }

  function openEditLocal() {
    if (!nodesCfg) return;
    setLocalName(nodesCfg.local.display_name || nodesCfg.local.node_id);
    setLocalRegion(nodesCfg.local.region || "");
    setLocalIP(nodesCfg.local.public_ip || "");
    setLocalDialogOpen(true);
  }

  async function saveLocalNode() {
    setSavingLocal(true);
    try {
      const updated = await api.updateLocalNode({
        display_name: localName.trim(),
        region: localRegion.trim(),
        public_ip: localIP.trim(),
      });
      setNodesCfg(updated);
      setLocalDialogOpen(false);
      toast.success("本机服务器信息已更新");
      onNodesChanged();
      void loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingLocal(false);
    }
  }

  function openAddPeer() {
    const nextIdx = (nodesCfg?.peers.length ?? 0) + 2;
    setEditingPeerId(null);
    setPeerNodeId(`vps-${nextIdx}`);
    setPeerName(`VPS-${nextIdx} (备节点)`);
    setPeerRegion("");
    setPeerIP("");
    setPeerURL("");
    setPeerToken("");
    setPeerDialogOpen(true);
  }

  function openEditPeer(peer: PeerNodeView) {
    setEditingPeerId(peer.node_id);
    setPeerNodeId(peer.node_id);
    setPeerName(peer.display_name);
    setPeerRegion(peer.region);
    setPeerIP(peer.public_ip);
    setPeerURL(peer.api_url);
    setPeerToken("");
    setPeerDialogOpen(true);
  }

  async function savePeer() {
    setSavingPeer(true);
    try {
      const updated = await api.upsertPeerNode({
        node_id: peerNodeId.trim(),
        display_name: peerName.trim(),
        region: peerRegion.trim(),
        public_ip: peerIP.trim(),
        api_url: peerURL.trim(),
        api_token: peerToken.trim(),
      });
      setNodesCfg(updated);
      setPeerDialogOpen(false);
      toast.success(`服务器 ${peerNodeId.trim()} 已保存；在新服务器粘贴一键接入命令后几秒即自动上线`);
      onNodesChanged();
      void loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加服务器失败");
    } finally {
      setSavingPeer(false);
    }
  }

  async function removePeer(nodeId: string) {
    try {
      const updated = await api.deletePeerNode(nodeId);
      setNodesCfg(updated);
      toast.success(`已移除远端服务器 ${nodeId}`);
      onNodesChanged();
      void loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失败");
    }
  }

  const localId = nodesCfg?.local.node_id;
  const localToken = nodesCfg?.local.cluster_token || "";
  const peerById = new Map((nodesCfg?.peers ?? []).map((p) => [p.node_id, p]));

  const livePeerInstallCmd = buildPeerInstallCmd({
    nodeId: peerNodeId,
    displayName: peerName,
    region: peerRegion,
    publicIP: peerIP,
    apiURL: peerURL || (peerIP.trim() ? `http://${peerIP.trim()}:18080` : "http://IP:18080"),
    clusterToken: peerToken.trim() || localToken,
  });

  return (
    <div className="mx-auto max-w-[1280px] p-4 lg:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[#F1F3F6]">中转服务器与播控记录</h1>
          <p className="mt-0.5 text-[12px] text-[#8B94A5]">
            在此填入新服务器 IP 并复制一键接入命令，新机运行后自动上线并可在通道配置中分配主备路由。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openEditLocal} disabled={!nodesCfg}>
            <Pencil className="h-3.5 w-3.5" />
            编辑本机信息
          </Button>
          <Button variant="primary" size="sm" onClick={openAddPeer}>
            <Plus className="h-3.5 w-3.5" />
            添加服务器
          </Button>
        </div>
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
          {localToken && (
            <button
              type="button"
              onClick={() => void copyText("cluster-tok", "集群互联密钥", localToken)}
              className="inline-flex items-center gap-1.5 text-[11.5px] text-[#8B94A5] hover:text-[#F1F3F6] cursor-pointer"
            >
              <span>集群互联密钥：</span>
              <code className="tabular text-[#C8CFD9]">
                {localToken.slice(0, 6)}••••{localToken.slice(-4)}
              </code>
              {copiedKey === "cluster-tok" ? (
                <Check className="h-3.5 w-3.5 text-[#4ADE80]" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          )}
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
                <th className="px-3 py-2 font-medium">最近刷新</th>
                <th className="px-4 py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A1E26]">
              {nodes.map((n) => {
                const isLocal = n.node_id === localId;
                const peerMeta = peerById.get(n.node_id);
                const rowCmdKey = `cmd-${n.node_id}`;
                return (
                  <tr key={n.node_id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 font-medium text-[#F1F3F6]">
                        <span>{n.node_id}</span>
                        {isLocal && (
                          <span className="rounded border border-[#2A2F3A] bg-[#191C22] px-1.5 py-0.2 text-[10px] font-normal text-[#98A1B0]">
                            本机
                          </span>
                        )}
                      </div>
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
                      <span
                        className={n.host.udp_rcvbuf_errors > 0 ? "text-[#F87171]" : "text-[#4ADE80]"}
                      >
                        {n.host.udp_rcvbuf_errors} / {n.host.udp_in_errors}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2.5 text-[#8B94A5]">{formatTime(n.updated_at)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {isLocal ? (
                        <Button variant="ghost" size="xs" onClick={openEditLocal}>
                          编辑
                        </Button>
                      ) : peerMeta ? (
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() =>
                              void copyText(
                                rowCmdKey,
                                `${peerMeta.node_id} 一键接入命令`,
                                buildPeerInstallCmd({
                                  nodeId: peerMeta.node_id,
                                  displayName: peerMeta.display_name,
                                  region: peerMeta.region,
                                  publicIP: peerMeta.public_ip,
                                  apiURL: peerMeta.api_url,
                                  clusterToken: localToken,
                                })
                              )
                            }
                          >
                            {copiedKey === rowCmdKey ? (
                              <Check className="h-3 w-3 text-[#4ADE80]" />
                            ) : (
                              <Terminal className="h-3 w-3" />
                            )}
                            接入命令
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => openEditPeer(peerMeta)}>
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-[#F87171] hover:text-[#FCA5A5]"
                            onClick={() => void removePeer(peerMeta.node_id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
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
          <Button variant="ghost" size="xs" onClick={() => void loadAll()} disabled={loading}>
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

      {/* Dialog: Edit Local Node */}
      <Dialog open={localDialogOpen} onOpenChange={setLocalDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑本机服务器信息 ({localId})</DialogTitle>
            <DialogDescription>
              填写公网 IP 后，通道配置和监看页面将自动生成对应推流/拉流地址。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div className="space-y-1">
              <label className="text-[12px] text-[#98A1B0]">显示名称</label>
              <Input
                value={localName}
                onChange={(e) => setLocalName(e.target.value)}
                placeholder="例如：VPS-1 (洛杉矶主节点)"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-[#98A1B0]">所在机房 / 区域</label>
              <Input
                value={localRegion}
                onChange={(e) => setLocalRegion(e.target.value)}
                placeholder="例如：LosAngeles / Singapore / HongKong"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-[#98A1B0]">公网 IP</label>
              <Input
                className="tabular"
                value={localIP}
                onChange={(e) => setLocalIP(e.target.value)}
                placeholder="例如：198.51.100.11"
              />
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLocalDialogOpen(false)} disabled={savingLocal}>
              取消
            </Button>
            <Button variant="primary" onClick={saveLocalNode} disabled={savingLocal}>
              {savingLocal ? "保存中..." : "保存"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Add / Edit Remote Peer Server */}
      <Dialog open={peerDialogOpen} onOpenChange={setPeerDialogOpen}>
        <DialogContent className="max-w-[580px]">
          <DialogHeader>
            <DialogTitle>{editingPeerId ? `编辑服务器 (${editingPeerId})` : "添加中转服务器"}</DialogTitle>
            <DialogDescription>
              填好新服务器 IP 后保存，再直接复制下方自动生成的接入命令粘贴到新服务器终端运行即可自动上线。
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[12px] text-[#98A1B0]">服务器标识</label>
                <Input
                  className="tabular"
                  value={peerNodeId}
                  disabled={!!editingPeerId}
                  onChange={(e) => setPeerNodeId(e.target.value)}
                  placeholder="例如：vps-2"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] text-[#98A1B0]">显示名称</label>
                <Input
                  value={peerName}
                  onChange={(e) => setPeerName(e.target.value)}
                  placeholder="例如：香港备节点"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[12px] text-[#98A1B0]">机房 / 区域</label>
                <Input
                  value={peerRegion}
                  onChange={(e) => setPeerRegion(e.target.value)}
                  placeholder="例如：HongKong"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] text-[#98A1B0]">公网 IP</label>
                <Input
                  className="tabular"
                  value={peerIP}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPeerIP(v);
                    if (!editingPeerId && v.trim()) {
                      setPeerURL(`http://${v.trim()}:18080`);
                    }
                  }}
                  placeholder="例如：198.51.100.12"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[12px] text-[#98A1B0]">远端控制面地址</label>
                <Input
                  className="tabular"
                  value={peerURL}
                  onChange={(e) => setPeerURL(e.target.value)}
                  placeholder="http://服务器IP:18080"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] text-[#98A1B0]">
                  集群密钥（留空自动同本机）
                </label>
                <Input
                  type="password"
                  className="tabular"
                  value={peerToken}
                  onChange={(e) => setPeerToken(e.target.value)}
                  placeholder="通常留空即可"
                />
              </div>
            </div>

            {/* Live Copyable One-Click Install Command for the New VPS */}
            <div className="rounded-md border border-[#232730] bg-[#0B0D10] overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#1B1F27] bg-[#13161B] px-3 py-1.5">
                <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[#D3D8E0]">
                  <Terminal className="h-3.5 w-3.5 text-[#8B94A5]" />
                  新服务器一键接入命令（已自动填入 IP 与集群密钥）
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void copyText("modal-cmd", "新服务器接入命令", livePeerInstallCmd)}
                >
                  {copiedKey === "modal-cmd" ? (
                    <Check className="h-3 w-3 text-[#4ADE80]" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === "modal-cmd" ? "已复制" : "一键复制"}
                </Button>
              </div>
              <pre className="p-3 font-mono text-[11px] leading-relaxed text-[#B8C0CE] whitespace-pre-wrap break-all select-all m-0">
                {livePeerInstallCmd}
              </pre>
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPeerDialogOpen(false)} disabled={savingPeer}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={savePeer}
              disabled={savingPeer || !peerNodeId.trim() || !peerURL.trim()}
            >
              {savingPeer ? "保存中..." : "保存服务器"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
