import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  HelpCircle,
  Lock,
  Plus,
  Save,
  Terminal,
  Trash2,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import type { EventSheet, LegConfig, NodeLiveStatus, SignalGroupConfig } from "@/types";
import { api, resolveNodeHost } from "@/api";
import { copyToClipboard } from "@/lib/clipboard";
import { StopStreamDialog } from "@/components/StopStreamDialog";
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
import { cn } from "@/lib/utils";

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

function isGroupEnabled(grp: SignalGroupConfig): boolean {
  return grp.enabled !== false;
}

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
    `docker run -d --name ${leg.channel_id} --restart unless-stopped --network host local-srt-pass:v2 --id=${leg.channel_id} --listen=:${leg.in_port} --target=${target} --metrics=127.0.0.1:${metricsPort}`,
  ].join("\n");
}

function findChannelOwner(
  sheet: EventSheet,
  nodeId: string,
  channelId: string,
  excludeGIdx: number,
  excludeLIdx: number
): string | null {
  for (let gi = 0; gi < sheet.signal_groups.length; gi++) {
    const grp = sheet.signal_groups[gi];
    for (let li = 0; li < grp.legs.length; li++) {
      if (gi === excludeGIdx && li === excludeLIdx) continue;
      const leg = grp.legs[li];
      if (leg.node_id === nodeId && leg.channel_id === channelId) {
        return grp.name || `讯道 ${gi + 1}`;
      }
    }
  }
  return null;
}

function validateSheetConflicts(sheet: EventSheet): string | null {
  const usedChannels = new Map<string, string>();
  const usedPorts = new Map<string, string>();

  for (const grp of sheet.signal_groups) {
    if (!grp.name.trim()) {
      return "存在信号名称为空的配置项，请填写信号名称";
    }
    const seenInGroup = new Set<string>();
    for (const leg of grp.legs) {
      const chKey = `${leg.node_id}/${leg.channel_id}`;
      if (seenInGroup.has(chKey)) {
        return `信号「${grp.name}」的主备链路不能使用同一服务器的同一通道（${chKey}）`;
      }
      seenInGroup.add(chKey);

      const existingChOwner = usedChannels.get(chKey);
      if (existingChOwner) {
        return `通道冲突：信号「${grp.name}」与「${existingChOwner}」不能同时占用 ${chKey}`;
      }
      usedChannels.set(chKey, grp.name);

      if (leg.in_port > 0) {
        if (leg.in_port < 1 || leg.in_port > 65535) {
          return `信号「${grp.name}」的推流/监听端口 ${leg.in_port} 超出有效范围 (1-65535)`;
        }
        const inKey = `${leg.node_id}:${leg.in_port}`;
        const owner = usedPorts.get(inKey);
        if (owner) {
          return `端口冲突：信号「${grp.name}」与「${owner}」不能在同一服务器 (${leg.node_id}) 上共用端口 ${leg.in_port}`;
        }
        usedPorts.set(inKey, grp.name);
      }

      if (leg.mode === "srt-relay" && leg.out_port > 0) {
        if (leg.out_port < 1 || leg.out_port > 65535) {
          return `信号「${grp.name}」的拉流端口 ${leg.out_port} 超出有效范围 (1-65535)`;
        }
        if (leg.out_port === leg.in_port) {
          return `端口冲突：信号「${grp.name}」的推流与拉流端口不能相同 (${leg.out_port})`;
        }
        const outKey = `${leg.node_id}:${leg.out_port}`;
        const owner = usedPorts.get(outKey);
        if (owner) {
          return `端口冲突：信号「${grp.name}」与「${owner}」不能在同一服务器 (${leg.node_id}) 上共用端口 ${leg.out_port}`;
        }
        usedPorts.set(outKey, grp.name);
      }

      if (leg.mode === "udp-passthrough" && !leg.target_addr?.trim()) {
        return `信号「${grp.name}」选择了加密透传，请填写演播室解码器的公网 IP:端口`;
      }
    }
  }
  return null;
}

