import { useEffect, useState } from "react";
import type { LegLiveView } from "@/types";
import { cn } from "@/lib/utils";

interface Props {
  leg: LegLiveView;
  label: string;
  variant?: "mini" | "hero" | "wall";
  className?: string;
}

export function RouteThumbnail({ leg, label, variant = "mini", className }: Props) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((t) => t + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const s = leg.sample;
  const flowing = leg.node_online && s.src_connected && s.src_mbps >= 0.1;

  useEffect(() => {
    let active = true;
    let prevObjectURL: string | null = null;
    let retryTimer: number | null = null;

    async function load(allowRetry: boolean) {
      const url = `/api/v1/channels/${encodeURIComponent(leg.node_id)}/${encodeURIComponent(
        leg.channel_id
      )}/thumbnail?label=${encodeURIComponent(label)}&t=${tick}`;
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (res.status === 204) {
          setImgSrc(null);
          if (allowRetry && tick === 0 && flowing) {
            retryTimer = window.setTimeout(() => {
              if (active) void load(false);
            }, 2000);
          }
          return;
        }
        if (!res.ok) {
          setImgSrc(null);
          return;
        }
        const blob = await res.blob();
        if (!active || blob.size === 0) return;
        const objURL = URL.createObjectURL(blob);
        prevObjectURL = objURL;
        setImgSrc((old) => {
          if (old) URL.revokeObjectURL(old);
          return objURL;
        });
      } catch {
        if (active) setImgSrc(null);
      }
    }

    void load(true);
    return () => {
      active = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (prevObjectURL) {
        URL.revokeObjectURL(prevObjectURL);
      }
    };
  }, [leg.node_id, leg.channel_id, flowing, label, tick]);

  const sizeCls =
    variant === "mini"
      ? "w-[68px] h-[38px] rounded-[4px]"
      : variant === "hero"
      ? "w-[196px] h-[110px] rounded-md"
      : "w-full aspect-video rounded-none";

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden bg-[#14171D] flex items-center justify-center select-none",
        variant !== "wall" && "border border-[#262B35]",
        sizeCls,
        className
      )}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={`${label} 画面预览`}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 text-center px-2">
          {!flowing ? (
            <span
              className={cn(
                "tabular font-medium tracking-wider text-[#5A6373]",
                variant === "mini" ? "text-[9px]" : variant === "wall" ? "text-[11px]" : "text-[10.5px]"
              )}
            >
              {s.fault_code === "STREAM_STOPPED"
                ? "STOPPED"
                : s.fault_code === "IDLE_EXPECTED_OFF"
                ? "STANDBY"
                : "NO SIGNAL"}
            </span>
          ) : s.encrypted ? (
            <span
              className={cn(
                "tabular font-medium tracking-wider text-[#98A1B0]",
                variant === "mini" ? "text-[9.5px]" : "text-[11px]"
              )}
            >
              AES · {s.src_mbps.toFixed(1)}M
            </span>
          ) : (
            <span
              className={cn(
                "tabular font-medium tracking-wider text-[#98A1B0]",
                variant === "mini" ? "text-[9.5px]" : "text-[11px]"
              )}
            >
              LIVE · {s.src_mbps.toFixed(1)}M
            </span>
          )}
        </div>
      )}
    </div>
  );
}
