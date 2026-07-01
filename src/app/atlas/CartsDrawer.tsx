"use client";

import { useEffect, useState } from "react";
import { getNodeDossier, type Dossier } from "./actions";
import { fmtAgo } from "@/graph/carts-shared";

// Slide-over detail drawer, shared by the board and the map. Given a node ref
// ("kind:nodeKey") it fetches the full dossier (decision log + writeup +
// where-used) and renders it over the current cart, without navigating away.
export function NodeDrawer({ nodeRef, title, onClose }: { nodeRef: string | null; title: string; onClose: () => void }) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeRef) return;
    setDossier(null);
    setLoading(true);
    const i = nodeRef.indexOf(":");
    const kind = nodeRef.slice(0, i);
    const key = nodeRef.slice(i + 1);
    let cancelled = false;
    getNodeDossier(kind, key)
      .then((d) => { if (!cancelled) { setDossier(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [nodeRef]);

  if (!nodeRef) return null;
  return (
    <>
      <div className="carts-drawer-scrim" onClick={onClose} />
      <aside className="carts-drawer">
        <div className="carts-drawer-head">
          <div className="carts-drawer-title">{title}</div>
          <button className="carts-drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {loading && <div className="carts-drawer-loading">Loading detail…</div>}
        {!loading && dossier && <Detail dossier={dossier} />}
        {!loading && !dossier && <div className="carts-drawer-loading">No detail available for this node.</div>}
      </aside>
    </>
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
