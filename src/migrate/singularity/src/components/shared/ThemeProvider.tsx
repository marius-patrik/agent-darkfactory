import type * as React from "react";
import { useTheme } from "./useTheme.js";

/**
 * Injects a small global stylesheet that aliases VS Code theme variables to
 * VSDAW component variables. This lets canvas code and inline styles read a
 * stable set of custom properties while still tracking the active VS Code theme.
 */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const theme = useTheme();

  return (
    <>
      <style>{`
        :root {
          --vsdaw-bg: ${theme["--vscode-editor-background"]};
          --vsdaw-fg: ${theme["--vscode-editor-foreground"]};
          --vsdaw-panel-bg: ${theme["--vscode-panel-background"]};
          --vsdaw-sidebar-bg: ${theme["--vscode-sideBar-background"]};
          --vsdaw-button-bg: ${theme["--vscode-button-background"]};
          --vsdaw-button-fg: ${theme["--vscode-button-foreground"]};
          --vsdaw-button-hover: ${theme["--vscode-button-hoverBackground"]};
          --vsdaw-input-bg: ${theme["--vscode-input-background"]};
          --vsdaw-input-fg: ${theme["--vscode-input-foreground"]};
          --vsdaw-input-border: ${theme["--vscode-input-border"]};
          --vsdaw-focus: ${theme["--vscode-focusBorder"]};
          --vsdaw-border: ${theme["--vscode-panel-border"]};
          --vsdaw-active-bg: ${theme["--vscode-list-activeSelectionBackground"]};
          --vsdaw-active-fg: ${theme["--vscode-list-activeSelectionForeground"]};
          --vsdaw-hover-bg: ${theme["--vscode-list-hoverBackground"]};
          --vsdaw-scrollbar: ${theme["--vscode-scrollbarSlider-background"]};
          --vsdaw-scrollbar-hover: ${theme["--vscode-scrollbarSlider-hoverBackground"]};
          --vsdaw-status-bg: ${theme["--vscode-statusBar-background"]};
          --vsdaw-status-fg: ${theme["--vscode-statusBar-foreground"]};
          --vsdaw-error: ${theme["--vscode-errorForeground"]};
          --vsdaw-warning: ${theme["--vscode-warningForeground"]};
        }
        * { box-sizing: border-box; }
        html, body, #root { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }
        :focus-visible { outline: 1px solid var(--vsdaw-focus); outline-offset: -1px; }
      `}</style>
      {children}
    </>
  );
};
