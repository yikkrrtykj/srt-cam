import { useState } from "react";
import { api } from "../api";

interface Props {
  nodeId: string;
  nodeName: string;
  channelId: string;
  signalName: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export function SafeRestartModal({
  nodeId,
  nodeName,
  channelId,
  signalName,
  onClose,
  onSuccess,
}: Props) {
  const [confirmInput, setConfirmInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setBusy(true);
    setError("");
    try {
      await api.restartChannel(nodeId, channelId, confirmInput.trim());
      onSuccess(`已重置通道 ${signalName} (${channelId})`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="restart-modal-title">
      <div className="modal-box">
        <h2 id="restart-modal-title">重置单路信号通道</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 12px" }}>
          信号 <strong>{signalName}</strong> · 通道{" "}
          <code className="mono">{channelId}</code>（服务器 {nodeName || nodeId}）。
          仅断开并重建该路中转，其他信号不受影响。
        </p>

        {error && <div className="notice notice-err">{error}</div>}

        <div className="field">
          <label htmlFor="confirm-channel-input">
            为防误操作，请输入通道编号 <code className="mono">{channelId}</code> 确认
          </label>
          <input
            id="confirm-channel-input"
            className="input mono"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={channelId}
            autoFocus
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || confirmInput.trim() !== channelId}
            onClick={handleConfirm}
          >
            {busy ? "重置中..." : "确认重置"}
          </button>
        </div>
      </div>
    </div>
  );
}
