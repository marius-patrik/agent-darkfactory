import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div className="p-4" style={{ color: "var(--vsdaw-fg)", backgroundColor: "var(--vsdaw-bg)" }}>
      <h1 className="text-lg font-semibold">VSDAW</h1>
      <p className="text-sm opacity-80">Views bundle placeholder.</p>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
