import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-8 w-full rounded-md border border-[#262B35] bg-[#0D0F12] px-2.5 text-[12.5px] text-[#F1F3F6] placeholder:text-[#586070] transition-colors focus:outline-none focus:border-[#4B5466] focus:ring-1 focus:ring-[#4B5466]/60 disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";
