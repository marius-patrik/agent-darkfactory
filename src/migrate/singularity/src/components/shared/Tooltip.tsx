import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children, side = "bottom" }) => {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={4}
          style={{
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 11,
            backgroundColor: "var(--vsdaw-panel-bg)",
            color: "var(--vsdaw-fg)",
            border: "1px solid var(--vsdaw-border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            zIndex: 100,
          }}
        >
          {content}
          <TooltipPrimitive.Arrow style={{ fill: "var(--vsdaw-border)" }} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
};
