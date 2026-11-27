import { useEffect, useState } from "react";
import { Check, Copy, Download, HelpCircle, Plus, Save, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { EventSheet, LegConfig, NodeLiveStatus, SignalGroupConfig } from "@/types";
import { api, resolveNodeHost } from "@/api";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  nodes: NodeLiveStatus[];
  onSaved: () => void;
}

const RELAY_PRESETS = Array.from({ length: 10 }, (_, idx) => {
  const n = idx + 1;
  return {
    channel_id: `srt-cam${n}`,
    label: `通道 ${n} (推 ${20000 + n} → 拉 ${21000 + n})`,
    mode: "srt-relay" as const,
    in_port: 20000 + n,
    out_port: 21000 + n,
  };
});

const PASS_PRESETS = Array.from({ length: 4 }, (_, idx) => {
  const n = idx + 1;
  return {
    channel_id: `srt-pass${n}`,
    label: `透传通道 ${n} (VPS 监听 ${31110 + n})`,
    mode: "udp-passthrough" as const,
    in_port: 31110 + n,
    out_port: 41110 + n,
    metrics_port: 19100 + n,
  };
});

const ALL_PRESETS = [...RELAY_PRESETS, ...PASS_PRESETS];

function parsePortSuffix(addr: string): number | null {
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return null;
  const p = Number(addr.slice(idx + 1).trim());
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

function buildPassRunCmd(leg: LegConfig): string {
  const preset = PASS_PRESETS.find((p) => p.channel_id === leg.channel_id);
  const metricsPort = preset?.metrics_port ?? 19101;
  const target = leg.target_addr?.trim() || `<演播室公网IP>:${leg.out_port || 41111}`;
  return [
    `cd ~/srt-cam && docker build -f deploy/Dockerfile.pass -t local-srt-pass:v2 .`,
    `docker rm -f ${leg.channel_id} 2>/dev/null || true`,
    `docker run -d --name ${leg.channel_id} --restart always --network host local-srt-pass:v2 --id=${leg.channel_id} --listen=:${leg.in_port} --target=${target} --metrics=127.0.0.1:${metricsPort}`,
  ].join("\n");
}

export function EventSheetPage({ nodes, onSaved }: Props) {
  const [sheet, setSheet] = useState<EventSheet | null>(null);
  const [saving, setSaving] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");

  const defaultNodeId = nodes[0]?.node_id || "vps-1";

  useEffect(() => {
    api
      .getEventSheet()
      .then((s) => setSheet(s))
      .catch((err) => toast.error(err instanceof Error ? err.message : "加载通道配置失败"));
  }, []);

  async function handleSave() {
    if (!sheet) return;
    for (const grp of sheet.signal_groups) {
      const seen = new Set<string>();
      for (const leg of grp.legs) {
        const key = `${leg.node_id}/${leg.channel_id}`;
        if (seen.has(key)) {
          toast.error(`信号「${grp.name}」的主备链路不能使用同一服务器的同一通道（${key}）`);
          return;
        }
        seen.add(key);
        if (leg.mode === "udp-passthrough" && !leg.target_addr?.trim()) {
          toast.error(`信号「${grp.name}」选择了加密透传，请填写演播室解码器的公网 IP:端口`);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const saved = await api.saveEventSheet(sheet);
      setSheet(saved);
      toast.success("通道配置已保存并立即生效");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function handleExportJSON() {
    if (!sheet) return;
    const blob = new Blob([JSON.stringify(sheet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `通道配置-${sheet.event_name || "srt-cam"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyText(key: string, label: string, text: string) {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      toast.success(`已复制${label}`);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? "" : cur)), 1500);
    } else {
      toast.error("复制失败");
    }
  }

  function updateGroup(idx: number, patch: Partial<SignalGroupConfig>) {
    if (!sheet) return;
    const next = { ...sheet, signal_groups: [...sheet.signal_groups] };
    next.signal_groups[idx] = { ...next.signal_groups[idx], ...patch };
    setSheet(next);
  }

  function updateLeg(gIdx: number, lIdx: number, patch: Partial<LegConfig>) {
    if (!sheet) return;
    const next = { ...sheet, signal_groups: [...sheet.signal_groups] };
    const legs = [...next.signal_groups[gIdx].legs];
    legs[lIdx] = { ...legs[lIdx], ...patch };
    next.signal_groups[gIdx] = { ...next.signal_groups[gIdx], legs };
    setSheet(next);
  }

  function updateDualLegRole(gIdx: number, lIdx: number, nextRole: "primary" | "backup") {
    if (!sheet) return;
    const grp = sheet.signal_groups[gIdx];
    if (grp.legs.length !== 2) return;
    const otherRole = nextRole === "primary" ? "backup" : "primary";
    const legs = grp.legs.map((leg, i) => ({
      ...leg,
      role: i === lIdx ? nextRole : otherRole,
    }));
    updateGroup(gIdx, { legs });
  }

  function handlePresetChannel(gIdx: number, lIdx: number, channelId: string) {
    const preset = ALL_PRESETS.find((p) => p.channel_id === channelId);
    if (preset) {
      updateLeg(gIdx, lIdx, {
        channel_id: preset.channel_id,
        mode: preset.mode,
        in_port: preset.in_port,
        out_port: preset.out_port,
      });
    } else {
      updateLeg(gIdx, lIdx, { channel_id: channelId });
    }
  }

  function handleModeChange(gIdx: number, lIdx: number, nextMode: LegConfig["mode"]) {
    if (!sheet) return;
    const leg = sheet.signal_groups[gIdx].legs[lIdx];
    const usedOnNode = new Set(
      sheet.signal_groups.flatMap((g) =>
        g.legs.filter((l) => l.node_id === leg.node_id).map((l) => l.channel_id)
      )
    );

    if (nextMode === "udp-passthrough") {
      const alreadyPass = PASS_PRESETS.some((p) => p.channel_id === leg.channel_id);
      if (alreadyPass) {
        updateLeg(gIdx, lIdx, { mode: nextMode });
        return;
      }
      const preset = PASS_PRESETS.find((p) => !usedOnNode.has(p.channel_id)) ?? PASS_PRESETS[0];
      updateLeg(gIdx, lIdx, {
        mode: nextMode,
        channel_id: preset.channel_id,
        in_port: preset.in_port,
        out_port: preset.out_port,
      });
    } else {
      const alreadyRelay = RELAY_PRESETS.some((p) => p.channel_id === leg.channel_id);
      if (alreadyRelay) {
        updateLeg(gIdx, lIdx, { mode: nextMode, target_addr: "" });
        return;
      }
      const preset = RELAY_PRESETS.find((p) => !usedOnNode.has(p.channel_id)) ?? RELAY_PRESETS[0];
      updateLeg(gIdx, lIdx, {
        mode: nextMode,
        channel_id: preset.channel_id,
        in_port: preset.in_port,
        out_port: preset.out_port,
        target_addr: "",
      });
    }
  }

  function addGroup() {
    if (!sheet) return;
    const usedChannels = new Set(
      sheet.signal_groups.flatMap((g) => g.legs.map((l) => l.channel_id))
    );
    const nextPreset =
      RELAY_PRESETS.find((p) => !usedChannels.has(p.channel_id)) ?? RELAY_PRESETS[0];
    const n = sheet.signal_groups.length + 1;
    const created: SignalGroupConfig = {
      id: `signal-${Date.now().toString(36)}-${n}`,
      name: `讯道 ${n}`,
      direction: "venue_to_hub",
      redundancy_type: "single",
      expected_active: false,
      legs: [
        {
          role: "single",
          node_id: defaultNodeId,
          channel_id: nextPreset.channel_id,
          mode: nextPreset.mode,
          carrier: "公网",
          src_device: "",
          dst_device: "",
          in_port: nextPreset.in_port,
          out_port: nextPreset.out_port,
        },
      ],
    };
    setSheet({ ...sheet, signal_groups: [...sheet.signal_groups, created] });
  }

  function addBackupLeg(gIdx: number) {
    if (!sheet) return;
    const grp = sheet.signal_groups[gIdx];
    const first = grp.legs[0];
    const otherNode = nodes.find((n) => n.node_id !== first?.node_id)?.node_id;
    const backupNode = otherNode || first?.node_id || defaultNodeId;

    let backupChannelId = first?.channel_id || "srt-cam1";
    let backupMode = first?.mode || ("srt-relay" as const);
    let backupInPort = first?.in_port || 20001;
    let backupOutPort = first?.out_port || 21001;

    if (backupNode === first?.node_id) {
      const usedOnSameNode = new Set(
        sheet.signal_groups.flatMap((g) =>
          g.legs.filter((l) => l.node_id === backupNode).map((l) => l.channel_id)
        )
      );
      const pool = first?.mode === "udp-passthrough" ? PASS_PRESETS : RELAY_PRESETS;
      const freePreset =
        pool.find((p) => !usedOnSameNode.has(p.channel_id)) ??
        pool.find((p) => p.channel_id !== first?.channel_id) ??
        pool[0];
      backupChannelId = freePreset.channel_id;
      backupMode = freePreset.mode;
      backupInPort = freePreset.in_port;
      backupOutPort = freePreset.out_port;
    }

    const backup: LegConfig = {
      role: "backup",
      node_id: backupNode,
      channel_id: backupChannelId,
      mode: backupMode,
      carrier: "备用线路",
      src_device: "",
      dst_device: "",
      in_port: backupInPort,
      out_port: backupOutPort,
      target_addr: first?.mode === "udp-passthrough" ? first.target_addr || "" : "",
    };
    const legs = grp.legs.map((l, idx) => (idx === 0 ? { ...l, role: "primary" } : l));
    legs.push(backup);
    updateGroup(gIdx, {
      redundancy_type: grp.redundancy_type === "single" ? "dual_hardware" : grp.redundancy_type,
      legs,
    });
  }

  function removeLeg(gIdx: number, lIdx: number) {
    if (!sheet) return;
    const grp = sheet.signal_groups[gIdx];
    if (grp.legs.length <= 1) return;
    const legs = grp.legs
      .filter((_, idx) => idx !== lIdx)
      .map((l, _idx, arr) => (arr.length === 1 ? { ...l, role: "single" } : l));
    updateGroup(gIdx, {
      redundancy_type: legs.length === 1 ? "single" : grp.redundancy_type,
      legs,
    });
  }

  function removeGroup(gIdx: number) {
    if (!sheet) return;
    setSheet({
      ...sheet,
      signal_groups: sheet.signal_groups.filter((_, idx) => idx !== gIdx),
    });
  }

  if (!sheet) {
    return (
      <div className="mx-auto max-w-[1360px] p-5 text-[12.5px] text-[#7C8596]">
        正在加载通道配置...
      </div>
    );
  }

  const nodeOptions = Array.from(
    new Map(
      [
        ...nodes.map((n) => [n.node_id, n.display_name || n.node_id] as const),
        ...sheet.signal_groups.flatMap((g) => g.legs.map((l) => [l.node_id, l.node_id] as const)),
      ]
    ).entries()
  );

  const siteA = sheet.sites.venue || "站点 A";
  const siteB = sheet.sites.hub || "站点 B";

  return (
    <div className="mx-auto max-w-[1360px] p-4 lg:p-6 space-y-5">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[16px] font-semibold text-[#F1F3F6]">直播通道配置</h1>
            <span className="tabular rounded border border-[#232730] bg-[#14171C] px-2 py-0.5 text-[11px] text-[#98A1B0]">
              共 {sheet.signal_groups.length} 路信号
            </span>
          </div>
          <p className="mt-0.5 text-[12px] text-[#8B94A5]">
            自定义项目与两端站点名称，按需增删信号通道、配置主备路由并一键复制编码器推流/解码器拉流地址。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportJSON}>
            <Download className="h-3.5 w-3.5" />
            导出配置
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
            {saving ? "保存中..." : "保存生效"}
          </Button>
        </div>
      </div>

      {/* Project & Custom Site Labels */}
      <section className="rounded-lg border border-[#232730] bg-[#111316] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[12.5px] font-medium text-[#E6E9EF]">项目与站点名称（可自由自定义）</h2>
          <span className="text-[11px] text-[#757E8F]">
            也可在顶部栏右侧点击项目名快速修改
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          <div className="space-y-1.5">
            <label className="block text-[11.5px] text-[#98A1B0]">项目 / 场次名称</label>
            <Input
              value={sheet.event_name}
              placeholder="例如：周末联赛直播回传"
              onChange={(e) => setSheet({ ...sheet, event_name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11.5px] text-[#98A1B0]">站点 A（如前方现场）</label>
            <Input
              value={sheet.sites.venue}
              placeholder="例如：前方现场 / 场馆"
              onChange={(e) =>
                setSheet({ ...sheet, sites: { ...sheet.sites, venue: e.target.value } })
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11.5px] text-[#98A1B0]">站点 B（如制作中心）</label>
            <Input
              value={sheet.sites.hub}
              placeholder="例如：导播中心 / 演播室"
              onChange={(e) =>
                setSheet({ ...sheet, sites: { ...sheet.sites, hub: e.target.value } })
              }
            />
          </div>
        </div>
      </section>

      {/* Signal Group Cards */}
      <div className="space-y-3.5">
        {sheet.signal_groups.map((grp, gIdx) => {
          const hasPassLeg = grp.legs.some((l) => l.mode === "udp-passthrough");
          return (
            <section
              key={grp.id + gIdx}
              className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden"
            >
              {/* Signal Header */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Input
                    className="w-[155px] font-medium text-[#F1F3F6]"
                    value={grp.name}
                    onChange={(e) => updateGroup(gIdx, { name: e.target.value })}
                    placeholder="信号名（如 PGM）"
                  />

                  <Select
                    value={grp.direction}
                    onValueChange={(v) =>
                      updateGroup(gIdx, { direction: v as SignalGroupConfig["direction"] })
                    }
                  >
                    <SelectTrigger className="w-[190px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="venue_to_hub">
                        {siteA} → {siteB}
                      </SelectItem>
                      <SelectItem value="hub_to_venue">
                        {siteB} → {siteA}
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={grp.redundancy_type}
                    onValueChange={(v) =>
                      updateGroup(gIdx, {
                        redundancy_type: v as SignalGroupConfig["redundancy_type"],
                      })
                    }
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single">单路传输</SelectItem>
                      <SelectItem value="dual_hardware">双机热备</SelectItem>
                      <SelectItem value="makito_bonding">单机双路无缝</SelectItem>
                    </SelectContent>
                  </Select>

                  <label className="inline-flex items-center gap-2 pl-1 text-[12px] text-[#C8CFD9] cursor-pointer select-none">
                    <Switch
                      checked={grp.expected_active}
                      onCheckedChange={(checked) => updateGroup(gIdx, { expected_active: checked })}
                    />
                    断流告警
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  {grp.legs.length < 2 && (
                    <Button variant="outline" size="xs" onClick={() => addBackupLeg(gIdx)}>
                      <Plus className="h-3 w-3" />
                      添加备路
                    </Button>
                  )}
                  <Button variant="danger" size="xs" onClick={() => removeGroup(gIdx)}>
                    <Trash2 className="h-3 w-3" />
                    删除
                  </Button>
                </div>
              </div>

              {/* Legs Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="border-b border-[#1E222B] text-[11px] text-[#757E8F]">
                    <tr>
                      <th className="px-4 py-2 font-medium">主备</th>
                      <th className="px-2 py-2 font-medium">中转服务器</th>
                      <th className="px-2 py-2 font-medium">通道号</th>
                      <th className="px-2 py-2 font-medium">
                        <span className="inline-flex items-center gap-1">
                          传输模式
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpCircle className="h-3 w-3 text-[#656E7E] cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[300px] space-y-1">
                              <div>
                                <strong className="text-[#F1F3F6]">标准中转</strong>：推流与拉流端均作 Caller，无需端口映射，支持 vMix/OBS/手机/普通编解码器与画面缩略图（常用）。
                              </div>
                              <div>
                                <strong className="text-[#F1F3F6]">加密透传</strong>：UDP 原始包直通不解密，保留 SRT 包序号，专为 Haivision Makito X4 双路无缝合流准备（需填演播室解码器公网 IP:端口）。
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </span>
                      </th>
                      <th className="px-2 py-2 font-medium">线路备注</th>
                      <th className="px-2 py-2 font-medium">发端设备</th>
                      <th className="px-2 py-2 font-medium">收端设备</th>
                      <th className="px-4 py-2 font-medium">
                        {hasPassLeg ? "监听端口 → 演播室解码器 IP:端口" : "推流 / 拉流端口"}
                      </th>
                      {grp.legs.length > 1 && <th className="px-2 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1A1E26]">
                    {grp.legs.map((leg, lIdx) => {
                      const isKnownPreset = ALL_PRESETS.some((p) => p.channel_id === leg.channel_id);
                      const isPass = leg.mode === "udp-passthrough";
                      return (
                        <tr key={lIdx}>
                          <td className="px-4 py-2">
                            {grp.legs.length === 1 ? (
                              <span className="inline-flex h-8 w-[76px] items-center justify-center rounded-md border border-[#232730] bg-[#14171C] text-[12px] text-[#98A1B0]">
                                单路
                              </span>
                            ) : (
                              <Select
                                value={leg.role === "backup" ? "backup" : "primary"}
                                onValueChange={(v) =>
                                  updateDualLegRole(gIdx, lIdx, v as "primary" | "backup")
                                }
                              >
                                <SelectTrigger className="w-[78px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="primary">主路</SelectItem>
                                  <SelectItem value="backup">备路</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </td>

                          <td className="px-2 py-2">
                            <Select
                              value={leg.node_id}
                              onValueChange={(v) => updateLeg(gIdx, lIdx, { node_id: v })}
                            >
                              <SelectTrigger className="w-[132px] tabular">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {nodeOptions.map(([id, label]) => (
                                  <SelectItem key={id} value={id}>
                                    {id === label ? id : `${id} (${label})`}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>

                          <td className="px-2 py-2">
                            <Select
                              value={leg.channel_id}
                              onValueChange={(v) => handlePresetChannel(gIdx, lIdx, v)}
                            >
                              <SelectTrigger className="w-[232px] tabular">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {!isKnownPreset && (
                                  <SelectItem value={leg.channel_id}>
                                    {leg.channel_id}（自定义）
                                  </SelectItem>
                                )}
                                <SelectGroup>
                                  <SelectLabel>标准中转通道 (推流 + 拉流)</SelectLabel>
                                  {RELAY_PRESETS.map((p) => (
                                    <SelectItem key={p.channel_id} value={p.channel_id}>
                                      {p.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                                <SelectGroup>
                                  <SelectLabel>加密透传通道 (Makito 无缝)</SelectLabel>
                                  {PASS_PRESETS.map((p) => (
                                    <SelectItem key={p.channel_id} value={p.channel_id}>
                                      {p.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </td>

                          <td className="px-2 py-2">
                            <Select
                              value={leg.mode}
                              onValueChange={(v) =>
                                handleModeChange(gIdx, lIdx, v as LegConfig["mode"])
                              }
                            >
                              <SelectTrigger className="w-[118px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="srt-relay">标准中转</SelectItem>
                                <SelectItem value="udp-passthrough">加密透传</SelectItem>
                              </SelectContent>
                            </Select>
                          </td>

                          <td className="px-2 py-2">
                            <Input
                              className="w-[76px]"
                              value={leg.carrier}
                              placeholder="公网"
                              onChange={(e) => updateLeg(gIdx, lIdx, { carrier: e.target.value })}
                            />
                          </td>

                          <td className="px-2 py-2">
                            <Input
                              className="w-[126px]"
                              value={leg.src_device}
                              placeholder="编码器"
                              onChange={(e) =>
                                updateLeg(gIdx, lIdx, { src_device: e.target.value })
                              }
                            />
                          </td>

                          <td className="px-2 py-2">
                            <Input
                              className="w-[126px]"
                              value={leg.dst_device}
                              placeholder="解码器"
                              onChange={(e) =>
                                updateLeg(gIdx, lIdx, { dst_device: e.target.value })
                              }
                            />
                          </td>

                          <td className="px-4 py-2 whitespace-nowrap">
                            {isPass ? (
                              <div className="inline-flex items-center gap-1.5">
                                <Input
                                  className="w-[70px] tabular"
                                  type="number"
                                  value={leg.in_port}
                                  title="VPS 透传入口监听端口"
                                  onChange={(e) =>
                                    updateLeg(gIdx, lIdx, { in_port: Number(e.target.value) })
                                  }
                                />
                                <span className="text-[#656E7E]">→</span>
                                <Input
                                  className="w-[172px] tabular"
                                  value={leg.target_addr || ""}
                                  placeholder="演播室IP:41111"
                                  title="演播室解码器公网 IP 与监听端口"
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    const parsedPort = parsePortSuffix(val);
                                    updateLeg(gIdx, lIdx, {
                                      target_addr: val,
                                      ...(parsedPort ? { out_port: parsedPort } : {}),
                                    });
                                  }}
                                />
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <Input
                                  className="w-[72px] tabular"
                                  type="number"
                                  value={leg.in_port}
                                  onChange={(e) =>
                                    updateLeg(gIdx, lIdx, { in_port: Number(e.target.value) })
                                  }
                                />
                                <span className="text-[#586070]">/</span>
                                <Input
                                  className="w-[72px] tabular"
                                  type="number"
                                  value={leg.out_port}
                                  onChange={(e) =>
                                    updateLeg(gIdx, lIdx, { out_port: Number(e.target.value) })
                                  }
                                />
                              </div>
                            )}
                          </td>

                          {grp.legs.length > 1 && (
                            <td className="px-2 py-2 text-right">
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => removeLeg(gIdx, lIdx)}
                              >
                                移除
                              </Button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Copyable SRT URL Footer Bar */}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[#1C2028] bg-[#0D0F12] px-4 py-2.5 text-[11.5px]">
                {grp.legs.map((leg, lIdx) => {
                  const host = resolveNodeHost(nodes, leg.node_id);
                  const push = `srt://${host}:${leg.in_port}`;
                  const pull = `srt://${host}:${leg.out_port}`;
                  const roleTag =
                    grp.legs.length > 1 ? (leg.role === "backup" ? "[备] " : "[主] ") : "";
                  const kPush = `${gIdx}-${lIdx}-push`;
                  const kPull = `${gIdx}-${lIdx}-pull`;
                  const kPassCmd = `${gIdx}-${lIdx}-passcmd`;
                  return (
                    <div key={lIdx} className="inline-flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void copyText(kPush, "推流地址", push)}
                        className="inline-flex items-center gap-1.5 text-[#98A1B0] hover:text-[#F1F3F6] cursor-pointer"
                      >
                        <span>{roleTag}推流:</span>
                        <code className="tabular text-[#E6E9EF]">{push}</code>
                        {copiedKey === kPush ? (
                          <Check className="h-3 w-3 text-[#4ADE80]" />
                        ) : (
                          <Copy className="h-3 w-3 text-[#6B7485]" />
                        )}
                      </button>
                      {leg.mode !== "udp-passthrough" ? (
                        <button
                          type="button"
                          onClick={() => void copyText(kPull, "拉流地址", pull)}
                          className="inline-flex items-center gap-1.5 text-[#98A1B0] hover:text-[#F1F3F6] cursor-pointer"
                        >
                          <span>{roleTag}拉流:</span>
                          <code className="tabular text-[#E6E9EF]">{pull}</code>
                          {copiedKey === kPull ? (
                            <Check className="h-3 w-3 text-[#4ADE80]" />
                          ) : (
                            <Copy className="h-3 w-3 text-[#6B7485]" />
                          )}
                        </button>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1.5 text-[#98A1B0]">
                            <span>→ 透传目标:</span>
                            <code className="tabular text-[#E6E9EF]">
                              {leg.target_addr?.trim() || "请先填写演播室IP:端口"}
                            </code>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void copyText(
                                kPassCmd,
                                `${leg.channel_id} 透传容器启动命令`,
                                buildPassRunCmd(leg)
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-[#2A2F3A] bg-[#161920] px-2 py-0.5 text-[11px] text-[#C8CFD9] hover:text-white hover:border-[#3A4150] cursor-pointer"
                          >
                            {copiedKey === kPassCmd ? (
                              <Check className="h-3 w-3 text-[#4ADE80]" />
                            ) : (
                              <Terminal className="h-3 w-3" />
                            )}
                            复制透传启动命令
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div>
        <Button variant="secondary" size="sm" onClick={addGroup}>
          <Plus className="h-3.5 w-3.5" />
          新增信号通道
        </Button>
      </div>
    </div>
  );
}
