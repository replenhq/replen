"use client";

import { useEffect, useRef, useState } from "react";

export type GNode = { id: number; kind: string; label: string; theme: string | null; keystone: boolean; provenance: string | null; stars: number | null; degree: number };
export type GEdge = { kind: string; src: number; dst: number; weight: number | null };

const KIND_COLOR: Record<string, string> = {
  project: "#ffc857", capability: "#5eb0ef", candidate: "#65a30d", product: "#c084fc", modality: "#888",
};
const EDGE_COLOR: Record<string, string> = {
  HAS_CAPABILITY: "rgba(94,176,239,0.18)", ADJACENT_TO: "rgba(120,120,140,0.14)", FILLS: "rgba(101,163,13,0.3)",
  EVALUATED: "rgba(217,119,6,0.35)", MEMBER_OF: "rgba(192,132,252,0.3)", RELATES_TO: "rgba(120,120,140,0.10)",
};

type P = { x: number; y: number; vx: number; vy: number };

export function AtlasGraph({ nodes, edges }: { nodes: GNode[]; edges: GEdge[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<GNode | null>(null);

  useEffect(() => {
    const _cv = canvasRef.current; if (!_cv) return;
    const _cx = _cv.getContext("2d"); if (!_cx) return;
    const cv: HTMLCanvasElement = _cv;
    const cx: CanvasRenderingContext2D = _cx;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const validEdges = edges.filter((e) => byId.has(e.src) && byId.has(e.dst));
    const neighbors = new Map<number, Set<number>>();
    for (const e of validEdges) { (neighbors.get(e.src) ?? neighbors.set(e.src, new Set()).get(e.src)!).add(e.dst); (neighbors.get(e.dst) ?? neighbors.set(e.dst, new Set()).get(e.dst)!).add(e.src); }

    // layout state
    const pos = new Map<number, P>();
    nodes.forEach((n, i) => { const a = (i / nodes.length) * Math.PI * 2; const r = 200 + Math.random() * 200; pos.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 }); });
    const radius = (n: GNode) => (n.kind === "project" ? 7 : n.kind === "product" ? 8 : n.keystone ? 6 : 3) + Math.min(4, n.degree * 0.15);

    let cam = { x: 0, y: 0, scale: 0.9 };
    let alpha = 1;
    let hovered: GNode | null = null;
    let selId: number | null = null;
    let raf = 0;

    function resize() { const dpr = window.devicePixelRatio || 1; const r = cv.getBoundingClientRect(); cv.width = r.width * dpr; cv.height = r.height * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); cam.x = r.width / 2; cam.y = r.height / 2; }
    resize(); window.addEventListener("resize", resize);

    function tick() {
      if (alpha > 0.02) {
        // repulsion (O(n^2) — fine for a few hundred nodes; cools down)
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
        // springs
        for (const e of validEdges) {
          const a = pos.get(e.src)!, b = pos.get(e.dst)!;
          let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const target = e.kind === "HAS_CAPABILITY" ? 60 : e.kind === "MEMBER_OF" ? 50 : 90;
          const f = (d - target) * 0.01 * (e.kind === "RELATES_TO" ? 0.4 : 1);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        // centering + integrate
        for (const n of nodes) { const p = pos.get(n.id)!; p.vx -= p.x * 0.002; p.vy -= p.y * 0.002; p.vx *= 0.85; p.vy *= 0.85; p.x += p.vx * alpha; p.y += p.vy * alpha; }
        alpha *= 0.985;
      }
      draw();
      raf = requestAnimationFrame(tick);
    }

    function draw() {
      const r = cv.getBoundingClientRect();
      cx.clearRect(0, 0, r.width, r.height);
      const tx = (x: number) => x * cam.scale + cam.x, ty = (y: number) => y * cam.scale + cam.y;
      const focus = selId ?? (hovered?.id ?? null);
      const hi = focus != null ? neighbors.get(focus) ?? new Set() : null;
      // edges
      for (const e of validEdges) {
        const a = pos.get(e.src)!, b = pos.get(e.dst)!;
        const on = focus != null && (e.src === focus || e.dst === focus);
        cx.strokeStyle = on ? "rgba(255,200,87,0.5)" : (EDGE_COLOR[e.kind] ?? "rgba(120,120,140,0.1)");
        cx.lineWidth = on ? 1.4 : 0.6;
        cx.beginPath(); cx.moveTo(tx(a.x), ty(a.y)); cx.lineTo(tx(b.x), ty(b.y)); cx.stroke();
      }
      // nodes
      for (const n of nodes) {
        const p = pos.get(n.id)!; const dim = focus != null && n.id !== focus && !hi?.has(n.id);
        cx.globalAlpha = dim ? 0.18 : 1;
        cx.fillStyle = KIND_COLOR[n.kind] ?? "#999";
        cx.beginPath(); cx.arc(tx(p.x), ty(p.y), radius(n) * Math.min(1.6, cam.scale + 0.4), 0, Math.PI * 2); cx.fill();
        const showLabel = !dim && (n.kind === "project" || n.kind === "product" || n.keystone || n.id === focus || cam.scale > 1.6);
        if (showLabel) { cx.globalAlpha = dim ? 0.3 : 0.92; cx.fillStyle = "#ddd"; cx.font = `${n.kind === "project" ? 12 : 10}px system-ui`; cx.fillText(n.label.slice(0, 28), tx(p.x) + radius(n) + 3, ty(p.y) + 3); }
        cx.globalAlpha = 1;
      }
    }

    // interaction
    let dragging = false, lastX = 0, lastY = 0, moved = false;
    const hit = (mx: number, my: number): GNode | null => {
      for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]; const p = pos.get(n.id)!; const sx = p.x * cam.scale + cam.x, sy = p.y * cam.scale + cam.y; const rr = radius(n) * Math.min(1.6, cam.scale + 0.4) + 3; if ((mx - sx) ** 2 + (my - sy) ** 2 < rr * rr) return n; } return null;
    };
    const onWheel = (ev: WheelEvent) => { ev.preventDefault(); const r = cv.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top; const f = ev.deltaY < 0 ? 1.1 : 0.9; const wx = (mx - cam.x) / cam.scale, wy = (my - cam.y) / cam.scale; cam.scale = Math.max(0.2, Math.min(5, cam.scale * f)); cam.x = mx - wx * cam.scale; cam.y = my - wy * cam.scale; };
    const onDown = (ev: MouseEvent) => { dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY; };
    const onMove = (ev: MouseEvent) => {
      const r = cv.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      if (dragging) { const dx = ev.clientX - lastX, dy = ev.clientY - lastY; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; cam.x += dx; cam.y += dy; lastX = ev.clientX; lastY = ev.clientY; }
      else { hovered = hit(mx, my); cv.style.cursor = hovered ? "pointer" : "grab"; }
    };
    const onUp = (ev: MouseEvent) => { if (dragging && !moved) { const r = cv.getBoundingClientRect(); const n = hit(ev.clientX - r.left, ev.clientY - r.top); selId = n?.id ?? null; setSelected(n); } dragging = false; };
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("mousedown", onDown); window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);

    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); cv.removeEventListener("wheel", onWheel); cv.removeEventListener("mousedown", onDown); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [nodes, edges]);

  const legend: Array<[string, string]> = [["project", KIND_COLOR.project], ["capability", KIND_COLOR.capability], ["candidate", KIND_COLOR.candidate], ["product", KIND_COLOR.product]];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", background: "var(--bg, #0a0a0a)", cursor: "grab" }} />
      <div style={{ position: "absolute", top: 12, left: 12, display: "flex", gap: 12, fontSize: 12, color: "#aaa", background: "rgba(0,0,0,0.4)", padding: "6px 10px", borderRadius: 6 }}>
        {legend.map(([k, c]) => <span key={k}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, background: c, marginRight: 5 }} />{k}</span>)}
      </div>
      {selected && (
        <div style={{ position: "absolute", top: 12, right: 12, width: 280, background: "rgba(20,20,20,0.95)", border: "1px solid #333", borderRadius: 8, padding: 14, fontSize: 13, color: "#ddd" }}>
          <div style={{ fontSize: 11, color: KIND_COLOR[selected.kind] ?? "#999", textTransform: "uppercase", letterSpacing: 0.5 }}>{selected.kind}{selected.keystone ? " · keystone" : ""}</div>
          <div style={{ fontWeight: 700, fontSize: 15, margin: "4px 0" }}>{selected.label}</div>
          {selected.theme && <div style={{ color: "#999" }}>theme: {selected.theme}</div>}
          {selected.provenance && <div style={{ color: "#999" }}>provenance: {selected.provenance}</div>}
          {selected.stars != null && <div style={{ color: "#999" }}>{selected.stars}★</div>}
          <div style={{ color: "#777", marginTop: 6 }}>{selected.degree} connections</div>
          <button onClick={() => setSelected(null)} style={{ marginTop: 10, background: "none", border: "1px solid #444", color: "#aaa", borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontSize: 12 }}>close</button>
        </div>
      )}
    </div>
  );
}
