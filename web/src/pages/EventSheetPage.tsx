import { useEffect, useState } from "react";
import type { EventSheet, LegConfig, SignalGroupConfig } from "../types";
import { api } from "../api";

interface Props {
  onSaved: () => void;
}

export function EventSheetPage({ onSaved }: Props) {
  const [sheet, setSheet] = useState<EventSheet | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [rawJSON, setRawJSON] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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
      setMsg({ kind: "ok", text: "配置已保存" });
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
    a.download = `event-sheet-${sheet.event_name || "srt-cam"}.json`;
    a.click();
    URL.revokeObjectURL(url);
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

  function addGroup() {
    if (!sheet) return;
    const n = sheet.signal_groups.length + 1;
    const created: SignalGroupConfig = {
      id: `route-${n}`,
      name: `CAM${n}`,
      direction: "venue_to_hub",
      redundancy_type: "single",
      expected_active: false,
      legs: [
        {
          role: "single",
          node_id: "vps-1",
          channel_id: `srt-cam${Math.min(n, 10)}`,
          mode: "srt-relay",
          carrier: "电信",
          src_device: "",
          dst_device: "",
          in_port: 21110 + Math.min(n, 10),
          out_port: 11110 + Math.min(n, 10),
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
    const backup: LegConfig = {
      role: "backup",
      node_id: "vps-2",
      channel_id: first?.channel_id || "srt-cam1",
      mode: first?.mode || "srt-relay",
      carrier: "联通",
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
    return <div className="panel" style={{ padding: 16 }}>加载中...</div>;
  }

  return (
    <div>
      <div className="toolbar-row">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>路由表配置</strong>
          <span className="pill pill-idle">{sheet.signal_groups.length} 组</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn" onClick={() => setJsonMode(!jsonMode)}>
            {jsonMode ? "表单视图" : "JSON 编辑"}
          </button>
          <button type="button" className="btn" onClick={handleExportJSON}>
            导出 JSON
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
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
                <label>场次名称</label>
                <input
                  className="input"
                  value={sheet.event_name}
                  onChange={(e) => {
                    const next = { ...sheet, event_name: e.target.value };
                    setSheet(next);
                    setRawJSON(JSON.stringify(next, null, 2));
                  }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>现场端名称</label>
                <input
                  className="input"
                  value={sheet.sites.venue}
                  onChange={(e) => {
                    const next = { ...sheet, sites: { ...sheet.sites, venue: e.target.value } };
                    setSheet(next);
                    setRawJSON(JSON.stringify(next, null, 2));
                  }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>制作中心名称</label>
                <input
                  className="input"
                  value={sheet.sites.hub}
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
                    style={{ width: 130, fontWeight: 600 }}
                    value={grp.name}
                    onChange={(e) => updateGroup(gIdx, { name: e.target.value })}
                    placeholder="路由名"
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
                    <option value="single">单路</option>
                    <option value="dual_hardware">双机热备</option>
                    <option value="makito_bonding">Path Redundancy (单机双路无缝)</option>
                  </select>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={grp.expected_active}
                      onChange={(e) => updateGroup(gIdx, { expected_active: e.target.checked })}
                    />
                    告警监控
                  </label>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {grp.legs.length < 2 && (
                    <button type="button" className="btn btn-xs" onClick={() => addBackupLeg(gIdx)}>
                      + 备路
                    </button>
                  )}
                  <button type="button" className="btn btn-xs btn-danger" onClick={() => removeGroup(gIdx)}>
                    删除
                  </button>
                </div>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="gw-table">
                  <thead>
                    <tr>
                      <th>角色</th>
                      <th>节点</th>
                      <th>容器</th>
                      <th>模式</th>
                      <th>运营商</th>
                      <th>发端设备</th>
                      <th>收端设备</th>
                      <th>入 / 出端口</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grp.legs.map((leg, lIdx) => (
                      <tr key={lIdx}>
                        <td>
                          <select
                            className="select"
                            value={leg.role}
                            onChange={(e) => updateLeg(gIdx, lIdx, { role: e.target.value })}
                          >
                            <option value="primary">主</option>
                            <option value="backup">备</option>
                            <option value="single">单</option>
                          </select>
                        </td>
                        <td>
                          <input
                            className="input mono"
                            style={{ width: 82 }}
                            value={leg.node_id}
                            onChange={(e) => updateLeg(gIdx, lIdx, { node_id: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input mono"
                            style={{ width: 102 }}
                            value={leg.channel_id}
                            onChange={(e) => updateLeg(gIdx, lIdx, { channel_id: e.target.value })}
                          />
                        </td>
                        <td>
                          <select
                            className="select"
                            value={leg.mode}
                            onChange={(e) => updateLeg(gIdx, lIdx, { mode: e.target.value as LegConfig["mode"] })}
                          >
                            <option value="srt-relay">SRT Relay</option>
                            <option value="udp-passthrough">UDP Pass</option>
                          </select>
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ width: 74 }}
                            value={leg.carrier}
                            onChange={(e) => updateLeg(gIdx, lIdx, { carrier: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ width: 155 }}
                            value={leg.src_device}
                            onChange={(e) => updateLeg(gIdx, lIdx, { src_device: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ width: 155 }}
                            value={leg.dst_device}
                            onChange={(e) => updateLeg(gIdx, lIdx, { dst_device: e.target.value })}
                          />
                        </td>
                        <td className="mono" style={{ whiteSpace: "nowrap" }}>
                          <input
                            className="input mono"
                            style={{ width: 68 }}
                            type="number"
                            value={leg.in_port}
                            onChange={(e) => updateLeg(gIdx, lIdx, { in_port: Number(e.target.value) })}
                          />
                          {" / "}
                          <input
                            className="input mono"
                            style={{ width: 68 }}
                            type="number"
                            value={leg.out_port}
                            onChange={(e) => updateLeg(gIdx, lIdx, { out_port: Number(e.target.value) })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <button type="button" className="btn" onClick={addGroup}>
            + 添加路由
          </button>
        </>
      )}
    </div>
  );
}
