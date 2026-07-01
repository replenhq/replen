"use client";

import { useState } from "react";
import { Icon } from "@/components/Icons";
import { NodeDrawer } from "./CartsDrawer";
import type { CartGroup, CartCard } from "@/graph/carts-shared";

// Cards layout: the cart's nodes as a card grid, grouped by a categorical
// (verdict for candidates, theme/domain for capabilities). Click a card for
// its dossier. Reuses the board's card visual.
const META_ICON: Record<string, string> = { star: "star", hex: "hexagon", doc: "doc", split: "split", folder: "folder" };

export function CartsCards({ groups }: { groups: CartGroup[] }) {
  const [sel, setSel] = useState<CartCard | null>(null);
  if (!groups.length) return <div className="carts-empty"><p>Nothing here yet.</p></div>;
  return (
    <div className="carts-cards-wrap">
      {groups.map((g) => (
        <section key={g.key} className="carts-cards-group">
          <div className="carts-cards-group-head">
            <span className="carts-cards-group-name">{g.label}</span>
            <span className="carts-cards-group-count">{g.total}</span>
          </div>
          <div className="carts-cards-grid">
            {g.cards.map((card) => (
              <div key={card.key} className="carts-card carts-card-click" onClick={() => setSel(card)}>
                <div className="carts-card-title">{card.title}</div>
                {card.meta.map((m, i) => (
                  <div key={i} className="carts-card-meta"><Icon name={META_ICON[m.icon] ?? "doc"} size={13} />{m.text}</div>
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
          </div>
        </section>
      ))}
      <NodeDrawer nodeRef={sel?.node ?? null} title={sel?.title ?? ""} onClose={() => setSel(null)} />
    </div>
  );
}
