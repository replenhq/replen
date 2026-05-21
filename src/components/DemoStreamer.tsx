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
  finishedAt: number | null;
  now: number;
  /** How many real match cards have been "revealed" on the feed below.
   *  Driven by the SCRIPT's `match` events firing — each one increments
   *  this by REVEALS_PER_MATCH_EVENT, so the feed populates progressively
   *  as the streamer announces matches. On run completion, set to a
   *  sentinel large value so any remaining match cards become visible. */
  revealedMatchCount: number;
  /** After the run completes the visitor can collapse the log to an
   *  ℹ icon next to the Refresh button and re-open it to audit what
   *  ran. Toggle via setExpanded. While the run is in flight the log
   *  is always visible regardless of this flag. */
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  start: () => void;
};

const REVEALS_PER_MATCH_EVENT = 2;
const REVEAL_ALL = 9999;

const StreamerContext = createContext<Ctx | null>(null);

export function DemoStreamerProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<Event[]>([]);
  const [candidates, setCandidates] = useState(0);
  const [matches, setMatches] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [revealedMatchCount, setRevealedMatchCount] = useState(0);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
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
    setRevealedMatchCount(0);
    let nextId = 1;
    SCRIPT.forEach((step) => {
      const t = setTimeout(() => {
        setEvents((prev) => [...prev, { id: nextId++, kind: step.kind, message: step.message }]);
        if (step.candDelta) setCandidates((c) => c + step.candDelta!);
        if (step.matchDelta) {
          setMatches((m) => m + step.matchDelta!);
          // Tie reveal of the actual persisted match cards below to the
          // streamer's announcement cadence — gives the impression of a
          // live pipeline populating the feed in real time.
          setRevealedMatchCount((r) => r + REVEALS_PER_MATCH_EVENT);
        }
      }, step.delayMs);
      timers.current.push(t);
    });
    const final = setTimeout(() => {
      setRunning(false);
      setDone(true);
      setFinishedAt(Date.now());
      // Backstop in case the SCRIPT's match events didn't add up to
      // every persisted match card.
      setRevealedMatchCount(REVEAL_ALL);
      // Default to collapsed once the run completes — the streamer
      // shifts to a compact ℹ icon next to the Refresh button, which
      // the visitor can click to re-open for auditing.
      setExpanded(false);
    }, TOTAL_MS);
    timers.current.push(final);
  }

  return (
    <StreamerContext.Provider value={{ events, candidates, matches, running, done, startedAt, finishedAt, now, revealedMatchCount, expanded, setExpanded, start }}>
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
// Refresh; visible while the pipeline is running, and also after
// completion when the visitor has expanded the minimized chip in
// the header (so the run log stays auditable rather than vanishing).
export function DemoStreamerLog() {
  const ctx = useContext(StreamerContext);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [ctx?.events.length]);

  if (!ctx) return null;
  const { events, candidates, matches, running, done, startedAt, finishedAt, now, expanded, setExpanded } = ctx;
  // Visible while the pipeline is in flight; afterward only when the
  // visitor explicitly re-opens via the minimized chip in the header.
  if (!running && !(done && expanded)) return null;
  // While running, drive the timer from the live clock; once done,
  // freeze the duration so the audit view shows the actual runtime.
  const endTs = running ? now : (finishedAt ?? now);
  const elapsedMs = Math.max(0, (startedAt ? endTs - startedAt : 0));

  const elapsed = Math.floor(elapsedMs / 1000);
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
        {done && expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{ marginLeft: 8, fontSize: 12, padding: "2px 8px" }}
            title="Collapse to minimized chip in the header"
          >
            Hide
          </button>
        )}
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

// Hides its children until the visitor has clicked Refresh at least once
// — used to gate the entire match-list block (filter pills, count line,
// project sections) so the page is empty on first arrival and populates
// as the streamer runs. After the run, children stay visible.
export function DemoMatchListGate({ children }: { children: ReactNode }) {
  const ctx = useContext(StreamerContext);
  // No provider → not in demo mode, render unchanged. The component is
  // safe to import + use from a server-rendered demo page that wraps
  // matches in this gate unconditionally.
  if (!ctx) return <>{children}</>;
  if (!ctx.running && !ctx.done) return null;
  return <>{children}</>;
}

// Reveals its children once the streamer's revealed-match counter has
// passed the given `index`. Use for individual match cards (with their
// global flat index) and project section wrappers (with the first
// global index of any match in that section). Pre-refresh, children
// are hidden; during the run they fade in as the streamer announces
// matches; after `done` everything is visible.
export function DemoRevealAt({ children, index }: { children: ReactNode; index: number }) {
  const ctx = useContext(StreamerContext);
  if (!ctx) return <>{children}</>;
  if (!ctx.running && !ctx.done) return null;
  if (index >= ctx.revealedMatchCount) return null;
  return <>{children}</>;
}

// Minimized "ⓘ" affordance shown after a run completes — the
// glyph itself is a unicode circled-i, so colouring it amber gives
// the "yellow circle with yellow i" look without any pill / button
// chrome around it. Inline-positioned so it can sit adjacent to the
// "Last run: <date>" meta line. Click to re-open the full streamer
// log for auditing.
export function DemoStreamerMinimized() {
  const ctx = useContext(StreamerContext);
  if (!ctx) return null;
  const { done, running, expanded, setExpanded, matches, candidates } = ctx;
  if (!done) return null;
  if (running) return null;
  if (expanded) return null;
  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      title={`View last run · ${matches} matches · ${candidates} candidates scanned`}
      aria-label="View last run details"
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        marginLeft: 6,
        fontSize: 14,
        lineHeight: 1,
        color: "var(--amber, #ffc857)",
        cursor: "pointer",
        verticalAlign: "middle",
      }}
    >
      ⓘ
    </button>
  );
}

// Empty-state callout shown only before the visitor clicks Refresh —
// gives the page something to anchor on instead of looking blank.
// Disappears the moment the streamer starts.
export function DemoPreRunEmptyState() {
  const ctx = useContext(StreamerContext);
  if (!ctx) return null;
  if (ctx.running || ctx.done) return null;
  return (
    <div
      role="status"
      style={{
        margin: "32px 0",
        padding: "28px 24px",
        border: "1px dashed var(--line, #ccc4)",
        borderRadius: 12,
        background: "var(--surface-1, transparent)",
        textAlign: "center",
        color: "var(--dim, #888)",
        fontSize: 15,
        lineHeight: 1.55,
      }}
    >
      <p style={{ margin: 0, color: "var(--fg)" }}>
        <strong>Click <em>Refresh</em> above to run the pipeline.</strong>
      </p>
      <p style={{ margin: "6px 0 0", fontSize: 14 }}>
        Watch matches appear as Replen scans the day's candidates, scores them against the demo projects, and writes up the best fits.
      </p>
    </div>
  );
}
