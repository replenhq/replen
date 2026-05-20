"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

// Canned pipeline-stream playback used in demo mode. Mirrors the real
// LivePipelineStatus structure (same class names, same markers, same
// counters) so a demo visitor sees the actual UX of a pipeline run
// without firing any LLM calls or scheduling state.
//
// Split into three pieces sharing state via React Context so the
// trigger button can live in the feed header (right-aligned, same
// slot as the real Refresh button) while the log strip renders
// below the header where LivePipelineStatus normally goes.

type EventKind = "fetch_start" | "fetch_done" | "scan" | "triage_skip" | "reason" | "match";
type Event = { id: number; kind: EventKind; message: string };

const SCRIPT: { delayMs: number; kind: EventKind; message: string; candDelta?: number; matchDelta?: number }[] = [
  { delayMs:     0, kind: "fetch_start",  message: "Fetching candidates from your sources…" },
  { delayMs:  1200, kind: "scan",         message: "gh-trending TypeScript: 30 repos pulled (last 24h)", candDelta: 30 },
  { delayMs:  1900, kind: "scan",         message: "gh-trending Python: 30 repos pulled (last 24h)",     candDelta: 30 },
  { delayMs:  2400, kind: "scan",         message: "Hacker News top: 12 OSS-linked items",                candDelta: 12 },
  { delayMs:  3000, kind: "scan",         message: "Reddit r/programming + 4 niche subs: 18 items",       candDelta: 18 },
  { delayMs:  3700, kind: "fetch_done",   message: "Fetched 42 new candidates (147 total seen)" },
  { delayMs:  4400, kind: "scan",         message: "Scanning tanstack/query (42k★)" },
  { delayMs:  5100, kind: "triage_skip",  message: "Triaged ggerganov/whisper.cpp → skip: speech model, no fit for your projects" },
  { delayMs:  5800, kind: "scan",         message: "Scanning ultralytics/yolov8 (28k★)" },
  { delayMs:  6700, kind: "scan",         message: "Scanning drizzle-team/drizzle-zod (4.5k★)" },
  { delayMs:  7400, kind: "reason",       message: "Reasoning about tanstack/query against 2 projects" },
  { delayMs:  9100, kind: "match",        message: "Match: tanstack/query → sandbox-nextapp (high · 88 · need: faster partner onboarding wizard)", matchDelta: 1 },
  { delayMs: 10200, kind: "reason",       message: "Reasoning about ultralytics/yolov8 against 2 projects" },
  { delayMs: 12100, kind: "match",        message: "Match: ultralytics/yolov8 → sightline (high · 92 · need: multi-camera tracker handoff)",      matchDelta: 1 },
  { delayMs: 13000, kind: "scan",         message: "Scanning obss/sahi (5.3k★)" },
  { delayMs: 13800, kind: "reason",       message: "Reasoning about drizzle-team/drizzle-zod against 2 projects" },
  { delayMs: 15400, kind: "match",        message: "Match: drizzle-team/drizzle-zod → sandbox-nextapp (medium · 72 · need: type-safe partner input validation)", matchDelta: 1 },
  { delayMs: 16800, kind: "reason",       message: "Reasoning about obss/sahi against 2 projects" },
  { delayMs: 18900, kind: "match",        message: "Match: obss/sahi → sightline (medium · 65 · need: small-object recall on high-res cameras)",   matchDelta: 1 },
  { delayMs: 20100, kind: "scan",         message: "Synthesis: 2 cluster(s) identified, drafting" },
  { delayMs: 22400, kind: "scan",         message: "Synthesis: 2 insight(s) added" },
  { delayMs: 23000, kind: "scan",         message: "Activity refreshed for 2 project(s)" },
  { delayMs: 23500, kind: "scan",         message: "Done — 4 matches, 2 insights, $0.18 spent" },
];

const TOTAL_MS = SCRIPT[SCRIPT.length - 1].delayMs + 800;

type Ctx = {
  events: Event[];
  candidates: number;
  matches: number;
  running: boolean;
  done: boolean;
  startedAt: number | null;
  now: number;
  start: () => void;
};

const StreamerContext = createContext<Ctx | null>(null);

export function DemoStreamerProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [candidates, setCandidates] = useState(0);
  const [matches, setMatches] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    tick.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (tick.current) clearInterval(tick.current); };
  }, [running]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  function start() {
    if (running || done) return;
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    setEvents([]);
    setCandidates(0);
    setMatches(0);
    let nextId = 1;
    SCRIPT.forEach((step) => {
      const t = setTimeout(() => {
        setEvents((prev) => [...prev, { id: nextId++, kind: step.kind, message: step.message }]);
        if (step.candDelta) setCandidates((c) => c + step.candDelta!);
        if (step.matchDelta) setMatches((m) => m + step.matchDelta!);
      }, step.delayMs);
      timers.current.push(t);
    });
    const final = setTimeout(() => { setRunning(false); setDone(true); }, TOTAL_MS);
    timers.current.push(final);
  }

  return (
    <StreamerContext.Provider value={{ events, candidates, matches, running, done, startedAt, now, start }}>
      {children}
    </StreamerContext.Provider>
  );
}

// Right-aligned button that lives where the real Refresh button does.
// Default button styling (not .primary) so it blends with the rest of
// the header chrome; no "demo" copy — the page-level banner conveys
// that.
export function DemoStreamerButton() {
  const ctx = useContext(StreamerContext);
  if (!ctx) return null;
  const { running, done, start } = ctx;
  const disabled = running || done;
  const label = running ? "Running…" : done ? "Run complete" : "Refresh";
  return (
    <button type="button" onClick={start} disabled={disabled} title="Run a simulated pipeline">
      <Icon name="refresh" /> {label}
    </button>
  );
}

// Full-width log strip. Renders nothing until the visitor clicks
// Refresh; after that, mirrors LivePipelineStatus 1:1.
export function DemoStreamerLog() {
  const ctx = useContext(StreamerContext);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [ctx?.events.length]);

  if (!ctx) return null;
  const { events, candidates, matches, running, done, startedAt, now } = ctx;
  if (!running && !done) return null;

  const elapsed = Math.max(0, Math.floor(((startedAt ? now - startedAt : 0)) / 1000));
  const mm = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const ss = (elapsed % 60).toString().padStart(2, "0");

  return (
    <div className="pipeline-log" role="status" aria-live="polite">
      <div className="pipeline-log-head">
        <span className="pipeline-spinner" aria-hidden="true">
          <Icon name="refresh" size={14} />
        </span>
        <span className="pipeline-log-title">
          {done ? "Pipeline complete" : "Pipeline running"}
        </span>
        <span className="pipeline-log-counts">
          {candidates} candidates · {matches} matches · {mm}:{ss}
        </span>
      </div>
      <div className="pipeline-log-body" ref={scrollRef}>
        {events.map((e) => (
          <div key={e.id} className={`pipeline-log-line kind-${e.kind}`}>
            <span className="pipeline-log-marker" aria-hidden="true">{markerFor(e.kind)}</span>
            <span className="pipeline-log-msg">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function markerFor(kind: EventKind): string {
  switch (kind) {
    case "match":        return "✓";
    case "triage_skip":  return "·";
    case "fetch_start":
    case "fetch_done":   return "↓";
    case "reason":       return "?";
    case "scan":
    default:             return "›";
  }
}
