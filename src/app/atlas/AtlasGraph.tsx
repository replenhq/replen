"use client";

// Atlas graph view. Two layouts over the same nodes:
//   Links — force-directed by graph structure (navigation)
//   Map   — fixed positions from the PCA semantic projection (meaning)
// Live state rides on top: alert rings (security red / breaking orange /
// pricing amber, pulsing), hollow circles for blind-spot capabilities, queued
// badges on projects. Clicking opens the dossier (server action) with a
// queue button. Search, kind filters, and depth focus keep big graphs legible.

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { getNodeDossier, queueFromAtlas, type Dossier } from "./actions";

export type GNode = {
  id: number; kind: string; nodeKey: string; label: string; theme: string | null;
  keystone: boolean; provenance: string | null; stars: number | null; degree: number;
  alertKind: string | null; alertCount: number; blindspot: boolean; queued: number;
};
export type GEdge = { kind: string; src: number; dst: number; weight: number | null };

const KIND_COLOR: Record<string, string> = {
  project: "#ffc857", capability: "#5eb0ef", candidate: "#65a30d", product: "#c084fc", tool: "#f472b6", modality: "#888",
};
const EDGE_COLOR: Record<string, string> = {
  HAS_CAPABILITY: "rgba(94,176,239,0.18)", ADJACENT_TO: "rgba(120,120,140,0.14)", FILLS: "rgba(101,163,13,0.3)",
  EVALUATED: "rgba(217,119,6,0.35)", MEMBER_OF: "rgba(192,132,252,0.3)", RELATES_TO: "rgba(120,120,140,0.10)",
  USES: "rgba(244,114,182,0.12)",
};
const ALERT_COLOR: Record<string, string> = { security: "#ef4444", breaking: "#f97316", pricing: "#eab308" };
const ALL_KINDS = ["project", "capability", "candidate", "tool", "product"];

type P = { x: number; y: number; vx: number; vy: number };

