"use client";

// Atlas graph view. Two layouts over the same nodes:
//   Links — force-directed by graph structure (navigation)
//   Map   — fixed positions from the PCA semantic projection (meaning)
// Live state rides on top: alert rings (security red / breaking orange /
// pricing amber, pulsing), hollow circles for blind-spot capabilities, queued
// badges on projects. Clicking opens the dossier (server action) with a
// queue button. Search, kind filters, and depth focus keep big graphs legible.

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import {
  getNodeDossier, queueFromAtlas, suggestionAction, setToolPref, addGoal, resolveGoal,
  curateCapability, setNodeNote, type Dossier,
} from "./actions";

export type GNode = {
  id: number; kind: string; nodeKey: string; label: string; theme: string | null;
  keystone: boolean; provenance: string | null; stars: number | null; degree: number;
  alertKind: string | null; alertCount: number; blindspot: boolean; queued: number;
};
export type GEdge = { kind: string; src: number; dst: number; weight: number | null };

const KIND_COLOR: Record<string, string> = {
  project: "#ffc857", capability: "#5eb0ef", candidate: "#65a30d", product: "#c084fc", tool: "#f472b6", suggestion: "#2dd4bf", goal: "#f43f5e", modality: "#888",
};
const EDGE_COLOR: Record<string, string> = {
  HAS_CAPABILITY: "rgba(94,176,239,0.18)", ADJACENT_TO: "rgba(120,120,140,0.14)", FILLS: "rgba(101,163,13,0.3)",
  EVALUATED: "rgba(217,119,6,0.35)", MEMBER_OF: "rgba(192,132,252,0.3)", RELATES_TO: "rgba(120,120,140,0.10)",
  USES: "rgba(244,114,182,0.12)", SUGGESTED: "rgba(45,212,191,0.30)", GOAL_OF: "rgba(244,63,94,0.35)",
};
const ALERT_COLOR: Record<string, string> = { security: "#ef4444", breaking: "#f97316", pricing: "#eab308" };
const ALL_KINDS = ["project", "capability", "candidate", "suggestion", "goal", "tool", "product"];

type P = { x: number; y: number; z: number; vx: number; vy: number; vz: number };

