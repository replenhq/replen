"use client";

import { useMemo, useState } from "react";
import { NodeDrawer } from "./CartsDrawer";
import type { CartMapPoint } from "@/graph/carts-shared";

// The semantic map as a Cart layout: the cart's nodes placed by MEANING (the
// same PCA projection the graph uses), coloured by a chosen dimension. Clusters
// are themes; empty regions are blind spots; click a dot for its dossier.
type By = "theme" | "provenance" | "verdict" | "modality";

const PALETTE = ["#ffc857", "#6fce82", "#9fb3ff", "#e08a6a", "#c58cf0", "#5ec8c8", "#d8b06a", "#7d9cff", "#cf7fae", "#88c070"];
const VERDICT_COLOR: Record<string, string> = { adopt: "#6fce82", port: "#ffc857", "cherry-pick": "#d8b06a", "clean-room": "#9fb3ff", upgrade: "#9fb3ff", skip: "#66645e", suggested: "#9d9a93", evaluating: "#e0a92e" };
const PROV_COLOR: Record<string, string> = { grounded: "#6fce82", extracted: "#9fb3ff", inferred: "#66645e", ambiguous: "#66645e" };
const NEUTRAL = "#66645e";

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function value(p: CartMapPoint, by: By): string | null {
  return by === "verdict" ? p.verdict : by === "provenance" ? p.provenance : by === "modality" ? p.modality : p.theme;
}
function colorFor(p: CartMapPoint, by: By): string {
  const v = value(p, by);
  if (!v) return NEUTRAL;
  if (by === "verdict") return VERDICT_COLOR[v] ?? NEUTRAL;
  if (by === "provenance") return PROV_COLOR[v] ?? NEUTRAL;
  return hashColor(v);
}

const W = 1000, H = 640, PAD = 44;

export function CartsMap({ points, positions }: { points: CartMapPoint[]; positions: Record<string, { x: number; y: number }> }) {
  const placed = useMemo(
    () => points.map((p) => ({ p, pos: positions[p.node] })).filter((r): r is { p: CartMapPoint; pos: { x: number; y: number } } => !!r.pos),
    [points, positions],
  );
  const has = useMemo(() => ({
    theme: points.some((p) => p.theme), provenance: points.some((p) => p.provenance),
    verdict: points.some((p) => p.verdict), modality: points.some((p) => p.modality),
  }), [points]);
  const options = (["theme", "provenance", "verdict", "modality"] as By[]).filter((k) => has[k]);
  const [by, setBy] = useState<By>(has.theme ? "theme" : has.verdict ? "verdict" : (options[0] ?? "theme"));
  const [hover, setHover] = useState<number | null>(null);
  const [sel, setSel] = useState<CartMapPoint | null>(null);

  const bounds = useMemo(() => {
    if (!placed.length) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    const xs = placed.map((r) => r.pos.x), ys = placed.map((r) => r.pos.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [placed]);
  const sx = (x: number) => PAD + (bounds.maxX > bounds.minX ? (x - bounds.minX) / (bounds.maxX - bounds.minX) : 0.5) * (W - 2 * PAD);
  const sy = (y: number) => PAD + (bounds.maxY > bounds.minY ? (y - bounds.minY) / (bounds.maxY - bounds.minY) : 0.5) * (H - 2 * PAD);

  const legend = useMemo(() => {
    const seen = new Map<string, { color: string; n: number }>();
    for (const { p } of placed) {
      const v = value(p, by) ?? "—";
      const e = seen.get(v) ?? { color: colorFor(p, by), n: 0 };
      e.n++; seen.set(v, e);
    }
    return [...seen.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  }, [placed, by]);

  const showLabels = placed.length <= 45;
  const unplaced = points.length - placed.length;

  if (!placed.length) {
    return <div className="carts-empty"><p>Nothing to place on the map yet.</p><p className="carts-faint">The semantic map needs project + candidate embeddings from a pipeline run.</p></div>;
  }

  return (
    <div className="carts-map-wrap">
      <div className="carts-map-controls">
        <span className="carts-map-by-label">Colour by</span>
        {options.map((o) => (
          <button key={o} className={`carts-map-by${by === o ? " active" : ""}`} onClick={() => setBy(o)}>{o}</button>
        ))}
        <span className="carts-map-hint">{placed.length} placed{unplaced > 0 ? `  ·  ${unplaced} not on the map` : ""}  ·  positioned by meaning (PCA)</span>
      </div>
      <div className="carts-map-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="carts-map-svg">
          {placed.map((r, i) => (
            <circle
              key={r.p.node + i}
              cx={sx(r.pos.x)} cy={sy(r.pos.y)} r={hover === i ? 7 : 5}
              fill={colorFor(r.p, by)} fillOpacity={hover === null || hover === i ? 0.9 : 0.5}
              stroke={hover === i ? "#ece9e2" : "none"} strokeWidth={1}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => setSel(r.p)}
            >
              <title>{r.p.label}</title>
            </circle>
          ))}
          {placed.map((r, i) => (
            (showLabels || hover === i) ? (
              <text key={"t" + i} x={sx(r.pos.x)} y={sy(r.pos.y) - 9} textAnchor="middle"
                className={hover === i ? "carts-map-label hot" : "carts-map-label"}>
                {r.p.label.length > 26 ? r.p.label.slice(0, 25) + "…" : r.p.label}
              </text>
            ) : null
          ))}
        </svg>
        <div className="carts-map-legend">
          {legend.map(([v, { color, n }]) => (
            <div key={v} className="carts-map-legend-item"><span className="carts-map-swatch" style={{ background: color }} />{v} <span className="carts-map-legend-n">{n}</span></div>
          ))}
        </div>
      </div>
      <NodeDrawer nodeRef={sel?.node ?? null} title={sel?.label ?? ""} onClose={() => setSel(null)} />
    </div>
  );
}
