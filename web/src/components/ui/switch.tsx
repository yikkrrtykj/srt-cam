import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-[18px] w-[32px] shrink-0 cursor-pointer items-center rounded-full border border-[#323846] bg-[#1E222B] p-[2px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#525B6B] disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:border-[#22C55E]/70 data-[state=checked]:bg-[#22C55E]/85",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-[12px] w-[12px] rounded-full bg-[#C8CFD9] transition-transform data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-[#08130C] data-[state=unchecked]:translate-x-0"
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
