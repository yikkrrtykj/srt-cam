import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  signalName: string;
  activeMbps: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function StopStreamDialog({
  open,
  signalName,
  activeMbps,
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#F87171]">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            确认停止正在传输的信号？
          </DialogTitle>
          <DialogDescription>
            信号 <strong className="text-[#F1F3F6]">{signalName}</strong> 当前正在推流（
            <span className="tabular font-medium text-[#FBBF24]">
              {activeMbps.toFixed(1)} Mb/s
            </span>
            ）。关闭流开关将立即停止底层 SRT 转发容器并中断当前画面传输，同时解锁该路的服务器、通道和端口参数。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? "正在停止..." : "确认停止信号流"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
