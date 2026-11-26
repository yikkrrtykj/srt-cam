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
      onSuccess(`已安全重启单路 ${nodeId}/${channelId}（其他通道零影响）`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重启失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="restart-modal-title">
      <div className="modal-card">
        <h2 id="restart-modal-title">单路安全重启二次确认</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 12px" }}>
          将仅重启信号 <strong>{signalName}</strong> 对应的单个容器{" "}
          <code className="mono">{nodeId} / {channelId}</code>（{nodeName}）。
          <br />
          <strong>同节点其他通道不受任何影响</strong>，本次操作将写入审计日志。
        </p>

        {error && <div className="notice-bar notice-err">{error}</div>}

        <div className="form-field">
          <label htmlFor="confirm-channel-input">
            请输入通道名 <code className="mono">{channelId}</code> 以确认重启：
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || confirmInput.trim() !== channelId}
            onClick={handleConfirm}
          >
            {busy ? "正在重启..." : "确认仅重启此通道"}
          </button>
        </div>
      </div>
    </div>
  );
}
