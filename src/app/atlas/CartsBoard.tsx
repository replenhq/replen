"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Icon } from "@/components/Icons";
import { getNodeDossier, type Dossier } from "./actions";
import { setCartVerdict } from "./carts-actions";
import { VERDICT_COLUMNS, fmtAgo, type CartGroup, type CartCard } from "@/graph/carts-shared";

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
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [loadingDoss, setLoadingDoss] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function openCard(card: CartCard) {
    setSel(card);
    setDossier(null);
    setLoadingDoss(true);
    const i = card.node.indexOf(":");
    const kind = card.node.slice(0, i);
    const key = card.node.slice(i + 1);
    getNodeDossier(kind, key).then((d) => { setDossier(d); setLoadingDoss(false); }).catch(() => setLoadingDoss(false));
  }

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
                    onClick={() => openCard(card)}
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

      {sel && (
        <>
          <div className="carts-drawer-scrim" onClick={() => setSel(null)} />
          <aside className="carts-drawer">
            <div className="carts-drawer-head">
              <div className="carts-drawer-title">{sel.title}</div>
              <button className="carts-drawer-close" onClick={() => setSel(null)} aria-label="Close">×</button>
            </div>
            {loadingDoss && <div className="carts-drawer-loading">Loading detail…</div>}
            {!loadingDoss && dossier && <Detail dossier={dossier} />}
            {!loadingDoss && !dossier && <div className="carts-drawer-loading">No detail available for this node.</div>}
          </aside>
        </>
      )}
    </div>
  );
}

function Detail({ dossier }: { dossier: Dossier }) {
  return (
    <div className="carts-drawer-body">
      {dossier.subtitle && <div className="carts-drawer-subtitle">{dossier.subtitle}</div>}
      {dossier.url && <a className="carts-drawer-repo" href={dossier.url} target="_blank" rel="noopener">Open repo →</a>}

      {dossier.decisions && dossier.decisions.length > 0 && (
        <div className="carts-drawer-section">
          <div className="carts-drawer-h">Decision log</div>
          {dossier.decisions.map((d, i) => (
            <div key={i} className="carts-decision">
              <div className="carts-decision-head">
                <span className="carts-verdict-pill">{d.verdict}</span>
                {d.score != null && <span className="carts-dim">{d.score}% match</span>}
                {d.effort && <span className="carts-faint">{d.effort}</span>}
                <span className="carts-faint">{d.project}{d.at ? `  ·  ${fmtAgo(d.at)}` : ""}</span>
              </div>
              {d.oneLine && <div className="carts-decision-one">{d.oneLine}</div>}
              {d.writeup && <div className="carts-decision-writeup">{d.writeup}</div>}
              {d.reason && <div className="carts-faint">reason: {d.reason}</div>}
            </div>
          ))}
        </div>
      )}

      {dossier.sections?.map((s, i) => (
        s.items.length > 0 ? (
          <div key={i} className="carts-drawer-section">
            <div className="carts-drawer-h">{s.heading}</div>
            <ul className="carts-drawer-list">{s.items.map((it, j) => <li key={j}>{it}</li>)}</ul>
          </div>
        ) : null
      ))}
    </div>
  );
}
