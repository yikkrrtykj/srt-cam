import { useEffect, useState } from "react";
import type { LegLiveView } from "../types";

interface Props {
  leg: LegLiveView;
  label: string;
  size?: "sm" | "md";
}

export function RouteThumbnail({ leg, label, size = "sm" }: Props) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Refresh keyframe thumbnail every 5 seconds
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((t) => t + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let prevObjectURL: string | null = null;

    async function load() {
      const url = `/api/v1/channels/${encodeURIComponent(leg.node_id)}/${encodeURIComponent(
        leg.channel_id
      )}/thumbnail?label=${encodeURIComponent(label)}&t=${tick}`;
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (res.status === 204 || !res.ok) {
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

    void load();
    return () => {
      active = false;
      if (prevObjectURL) {
        URL.revokeObjectURL(prevObjectURL);
      }
    };
  }, [leg.node_id, leg.channel_id, label, tick]);

  const s = leg.sample;
  const flowing = leg.node_online && s.src_connected && s.src_mbps >= 0.1;
  const cls = size === "md" ? "hv-thumb hv-thumb-md" : "hv-thumb";

  if (imgSrc) {
    return (
      <div className={cls}>
        <img src={imgSrc} alt={`${label} 画面预览`} />
      </div>
    );
  }

  // Clean fallback monitor tile when no real preview source is configured (HTTP 204)
  return (
    <div className={`${cls} hv-thumb-fallback`}>
      {!flowing ? (
        <span className="hv-thumb-tag mono">
          {s.fault_code === "IDLE_EXPECTED_OFF" ? "STANDBY" : "NO SIGNAL"}
        </span>
      ) : s.encrypted ? (
        <span className="hv-thumb-tag hv-thumb-enc mono">AES</span>
      ) : (
        <span className="hv-thumb-tag hv-thumb-live mono">{s.src_mbps.toFixed(1)}M</span>
      )}
    </div>
  );
}
