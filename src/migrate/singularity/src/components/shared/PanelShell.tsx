import { motion } from "framer-motion";
import type * as React from "react";

export const PanelShell: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className={`w-full h-full flex flex-col ${className || ""}`}
      style={{
        backgroundColor: "var(--vsdaw-bg)",
        color: "var(--vsdaw-fg)",
        fontFamily:
          "var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
        fontSize: "var(--vscode-font-size, 13px)",
      }}
    >
      {children}
    </motion.div>
  );
};
