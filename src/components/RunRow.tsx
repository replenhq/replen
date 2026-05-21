"use client";

import { useState } from "react";

// Per-run table row with an inline-expandable event log. Clicking
// the "▾ N events" button on the right toggles a second <tr> below
// this one (full-width via colspan) that renders the persisted
// pipelineEvents for the run — same data the in-flight streamer
// shows, just frozen. Pure client-side toggle; no extra fetch.
//
// Kept as a small client island so the parent /runs page stays a
// server component for the big aggregate queries.

type Event = { id: number; kind: string; message: string; createdAt: string };

type Props = {
  startedISO: string;
  duration: string;
  candidates: number;
  analyzed: number;
  matches: number;
  emailSent: boolean;
  dsIn: string;
  dsOut: string;
  anIn: string;
  anOut: string;
  cost: string;
  hasError: boolean;
  events: Event[];
};

export function RunRow(p: Props) {
  const [open, setOpen] = useState(false);
  const eventCount = p.events.length;
  return (
    <>
      <tr>
        <td className="meta" style={{ whiteSpace: "nowrap" }}>{formatLocal(p.startedISO)}</td>
        <td className="meta">{p.duration}</td>
        <td style={{ textAlign: "right" }}>{p.candidates}</td>
        <td style={{ textAlign: "right" }}>{p.analyzed}</td>
        <td style={{ textAlign: "right" }}>{p.matches}</td>
        <td style={{ textAlign: "center" }}>{p.emailSent ? "✓" : "-"}</td>
        <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
          {p.dsIn} / {p.dsOut}
        </td>
        <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
          {p.anIn} / {p.anOut}
        </td>
        <td style={{ textAlign: "right" }}>{p.cost}</td>
        <td className="meta">{p.hasError ? "yes" : "-"}</td>
        <td style={{ textAlign: "right" }}>
          {eventCount > 0 ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              style={{ fontSize: 12, padding: "2px 8px" }}
              aria-expanded={open}
              aria-label={open ? "Collapse run events" : "Expand run events"}
            >
              {open ? "▴" : "▾"} {eventCount} {eventCount === 1 ? "event" : "events"}
            </button>
          ) : (
            <span className="meta">-</span>
          )}
        </td>
      </tr>
      {open && eventCount > 0 && (
        <tr>
          <td colSpan={11} style={{ padding: "0 0 12px 0", background: "rgba(0,0,0,0.02)" }}>
            <div
              style={{
                margin: "6px 8px 4px",
                padding: "8px 10px",
                border: "1px solid rgba(0,0,0,0.10)",
                borderRadius: 6,
                background: "var(--surface-1, #fafafa)",
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
                maxHeight: 320,
                overflow: "auto",
              }}
            >
              {p.events.map((e) => (
                <div key={e.id} style={{ display: "flex", gap: 8, padding: "2px 0", color: "var(--fg)" }}>
                  <span aria-hidden="true" style={{ width: 12, color: "var(--dim, #888)" }}>
                    {markerFor(e.kind)}
                  </span>
                  <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.message}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function markerFor(kind: string): string {
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

function formatLocal(iso: string): string {
  // Match the LocalTime component's day-month-time shape so the table
  // visual stays consistent. Browser locale via toLocaleString.
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