export function AtlasGraph({ nodes, edges, mapPos }: { nodes: GNode[]; edges: GEdge[]; mapPos: Record<number, { x: number; y: number }> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [view, setView] = useState<"links" | "map">("links");
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(new Set(ALL_KINDS));
  const [depth, setDepth] = useState<1 | 2>(1);
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [, startTransition] = useTransition();

  // live refs so the render loop sees current UI state without re-init
  const viewRef = useRef(view); viewRef.current = view;
  const searchRef = useRef(search); searchRef.current = search;
  const kindsRef = useRef(kinds); kindsRef.current = kinds;
  const depthRef = useRef(depth); depthRef.current = depth;
  const selRef = useRef<number | null>(null);

  useEffect(() => {
    const _cv = canvasRef.current; if (!_cv) return;
    const _cx = _cv.getContext("2d"); if (!_cx) return;
    const cv: HTMLCanvasElement = _cv;
    const cx: CanvasRenderingContext2D = _cx;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const validEdges = edges.filter((e) => byId.has(e.src) && byId.has(e.dst));
    const neighbors = new Map<number, Set<number>>();
    for (const e of validEdges) { (neighbors.get(e.src) ?? neighbors.set(e.src, new Set()).get(e.src)!).add(e.dst); (neighbors.get(e.dst) ?? neighbors.set(e.dst, new Set()).get(e.dst)!).add(e.src); }

    const pos = new Map<number, P>();
    nodes.forEach((n, i) => { const a = (i / nodes.length) * Math.PI * 2; const r = 200 + (i % 7) * 40; pos.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 }); });
    const radius = (n: GNode) => (n.kind === "project" ? 7 : n.kind === "product" ? 8 : n.kind === "tool" ? 3.5 : n.keystone ? 6 : 3) + Math.min(4, n.degree * 0.15);

    let cam = { x: 0, y: 0, scale: 0.9 };
    let alpha = 1;
    let hovered: GNode | null = null;
    let raf = 0;
    const t0 = performance.now();

    const visible = (n: GNode) => kindsRef.current.has(n.kind) || (n.kind !== "project" && !ALL_KINDS.includes(n.kind));
    const searchHit = (n: GNode) => searchRef.current.length >= 2 && n.label.toLowerCase().includes(searchRef.current.toLowerCase());

    // Focus set: selected node + neighborhood at the chosen depth.
    const focusSet = (): Set<number> | null => {
      const sel = selRef.current;
      if (sel == null) return null;
      const out = new Set<number>([sel]);
      let frontier = [sel];
      for (let d = 0; d < depthRef.current; d++) {
        const next: number[] = [];
        for (const id of frontier) for (const nb of neighbors.get(id) ?? []) if (!out.has(nb)) { out.add(nb); next.push(nb); }
        frontier = next;
      }
      return out;
    };

    function resize() { const dpr = window.devicePixelRatio || 1; const r = cv.getBoundingClientRect(); cv.width = r.width * dpr; cv.height = r.height * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); cam.x = r.width / 2; cam.y = r.height / 2; }
    resize(); window.addEventListener("resize", resize);

    // In map view, glide nodes with coordinates toward them; hide the rest.
    const mapTarget = (id: number) => mapPos[id];

    function tick() {
      if (viewRef.current === "links" && alpha > 0.02) {
        const arr = nodes;
        for (let i = 0; i < arr.length; i++) {
          const a = pos.get(arr[i].id)!;
          for (let k = i + 1; k < arr.length; k++) {
            const b = pos.get(arr[k].id)!;
            let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
            const f = 600 / d2; const d = Math.sqrt(d2); const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
        }
        for (const e of validEdges) {
          const a = pos.get(e.src)!, b = pos.get(e.dst)!;
          let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const target = e.kind === "HAS_CAPABILITY" ? 60 : e.kind === "MEMBER_OF" ? 50 : e.kind === "USES" ? 70 : 90;
          const f = (d - target) * 0.01 * (e.kind === "RELATES_TO" ? 0.4 : 1);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        for (const n of nodes) { const p = pos.get(n.id)!; p.vx -= p.x * 0.002; p.vy -= p.y * 0.002; p.vx *= 0.85; p.vy *= 0.85; p.x += p.vx * alpha; p.y += p.vy * alpha; }
        alpha *= 0.985;
      } else if (viewRef.current === "map") {
        for (const n of nodes) {
          const t = mapTarget(n.id);
          if (!t) continue;
          const p = pos.get(n.id)!;
          p.x += (t.x - p.x) * 0.12; p.y += (t.y - p.y) * 0.12; p.vx = 0; p.vy = 0;
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    }

    function draw() {
      const r = cv.getBoundingClientRect();
      cx.clearRect(0, 0, r.width, r.height);
      const tx = (x: number) => x * cam.scale + cam.x, ty = (y: number) => y * cam.scale + cam.y;
      const inMap = viewRef.current === "map";
      const shown = (n: GNode) => visible(n) && (!inMap || !!mapTarget(n.id));
      const focus = focusSet();
      const searching = searchRef.current.length >= 2;
      const pulse = 1 + 0.25 * Math.sin((performance.now() - t0) / 300);
      // Hover focus (when nothing is selected): highlight the hovered node's
      // edges and dim everything outside its neighborhood — the quick "what
      // is this linked to?" read, no click needed.
      const hoverId = selRef.current == null && hovered ? hovered.id : null;
      const hoverHi = hoverId != null ? neighbors.get(hoverId) ?? new Set<number>() : null;

      for (const e of validEdges) {
        if (inMap) break; // the map is about position, not plumbing
        const na = byId.get(e.src)!, nb = byId.get(e.dst)!;
        if (!shown(na) || !shown(nb)) continue;
        if (focus && !(focus.has(e.src) && focus.has(e.dst))) continue;
        const a = pos.get(e.src)!, b = pos.get(e.dst)!;
        const on = (selRef.current != null && (e.src === selRef.current || e.dst === selRef.current))
          || (hoverId != null && (e.src === hoverId || e.dst === hoverId));
        cx.strokeStyle = on ? "rgba(255,200,87,0.5)" : (EDGE_COLOR[e.kind] ?? "rgba(120,120,140,0.1)");
        cx.lineWidth = on ? 1.4 : 0.6;
        cx.beginPath(); cx.moveTo(tx(a.x), ty(a.y)); cx.lineTo(tx(b.x), ty(b.y)); cx.stroke();
      }
      for (const n of nodes) {
        if (!shown(n)) continue;
        if (focus && !focus.has(n.id)) continue;
        const p = pos.get(n.id)!;
        const hoverDim = hoverId != null && n.id !== hoverId && !hoverHi?.has(n.id);
        const dimmed = (searching && !searchHit(n)) || hoverDim;
        const rr = radius(n) * Math.min(1.6, cam.scale + 0.4);
        const x = tx(p.x), y = ty(p.y);
        cx.globalAlpha = dimmed ? 0.12 : 1;
        // alert ring (live state) — pulses
        if (n.alertCount > 0 && n.alertKind) {
          cx.strokeStyle = ALERT_COLOR[n.alertKind] ?? "#eab308";
          cx.lineWidth = 2;
          cx.beginPath(); cx.arc(x, y, rr + 3 * pulse, 0, Math.PI * 2); cx.stroke();
        }
        cx.fillStyle = KIND_COLOR[n.kind] ?? "#999";
        if (n.blindspot) {
          // hollow = uncovered capability
          cx.strokeStyle = KIND_COLOR[n.kind] ?? "#999"; cx.lineWidth = 1.5;
          cx.beginPath(); cx.arc(x, y, rr, 0, Math.PI * 2); cx.stroke();
        } else {
          cx.beginPath(); cx.arc(x, y, rr, 0, Math.PI * 2); cx.fill();
        }
        if (n.queued > 0) {
          cx.fillStyle = "#22d3ee";
          cx.beginPath(); cx.arc(x + rr, y - rr, 3, 0, Math.PI * 2); cx.fill();
        }
        const showLabel = !dimmed && (n.kind === "project" || n.kind === "product" || n.keystone || n.id === selRef.current || n.id === hoverId || (hoverHi?.has(n.id) ?? false) || (searching && searchHit(n)) || cam.scale > 1.6);
        if (showLabel) { cx.globalAlpha = 0.92; cx.fillStyle = "#ddd"; cx.font = `${n.kind === "project" ? 12 : 10}px system-ui`; cx.fillText(n.label.slice(0, 28), x + rr + 3, y + 3); }
        cx.globalAlpha = 1;
      }
    }

    let dragging = false, lastX = 0, lastY = 0, moved = false;
    const hit = (mx: number, my: number): GNode | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!visible(n)) continue;
        if (viewRef.current === "map" && !mapTarget(n.id)) continue;
        const p = pos.get(n.id)!;
        const sx = p.x * cam.scale + cam.x, sy = p.y * cam.scale + cam.y;
        const rr = radius(n) * Math.min(1.6, cam.scale + 0.4) + 3;
        if ((mx - sx) ** 2 + (my - sy) ** 2 < rr * rr) return n;
      }
      return null;
    };
    const onWheel = (ev: WheelEvent) => { ev.preventDefault(); const r = cv.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top; const f = ev.deltaY < 0 ? 1.1 : 0.9; const wx = (mx - cam.x) / cam.scale, wy = (my - cam.y) / cam.scale; cam.scale = Math.max(0.2, Math.min(5, cam.scale * f)); cam.x = mx - wx * cam.scale; cam.y = my - wy * cam.scale; };
    const onDown = (ev: MouseEvent) => { dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY; };
    const onMove = (ev: MouseEvent) => {
      const r = cv.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      if (dragging) { const dx = ev.clientX - lastX, dy = ev.clientY - lastY; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; cam.x += dx; cam.y += dy; lastX = ev.clientX; lastY = ev.clientY; }
      else { hovered = hit(mx, my); cv.style.cursor = hovered ? "pointer" : "grab"; }
    };
    const onUp = (ev: MouseEvent) => {
      if (dragging && !moved) {
        const r = cv.getBoundingClientRect();
        const n = hit(ev.clientX - r.left, ev.clientY - r.top);
        selRef.current = n?.id ?? null;
        setSelected(n);
      }
      dragging = false;
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("mousedown", onDown); window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);

    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); cv.removeEventListener("wheel", onWheel); cv.removeEventListener("mousedown", onDown); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [nodes, edges, mapPos]);

  // Dossier loads when selection changes.
  useEffect(() => {
    if (!selected) { setDossier(null); return; }
    setDossierLoading(true);
    setQueuedMsg(null);
    let cancelled = false;
    getNodeDossier(selected.kind, selected.nodeKey)
      .then((d) => { if (!cancelled) setDossier(d); })
      .catch(() => { if (!cancelled) setDossier(null); })
      .finally(() => { if (!cancelled) setDossierLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const toggleKind = (k: string) => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k); else next.add(k);
    setKinds(next);
  };
  const queueIt = (title: string) => {
    startTransition(async () => {
      const res = await queueFromAtlas(title, selected?.kind === "project" ? selected.nodeKey : null);
      setQueuedMsg(res.ok ? "Queued — it'll come up in your next coding session." : "Couldn't queue that.");
    });
  };

  const chip = (active: boolean): CSSProperties => ({
    padding: "3px 10px", borderRadius: 10, fontSize: 12, cursor: "pointer", userSelect: "none",
    border: `1px solid ${active ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.14)"}`,
    color: active ? "#f3f3f3" : "#9a9a9a",
    background: active ? "rgba(255,255,255,0.13)" : "transparent",
  });

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", background: "var(--bg, #0a0a0a)", cursor: "grab" }} />

      {/* controls — one glass panel, collapsible */}
      <div style={{ position: "absolute", top: 12, left: 12, fontSize: 12, color: "#cfcfcf", maxWidth: 380 }}>
        <div style={{
          background: "rgba(16,16,20,0.72)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
          border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
          padding: panelOpen ? "10px 12px" : "6px 10px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              onClick={() => setPanelOpen(!panelOpen)}
              title={panelOpen ? "Collapse controls" : "Expand controls"}
              style={{ cursor: "pointer", color: "#9ca3af", fontSize: 13, userSelect: "none", padding: "0 2px" }}
            >{panelOpen ? "▾" : "▸"}</span>
            <span style={chip(view === "links")} onClick={() => setView("links")}>Links</span>
            <span style={chip(view === "map")} onClick={() => setView("map")} title="Semantic map — position by meaning (PCA over the matcher's embeddings)">Map</span>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search…"
              style={{ background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 6, color: "#f1f1f1", padding: "4px 9px", fontSize: 12, width: 120, outline: "none" }}
            />
            {selected && (
              <span style={chip(false)} onClick={() => setDepth(depth === 1 ? 2 : 1)} title="Focus neighborhood depth">depth {depth}</span>
            )}
          </div>
          {panelOpen && (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {ALL_KINDS.map((k) => (
                  <span key={k} style={{ ...chip(kinds.has(k)) }} onClick={() => toggleKind(k)}>
                    <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 7, background: KIND_COLOR[k], marginRight: 5, opacity: kinds.has(k) ? 1 : 0.35 }} />{k}
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", color: "#b8b8b8" }}>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, border: `2px solid ${ALERT_COLOR.security}`, marginRight: 5 }} />alert</span>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, border: "1.5px solid #5eb0ef", marginRight: 5 }} />blind spot</span>
                <span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 7, background: "#22d3ee", marginRight: 5 }} />queued work</span>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, border: "1.5px dashed #888", marginRight: 5 }} />hover = links</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* dossier */}
      {selected && (
        <div style={{ position: "absolute", top: 12, right: 12, bottom: 12, width: 360, overflowY: "auto", background: "rgba(16,16,20,0.78)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.45)", padding: 16, fontSize: 13, color: "#ddd" }}>
          <div style={{ fontSize: 11, color: KIND_COLOR[selected.kind] ?? "#999", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {selected.kind}{selected.keystone ? " · keystone" : ""}{selected.blindspot ? " · blind spot" : ""}
          </div>
          <div style={{ fontWeight: 700, fontSize: 16, margin: "4px 0" }}>{selected.label}</div>
          {selected.alertCount > 0 && (
            <div style={{ color: ALERT_COLOR[selected.alertKind ?? "pricing"] ?? "#eab308", fontSize: 12, marginBottom: 6 }}>
              {selected.alertCount} live alert{selected.alertCount === 1 ? "" : "s"} in the last 14 days
            </div>
          )}
          {dossierLoading && <div style={{ color: "#777", margin: "10px 0" }}>loading…</div>}
          {dossier && (
            <>
              {dossier.subtitle && <div style={{ color: "#999", marginBottom: 8 }}>{dossier.subtitle}</div>}
              {dossier.url && <div style={{ marginBottom: 8 }}><a href={dossier.url} target="_blank" rel="noreferrer" style={{ color: "#5eb0ef" }}>{dossier.url.replace(/^https?:\/\//, "")}</a></div>}
              {dossier.sections.map((s) => (
                <div key={s.heading} style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{s.heading}</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {s.items.map((it, i) => <li key={i} style={{ margin: "3px 0", color: "#ccc" }}>{it}</li>)}
                  </ul>
                </div>
              ))}
              {dossier.queueSuggestion && !queuedMsg && (
                <button onClick={() => queueIt(dossier.queueSuggestion!)} style={{ marginTop: 14, background: "rgba(34,211,238,0.12)", border: "1px solid #155e6b", color: "#67e8f9", borderRadius: 5, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
                  Queue for next session →
                </button>
              )}
              {queuedMsg && <div style={{ marginTop: 12, color: "#67e8f9", fontSize: 12 }}>{queuedMsg}</div>}
            </>
          )}
          <div style={{ color: "#666", marginTop: 12, fontSize: 12 }}>{selected.degree} connections{selected.theme ? ` · theme: ${selected.theme}` : ""}</div>
          <button onClick={() => { selRef.current = null; setSelected(null); }} style={{ marginTop: 12, background: "none", border: "1px solid #444", color: "#aaa", borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontSize: 12 }}>close</button>
        </div>
      )}
    </div>
  );
}
