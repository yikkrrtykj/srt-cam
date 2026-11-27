import { useEffect, useState } from "react";
import { Bell, RefreshCw, Save, Send, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { AlertConfigView, FaultEvent, OverviewResponse } from "@/types";
import { api, faultLayerLabel, formatDateTime, groupStatusMeta, severityMeta } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusBadge, TallyDot } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  overview: OverviewResponse;
  onRefreshOverview: () => void;
}

const SPORTS_PRESET = {
  minFlowMbps: 0.5,
  highRttMs: 200,
  highLoss: 60,
  highRetrans: 80,
  highNak: 60,
  udpDropTrigger: 10,
};

const DEFAULT_PRESET = {
  minFlowMbps: 0.1,
  highRttMs: 250,
  highLoss: 20,
  highRetrans: 30,
  highNak: 20,
  udpDropTrigger: 10,
};

export function AlertsPage({ overview, onRefreshOverview }: Props) {
  const [cfg, setCfg] = useState<AlertConfigView | null>(null);
  const [events, setEvents] = useState<FaultEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busySignalId, setBusySignalId] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [webhookInput, setWebhookInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [debounceSec, setDebounceSec] = useState(10);
  const [cooldownSec, setCooldownSec] = useState(180);
  const [watchdogSec, setWatchdogSec] = useState(20);
  const [dashboardUrl, setDashboardUrl] = useState("");

  const [minFlowMbps, setMinFlowMbps] = useState(0.1);
  const [highRttMs, setHighRttMs] = useState(250);
  const [highLoss, setHighLoss] = useState(20);
  const [highRetrans, setHighRetrans] = useState(30);
  const [highNak, setHighNak] = useState(20);
  const [udpDropTrigger, setUdpDropTrigger] = useState(10);

  async function loadAll() {
    setLoading(true);
    try {
      const [ac, evRes] = await Promise.all([api.getAlertConfig(), api.events()]);
      applyConfigView(ac);
      setEvents(evRes.events);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载告警设置失败");
    } finally {
      setLoading(false);
    }
  }

  function applyConfigView(ac: AlertConfigView) {
    setCfg(ac);
    setEnabled(ac.feishu.enabled);
    setWebhookInput("");
    setSecretInput("");
    setClearSecret(false);
    setDebounceSec(ac.feishu.debounce_sec);
    setCooldownSec(ac.feishu.cooldown_sec);
    setWatchdogSec(ac.feishu.watchdog_sec);
    setDashboardUrl(ac.feishu.dashboard_base_url || "");
    setMinFlowMbps(ac.thresholds.min_flow_mbps);
    setHighRttMs(ac.thresholds.high_rtt_ms);
    setHighLoss(ac.thresholds.high_loss_per_sample);
    setHighRetrans(ac.thresholds.high_retrans);
    setHighNak(ac.thresholds.high_nak_lost);
    setUdpDropTrigger(ac.thresholds.udp_buf_drop_trigger);
  }

  function applyThresholdPreset(preset: typeof SPORTS_PRESET, name: string) {
    setMinFlowMbps(preset.minFlowMbps);
    setHighRttMs(preset.highRttMs);
    setHighLoss(preset.highLoss);
    setHighRetrans(preset.highRetrans);
    setHighNak(preset.highNak);
    setUdpDropTrigger(preset.udpDropTrigger);
    toast.success(`已填入「${name}」阈值，点击右上角保存配置后生效`);
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.saveAlertConfig({
        feishu: {
          enabled,
          webhook_url: webhookInput.trim(),
          secret: secretInput.trim(),
          clear_secret: clearSecret,
          debounce_sec: Number(debounceSec) || 10,
          cooldown_sec: Number(cooldownSec) || 180,
          watchdog_sec: Number(watchdogSec) || 20,
          dashboard_base_url: dashboardUrl.trim(),
        },
        thresholds: {
          min_flow_mbps: Number(minFlowMbps) || 0.1,
          high_rtt_ms: Number(highRttMs) || 250,
          high_loss_per_sample: Math.max(0, Number(highLoss) || 0),
          high_retrans: Math.max(0, Number(highRetrans) || 0),
          high_nak_lost: Math.max(0, Number(highNak) || 0),
          udp_buf_drop_trigger: Math.max(0, Number(udpDropTrigger) || 0),
        },
      });
      applyConfigView(updated);
      toast.success("告警配置已保存并立即生效");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存告警配置失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestFeishu() {
    setTesting(true);
    try {
      await api.testFeishu();
      toast.success("测试飞书告警卡片已发送，请检查群聊消息");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "测试飞书发送失败");
    } finally {
      setTesting(false);
    }
  }

  async function handleToggleSignal(groupId: string, name: string, active: boolean) {
    setBusySignalId(groupId);
    try {
      await api.toggleExpectedActive(groupId, active);
      toast.success(`${name} 已${active ? "开启断流告警" : "设为待机"}`);
      onRefreshOverview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换失败");
    } finally {
      setBusySignalId(null);
    }
  }

  if (loading && !cfg) {
    return (
      <div className="mx-auto max-w-[1280px] p-5 text-[12.5px] text-[#7C8596]">
        正在加载告警设置...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] p-4 lg:p-6 space-y-5">
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[#F1F3F6]">告警设置与飞书通知</h1>
          <p className="mt-0.5 text-[12px] text-[#8B94A5]">
            统一配置飞书群机器人通知、防抖冷却、信号异常判定阈值与单路断流告警开关。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleTestFeishu} disabled={testing}>
            <Send className="h-3.5 w-3.5" />
            {testing ? "发送中..." : "发送测试飞书"}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
            {saving ? "保存中..." : "保存配置"}
          </Button>
        </div>
      </div>

      {/* Main 2-Column Configuration Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Card 1: Feishu Webhook */}
        <section className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#1E222B] bg-[#14171C] px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-[#98A1B0]" />
              <h2 className="text-[13px] font-medium text-[#F1F3F6]">飞书群机器人通知</h2>
              {cfg && (
                <StatusBadge tone={cfg.feishu.enabled ? "ok" : "idle"}>
                  {cfg.feishu.enabled ? "已启用" : "未启用"}
                </StatusBadge>
              )}
            </div>
            <label className="inline-flex items-center gap-2 text-[12px] text-[#C8CFD9] cursor-pointer select-none">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              启用推送
            </label>
          </div>

          <div className="p-4 space-y-3.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[12px] text-[#98A1B0]">Webhook 地址</label>
                {cfg?.feishu.webhook_configured && (
                  <span className="tabular text-[11px] text-[#4ADE80]">
                    已配置：{cfg.feishu.webhook_masked}
                  </span>
                )}
              </div>
              <Input
                className="tabular"
                value={webhookInput}
                onChange={(e) => setWebhookInput(e.target.value)}
                placeholder={
                  cfg?.feishu.webhook_configured
                    ? "留空保持现有地址，或粘贴新 Webhook 替换"
                    : "https://open.feishu.cn/open-apis/bot/v2/hook/..."
                }
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[12px] text-[#98A1B0]">签名校验密钥（可选）</label>
                {cfg?.feishu.secret_configured && !clearSecret && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[#4ADE80]">已配置</span>
                    <button
                      type="button"
                      className="text-[11px] text-[#98A1B0] underline hover:text-[#F87171] cursor-pointer"
                      onClick={() => setClearSecret(true)}
                    >
                      清除密钥
                    </button>
                  </div>
                )}
                {clearSecret && (
                  <span className="text-[11px] text-[#FBBF24]">保存后将清除现有密钥</span>
                )}
              </div>
              <Input
                type="password"
                value={secretInput}
                onChange={(e) => {
                  setSecretInput(e.target.value);
                  if (e.target.value) setClearSecret(false);
                }}
                placeholder={
                  cfg?.feishu.secret_configured
                    ? "留空保持现有密钥"
                    : "飞书机器人安全设置中的签名密钥（若未开启可留空）"
                }
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] text-[#98A1B0]">
                控制台访问地址（可选，留空不影响推送）
              </label>
              <Input
                className="tabular"
                value={dashboardUrl}
                onChange={(e) => setDashboardUrl(e.target.value)}
                placeholder="填写后飞书告警卡片内会附带“查看链路趋势”跳转按钮"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 pt-1">
              <div className="space-y-1.5">
                <label className="block text-[11.5px] text-[#98A1B0]">持续防抖 (秒)</label>
                <Input
                  type="number"
                  min={1}
                  max={600}
                  className="tabular"
                  value={debounceSec}
                  onChange={(e) => setDebounceSec(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-[11.5px] text-[#98A1B0]">重复冷却 (秒)</label>
                <Input
                  type="number"
                  min={10}
                  max={86400}
                  className="tabular"
                  value={cooldownSec}
                  onChange={(e) => setCooldownSec(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-[11.5px] text-[#98A1B0]">备节点接管 (秒)</label>
                <Input
                  type="number"
                  min={5}
                  max={600}
                  className="tabular"
                  value={watchdogSec}
                  onChange={(e) => setWatchdogSec(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="rounded-md border border-[#1E222B] bg-[#0D0F12] px-3 py-2 text-[11.5px] text-[#7C8596]">
              修改 Webhook 后请先点击右上角“保存配置”，再点击“发送测试飞书”验证群聊是否收到测试卡片。
            </div>
          </div>
        </section>

        {/* Card 2: Diagnostic Thresholds */}
        <section className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-[#98A1B0]" />
              <h2 className="text-[13px] font-medium text-[#F1F3F6]">信号异常判定阈值</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => applyThresholdPreset(SPORTS_PRESET, "赛事回传推荐")}
              >
                赛事回传推荐
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => applyThresholdPreset(DEFAULT_PRESET, "通用默认")}
              >
                恢复默认
              </Button>
            </div>
          </div>

          <div className="p-4 space-y-3.5">
            <div className="rounded-md border border-[#1E222B] bg-[#0D0F12] px-3 py-2.5 text-[11.5px] text-[#98A1B0] space-y-1">
              <div>
                <span className="inline-block h-2 w-2 rounded-full bg-[#EF4444] mr-1.5 align-middle" />
                <strong className="text-[#F1F3F6]">红灯（中断）</strong>：码率掉到“最低码率”以下，或通道停止运行。
              </div>
              <div>
                <span className="inline-block h-2 w-2 rounded-full bg-[#F59E0B] mr-1.5 align-middle" />
                <strong className="text-[#F1F3F6]">黄灯（波动）</strong>：出现任意<strong className="text-[#E6E9EF]">未恢复弃包（真丢画面）</strong>、4×时延超过设定缓冲，或超过下方任意预警线。
              </div>
              <div>
                <span className="inline-block h-2 w-2 rounded-full bg-[#22C55E] mr-1.5 align-middle" />
                <strong className="text-[#F1F3F6]">绿灯（正常）</strong>：推流与拉流码率正常、0 弃包，且各项指标均在安全范围内。
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <ThresholdField
                label="断流判定码率 (Mb/s)"
                hint="低于此码率即判定为断流（红灯）"
                value={minFlowMbps}
                step="0.05"
                onChange={setMinFlowMbps}
              />
              <ThresholdField
                label="高延迟预警线 (ms)"
                hint="往返时延 RTT 超过此值报波动（黄灯）"
                value={highRttMs}
                step="10"
                onChange={setHighRttMs}
              />
              <ThresholdField
                label="2 秒内丢包预警线 (包)"
                hint="轻微丢包可被 SRT 自动救回，调大可减少误报"
                value={highLoss}
                onChange={setHighLoss}
              />
              <ThresholdField
                label="2 秒内重传预警线 (包)"
                hint="重传超此数提示线路变差（若出现弃包必立刻告警）"
                value={highRetrans}
                onChange={setHighRetrans}
              />
              <ThresholdField
                label="透传模式重发请求线 (包)"
                hint="仅加密透传生效：解码端 2 秒内请求重发上限"
                value={highNak}
                onChange={setHighNak}
              />
              <ThresholdField
                label="服务器过载丢包线 (包)"
                hint="中转服务器自身收包溢出上限，正常应为 0"
                value={udpDropTrigger}
                onChange={setUdpDropTrigger}
              />
            </div>
          </div>
        </section>
      </div>

      {/* Section 3: Signal Alarm Arm/Disarm Matrix */}
      <section className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-[#F1F3F6]">
            信号断流告警开关 ({overview.groups.filter((g) => g.expected_active).length}/{overview.groups.length} 路已开启)
          </h2>
          <span className="text-[11.5px] text-[#757E8F]">
            仅已开启“断流告警”的在播信号会触发飞书推送，未开播通道请保持关闭
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="border-b border-[#1E222B] text-[11px] text-[#757E8F]">
              <tr>
                <th className="px-4 py-2 font-medium">信号名称</th>
                <th className="px-3 py-2 font-medium">当前状态</th>
                <th className="px-3 py-2 font-medium">通道 / 端口</th>
                <th className="px-3 py-2 font-medium">实时码率</th>
                <th className="px-4 py-2 font-medium text-right">断流告警</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A1E26]">
              {overview.groups.map((g) => {
                const st = groupStatusMeta(g);
                const leg = g.legs[0];
                return (
                  <tr key={g.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 font-medium text-[#F1F3F6]">
                      <div className="flex items-center gap-2">
                        <TallyDot tone={st.tone} />
                        {g.name}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                    </td>
                    <td className="tabular px-3 py-2.5 text-[#98A1B0]">
                      {leg ? `${leg.node_id} / ${leg.channel_id} (:${leg.in_port})` : "-"}
                    </td>
                    <td className="tabular px-3 py-2.5 text-[#D3D8E0]">
                      {leg ? `${leg.sample.src_mbps.toFixed(2)} Mb/s` : "-"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Switch
                        checked={g.expected_active}
                        disabled={busySignalId === g.id}
                        onCheckedChange={(checked) => void handleToggleSignal(g.id, g.name, checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Section 4: Global Recent Alert / Incident Log */}
      <section className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-[#F1F3F6]">
            近期全站告警记录 ({events.length})
          </h2>
          <Button variant="ghost" size="xs" onClick={() => void loadAll()} disabled={loading}>
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
        {events.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-[#6B7485]">
            近 7 天暂无异常告警记录
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="border-b border-[#1E222B] text-[11px] text-[#757E8F]">
                <tr>
                  <th className="px-4 py-2 font-medium">发生时间</th>
                  <th className="px-3 py-2 font-medium">恢复时间</th>
                  <th className="px-3 py-2 font-medium">信号</th>
                  <th className="px-3 py-2 font-medium">通道</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">区段</th>
                  <th className="px-4 py-2 font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A1E26]">
                {events.slice(0, 50).map((ev) => {
                  const sm = severityMeta(ev.severity);
                  return (
                    <tr key={ev.id} className="hover:bg-white/[0.02]">
                      <td className="tabular px-4 py-2 text-[#C8CFD9] whitespace-nowrap">
                        {formatDateTime(ev.start_ts)}
                      </td>
                      <td className="tabular px-3 py-2 text-[#8B94A5] whitespace-nowrap">
                        {ev.end_ts ? formatDateTime(ev.end_ts) : "持续中"}
                      </td>
                      <td className="px-3 py-2 font-medium text-[#F1F3F6] whitespace-nowrap">
                        {ev.signal_name}
                      </td>
                      <td className="tabular px-3 py-2 text-[#98A1B0] whitespace-nowrap">
                        {ev.node_id}/{ev.channel_id}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge tone={sm.tone}>{sm.label}</StatusBadge>
                      </td>
                      <td className="px-3 py-2 text-[#98A1B0] whitespace-nowrap">
                        {faultLayerLabel(ev.fault_layer)}
                      </td>
                      <td className="px-4 py-2 text-[#D3D8E0]">{ev.summary}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ThresholdField({
  label,
  hint,
  value,
  step = "1",
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  step?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[12px] text-[#C8CFD9]">{label}</label>
      <Input
        type="number"
        step={step}
        min={0}
        className="tabular"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="text-[11px] text-[#6B7485]">{hint}</div>
    </div>
  );
}
