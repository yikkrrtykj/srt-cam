import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "@/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-[#F87171]" />
            重置单路信号通道
          </DialogTitle>
          <DialogDescription>
            信号 <strong className="text-[#F1F3F6]">{signalName}</strong> · 通道{" "}
            <code className="tabular rounded bg-[#1B1F27] px-1.5 py-0.5 text-[#E6E9EF]">
              {channelId}
            </code>
            （服务器 {nodeName || nodeId}）。仅断开并重建该路中转，其他信号不受影响。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="mt-3 rounded-md border border-[#542228] bg-[#251316] px-3 py-2 text-[12px] text-[#F87171]">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-2">
          <label
            htmlFor="confirm-channel-input"
            className="block text-[12px] text-[#98A1B0]"
          >
            为防误操作，请输入通道编号{" "}
            <code className="tabular text-[#F1F3F6]">{channelId}</code> 确认
          </label>
          <Input
            id="confirm-channel-input"
            className="tabular"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={channelId}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmInput.trim() === channelId && !busy) {
                void handleConfirm();
              }
            }}
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={busy || confirmInput.trim() !== channelId}
            onClick={handleConfirm}
          >
            {busy ? "重置中..." : "确认重置"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
