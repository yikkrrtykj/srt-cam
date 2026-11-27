import { useEffect, useState } from "react";
import type { EventSheet, LegConfig, NodeLiveStatus, SignalGroupConfig } from "../types";
import { api, resolveNodeHost } from "../api";

interface Props {
  nodes: NodeLiveStatus[];
  onSaved: () => void;
}

const RELAY_PRESETS = Array.from({ length: 10 }, (_, idx) => {
  const n = idx + 1;
  return {
    channel_id: `srt-cam${n}`,
    label: `通道 ${n} (推 ${21110 + n} → 拉 ${11110 + n})`,
    mode: "srt-relay" as const,
    in_port: 21110 + n,
    out_port: 11110 + n,
  };
});

const PASS_PRESETS = Array.from({ length: 4 }, (_, idx) => {
  const n = idx + 1;
  return {
    channel_id: `srt-pass${n}`,
    label: `透传通道 ${n} (端口 ${31110 + n})`,
    mode: "udp-passthrough" as const,
    in_port: 31110 + n,
    out_port: 41110 + n,
  };
});

const ALL_PRESETS = [...RELAY_PRESETS, ...PASS_PRESETS];

export function EventSheetPage({ nodes, onSaved }: Props) {
  const [sheet, setSheet] = useState<EventSheet | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [rawJSON, setRawJSON] = useState("");
  const [saving, setSaving] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const defaultNodeId = nodes[0]?.node_id || "vps-1";

  useEffect(() => {
    api
      .getEventSheet()
      .then((s) => {
        setSheet(s);
        setRawJSON(JSON.stringify(s, null, 2));
      })
      .catch((err) => setMsg({ kind: "err", text: String(err) }));
  }, []);

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      const payload: EventSheet = jsonMode ? JSON.parse(rawJSON) : sheet!;
      const saved = await api.saveEventSheet(payload);
      setSheet(saved);
      setRawJSON(JSON.stringify(saved, null, 2));
      setMsg({ kind: "ok", text: "通道配置已保存并立即生效" });
      onSaved();
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "保存失败" });
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

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? "" : cur)), 1500);
    } catch {
      // ignore
    }
  }

  function updateGroup(idx: number, patch: Partial<SignalGroupConfig>) {
    if (!sheet) return;
    const next = { ...sheet, signal_groups: [...sheet.signal_groups] };
    next.signal_groups[idx] = { ...next.signal_groups[idx], ...patch };
    setSheet(next);
    setRawJSON(JSON.stringify(next, null, 2));
  }

  function updateLeg(gIdx: number, lIdx: number, patch: Partial<LegConfig>) {
    if (!sheet) return;
    const next = { ...sheet, signal_groups: [...sheet.signal_groups] };
    const legs = [...next.signal_groups[gIdx].legs];
    legs[lIdx] = { ...legs[lIdx], ...patch };
    next.signal_groups[gIdx] = { ...next.signal_groups[gIdx], legs };
    setSheet(next);
    setRawJSON(JSON.stringify(next, null, 2));
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
    const next = { ...sheet, signal_groups: [...sheet.signal_groups, created] };
    setSheet(next);
    setRawJSON(JSON.stringify(next, null, 2));
  }

  function addBackupLeg(gIdx: number) {
    if (!sheet) return;
    const grp = sheet.signal_groups[gIdx];
    const first = grp.legs[0];
    const backupNode = nodes.find((n) => n.node_id !== first?.node_id)?.node_id || "vps-2";
    const backup: LegConfig = {
      role: "backup",
      node_id: backupNode,
      channel_id: first?.channel_id || "srt-cam1",
      mode: first?.mode || "srt-relay",
      carrier: "备用线路",
      src_device: "",
      dst_device: "",
      in_port: first?.in_port || 21111,
      out_port: first?.out_port || 11111,
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
    const next = {
      ...sheet,
      signal_groups: sheet.signal_groups.filter((_, idx) => idx !== gIdx),
    };
    setSheet(next);
    setRawJSON(JSON.stringify(next, null, 2));
  }

  if (!sheet) {
    return <div className="panel" style={{ padding: 16 }}>加载配置中...</div>;
  }

  const nodeOptions = Array.from(
    new Map(
      [
        ...nodes.map((n) => [n.node_id, n.display_name || n.node_id] as const),
        ...sheet.signal_groups.flatMap((g) =>
          g.legs.map((l) => [l.node_id, l.node_id] as const)
        ),
      ]
    ).entries()
  );

  return (
    <div>
      <div className="toolbar-row">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>直播通道配置</strong>
          <span className="pill pill-idle">共 {sheet.signal_groups.length} 路信号</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-xs" onClick={handleExportJSON}>
            备份配置
          </button>
          <button type="button" className="btn btn-xs" onClick={() => setJsonMode(!jsonMode)}>
            {jsonMode ? "返回表单配置" : "高级配置源码"}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存生效"}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`notice ${msg.kind === "ok" ? "notice-ok" : "notice-err"}`}>{msg.text}</div>
      )}

      {jsonMode ? (
        <div className="panel" style={{ padding: 14 }}>
          <textarea
            className="textarea mono"
            style={{ width: "100%", minHeight: 520 }}
            value={rawJSON}
            onChange={(e) => setRawJSON(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>直播项目 / 场次名称</label>
                <input
                  className="input"
                  value={sheet.event_name}
                  placeholder="例如：海外赛事回传"
                  onChange={(e) => {
                    const next = { ...sheet, event_name: e.target.value };
                    setSheet(next);
                    setRawJSON(JSON.stringify(next, null, 2));
                  }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>前方现场名称</label>
                <input
                  className="input"
                  value={sheet.sites.venue}
                  placeholder="例如：海外现场"
                  onChange={(e) => {
                    const next = { ...sheet, sites: { ...sheet.sites, venue: e.target.value } };
                    setSheet(next);
                    setRawJSON(JSON.stringify(next, null, 2));
                  }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>后方制作中心名称</label>
                <input
                  className="input"
                  value={sheet.sites.hub}
                  placeholder="例如：上海制作中心"
                  onChange={(e) => {
                    const next = { ...sheet, sites: { ...sheet.sites, hub: e.target.value } };
                    setSheet(next);
                    setRawJSON(JSON.stringify(next, null, 2));
                  }}
                />
              </div>
            </div>
          </div>

          {sheet.signal_groups.map((grp, gIdx) => (
            <div key={grp.id + gIdx} className="panel">
              <div className="panel-head">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <input
                    className="input"
                    style={{ width: 150, fontWeight: 600 }}
                    value={grp.name}
                    onChange={(e) => updateGroup(gIdx, { name: e.target.value })}
                    placeholder="信号名称（如 PGM / 机位1）"
                  />
                  <select
                    className="select"
                    value={grp.direction}
                    onChange={(e) => updateGroup(gIdx, { direction: e.target.value as SignalGroupConfig["direction"] })}
                  >
                    <option value="venue_to_hub">{sheet.sites.venue || "现场"} → {sheet.sites.hub || "制作中心"}</option>
                    <option value="hub_to_venue">{sheet.sites.hub || "制作中心"} → {sheet.sites.venue || "现场"}</option>
                  </select>
                  <select
                    className="select"
                    value={grp.redundancy_type}
                    onChange={(e) => updateGroup(gIdx, { redundancy_type: e.target.value as SignalGroupConfig["redundancy_type"] })}
                  >
                    <option value="single">单路传输</option>
                    <option value="dual_hardware">双机热备</option>
                    <option value="makito_bonding">单机双路无缝 (Path Redundancy)</option>
                  </select>
                  <label className="switch" title="开启后，若信号中断或波动将发送飞书告警">
                    <input
                      type="checkbox"
                      checked={grp.expected_active}
                      onChange={(e) => updateGroup(gIdx, { expected_active: e.target.checked })}
                    />
                    开启断流告警
                  </label>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {grp.legs.length < 2 && (
                    <button type="button" className="btn btn-xs" onClick={() => addBackupLeg(gIdx)}>
                      + 添加备路
                    </button>
                  )}
                  <button type="button" className="btn btn-xs btn-danger" onClick={() => removeGroup(gIdx)}>
                    删除信号
                  </button>
                </div>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="gw-table">
                  <thead>
                    <tr>
                      <th>主备</th>
                      <th>中转服务器</th>
                      <th>通道号</th>
                      <th>传输模式</th>
                      <th>网络线路</th>
                      <th>编码器 / 发端</th>
                      <th>解码器 / 收端</th>
                      <th>推流 / 拉流端口</th>
                      {grp.legs.length > 1 && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {grp.legs.map((leg, lIdx) => {
                      const isKnownPreset = ALL_PRESETS.some((p) => p.channel_id === leg.channel_id);
                      return (
                        <tr key={lIdx}>
                          <td>
                            <select
                              className="select"
                              value={leg.role}
                              onChange={(e) => updateLeg(gIdx, lIdx, { role: e.target.value })}
                            >
                              <option value="primary">主路</option>
                              <option value="backup">备路</option>
                              <option value="single">单路</option>
                            </select>
                          </td>
                          <td>
                            <select
                              className="select mono"
                              value={leg.node_id}
                              onChange={(e) => updateLeg(gIdx, lIdx, { node_id: e.target.value })}
                            >
                              {nodeOptions.map(([id, label]) => (
                                <option key={id} value={id}>
                                  {id === label ? id : `${id} (${label})`}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              className="select mono"
                              value={leg.channel_id}
                              onChange={(e) => handlePresetChannel(gIdx, lIdx, e.target.value)}
                            >
                              {!isKnownPreset && (
                                <option value={leg.channel_id}>{leg.channel_id}（自定义）</option>
                              )}
                              <optgroup label="标准中转通道 (推流+拉流)">
                                {RELAY_PRESETS.map((p) => (
                                  <option key={p.channel_id} value={p.channel_id}>
                                    {p.label}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="加密透传通道 (Makito 双路无缝)">
                                {PASS_PRESETS.map((p) => (
                                  <option key={p.channel_id} value={p.channel_id}>
                                    {p.label}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          </td>
                          <td>
                            <select
                              className="select"
                              value={leg.mode}
                              onChange={(e) => updateLeg(gIdx, lIdx, { mode: e.target.value as LegConfig["mode"] })}
                            >
                              <option value="srt-relay">标准中转 (推流+拉流)</option>
                              <option value="udp-passthrough">加密透传 (Makito 无缝)</option>
                            </select>
                          </td>
                          <td>
                            <input
                              className="input"
                              style={{ width: 78 }}
                              value={leg.carrier}
                              placeholder="电信/公网"
                              onChange={(e) => updateLeg(gIdx, lIdx, { carrier: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="input"
                              style={{ width: 145 }}
                              value={leg.src_device}
                              placeholder="如：现场编码器 #1"
                              onChange={(e) => updateLeg(gIdx, lIdx, { src_device: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="input"
                              style={{ width: 145 }}
                              value={leg.dst_device}
                              placeholder="如：演播室解码器"
                              onChange={(e) => updateLeg(gIdx, lIdx, { dst_device: e.target.value })}
                            />
                          </td>
                          <td className="mono" style={{ whiteSpace: "nowrap" }}>
                            <input
                              className="input mono"
                              style={{ width: 66 }}
                              type="number"
                              value={leg.in_port}
                              onChange={(e) => updateLeg(gIdx, lIdx, { in_port: Number(e.target.value) })}
                            />
                            {" / "}
                            <input
                              className="input mono"
                              style={{ width: 66 }}
                              type="number"
                              value={leg.out_port}
                              onChange={(e) => updateLeg(gIdx, lIdx, { out_port: Number(e.target.value) })}
                            />
                          </td>
                          {grp.legs.length > 1 && (
                            <td>
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() => removeLeg(gIdx, lIdx)}
                              >
                                移除
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* One-click copyable push/pull SRT addresses for encoders & decoders */}
              <div className="hv-url-bar mono">
                {grp.legs.map((leg, lIdx) => {
                  const host = resolveNodeHost(nodes, leg.node_id);
                  const push = `srt://${host}:${leg.in_port}`;
                  const pull = `srt://${host}:${leg.out_port}`;
                  const roleTag =
                    grp.legs.length > 1 ? (leg.role === "backup" ? "[备] " : "[主] ") : "";
                  const kPush = `${gIdx}-${lIdx}-push`;
                  const kPull = `${gIdx}-${lIdx}-pull`;
                  return (
                    <span key={lIdx} style={{ display: "inline-flex", flexWrap: "wrap", gap: 12 }}>
                      <span className="hv-url-item">
                        <span>{roleTag}推流地址:</span>
                        <strong style={{ color: "var(--text-primary)" }}>{push}</strong>
                        <button
                          type="button"
                          className="hv-copy-btn"
                          onClick={() => void copyText(kPush, push)}
                        >
                          {copiedKey === kPush ? "已复制" : "复制"}
                        </button>
                      </span>
                      {leg.mode !== "udp-passthrough" && (
                        <span className="hv-url-item">
                          <span>{roleTag}拉流地址:</span>
                          <strong style={{ color: "var(--text-primary)" }}>{pull}</strong>
                          <button
                            type="button"
                            className="hv-copy-btn"
                            onClick={() => void copyText(kPull, pull)}
                          >
                            {copiedKey === kPull ? "已复制" : "复制"}
                          </button>
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}

          <button type="button" className="btn" onClick={addGroup}>
            + 新增信号通道
          </button>
        </>
      )}
    </div>
  );
}
