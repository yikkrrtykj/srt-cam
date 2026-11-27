import { ArrowRight, Lock, RotateCcw } from "lucide-react";
import type { LegLiveView, SignalGroupLiveView } from "@/types";
import { formatUptime, legTone, type BroadcastTone } from "@/api";
import { StatusBadge, TallyDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface LegWindowStats {
  maxRestarts: number;
  udpDrops: number;
}

interface Props {
  group: SignalGroupLiveView;
  legStats?: Record<string, LegWindowStats>;
  onRestartLeg?: (leg: LegLiveView) => void;
}

function roleLabel(role: string): string {
  if (role === "primary") return "主路";
  if (role === "backup") return "备路";
  return "单路";
}

function connBadge(connected: boolean, mbps: number, awaiting = false): { label: string; tone: BroadcastTone } {
  if (connected && mbps >= 0.1) return { label: "正常", tone: "ok" };
  if (awaiting) return { label: "待拉流", tone: "warn" };
  if (connected) return { label: "待机", tone: "idle" };
  return { label: "断开", tone: "crit" };
}

function barColor(level: "ok" | "warn" | "crit" | "idle"): string {
  if (level === "crit") return "bg-[#EF4444]";
  if (level === "warn") return "bg-[#F59E0B]";
  if (level === "ok") return "bg-[#22C55E]";
  return "bg-[#38404F]";
}

function textTone(tone: BroadcastTone): string {
  if (tone === "crit") return "text-[#F87171]";
  if (tone === "warn") return "text-[#FBBF24]";
  if (tone === "ok") return "text-[#4ADE80]";
  return "text-[#98A1B0]";
}

export function SignalHealthPanel({ group, legStats, onRestartLeg }: Props) {
  return (
    <div className="space-y-3">
      {group.legs.map((leg) => {
        const s = leg.sample;
        const key = `${leg.node_id}/${leg.channel_id}`;
        const tone = legTone(leg);
        const isPass = leg.mode === "udp-passthrough";
        const srcFlowing = s.src_mbps >= 0.1;
        const dstFlowing = s.dst_mbps >= 0.1;

        const win = legStats?.[key];
        const restarts = win ? Math.max(win.maxRestarts, s.restart_count) : s.restart_count;
        const udpDrops = win ? win.udpDrops : leg.host.udp_rcvbuf_errors;

        // Haivision 4×RTT buffer margin rule
        const hasTSBPD = !isPass && s.src_tsbpd_ms > 0;
        const fourXRTT = s.src_rtt_ms * 4;
        const marginPct = hasTSBPD ? Math.round((fourXRTT / s.src_tsbpd_ms) * 100) : 0;
        const marginLevel: "ok" | "warn" | "crit" | "idle" =
          !hasTSBPD || !srcFlowing ? "idle" : marginPct > 100 ? "crit" : marginPct >= 75 ? "warn" : "ok";

        const dstRttPct = Math.min(100, Math.round((s.dst_rtt_ms / 250) * 100));
        const dstRttLevel: "ok" | "warn" | "crit" | "idle" =
          !dstFlowing || s.dst_rtt_ms <= 0 ? "idle" : s.dst_rtt_ms >= 250 ? "crit" : s.dst_rtt_ms >= 100 ? "warn" : "ok";

        const srcBadge = connBadge(s.src_connected, s.src_mbps);
        const dstBadge = connBadge(s.dst_connected, s.dst_mbps, s.fault_code === "DOWNSTREAM_OFFLINE");

        return (
          <div
            key={key}
            className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden"
          >
            {/* Leg Top Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E222B] bg-[#14171C] px-3.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <TallyDot tone={tone} />
                <span className="text-[12.5px] font-medium text-[#F1F3F6]">
                  {roleLabel(leg.role)}
                  {leg.carrier ? ` · ${leg.carrier}` : ""}
                </span>
                <span className="rounded border border-[#262B35] bg-[#191C22] px-1.5 py-0.5 text-[10.5px] text-[#98A1B0]">
                  {isPass ? "加密透传" : "标准中转"}
                </span>
                {s.encrypted && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 rounded border border-[#2C3340] bg-[#191D24] px-1.5 py-0.5 text-[10.5px] text-[#CBD2DE]">
                        <Lock className="h-2.5 w-2.5" />
                        AES
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>SRT 端到端加密传输</TooltipContent>
                  </Tooltip>
                )}
                {s.path_medium && s.path_medium !== "-" && (
                  <StatusBadge tone={s.path_medium.includes("LO") ? "warn" : "idle"}>
                    {s.path_medium}
                  </StatusBadge>
                )}
                {!leg.node_online && <StatusBadge tone="crit">服务器离线</StatusBadge>}
              </div>

              <div className="flex items-center gap-2.5">
                <span className={cn("text-[12px]", textTone(tone))}>{s.fault_summary || "-"}</span>
                {onRestartLeg && (
                  <Button variant="outline" size="xs" onClick={() => onRestartLeg(leg)}>
                    <RotateCcw className="h-3 w-3" />
                    重置通道
                  </Button>
                )}
              </div>
            </div>

            {/* 3-Stage Fault Isolation Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_24px_0.85fr_24px_1fr] items-stretch gap-2 p-3">
              {/* Stage 1: Ingest */}
              <div className="rounded-md border border-[#1E222B] bg-[#0E1014] p-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#7C8596]">推流端 · 发端</span>
                  <StatusBadge tone={srcBadge.tone}>{srcBadge.label}</StatusBadge>
                </div>
                <div>
                  <div className="text-[13px] font-medium text-[#F1F3F6] truncate">
                    {leg.src_device || "发端编码器"}
                  </div>
                  <div className="tabular mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-[#98A1B0]">
                    <span>IP {s.src_peer_ip || "-"}</span>
                    <span>{s.src_mbps.toFixed(2)} Mb/s</span>
                    {!isPass && <span>RTT {s.src_rtt_ms > 0 ? `${s.src_rtt_ms.toFixed(0)}ms` : "-"}</span>}
                  </div>
                </div>

                {!isPass ? (
                  <>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-[#7C8596]">缓冲余量 (4×RTT / 设定)</span>
                        <span className={cn("tabular", textTone(marginLevel))}>
                          {hasTSBPD
                            ? `${fourXRTT.toFixed(0)} / ${s.src_tsbpd_ms.toFixed(0)}ms (${marginPct}%)`
                            : "-"}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1D212A]">
                        <div
                          className={cn("h-full transition-all", barColor(marginLevel))}
                          style={{ width: `${hasTSBPD && srcFlowing ? Math.min(100, marginPct) : 0}%` }}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                      <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                        <div className="text-[10px] text-[#757E8F]">网络丢包</div>
                        <div className="tabular text-[12.5px] font-medium text-[#E6E9EF]">{s.src_lost}</div>
                      </div>
                      <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                        <div className="text-[10px] text-[#757E8F]">重传救回</div>
                        <div className="tabular text-[12.5px] font-medium text-[#FBBF24]">{s.src_retrans}</div>
                      </div>
                      <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                        <div className="text-[10px] text-[#757E8F]">未恢复弃包</div>
                        <div
                          className={cn(
                            "tabular text-[12.5px] font-medium",
                            s.src_dropped > 0 ? "text-[#F87171]" : srcFlowing ? "text-[#4ADE80]" : "text-[#98A1B0]"
                          )}
                        >
                          {s.src_dropped}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="mt-auto rounded border border-[#1E222B] bg-[#13161B] p-2.5 text-[11.5px] text-[#98A1B0]">
                    <div>端到端加密直通透传 · 由编解码器直接协商缓冲</div>
                    <div className="tabular mt-1 text-[#C5CCD8]">
                      监听 :{leg.in_port} → {leg.target_addr || s.dst_peer_ip || "-"}
                    </div>
                  </div>
                )}
              </div>

              <div className="hidden lg:flex items-center justify-center text-[#454D5C]">
                <ArrowRight className="h-4 w-4" />
              </div>

              {/* Stage 2: Relay Gateway */}
              <div className="rounded-md border border-[#1E222B] bg-[#0E1014] p-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#7C8596]">中转服务器</span>
                  <span className="tabular text-[11px] text-[#98A1B0]">{leg.node_id}</span>
                </div>
                <div className="tabular text-[13px] font-medium text-[#F1F3F6]">
                  {leg.channel_id}{" "}
                  <span className="text-[11px] font-normal text-[#757E8F]">
                    (:{leg.in_port}{!isPass ? `→:${leg.out_port}` : ""})
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1.5 mt-auto">
                  <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                    <div className="text-[10px] text-[#757E8F]">通道状态</div>
                    <div className={cn("text-[12px] font-medium", s.process_state === "running" ? "text-[#4ADE80]" : "text-[#F87171]")}>
                      {s.process_state === "running" ? "运行中" : s.process_state || "-"}
                    </div>
                  </div>
                  <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                    <div className="text-[10px] text-[#757E8F]">异常重启</div>
                    <div className={cn("tabular text-[12px] font-medium", restarts === 0 ? "text-[#4ADE80]" : "text-[#F87171]")}>
                      {restarts} 次
                    </div>
                  </div>
                  <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                    <div className="text-[10px] text-[#757E8F]">持续运行</div>
                    <div className="tabular text-[12px] font-medium text-[#E6E9EF]">{formatUptime(s.uptime_sec)}</div>
                  </div>
                  <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                    <div className="text-[10px] text-[#757E8F]">系统缓冲丢包</div>
                    <div className={cn("tabular text-[12px] font-medium", udpDrops === 0 ? "text-[#4ADE80]" : "text-[#F87171]")}>
                      {udpDrops}
                    </div>
                  </div>
                </div>
              </div>

              <div className="hidden lg:flex items-center justify-center text-[#454D5C]">
                <ArrowRight className="h-4 w-4" />
              </div>

              {/* Stage 3: Egress */}
              <div className="rounded-md border border-[#1E222B] bg-[#0E1014] p-3 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-[#7C8596]">拉流端 · 收端</span>
                  <StatusBadge tone={dstBadge.tone}>{dstBadge.label}</StatusBadge>
                </div>
                <div>
                  <div className="text-[13px] font-medium text-[#F1F3F6] truncate">
                    {leg.dst_device || "收端解码器"}
                  </div>
                  <div className="tabular mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-[#98A1B0]">
                    <span>IP {s.dst_peer_ip || leg.target_addr || "-"}</span>
                    <span>{s.dst_mbps.toFixed(2)} Mb/s</span>
                    {!isPass && <span>RTT {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)}ms` : "-"}</span>}
                  </div>
                </div>

                {!isPass ? (
                  <>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-[#7C8596]">拉流时延 (告警参考 250ms)</span>
                        <span className={cn("tabular", textTone(dstRttLevel))}>
                          {s.dst_rtt_ms > 0 ? `${s.dst_rtt_ms.toFixed(0)} ms` : "-"}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1D212A]">
                        <div
                          className={cn("h-full transition-all", barColor(dstRttLevel))}
                          style={{ width: `${dstFlowing && s.dst_rtt_ms > 0 ? dstRttPct : 0}%` }}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                      <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                        <div className="text-[10px] text-[#757E8F]">网络丢包</div>
                        <div className="tabular text-[12.5px] font-medium text-[#E6E9EF]">{s.dst_lost}</div>
                      </div>
                      <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                        <div className="text-[10px] text-[#757E8F]">重传救回</div>
                        <div className="tabular text-[12.5px] font-medium text-[#FBBF24]">{s.dst_retrans}</div>
                      </div>
                      <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                        <div className="text-[10px] text-[#757E8F]">未恢复弃包</div>
                        <div
                          className={cn(
                            "tabular text-[12.5px] font-medium",
                            s.dst_dropped > 0 ? "text-[#F87171]" : dstFlowing ? "text-[#4ADE80]" : "text-[#98A1B0]"
                          )}
                        >
                          {s.dst_dropped}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="grid grid-cols-3 gap-1.5 mt-auto">
                    <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                      <div className="text-[10px] text-[#757E8F]">请求重发</div>
                      <div className="tabular text-[12.5px] font-medium text-[#E6E9EF]">{s.dst_nak_count}</div>
                    </div>
                    <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                      <div className="text-[10px] text-[#757E8F]">重传救回</div>
                      <div className="tabular text-[12.5px] font-medium text-[#FBBF24]">{s.src_retrans}</div>
                    </div>
                    <div className="rounded border border-[#1E222B] bg-[#13161B] px-2 py-1.5">
                      <div className="text-[10px] text-[#757E8F]">未恢复弃包</div>
                      <div
                        className={cn(
                          "tabular text-[12.5px] font-medium",
                          s.src_dropped > 0 ? "text-[#F87171]" : srcFlowing ? "text-[#4ADE80]" : "text-[#98A1B0]"
                        )}
                      >
                        {s.src_dropped}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
