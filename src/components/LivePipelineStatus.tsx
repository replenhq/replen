"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icons";

type EventKind = "fetch_start" | "fetch_done" | "scan" | "skip" | "triage_skip" | "reason" | "match" | "error";
type Event = { id: number; kind: EventKind; message: string; createdAt: string };

export type Status = {
  inFlight: boolean;
  runId?: number;
  startedAt?: string;
  finishedAt?: string;
  candidates?: number;
  matches?: number;
  phase?: "fetching" | "scoring" | "writing" | "done";
  events?: Event[];
};

const POLL_MS = 2500;
const MAX_EVENTS = 200;

type Ctx = {
  status: Status;
  events: Event[];
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  /** True when the page-level last-completed run has events to surface
   *  (i.e. we have something to chip about). */
  hasCompletedRun: boolean;
};

const PipelineContext = createContext<Ctx | null>(null);

// Wraps the feed so the chip in the header and the log in the body
// share polling state + the expand/collapse toggle. While inFlight we
// poll /api/pipeline-status; when the run completes we stop polling
// but keep the run's events in state so the chip can re-open the log
// for an audit trail. Initial events should come server-rendered so
// the chip surfaces on a fresh page load without waiting for the
// first poll.
export function LivePipelineProvider({ children, initial }: { children: ReactNode; initial: Status }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initial);
  const [events, setEvents] = useState<Event[]>(initial.events ?? []);
  const [expanded, setExpanded] = useState(false);
  const lastEventId = useRef<number>(initial.events?.at(-1)?.id ?? 0);
  const lastMatches = useRef<number>(initial.matches ?? 0);
  const wasInFlight = useRef<boolean>(initial.inFlight);

  useEffect(() => {
    if (!status.inFlight) {
      if (wasInFlight.current) {
        wasInFlight.current = false;
        router.refresh();
      }
      return;
    }
    wasInFlight.current = true;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pipeline-status?since=${lastEventId.current}`, { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const next: Status = await r.json();
        setStatus(next);
        if (next.events && next.events.length > 0) {
          lastEventId.current = next.events[next.events.length - 1].id;
          setEvents((prev) => {
            const merged = [...prev, ...next.events!];
            return merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
          });
        }
        const m = next.matches ?? 0;
        if (m > lastMatches.current) {
          lastMatches.current = m;
          router.refresh();
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [status.inFlight, router]);

  const hasCompletedRun = !status.inFlight && events.length > 0 && !!status.startedAt;

  return (
    <PipelineContext.Provider value={{ status, events, expanded, setExpanded, hasCompletedRun }}>
      {children}
    </PipelineContext.Provider>
  );
}

// Inline ⓘ glyph rendered next to the "Last run: <date>" meta in
// the feed header. Visible only after a completed run; click to
// expand the audit log. Transparent button chrome so it reads as
// inline text rather than a CTA. Mirror in spirit (and styling) of
// DemoStreamerMinimized so the two surfaces feel uniform.
export function LivePipelineChip() {
  const ctx = useContext(PipelineContext);
  if (!ctx) return null;
  const { hasCompletedRun, expanded, setExpanded, status } = ctx;
  if (!hasCompletedRun || expanded) return null;
  const matches = status.matches ?? 0;
  const candidates = status.candidates ?? 0;
  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      title={`View last run · ${matches} matches · ${candidates} candidates`}
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

// Full streamer log. Visible while a pipeline is in flight; also
// visible after completion when the visitor has clicked the chip
// to expand for audit. Hide button on the header collapses back.
export function LivePipelineLog() {
  const ctx = useContext(PipelineContext);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [ctx?.events.length]);

  if (!ctx) return null;
  const { status, events, expanded, setExpanded } = ctx;
  const inFlight = status.inFlight;
  if (!inFlight && !expanded) return null;

  const endTs = inFlight
    ? Date.now()
    : (status.finishedAt ? new Date(status.finishedAt).getTime() : Date.now());
  const startTs = status.startedAt ? new Date(status.startedAt).getTime() : endTs;
  const elapsed = Math.max(0, Math.floor((endTs - startTs) / 1000));
  const mm = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const ss = (elapsed % 60).toString().padStart(2, "0");

  return (
    <div className="pipeline-log" role="status" aria-live="polite">
      <div className="pipeline-log-head">
        <span className="pipeline-spinner" aria-hidden="true">
          <Icon name="refresh" size={14} />
        </span>
        <span className="pipeline-log-title">
          {inFlight ? "Pipeline running" : "Pipeline complete"}
        </span>
        <span className="pipeline-log-counts">
          {status.candidates ?? 0} candidates · {status.matches ?? 0} matches · {mm}:{ss}
        </span>
        {!inFlight && expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{ marginLeft: 8, fontSize: 12, padding: "2px 8px" }}
            title="Collapse to ⓘ icon next to the timestamp"
          >
            Hide
          </button>
        )}
      </div>
      <div className="pipeline-log-body" ref={scrollRef}>
        {events.length === 0 ? (
          <div className="pipeline-log-line muted">Waiting for first event…</div>
        ) : (
          events.map((e) => (
            <div key={e.id} className={`pipeline-log-line kind-${e.kind}`}>
              <span className="pipeline-log-marker" aria-hidden="true">{markerFor(e.kind)}</span>
              <span className="pipeline-log-msg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Back-compat single-component wrapper for callers that haven't been
// switched over to Provider + Chip + Log yet. Renders Provider with
// Log only; the chip stays off (use the triplet form to enable it).
export function LivePipelineStatus({ initial }: { initial: Status }) {
  return (
    <LivePipelineProvider initial={initial}>
      <LivePipelineLog />
    </LivePipelineProvider>
  );
}

function markerFor(kind: EventKind): string {
  switch (kind) {
    case "match":        return "✓";
    case "skip":
    case "triage_skip":  return "·";
    case "error":        return "✗";
    case "fetch_start":
    case "fetch_done":   return "↓";
    case "reason":       return "?";
    case "scan":
    default:             return "›";
  }
}
