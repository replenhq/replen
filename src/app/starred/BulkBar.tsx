"use client";

import { useState, useTransition } from "react";
import { bulkCreateHandoffs, bulkUnstar } from "../actions";

// Floating bar that collects checked match IDs and fires bulk actions. Renders
// nothing until at least one row is checked. The checkboxes live on the
// server-rendered rows and post their IDs via a custom event we listen to —
// keeps the parent /starred page entirely server-rendered.
export function BulkBar() {
  const [ids, setIds] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  // Listen for clicks on the row checkboxes. We keep the data binding here
  // rather than per-row to avoid making every row a client component.
  if (typeof window !== "undefined") {
    (window as unknown as { __bulkbar?: (id: number, on: boolean) => void }).__bulkbar = (id: number, on: boolean) => {
      setIds((prev) => {
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    };
  }

  if (ids.size === 0 && !msg) return null;

  const arr = [...ids];

  return (
    <div style={{
      position: "sticky", bottom: 12, marginTop: 16, padding: "10px 14px",
      background: "#111", color: "#fff", borderRadius: 8,
      display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
      boxShadow: "0 4px 16px #0004",
    }}>
      <b>{ids.size} selected</b>
      <button
        type="button"
        disabled={pending || arr.length === 0}
        onClick={() => startTransition(async () => {
          const r = await bulkUnstar(arr);
          setMsg(`Unstarred ${r.updated}`);
          setIds(new Set());
        })}
        style={{ background: "transparent", color: "#fff", border: "1px solid #fff8", padding: "4px 12px" }}
      >
        ★ Unstar
      </button>
      <button
        type="button"
        disabled={pending || arr.length === 0}
        onClick={() => startTransition(async () => {
          const r = await bulkCreateHandoffs(arr);
          setMsg(`Opened ${r.opened} PRs · ${r.skipped} skipped${r.failures.length ? " (see console)" : ""}`);
          if (r.failures.length) console.warn("[bulk handoff]", r.failures);
          setIds(new Set());
        })}
        style={{ background: "transparent", color: "#fff", border: "1px solid #fff8", padding: "4px 12px" }}
      >
        → Open handoff PRs
      </button>
      {msg && <span style={{ marginLeft: 8, fontSize: 13, opacity: 0.85 }}>{msg}</span>}
      <button
        type="button"
        onClick={() => { setIds(new Set()); setMsg(null); }}
        style={{ background: "transparent", color: "#fff", border: "1px solid #fff4", padding: "4px 10px", marginLeft: "auto" }}
      >
        clear
      </button>
    </div>
  );
}

// Tiny client checkbox — fires the window-scoped callback so the bar above
// (which holds the actual state) can react. Marked with data-bulk to make
// "select-all" easy to implement later if we want it.
export function RowCheck({ id }: { id: number }) {
  return (
    <input
      type="checkbox"
      data-bulk={id}
      onChange={(e) => {
        const cb = (window as unknown as { __bulkbar?: (id: number, on: boolean) => void }).__bulkbar;
        if (cb) cb(id, e.target.checked);
      }}
      style={{ marginRight: 6 }}
    />
  );
}
