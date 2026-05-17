"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icons";

type EventKind = "fetch_start" | "fetch_done" | "scan" | "skip" | "triage_skip" | "reason" | "match" | "error";
type Event = { id: number; kind: EventKind; message: string; createdAt: string };

type Status = {
  inFlight: boolean;
  runId?: number;
  startedAt?: string;
  candidates?: number;
  matches?: number;
  phase?: "fetching" | "scoring" | "writing" | "done";
  events?: Event[];
};

const POLL_MS = 2500;
const MAX_EVENTS = 200;

// Live pipeline log. Polls /api/pipeline-status incrementally (?since=last_id)
// and appends new events to a scrollable feed — like Claude Code's tool stream,
// one line per decision. router.refresh() runs when the match count ticks up so
// new match rows render inline below.
export function LivePipelineStatus({ initial }: { initial: Status }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initial);
  const [events, setEvents] = useState<Event[]>(initial.events ?? []);
  const lastEventId = useRef<number>(initial.events?.at(-1)?.id ?? 0);
  const lastMatches = useRef<number>(initial.matches ?? 0);
  const wasInFlight = useRef<boolean>(initial.inFlight);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    // Fire the first tick immediately — otherwise users see the strip with
    // "Waiting for first event…" for the full 2.5s before any progress shows.
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status.inFlight, router]);

  // Auto-scroll to the bottom when new events arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (!status.inFlight) return null;

  const elapsed = status.startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(status.startedAt).getTime()) / 1000))
    : 0;
  const mm = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const ss = (elapsed % 60).toString().padStart(2, "0");

  return (
    <div className="pipeline-log" role="status" aria-live="polite">
      <div className="pipeline-log-head">
        <span className="pipeline-spinner" aria-hidden="true">
          <Icon name="refresh" size={14} />
        </span>
        <span className="pipeline-log-title">Pipeline running</span>
        <span className="pipeline-log-counts">
          {status.candidates ?? 0} candidates · {status.matches ?? 0} matches · {mm}:{ss}
        </span>
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
