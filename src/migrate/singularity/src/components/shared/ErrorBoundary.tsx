import * as React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  viewName?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[VSDAW ${this.props.viewName ?? "view"}] Uncaught error:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            backgroundColor: "var(--vsdaw-bg)",
            color: "var(--vsdaw-error)",
            fontFamily:
              "var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",
            fontSize: 13,
            gap: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>
            {this.props.viewName ? `${this.props.viewName} view` : "View"} failed to render
          </h2>
          <p style={{ margin: 0, opacity: 0.8, maxWidth: 480, textAlign: "center" }}>
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{
              padding: "6px 12px",
              borderRadius: 4,
              border: "1px solid var(--vsdaw-border)",
              backgroundColor: "var(--vsdaw-button-bg)",
              color: "var(--vsdaw-button-fg)",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
