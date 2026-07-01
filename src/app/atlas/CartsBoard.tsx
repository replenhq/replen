"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Icon } from "@/components/Icons";
import { setCartVerdict } from "./carts-actions";
import { NodeDrawer } from "./CartsDrawer";
import { VERDICT_COLUMNS, type CartGroup, type CartCard } from "@/graph/carts-shared";

const META_ICON: Record<string, string> = { star: "star", hex: "hexagon", doc: "doc", split: "split", folder: "folder" };
const DROP = new Set(VERDICT_COLUMNS);

// The triage board, client-side. Two interactions the server board can't do:
//  - drag a card into a verdict column -> setCartVerdict (writes EVALUATED back)
//  - click a card -> a slide-over dossier drawer, without leaving the board.
export function CartsBoard({ groups, note }: { groups: CartGroup[]; note: string }) {
  const columns = groups.map((g) => ({ key: g.key, label: g.label }));
  const initial = groups.flatMap((g) => g.cards);
  const [cards, moveCard] = useOptimistic(
    initial,
    (state: CartCard[], mv: { key: string; column: string }) => state.map((c) => (c.key === mv.key ? { ...c, column: mv.column } : c)),
  );
  const [pending, startTransition] = useTransition();
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [sel, setSel] = useState<CartCard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function drop(columnKey: string) {
    setOverCol(null);
    const k = dragKey;
    setDragKey(null);
    if (!k || !DROP.has(columnKey)) return;
    const card = cards.find((c) => c.key === k);
    if (!card || card.column === columnKey) return;
    setErr(null);
    startTransition(async () => {
      moveCard({ key: card.key, column: columnKey });
      const res = await setCartVerdict(card.repo, columnKey, card.projectSlug);
      if (!res.ok) setErr(res.error ?? "could not move that card");
    });
  }

  return (
    <div className="carts-board-wrap">
      <div className="carts-board">
        {columns.map((col) => {
          const colCards = cards.filter((c) => c.column === col.key);
          const droppable = DROP.has(col.key);
          const isOver = overCol === col.key && droppable && !!dragKey;
          return (
            <div
              key={col.key}
              className={`carts-col${isOver ? " drop" : ""}${droppable ? "" : " nodrop"}`}
              onDragOver={(e) => { if (droppable && dragKey) { e.preventDefault(); setOverCol(col.key); } }}
              onDragLeave={() => setOverCol((o) => (o === col.key ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(col.key); }}
            >
              <div className="carts-col-head">
                <span className="carts-col-name">{col.label}</span>
                <span className="carts-col-count">{colCards.length}</span>
                <span className="carts-col-dots">···</span>
              </div>
              <div className="carts-col-body">
                {colCards.map((card) => (
                  <div
                    key={card.key}
                    className="carts-card draggable"
                    draggable
                    onDragStart={() => setDragKey(card.key)}
                    onDragEnd={() => { setDragKey(null); setOverCol(null); }}
                    onClick={() => setSel(card)}
                  >
                    <div className="carts-card-title">{card.title}</div>
                    {card.meta.map((mt, i) => (
                      <div key={i} className="carts-card-meta"><Icon name={META_ICON[mt.icon] ?? "doc"} size={13} />{mt.text}</div>
                    ))}
                    {card.match != null && (
                      <div className="carts-card-match">
                        <div className="carts-card-match-row"><span>Match</span><span className="carts-card-match-pct">{card.match}%</span></div>
                        <span className="carts-bar-track"><span className="carts-bar-fill" style={{ width: `${card.match}%` }} /></span>
                      </div>
                    )}
                    {card.sub && <div className="carts-card-sub">{card.sub}</div>}
                  </div>
                ))}
                {droppable && <div className="carts-add">+&nbsp;&nbsp;Add a card</div>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="carts-board-note">
        {err ? <span className="carts-err">{err}</span> : note}
        {pending ? <span className="carts-saving">  ·  saving…</span> : null}
      </div>

      <NodeDrawer nodeRef={sel?.node ?? null} title={sel?.title ?? ""} onClose={() => setSel(null)} />
    </div>
  );
}
