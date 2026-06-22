import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

// DEV-ONLY render instrumentation.
// Wraps a region in React's official <Profiler> and records each commit to
// window.__RENDER_LOG__, so an external tool (the Chrome DevTools MCP) can read exactly which
// regions re-rendered per interaction, how often, and how long they took. This is the
// React-19-native alternative to why-did-you-render (whose createElement monkey-patching is
// unreliable under React 19's automatic JSX runtime). In production this is a transparent
// pass-through with zero Profiler overhead.
const DEV = process.env.NODE_ENV !== "production";

type RenderRecord = {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualMs: number; // time to render this commit
  baseMs: number; // estimated time to render the whole subtree without memoization
  commitTime: number;
};

type RenderSummary = Record<
  string,
  { count: number; totalMs: number; phases: Record<string, number> }
>;

declare global {
  interface Window {
    __RENDER_LOG__?: RenderRecord[];
    __renderReset?: () => void;
    __renderSummary?: () => RenderSummary;
  }
}

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, _s, commitTime) => {
  if (typeof window === "undefined") return;
  const log = (window.__RENDER_LOG__ ??= []);
  log.push({
    id,
    phase,
    actualMs: +actualDuration.toFixed(2),
    baseMs: +baseDuration.toFixed(2),
    commitTime: +commitTime.toFixed(1),
  });
  if (log.length > 5000) log.shift(); // cap memory during long sessions
};

if (DEV && typeof window !== "undefined") {
  // Helpers the MCP can call: clear the log before an interaction, then read a per-region summary.
  window.__renderReset = () => {
    window.__RENDER_LOG__ = [];
  };
  window.__renderSummary = () => {
    const out: RenderSummary = {};
    for (const r of window.__RENDER_LOG__ ?? []) {
      const e = (out[r.id] ??= { count: 0, totalMs: 0, phases: {} });
      e.count++;
      e.totalMs = +(e.totalMs + r.actualMs).toFixed(2);
      e.phases[r.phase] = (e.phases[r.phase] ?? 0) + 1;
    }
    return out;
  };
}

export function RenderProfiler({ id, children }: { id: string; children: ReactNode }) {
  if (!DEV) return <>{children}</>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}