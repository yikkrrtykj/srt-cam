import { useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import type { ChannelLogsResponse, SignalGroupLiveView } from "@/types";
import { api, formatTime } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Props {
  group: SignalGroupLiveView;
  legIdx: number;
}

export function ChannelLogsPanel({ group, legIdx }: Props) {
  const [tail, setTail] = useState(300);
  const [hideStats, setHideStats] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [data, setData] = useState<ChannelLogsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const safeIdx = legIdx < group.legs.length ? legIdx : 0;
  const activeLeg = group.legs[safeIdx];

  async function loadLogs() {
    if (!activeLeg) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.channelLogs(activeLeg.node_id, activeLeg.channel_id, tail, hideStats);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "通信记录读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    void loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLeg?.node_id, activeLeg?.channel_id, tail, hideStats]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return data.lines;
    return data.lines.filter((l) => l.text.toLowerCase().includes(kw) || l.level.includes(kw));
  }, [data, keyword]);

  async function copyLogs() {
    if (filtered.length === 0) return;
    const text = filtered
      .map((l) => `${l.ts ? l.ts + " " : ""}[${l.level.toUpperCase()}] ${l.text}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${filtered.length} 行通信记录`);
    } catch {
      toast.error("复制失败");
    }
  }

  if (!activeLeg) return null;

  return (
    <div className="rounded-lg border border-[#232730] bg-[#111316] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#1E222B] bg-[#14171C] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-[12px] text-[#C8CFD9] cursor-pointer select-none">
            <Switch checked={hideStats} onCheckedChange={setHideStats} />
            仅看连接与异常
          </label>

          <Select value={String(tail)} onValueChange={(v) => setTail(Number(v))}>
            <SelectTrigger className="w-[126px] h-7 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="100">最近 100 条</SelectItem>
              <SelectItem value="300">最近 300 条</SelectItem>
              <SelectItem value="800">最近 800 条</SelectItem>
            </SelectContent>
          </Select>

          <div className="relative w-[210px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5F6878]" />
            <Input
              className="h-7 pl-8 text-[12px]"
              placeholder="搜索关键字（如断线、DROPPED）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {data && (
            <span className="tabular text-[11px] text-[#757E8F]">
              显示 {filtered.length}/{data.total_lines} · {formatTime(data.fetched_at)}
            </span>
          )}
          <Button variant="outline" size="xs" onClick={copyLogs} disabled={filtered.length === 0}>
            <Copy className="h-3 w-3" />
            复制
          </Button>
          <Button variant="secondary" size="xs" onClick={() => void loadLogs()} disabled={loading}>
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            {loading ? "读取中" : "刷新"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="m-3 rounded-md border border-[#542228] bg-[#251316] px-3 py-2 text-[12px] text-[#F87171]">
          {error}
        </div>
      )}

      <div className="max-h-[460px] overflow-y-auto bg-[#0B0D10] p-3 font-mono text-[11.5px] leading-relaxed">
        {loading && !data ? (
          <div className="py-6 text-center text-[#757E8F]">正在读取通道通信记录...</div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center text-[#757E8F]">
            当前无匹配记录（可关闭“仅看连接与异常”查看全部底层统计）
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "grid grid-cols-[64px_56px_1fr] gap-2 rounded px-1.5 py-0.5 hover:bg-white/[0.03]",
                  line.level === "error" && "bg-[#EF4444]/[0.06]"
                )}
              >
                <span className="tabular text-[#5D6676]">{line.ts || "-"}</span>
                <span
                  className={cn(
                    "uppercase text-[10.5px] font-medium",
                    line.level === "error"
                      ? "text-[#F87171]"
                      : line.level === "warn"
                      ? "text-[#FBBF24]"
                      : line.level === "connect"
                      ? "text-[#4ADE80]"
                      : "text-[#757E8F]"
                  )}
                >
                  {line.level}
                </span>
                <span className="break-all text-[#D3D8E0]">{line.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
