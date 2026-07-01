"use client";

import { useState } from "react";
import { NodeDrawer } from "./CartsDrawer";
import { fmtAgo, type CartTimelineItem } from "@/graph/carts-shared";

// Timeline layout: the cart's nodes down a month-grouped chronological list
// (newest first), the decision history over time. Click a row for its dossier.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthKey(at: number | null): string {
  if (at == null) return "undated";
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
}
function monthLabel(k: string): string {
  if (k === "undated") return "Undated";
  const [y, m] = k.split("-");
  return `${MONTHS[Number(m)]} ${y}`;
}

export function CartsTimeline({ items }: { items: CartTimelineItem[] }) {
  const [sel, setSel] = useState<CartTimelineItem | null>(null);
  if (!items.length) return <div className="carts-empty"><p>No dated items in this cart yet.</p></div>;

  // group by month, preserving the incoming newest-first order
  const groups: { key: string; items: CartTimelineItem[] }[] = [];
  const idx = new Map<string, number>();
  for (const it of items) {
    const k = monthKey(it.at);
    if (!idx.has(k)) { idx.set(k, groups.length); groups.push({ key: k, items: [] }); }
    groups[idx.get(k)!].items.push(it);
  }

  return (
    <div className="carts-timeline-wrap">
      {groups.map((g) => (
        <section key={g.key} className="carts-tl-month">
          <div className="carts-tl-month-head">{monthLabel(g.key)}<span className="carts-tl-month-n">{g.items.length}</span></div>
          <div className="carts-tl-items">
            {g.items.map((it, i) => (
              <div key={it.node + i} className="carts-tl-row" onClick={() => setSel(it)}>
                <span className="carts-tl-dot" />
                <span className="carts-tl-title">{it.title}</span>
                {it.tag && <span className="carts-tl-tag">{it.tag}</span>}
                {it.sub && <span className="carts-tl-sub">{it.sub}</span>}
                <span className="carts-tl-date">{fmtAgo(it.at)}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
      <NodeDrawer nodeRef={sel?.node ?? null} title={sel?.title ?? ""} onClose={() => setSel(null)} />
    </div>
  );
}
