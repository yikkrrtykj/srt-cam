import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#525B6B] disabled:pointer-events-none disabled:opacity-45 cursor-pointer select-none",
  {
    variants: {
      variant: {
        primary: "bg-[#F1F3F6] text-[#0A0B0D] hover:bg-white active:bg-[#DCE0E8]",
        secondary:
          "bg-[#191C22] text-[#E6E9EF] border border-[#2A2F3A] hover:bg-[#222630] hover:border-[#3A4150]",
        outline:
          "bg-transparent text-[#C7CDD8] border border-[#262B35] hover:bg-[#181B21] hover:text-[#F1F3F6]",
        ghost: "bg-transparent text-[#98A1B0] hover:bg-[#191C22] hover:text-[#F1F3F6]",
        danger:
          "bg-[#251316] text-[#F87171] border border-[#542228] hover:bg-[#32171B] hover:border-[#782E36]",
      },
      size: {
        xs: "h-7 px-2.5 text-[11.5px]",
        sm: "h-8 px-3 text-[12px]",
        default: "h-9 px-3.5 text-[12.5px]",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = "Button";
