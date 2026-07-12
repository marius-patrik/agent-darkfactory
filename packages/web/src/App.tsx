import { useCallback, useEffect, useState } from "react";
import { api, type AppConfig, type Concept, type ConformanceReport, type LogEntry, type SearchHit, type TreeNode } from "./api";
import { Tree } from "./components/Tree";
import { ConceptView } from "./components/ConceptView";
import { LogView } from "./components/LogView";
import { ChatPanel } from "./components/ChatPanel";
import { GraphView } from "./components/GraphView";

type View =
  | { kind: "concept"; path: string }
  | { kind: "log" }
  | { kind: "graph" }
  | { kind: "empty" };

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [concept, setConcept] = useState<Concept | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.tree().then(setTree).catch((e) => setError(String(e)));
    api.validate().then(setReport).catch(() => {});
    api.log().then(setLog).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api.config().then(setConfig).catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (view.kind === "concept") {
      api.concept(view.path).then(setConcept).catch((e) => setError(String(e)));
    }
  }, [view]);

  // Re-load the open concept (and graph) after chat mutations.
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const onMutation = useCallback(() => {
    refresh();
    setGraphRefreshKey((k) => k + 1);
    setView((v) => ({ ...v }));
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => api.search(query).then(setHits).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [query]);

  const openConcept = useCallback((path: string) => {
    if (path === "/log.md") {
      setView({ kind: "log" });
    } else {
      setView({ kind: "concept", path });
    }
    setError(null);
    setQuery("");
  }, []);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        <div className="border-b border-zinc-800 p-3">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold tracking-wide text-cyan-300">understory 🌱</h1>
            {report && (
              <span
                title={`${report.conceptCount} concepts, ${report.issues.length} issues`}
                className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  report.conformant
                    ? "bg-emerald-900/60 text-emerald-300"
                    : "bg-red-900/60 text-red-300"
                }`}
              >
                {report.conformant ? "conformant" : "non-conformant"}
              </span>
            )}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-none focus:border-cyan-600"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {hits ? (
            <div className="space-y-1">
              {hits.length === 0 && <p className="px-2 text-xs text-zinc-500">No matches.</p>}
              {hits.map((h) => (
                <button
                  key={h.path}
                  onClick={() => openConcept(h.path)}
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800"
                >
                  <div className="text-sm text-zinc-200">{h.title ?? h.path}</div>
                  {h.snippet && <div className="truncate text-xs text-zinc-500">{h.snippet}</div>}
                </button>
              ))}
            </div>
          ) : tree ? (
            <Tree
              node={tree}
              selected={view.kind === "concept" ? view.path : null}
              onSelect={openConcept}
            />
          ) : (
            <p className="px-2 text-xs text-zinc-500">Loading…</p>
          )}
        </div>

        <div className="flex border-t border-zinc-800 text-xs">
          <button
            onClick={() => setView({ kind: "log" })}
            className={`flex-1 px-3 py-2 hover:bg-zinc-800 ${view.kind === "log" ? "text-cyan-300" : "text-zinc-400"}`}
          >
            Log
          </button>
          <button
            onClick={() => setView({ kind: "graph" })}
            className={`flex-1 border-l border-zinc-800 px-3 py-2 hover:bg-zinc-800 ${view.kind === "graph" ? "text-cyan-300" : "text-zinc-400"}`}
          >
            Graph
          </button>
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className="flex-1 border-l border-zinc-800 px-3 py-2 text-zinc-400 hover:bg-zinc-800"
          >
            {chatOpen ? "Hide chat" : "Chat"}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className={`min-w-0 flex-1 ${view.kind === "graph" ? "overflow-hidden" : "overflow-y-auto"}`}>
        {error && <p className="p-6 text-sm text-red-400">{error}</p>}
        {!error && view.kind === "empty" && (
          <div className="flex h-full items-center justify-center text-zinc-600">
            <p>Select a concept, or ask the agent →</p>
          </div>
        )}
        {!error && view.kind === "concept" && concept && (
          <ConceptView concept={concept} onNavigate={openConcept} />
        )}
        {!error && view.kind === "log" && <LogView entries={log} onNavigate={openConcept} />}
        {!error && view.kind === "graph" && (
          <GraphView refreshKey={graphRefreshKey} onNavigate={openConcept} />
        )}
      </main>

      {/* Chat */}
      {chatOpen && (
        <aside className="w-96 shrink-0 border-l border-zinc-800">
          <ChatPanel config={config} onMutation={onMutation} onOpenConcept={openConcept} />
        </aside>
      )}
    </div>
  );
}