function liveFlowMbpsOfGroup(nodes: NodeLiveStatus[], grp: SignalGroupConfig): number {
  let maxMbps = 0;
  for (const leg of grp.legs) {
    const node = nodes.find((n) => n.node_id === leg.node_id);
    const sample = node?.online ? node.channels[leg.channel_id] : undefined;
    if (sample && sample.src_mbps > maxMbps) {
      maxMbps = sample.src_mbps;
    }
  }
  return maxMbps;
}

export function EventSheetPage({ nodes, onSaved }: Props) {
  const [sheet, setSheet] = useState<EventSheet | null>(null);
  const [savedGroupIds, setSavedGroupIds] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [powerBusyId, setPowerBusyId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [stopConfirm, setStopConfirm] = useState<{
    groupId: string;
    signalName: string;
    activeMbps: number;
  } | null>(null);

  const defaultNodeId = nodes[0]?.node_id || "vps-1";

  useEffect(() => {
    api
      .getEventSheet()
      .then((s) => {
        setSheet(s);
        setSavedGroupIds(new Set(s.signal_groups.map((g) => g.id)));
        setDirty(false);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "加载通道配置失败"));
  }, []);

  async function persistSheet(targetSheet: EventSheet): Promise<EventSheet | null> {
    const errMsg = validateSheetConflicts(targetSheet);
    if (errMsg) {
      toast.error(errMsg);
      return null;
    }
    setSaving(true);
    try {
      const saved = await api.saveEventSheet(targetSheet);
      setSheet(saved);
      setSavedGroupIds(new Set(saved.signal_groups.map((g) => g.id)));
      setDirty(false);
      return saved;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!sheet) return;
    const saved = await persistSheet(sheet);
    if (saved) {
      toast.success("通道配置已保存并立即生效");
      onSaved();
    }
  }

  async function executePowerChange(groupId: string, signalName: string, enable: boolean, force = false) {
    setPowerBusyId(groupId);
    try {
      const res = await api.setSignalGroupEnabled(groupId, enable, force);
      setSheet(res.event_sheet);
      setSavedGroupIds(new Set(res.event_sheet.signal_groups.map((g) => g.id)));
      setDirty(false);
      setStopConfirm(null);
      if (enable) {
        toast.success(`已启动「${signalName}」`);
      } else {
        toast.success(`已停止「${signalName}」`);
      }
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "切换流开关失败";
      if (!enable && !force && msg.includes("二次确认")) {
        const grp = sheet?.signal_groups.find((g) => g.id === groupId);
        const mbps = grp ? Math.max(liveFlowMbpsOfGroup(nodes, grp), 0.1) : 0.1;
        setStopConfirm({ groupId, signalName, activeMbps: mbps });
      } else {
        toast.error(msg);
      }
    } finally {
      setPowerBusyId(null);
    }
  }

  async function handleToggleStreamPower(grp: SignalGroupConfig, nextEnable: boolean) {
    if (!sheet) return;
    // If there are unsaved changes (or a newly added signal), save first before switching power
    // so the server has the latest stopped transport configuration before starting the container.
    if (dirty || !savedGroupIds.has(grp.id)) {
      const saved = await persistSheet(sheet);
      if (!saved) return;
    }

    if (!nextEnable) {
      const activeMbps = liveFlowMbpsOfGroup(nodes, grp);
      if (activeMbps >= 0.1) {
        setStopConfirm({ groupId: grp.id, signalName: grp.name, activeMbps });
        return;
      }
    }

    await executePowerChange(grp.id, grp.name, nextEnable, false);
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

  function mutateSheet(next: EventSheet) {
    setSheet(next);
    setDirty(true);
  }

  function updateGroup(idx: number, patch: Partial<SignalGroupConfig>) {
    if (!sheet) return;
    const next = { ...sheet, signal_groups: [...sheet.signal_groups] };
    next.signal_groups[idx] = { ...next.signal_groups[idx], ...patch };
    mutateSheet(next);
  }

  function updateLeg(gIdx: number, lIdx: number, patch: Partial<LegConfig>) {
    if (!sheet) return;
    const next = { ...sheet, signal_groups: [...sheet.signal_groups] };
    const legs = [...next.signal_groups[gIdx].legs];
    legs[lIdx] = { ...legs[lIdx], ...patch };
    next.signal_groups[gIdx] = { ...next.signal_groups[gIdx], legs };
    mutateSheet(next);
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

  function handleNodeChange(gIdx: number, lIdx: number, nextNodeId: string) {
    if (!sheet) return;
    const leg = sheet.signal_groups[gIdx].legs[lIdx];
    const owner = findChannelOwner(sheet, nextNodeId, leg.channel_id, gIdx, lIdx);
    if (!owner) {
      updateLeg(gIdx, lIdx, { node_id: nextNodeId });
      return;
    }
    const pool = leg.mode === "udp-passthrough" ? PASS_PRESETS : RELAY_PRESETS;
    const freePreset = pool.find(
      (p) => !findChannelOwner(sheet, nextNodeId, p.channel_id, gIdx, lIdx)
    );
    if (freePreset) {
      updateLeg(gIdx, lIdx, {
        node_id: nextNodeId,
        channel_id: freePreset.channel_id,
        mode: freePreset.mode,
        in_port: freePreset.in_port,
        out_port: freePreset.out_port,
      });
      toast.info(`已自动切换为空闲通道 ${freePreset.channel_id}`);
    } else {
      updateLeg(gIdx, lIdx, { node_id: nextNodeId });
      toast.warning(`${nextNodeId} 上该通道已被「${owner}」占用，请手动调整通道`);
    }
  }

  function handlePresetChannel(gIdx: number, lIdx: number, channelId: string) {
    if (!sheet) return;
    const leg = sheet.signal_groups[gIdx].legs[lIdx];
    const owner = findChannelOwner(sheet, leg.node_id, channelId, gIdx, lIdx);
    if (owner) {
      toast.error(`该通道已被信号「${owner}」占用，请选择其他空闲通道`);
      return;
    }
    const preset = ALL_PRESETS.find((p) => p.channel_id === channelId);
    if (preset) {
      updateLeg(gIdx, lIdx, {
        channel_id: preset.channel_id,
        mode: preset.mode,
        in_port: preset.in_port,
        out_port: preset.out_port,
        ...(preset.mode === "srt-relay" ? { target_addr: "" } : {}),
      });
    } else {
      updateLeg(gIdx, lIdx, { channel_id: channelId });
    }
  }

  function handleModeChange(gIdx: number, lIdx: number, nextMode: LegConfig["mode"]) {
    if (!sheet) return;
    const leg = sheet.signal_groups[gIdx].legs[lIdx];

    if (nextMode === "udp-passthrough") {
      const alreadyPass = PASS_PRESETS.some((p) => p.channel_id === leg.channel_id);
      if (alreadyPass) {
        updateLeg(gIdx, lIdx, { mode: nextMode });
        return;
      }
      const preset =
        PASS_PRESETS.find((p) => !findChannelOwner(sheet, leg.node_id, p.channel_id, gIdx, lIdx)) ??
        PASS_PRESETS[0];
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
      const preset =
        RELAY_PRESETS.find(
          (p) => !findChannelOwner(sheet, leg.node_id, p.channel_id, gIdx, lIdx)
        ) ?? RELAY_PRESETS[0];
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
    const usedOnDefault = new Set(
      sheet.signal_groups.flatMap((g) =>
        g.legs.filter((l) => l.node_id === defaultNodeId).map((l) => l.channel_id)
      )
    );
    const nextPreset = RELAY_PRESETS.find((p) => !usedOnDefault.has(p.channel_id));
    if (!nextPreset) {
      toast.warning(`${defaultNodeId} 的 10 路标准中转通道已全部占用，可先添加第二台服务器或切换为透传通道`);
    }
    const chosen = nextPreset ?? RELAY_PRESETS[0];
    const n = sheet.signal_groups.length + 1;
    const created: SignalGroupConfig = {
      id: `signal-${Date.now().toString(36)}-${n}`,
      name: `讯道 ${n}`,
      direction: "venue_to_hub",
      redundancy_type: "single",
      enabled: false, // New signals start Stopped & Unlocked like Haivision Gateway
      expected_active: false,
      legs: [
        {
          role: "single",
          node_id: defaultNodeId,
          channel_id: chosen.channel_id,
          mode: chosen.mode,
          carrier: "公网",
          src_device: "",
          dst_device: "",
          in_port: chosen.in_port,
          out_port: chosen.out_port,
        },
      ],
    };
    mutateSheet({ ...sheet, signal_groups: [...sheet.signal_groups, created] });
  }

  function addBackupLeg(gIdx: number) {
    if (!sheet) return;
    const grp = sheet.signal_groups[gIdx];
    const first = grp.legs[0];
    const otherNode = nodes.find((n) => n.node_id !== first?.node_id)?.node_id;
    const backupNode = otherNode || first?.node_id || defaultNodeId;

    const usedOnBackupNode = new Set(
      sheet.signal_groups.flatMap((g) =>
        g.legs.filter((l) => l.node_id === backupNode).map((l) => l.channel_id)
      )
    );
    const pool = first?.mode === "udp-passthrough" ? PASS_PRESETS : RELAY_PRESETS;
    const preferredSameId =
      backupNode !== first?.node_id &&
      first?.channel_id &&
      !usedOnBackupNode.has(first.channel_id)
        ? pool.find((p) => p.channel_id === first.channel_id)
        : undefined;
    const freePreset =
      preferredSameId ??
      pool.find((p) => !usedOnBackupNode.has(p.channel_id)) ??
      pool.find((p) => p.channel_id !== first?.channel_id) ??
      pool[0];

    const backup: LegConfig = {
      role: "backup",
      node_id: backupNode,
      channel_id: freePreset.channel_id,
      mode: freePreset.mode,
      carrier: "备用线路",
      src_device: "",
      dst_device: "",
      in_port: freePreset.in_port,
      out_port: freePreset.out_port,
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
    const grp = sheet.signal_groups[gIdx];
    if (isGroupEnabled(grp)) {
      toast.error(`信号「${grp.name}」正在运行，请先关闭流开关后再删除`);
      return;
    }
    mutateSheet({
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
  const enabledCount = sheet.signal_groups.filter((g) => isGroupEnabled(g)).length;

  return (
    <div className="mx-auto max-w-[1360px] p-4 lg:p-6 space-y-5">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[16px] font-semibold text-[#F1F3F6]">直播通道配置</h1>
            <span className="tabular rounded border border-[#232730] bg-[#14171C] px-2 py-0.5 text-[11px] text-[#98A1B0]">
              运行 {enabledCount} / 共 {sheet.signal_groups.length} 路
            </span>
            {dirty && (
              <span className="rounded border border-[#4D3B16] bg-[#241B0B] px-2 py-0.5 text-[11px] text-[#FBBF24]">
                有未保存修改
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-[#8B94A5]">
            打开流开关即启动对应通道并锁定传输参数（防止直播中误改断流），信号名、备注和告警开关可随时修改。
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
              onChange={(e) => mutateSheet({ ...sheet, event_name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11.5px] text-[#98A1B0]">站点 A（如前方现场）</label>
            <Input
              value={sheet.sites.venue}
              placeholder="例如：前方现场 / 场馆"
              onChange={(e) =>
                mutateSheet({ ...sheet, sites: { ...sheet.sites, venue: e.target.value } })
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[11.5px] text-[#98A1B0]">站点 B（如制作中心）</label>
            <Input
              value={sheet.sites.hub}
              placeholder="例如：导播中心 / 演播室"
              onChange={(e) =>
                mutateSheet({ ...sheet, sites: { ...sheet.sites, hub: e.target.value } })
              }
            />
          </div>
        </div>
      </section>

      {/* Signal Group Cards */}
      <div className="space-y-3.5">
        {sheet.signal_groups.map((grp, gIdx) => {
          const locked = isGroupEnabled(grp);
          const busyPower = powerBusyId === grp.id;
          const hasPassLeg = grp.legs.some((l) => l.mode === "udp-passthrough");
          return (
            <section
              key={grp.id + gIdx}
              className={cn(
                "rounded-lg border bg-[#111316] overflow-hidden transition-colors",
                locked ? "border-[#232730]" : "border-[#2D3340]"
              )}
            >
              {/* Signal Header */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  {/* Haivision-style Stream Power / Lock Switch */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label
                        className={cn(
                          "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11.5px] font-medium cursor-pointer select-none transition-colors",
                          locked
                            ? "border-[#1E4631] bg-[#0F241A] text-[#4ADE80]"
                            : "border-[#2B313D] bg-[#101318] text-[#8B94A5]"
                        )}
                      >
                        <Switch
                          checked={locked}
                          disabled={busyPower || saving}
                          onCheckedChange={(checked) => void handleToggleStreamPower(grp, checked)}
                        />
                        {locked ? (
                          <span className="inline-flex items-center gap-1">
                            <Lock className="h-3 w-3" />
                            运行中
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Unlock className="h-3 w-3" />
                            已停止
                          </span>
                        )}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px]">
                      {locked
                        ? "通道运行中，传输参数已锁定防误改。关闭此开关将停止容器并解锁参数编辑。"
                        : "通道已停止，可自由修改服务器、通道与端口。开启后将启动容器并锁定参数。"}
                    </TooltipContent>
                  </Tooltip>

                  <Input
                    className="w-[150px] font-medium text-[#F1F3F6]"
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
                    <SelectTrigger className="w-[186px]">
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
                    disabled={locked}
                    onValueChange={(v) =>
                      updateGroup(gIdx, {
                        redundancy_type: v as SignalGroupConfig["redundancy_type"],
                      })
                    }
                  >
                    <SelectTrigger
                      className="w-[162px]"
                      title={locked ? "流运行中已锁定，请先关闭流开关" : undefined}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single">单路传输</SelectItem>
                      <SelectItem value="dual_hardware">双机热备</SelectItem>
                      <SelectItem value="makito_bonding">单机双路无缝</SelectItem>
                    </SelectContent>
                  </Select>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="inline-flex items-center gap-2 pl-1 text-[12px] text-[#C8CFD9] cursor-pointer select-none">
                        <Switch
                          checked={grp.expected_active}
                          onCheckedChange={(checked) => updateGroup(gIdx, { expected_active: checked })}
                        />
                        断流告警
                      </label>
                    </TooltipTrigger>
                    <TooltipContent>
                      {locked
                        ? "开启后，该路信号中断或严重波动时将自动推送飞书告警"
                        : "流停止时自动静音，不会触发断流告警"}
                    </TooltipContent>
                  </Tooltip>
                </div>

                <div className="flex items-center gap-2">
                  {grp.legs.length < 2 && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={locked}
                      title={locked ? "流运行中已锁定，请先关闭流开关后再添加备路" : undefined}
                      onClick={() => addBackupLeg(gIdx)}
                    >
                      <Plus className="h-3 w-3" />
                      添加备路
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="xs"
                    disabled={locked}
                    title={locked ? "流运行中已锁定，请先关闭流开关后再删除" : undefined}
                    onClick={() => removeGroup(gIdx)}
                  >
                    <Trash2 className="h-3 w-3" />
                    删除
                  </Button>
                </div>
              </div>

              {/* Legs Table (Cleaned up: removed 发端设备 / 收端设备 columns) */}
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
                      <th className="px-2 py-2 font-medium">备注</th>
                      <th className="px-4 py-2 font-medium">
                        {hasPassLeg ? "监听端口 → 演播室解码器 IP:端口" : "推流 / 拉流端口"}
                      </th>
                      {grp.legs.length > 1 && <th className="px-2 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1A1E26]">
                    {grp.legs.map((leg, lIdx) => {
                      const isRelayPreset = RELAY_PRESETS.some(
                        (p) => p.channel_id === leg.channel_id
                      );
                      const isKnownPreset = ALL_PRESETS.some(
                        (p) => p.channel_id === leg.channel_id
                      );
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
                                disabled={locked}
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
                              disabled={locked}
                              onValueChange={(v) => handleNodeChange(gIdx, lIdx, v)}
                            >
                              <SelectTrigger className="w-[144px] tabular">
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
                              disabled={locked}
                              onValueChange={(v) => handlePresetChannel(gIdx, lIdx, v)}
                            >
                              <SelectTrigger className="w-[244px] tabular">
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
                                  {RELAY_PRESETS.map((p) => {
                                    const owner = findChannelOwner(
                                      sheet,
                                      leg.node_id,
                                      p.channel_id,
                                      gIdx,
                                      lIdx
                                    );
                                    return (
                                      <SelectItem
                                        key={p.channel_id}
                                        value={p.channel_id}
                                        disabled={!!owner}
                                      >
                                        {owner ? `${p.label} · 已占(${owner})` : p.label}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectGroup>
                                <SelectGroup>
                                  <SelectLabel>加密透传通道 (Makito 无缝)</SelectLabel>
                                  {PASS_PRESETS.map((p) => {
                                    const owner = findChannelOwner(
                                      sheet,
                                      leg.node_id,
                                      p.channel_id,
                                      gIdx,
                                      lIdx
                                    );
                                    return (
                                      <SelectItem
                                        key={p.channel_id}
                                        value={p.channel_id}
                                        disabled={!!owner}
                                      >
                                        {owner ? `${p.label} · 已占(${owner})` : p.label}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </td>

                          <td className="px-2 py-2">
                            <Select
                              value={leg.mode}
                              disabled={locked}
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
                              className="w-[156px]"
                              value={leg.carrier}
                              placeholder="电信 / 机箱备注"
                              onChange={(e) => updateLeg(gIdx, lIdx, { carrier: e.target.value })}
                            />
                          </td>

                          <td className="px-4 py-2 whitespace-nowrap">
                            {isPass ? (
                              <div className="inline-flex items-center gap-1.5">
                                <Input
                                  className="w-[74px] tabular"
                                  type="number"
                                  disabled={locked}
                                  value={leg.in_port}
                                  title="VPS 透传入口监听端口"
                                  onChange={(e) =>
                                    updateLeg(gIdx, lIdx, { in_port: Number(e.target.value) })
                                  }
                                />
                                <span className="text-[#656E7E]">→</span>
                                <Input
                                  className="w-[184px] tabular"
                                  disabled={locked}
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
                            ) : isRelayPreset ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="tabular inline-flex h-8 items-center gap-1.5 rounded-md border border-[#232730] bg-[#0D0F13] px-3 text-[12px] text-[#B8C0CE]">
                                    <span>{leg.in_port}</span>
                                    <span className="text-[#586070]">/</span>
                                    <span>{leg.out_port}</span>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  标准通道端口与底层容器绑定，切换上方通道号即可自动变更端口，防止配置错位
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <Input
                                  className="w-[74px] tabular"
                                  type="number"
                                  disabled={locked}
                                  value={leg.in_port}
                                  onChange={(e) =>
                                    updateLeg(gIdx, lIdx, { in_port: Number(e.target.value) })
                                  }
                                />
                                <span className="text-[#586070]">/</span>
                                <Input
                                  className="w-[74px] tabular"
                                  type="number"
                                  disabled={locked}
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
                                disabled={locked}
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
              <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-[#1C2028] bg-[#0D0F12] px-4 py-2.5 text-[11.5px]">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
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

                {!locked && (
                  <span className="text-[11px] text-[#757E8F]">
                    编辑完成后打开左上角流开关即可启动并锁定
                  </span>
                )}
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

      <StopStreamDialog
        open={!!stopConfirm}
        signalName={stopConfirm?.signalName ?? ""}
        activeMbps={stopConfirm?.activeMbps ?? 0}
        busy={!!stopConfirm && powerBusyId === stopConfirm.groupId}
        onCancel={() => setStopConfirm(null)}
        onConfirm={() => {
          if (stopConfirm) {
            void executePowerChange(stopConfirm.groupId, stopConfirm.signalName, false, true);
          }
        }}
      />
    </div>
  );
}
