import type { BroadcastTone } from "@/api";
import { cn } from "@/lib/utils";

export function TallyDot({ tone, className }: { tone: BroadcastTone; className?: string }) {
  const color =
    tone === "ok"
      ? "bg-[#22C55E]"
      : tone === "warn"
      ? "bg-[#F59E0B]"
      : tone === "crit"
      ? "bg-[#EF4444]"
      : "bg-[#525B6B]";
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color, className)} />;
}

export function StatusBadge({
  tone,
  children,
  className,
  showDot = false,
}: {
  tone: BroadcastTone;
  children: React.ReactNode;
  className?: string;
  showDot?: boolean;
}) {
  const styles =
    tone === "ok"
      ? "border-[#1E3B2A] bg-[#102418] text-[#4ADE80]"
      : tone === "warn"
      ? "border-[#463315] bg-[#241B0D] text-[#FBBF24]"
      : tone === "crit"
      ? "border-[#4C1E22] bg-[#281215] text-[#F87171]"
      : "border-[#262B35] bg-[#16191F] text-[#98A1B0]";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium border leading-tight whitespace-nowrap",
        styles,
        className
      )}
    >
      {showDot && <TallyDot tone={tone} className="h-1.5 w-1.5" />}
      {children}
    </span>
  );
}
