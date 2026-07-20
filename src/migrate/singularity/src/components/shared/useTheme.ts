import { useEffect, useState } from "react";

export interface VsCodeTheme {
  "--vscode-editor-background": string;
  "--vscode-editor-foreground": string;
  "--vscode-button-background": string;
  "--vscode-button-foreground": string;
  "--vscode-button-hoverBackground": string;
  "--vscode-input-background": string;
  "--vscode-input-foreground": string;
  "--vscode-input-border": string;
  "--vscode-focusBorder": string;
  "--vscode-activityBar-background": string;
  "--vscode-panel-background": string;
  "--vscode-panel-border": string;
  "--vscode-sideBar-background": string;
  "--vscode-list-activeSelectionBackground": string;
  "--vscode-list-activeSelectionForeground": string;
  "--vscode-list-hoverBackground": string;
  "--vscode-scrollbarSlider-background": string;
  "--vscode-scrollbarSlider-hoverBackground": string;
  "--vscode-statusBar-background": string;
  "--vscode-statusBar-foreground": string;
  "--vscode-errorForeground": string;
  "--vscode-warningForeground": string;
}

const VARIABLES: (keyof VsCodeTheme)[] = [
  "--vscode-editor-background",
  "--vscode-editor-foreground",
  "--vscode-button-background",
  "--vscode-button-foreground",
  "--vscode-button-hoverBackground",
  "--vscode-input-background",
  "--vscode-input-foreground",
  "--vscode-input-border",
  "--vscode-focusBorder",
  "--vscode-activityBar-background",
  "--vscode-panel-background",
  "--vscode-panel-border",
  "--vscode-sideBar-background",
  "--vscode-list-activeSelectionBackground",
  "--vscode-list-activeSelectionForeground",
  "--vscode-list-hoverBackground",
  "--vscode-scrollbarSlider-background",
  "--vscode-scrollbarSlider-hoverBackground",
  "--vscode-statusBar-background",
  "--vscode-statusBar-foreground",
  "--vscode-errorForeground",
  "--vscode-warningForeground",
];

const FALLBACK_THEME: VsCodeTheme = {
  "--vscode-editor-background": "#1e1e1e",
  "--vscode-editor-foreground": "#cccccc",
  "--vscode-button-background": "#0e639c",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#1177bb",
  "--vscode-input-background": "#3c3c3c",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-focusBorder": "#007fd4",
  "--vscode-activityBar-background": "#333333",
  "--vscode-panel-background": "#1e1e1e",
  "--vscode-panel-border": "#414141",
  "--vscode-sideBar-background": "#252526",
  "--vscode-list-activeSelectionBackground": "#094771",
  "--vscode-list-activeSelectionForeground": "#ffffff",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-scrollbarSlider-background": "#79797966",
  "--vscode-scrollbarSlider-hoverBackground": "#646464b3",
  "--vscode-statusBar-background": "#007acc",
  "--vscode-statusBar-foreground": "#ffffff",
  "--vscode-errorForeground": "#f48771",
  "--vscode-warningForeground": "#cca700",
};

function readTheme(): VsCodeTheme {
  const styles = getComputedStyle(document.documentElement);
  const theme = {} as VsCodeTheme;
  for (const key of VARIABLES) {
    theme[key] = styles.getPropertyValue(key).trim() || FALLBACK_THEME[key];
  }
  return theme;
}

/**
 * Reads VS Code theme CSS variables and re-reads them when the VS Code
 * `vscode-webview-theme` data attribute changes.
 */
export function useTheme(): VsCodeTheme {
  const [theme, setTheme] = useState<VsCodeTheme>(() => readTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-vscode-theme-kind"],
    });
    // Fallback: re-read after a short delay to catch theme injection.
    const timeout = setTimeout(() => setTheme(readTheme()), 50);
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, []);

  return theme;
}

export function cssVar(theme: VsCodeTheme, name: keyof VsCodeTheme, fallback?: string): string {
  return theme[name] || fallback || "";
}