export function AtlasGraph({ nodes, edges, mapPos }: { nodes: GNode[]; edges: GEdge[]; mapPos: Record<number, { x: number; y: number; z: number }> }) {
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
  // 3D is the default — the first-load impression is the orbiting volume;
  // 2D remains one click away for focused reading.
  const [dim3, setDim3] = useState(true);
  const [, startTransition] = useTransition();

  // live refs so the render loop sees current UI state without re-init
  const viewRef = useRef(view); viewRef.current = view;
  const searchRef = useRef(search); searchRef.current = search;
  const kindsRef = useRef(kinds); kindsRef.current = kinds;
  const depthRef = useRef(depth); depthRef.current = depth;
  const dim3Ref = useRef(dim3); dim3Ref.current = dim3;
  const reheatRef = useRef(false);
  const scatterRef = useRef(false);
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
    nodes.forEach((n, i) => { const a = (i / nodes.length) * Math.PI * 2; const r = 200 + (i % 7) * 40; pos.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r, z: ((i * 37) % 240) - 120, vx: 0, vy: 0, vz: 0 }); });
    const radius = (n: GNode) => (n.kind === "project" ? 7 : n.kind === "product" ? 8 : n.kind === "tool" ? 3.5 : n.keystone ? 6 : 3) + Math.min(4, n.degree * 0.15);

    let cam = { x: 0, y: 0, scale: 0.9 };
    let yaw = 0, pitch = 0; // 3D orbit camera
    const PERSP = 1100;     // perspective distance — smaller = more dramatic
    let alpha = 1;
    let hovered: GNode | null = null;
    let raf = 0;
    const t0 = performance.now();
    // Per-frame projected screen positions (3D-aware) — draw + hit share them.
    const proj = new Map<number, { sx: number; sy: number; f: number; zr: number }>();
    const projectAll = () => {
      const is3d = dim3Ref.current;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (const n of nodes) {
        const p = pos.get(n.id)!;
        let xr = p.x, yr = p.y, zr = 0;
        if (is3d) {
          xr = p.x * cy + p.z * sy;
          const z1 = -p.x * sy + p.z * cy;
          yr = p.y * cp - z1 * sp;
          zr = p.y * sp + z1 * cp;
        }
        const f = is3d ? PERSP / Math.max(120, PERSP + zr) : 1;
        proj.set(n.id, { sx: xr * f * cam.scale + cam.x, sy: yr * f * cam.scale + cam.y, f, zr });
      }
    };

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
      if (reheatRef.current) { alpha = Math.max(alpha, 0.6); reheatRef.current = false; }
      const is3d = dim3Ref.current;
      // Entering 3D after the 2D mode flattened z: every node sits at z≈0 and
      // the simulation can never break that symmetry by itself (equal z means
      // zero z-forces — an unstable equilibrium, and a flat plane viewed
      // edge-on during orbit collapses to a line). Re-scatter depth
      // deterministically so the layout can actually inflate.
      if (scatterRef.current) {
        if (is3d) {
          nodes.forEach((n, i) => {
            const p = pos.get(n.id)!;
            if (Math.abs(p.z) < 40) { p.z = ((i * 53) % 280) - 140; p.vz = 0; }
          });
        }
        scatterRef.current = false;
      }
      if (viewRef.current === "links" && alpha > 0.02) {
        const arr = nodes;
        for (let i = 0; i < arr.length; i++) {
          const a = pos.get(arr[i].id)!;
          for (let k = i + 1; k < arr.length; k++) {
            const b = pos.get(arr[k].id)!;
            let dx = a.x - b.x, dy = a.y - b.y, dz = is3d ? a.z - b.z : 0;
            let d2 = dx * dx + dy * dy + dz * dz; if (d2 < 1) d2 = 1;
            const f = (is3d ? 1400 : 600) / d2; const d = Math.sqrt(d2);
            const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
            a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz;
          }
        }
        for (const e of validEdges) {
          const a = pos.get(e.src)!, b = pos.get(e.dst)!;
          let dx = b.x - a.x, dy = b.y - a.y, dz = is3d ? b.z - a.z : 0;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          const target = e.kind === "HAS_CAPABILITY" ? 60 : e.kind === "MEMBER_OF" ? 50 : e.kind === "USES" ? 70 : e.kind === "SUGGESTED" ? 75 : 90;
          const f = (d - target) * 0.01 * (e.kind === "RELATES_TO" ? 0.4 : 1);
          const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
          a.vx += fx; a.vy += fy; a.vz += fz; b.vx -= fx; b.vy -= fy; b.vz -= fz;
        }
        for (const n of nodes) {
          const p = pos.get(n.id)!;
          p.vx -= p.x * 0.002; p.vy -= p.y * 0.002; p.vz -= p.z * 0.002;
          p.vx *= 0.85; p.vy *= 0.85; p.vz *= 0.85;
          p.x += p.vx * alpha; p.y += p.vy * alpha;
          if (is3d) p.z += p.vz * alpha; else p.z *= 0.9; // 2D gently flattens
        }
        alpha *= 0.985;
      } else if (viewRef.current === "map") {
        for (const n of nodes) {
          const t = mapTarget(n.id);
          if (!t) continue;
          const p = pos.get(n.id)!;
          p.x += (t.x - p.x) * 0.12; p.y += (t.y - p.y) * 0.12;
          p.z += ((is3d ? t.z : 0) - p.z) * 0.12;
          p.vx = 0; p.vy = 0; p.vz = 0;
        }
      } else if (!is3d) {
        for (const n of nodes) { const p = pos.get(n.id)!; p.z *= 0.9; }
      }
      // Idle auto-orbit in 3D: a slow drift until the user grabs the camera —
      // the "alive" feel for demos without hijacking interaction.
      if (is3d && !userOrbited) yaw += 0.0018;
      draw();
      raf = requestAnimationFrame(tick);
    }

    function draw() {
      const r = cv.getBoundingClientRect();
      cx.clearRect(0, 0, r.width, r.height);
      projectAll();
      const is3d = dim3Ref.current;
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
        const a = proj.get(e.src)!, b = proj.get(e.dst)!;
        const on = (selRef.current != null && (e.src === selRef.current || e.dst === selRef.current))
          || (hoverId != null && (e.src === hoverId || e.dst === hoverId));
        // depth fade in 3D: edges further away recede
        const depthFade = is3d ? Math.max(0.25, Math.min(1, (a.f + b.f) / 2)) : 1;
        cx.globalAlpha = depthFade;
        cx.strokeStyle = on ? "rgba(255,200,87,0.5)" : (EDGE_COLOR[e.kind] ?? "rgba(120,120,140,0.1)");
        cx.lineWidth = on ? 1.4 : 0.6;
        cx.beginPath(); cx.moveTo(a.sx, a.sy); cx.lineTo(b.sx, b.sy); cx.stroke();
        cx.globalAlpha = 1;
      }
      // Painter's order in 3D: far nodes first so near ones overdraw them.
      const drawOrder = is3d
        ? nodes.slice().sort((a, b) => (proj.get(b.id)?.zr ?? 0) - (proj.get(a.id)?.zr ?? 0))
        : nodes;
      for (const n of drawOrder) {
        if (!shown(n)) continue;
        if (focus && !focus.has(n.id)) continue;
        const pr = proj.get(n.id)!;
        const hoverDim = hoverId != null && n.id !== hoverId && !hoverHi?.has(n.id);
        const dimmed = (searching && !searchHit(n)) || hoverDim;
        const rr = radius(n) * Math.min(1.6, cam.scale + 0.4) * (is3d ? pr.f : 1);
        const x = pr.sx, y = pr.sy;
        cx.globalAlpha = dimmed ? 0.12 : (is3d ? Math.max(0.35, Math.min(1, pr.f)) : 1);
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
    let userOrbited = false;
    const hit = (mx: number, my: number): GNode | null => {
      // nearest-first in 3D so the front node wins overlapping hits
      const order = dim3Ref.current
        ? nodes.slice().sort((a, b) => (proj.get(a.id)?.zr ?? 0) - (proj.get(b.id)?.zr ?? 0))
        : nodes.slice().reverse();
      for (const n of order) {
        if (!visible(n)) continue;
        if (viewRef.current === "map" && !mapTarget(n.id)) continue;
        const pr = proj.get(n.id);
        if (!pr) continue;
        const rr = radius(n) * Math.min(1.6, cam.scale + 0.4) * (dim3Ref.current ? pr.f : 1) + 3;
        if ((mx - pr.sx) ** 2 + (my - pr.sy) ** 2 < rr * rr) return n;
      }
      return null;
    };
    const onWheel = (ev: WheelEvent) => { ev.preventDefault(); const r = cv.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top; const f = ev.deltaY < 0 ? 1.1 : 0.9; const wx = (mx - cam.x) / cam.scale, wy = (my - cam.y) / cam.scale; cam.scale = Math.max(0.2, Math.min(5, cam.scale * f)); cam.x = mx - wx * cam.scale; cam.y = my - wy * cam.scale; };
    const onDown = (ev: MouseEvent) => { dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY; };
    const onMove = (ev: MouseEvent) => {
      const r = cv.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      if (dragging) {
        const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        if (dim3Ref.current) {
          // 3D: dragging orbits the camera (shift-drag pans)
          if (ev.shiftKey) { cam.x += dx; cam.y += dy; }
          else { yaw += dx * 0.005; pitch = Math.max(-1.4, Math.min(1.4, pitch + dy * 0.005)); userOrbited = true; }
        } else {
          cam.x += dx; cam.y += dy;
        }
        lastX = ev.clientX; lastY = ev.clientY;
      }
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
  // Input controls state (dossier edits + the panel's portfolio-goal box).
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [planDraft, setPlanDraft] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [panelGoalDraft, setPanelGoalDraft] = useState("");
  useEffect(() => {
    setActionMsg(null);
    setNoteDraft(dossier?.note ?? "");
    setPlanDraft(dossier?.tool?.plan ?? "");
    setRenameDraft("");
    setGoalDraft("");
  }, [dossier]);
  const act = (fn: () => Promise<{ ok: boolean } | { ok: boolean; id?: number } | { ok: boolean; touched: number }>, doneMsg: string) => {
    startTransition(async () => {
      try {
        const res = await fn();
        setActionMsg(res.ok ? doneMsg : "That didn't save — try again.");
      } catch {
        setActionMsg("That didn't save — try again.");
      }
    });
  };
  const inputStyle: CSSProperties = { background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 6, color: "#f1f1f1", padding: "4px 9px", fontSize: 12, outline: "none" };
  const btnStyle: CSSProperties = { background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)", color: "#ddd", borderRadius: 5, padding: "4px 10px", cursor: "pointer", fontSize: 12 };

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
            <span style={chip(dim3)} onClick={() => { setDim3(!dim3); reheatRef.current = true; scatterRef.current = true; }} title="3D — orbit with drag, shift-drag pans, scroll zooms. In Map view, depth is the third principal component.">3D</span>
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
              <div style={{ display: "flex", gap: 6, marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <input value={panelGoalDraft} onChange={(e) => setPanelGoalDraft(e.target.value)}
                  placeholder="add a portfolio goal (e.g. real-time collab)…" style={{ ...inputStyle, flex: 1 }} />
                <button style={btnStyle} disabled={!panelGoalDraft.trim()}
                  onClick={() => { const g = panelGoalDraft; setPanelGoalDraft(""); act(() => addGoal(g), `Goal "${g}" added — it'll appear on the graph and steer matching + scouting.`); }}>+ goal</button>
              </div>
              {actionMsg && !selected && <div style={{ marginTop: 8, color: "#67e8f9", fontSize: 12 }}>{actionMsg}</div>}
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
              {(dossier.decisions?.length ?? 0) > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                    Your decisions ({dossier.decisions!.length})
                  </div>
                  {dossier.decisions!.map((d, i) => (
                    <div key={i} style={{ margin: "6px 0 10px", padding: "8px 10px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, color: d.verdict === "adopt" ? "#86efac" : d.verdict === "port" ? "#93c5fd" : d.verdict === "defer" ? "#fcd34d" : "#f87171" }}>{d.verdict}</span>
                        {d.score != null && <span style={{ color: "#999" }}> · {d.score}/100</span>}
                        {d.effort && <span style={{ color: "#999" }}> · {d.effort}</span>}
                        {d.reason && <span style={{ color: "#999" }}> · {d.reason}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: "#888", margin: "2px 0" }}>triaged in {d.project} · {d.at}</div>
                      {d.oneLine && <div style={{ color: "#ccc", marginTop: 4 }}>{d.oneLine}</div>}
                      {!d.oneLine && !d.writeup && <div style={{ color: "#777", fontSize: 12, marginTop: 4 }}>bare verdict — the agent recorded no reasoning</div>}
                      {d.writeup && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: "pointer", color: "#5eb0ef", fontSize: 12 }}>show write-up</summary>
                          <div style={{ whiteSpace: "pre-wrap", color: "#bbb", fontSize: 12, marginTop: 6, maxHeight: 320, overflowY: "auto" }}>{d.writeup}</div>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {dossier.sections.map((s) => (
                <div key={s.heading} style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{s.heading}</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {s.items.map((it, i) => <li key={i} style={{ margin: "3px 0", color: "#ccc" }}>{it}</li>)}
                  </ul>
                </div>
              ))}
              {/* ── actions: judgment flowing back into the engine ── */}
              {dossier.suggestion && (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button style={{ ...btnStyle, color: "#fbbf24", borderColor: "#7c5e10" }}
                    onClick={() => act(() => suggestionAction(dossier.suggestion!.fullName, "star", dossier.suggestion!.projectSlug), "Starred — it won't re-surface, and it's saved for later.")}>★ Star</button>
                  <button style={{ ...btnStyle, color: "#f87171", borderColor: "#7f1d1d" }}
                    onClick={() => act(() => suggestionAction(dossier.suggestion!.fullName, "dismiss", dossier.suggestion!.projectSlug), "Dismissed — it won't be suggested again.")}>Dismiss</button>
                </div>
              )}
              {dossier.tool && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={planDraft} onChange={(e) => setPlanDraft(e.target.value)} placeholder="your plan/tier (e.g. Pro)" style={{ ...inputStyle, flex: 1 }} />
                    <button style={btnStyle} onClick={() => act(() => setToolPref(dossier.tool!.key, { plan: planDraft }), "Plan saved — pricing alerts are now personal to it.")}>save</button>
                  </div>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", color: "#bbb", fontSize: 12, cursor: "pointer" }}>
                    <input type="checkbox" defaultChecked={dossier.tool.migrateOff}
                      onChange={(e) => act(() => setToolPref(dossier.tool!.key, { migrateOff: e.target.checked }), e.target.checked ? "Marked migrating-off — its release noise is muted." : "Unmarked.")} />
                    we're migrating off this
                  </label>
                </div>
              )}
              {dossier.capability && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} placeholder="rename / merge into…" style={{ ...inputStyle, flex: 1 }} />
                    <button style={btnStyle} disabled={!renameDraft.trim()}
                      onClick={() => act(() => curateCapability(dossier.capability!.label, "merge", renameDraft), "Merged/renamed — applied everywhere, regeneration-proof.")}>apply</button>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {dossier.capability.provenance !== "grounded" && (
                      <button style={{ ...btnStyle, color: "#86efac", borderColor: "#14532d" }}
                        onClick={() => act(() => curateCapability(dossier.capability!.label, "confirm"), "Confirmed — now trusted as grounded; the inferred-facet premium no longer applies.")}>✓ confirm real</button>
                    )}
                    <button style={{ ...btnStyle, color: "#f87171", borderColor: "#7f1d1d" }}
                      onClick={() => { if (window.confirm(`Remove "${dossier.capability!.label}" as a capability everywhere? This also blocks regeneration from re-adding it.`)) act(() => curateCapability(dossier.capability!.label, "delete"), "Removed — it can't come back via regeneration."); }}>not a capability</button>
                  </div>
                </div>
              )}
              {dossier.project && (
                <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
                  <input value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)} placeholder="add a goal for this project…" style={{ ...inputStyle, flex: 1 }} />
                  <button style={btnStyle} disabled={!goalDraft.trim()}
                    onClick={() => act(() => addGoal(goalDraft, { projectSlug: dossier.project!.slug }), "Goal added — matching boosts it and scouting hunts for it from the next run.")}>+ goal</button>
                </div>
              )}
              {dossier.goal && (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button style={{ ...btnStyle, color: "#86efac", borderColor: "#14532d" }}
                    onClick={() => act(() => resolveGoal(dossier.goal!.id, "done"), "Marked done 🎉")}>done</button>
                  <button style={btnStyle}
                    onClick={() => act(() => resolveGoal(dossier.goal!.id, "dropped"), "Dropped — it stops steering matching and scouting.")}>drop</button>
                </div>
              )}
              {/* anchored note — flows into recall + the vault */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Note (agents see this via recall)</div>
                <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} rows={2}
                  placeholder="e.g. tried X here — rate limits killed it"
                  style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit" }} />
                <button style={{ ...btnStyle, marginTop: 4 }}
                  onClick={() => act(() => setNodeNote(selected.kind, selected.nodeKey, noteDraft), noteDraft.trim() ? "Note saved — recall and your Atlas tiles carry it now." : "Note cleared.")}>save note</button>
              </div>
              {actionMsg && <div style={{ marginTop: 10, color: "#67e8f9", fontSize: 12 }}>{actionMsg}</div>}
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
