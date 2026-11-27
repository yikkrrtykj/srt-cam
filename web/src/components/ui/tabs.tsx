import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: "underline" | "segmented" }
>(({ className, variant = "underline", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      variant === "underline"
        ? "inline-flex items-center gap-5 border-b border-[#232730]"
        : "inline-flex items-center gap-0.5 rounded-md border border-[#232730] bg-[#0D0F12] p-0.5",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { variant?: "underline" | "segmented" }
>(({ className, variant = "underline", ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-none cursor-pointer select-none disabled:pointer-events-none disabled:opacity-45",
      variant === "underline"
        ? "relative pb-2.5 pt-1 text-[12.5px] font-medium text-[#8B94A5] hover:text-[#D9DEE7] data-[state=active]:text-[#F1F3F6] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:bg-transparent data-[state=active]:after:bg-[#F1F3F6]"
        : "rounded-[4px] px-2.5 py-1 text-[11.5px] font-medium text-[#8B94A5] hover:text-[#D9DEE7] data-[state=active]:bg-[#222630] data-[state=active]:text-[#F1F3F6]",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("focus-visible:outline-none", className)}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
