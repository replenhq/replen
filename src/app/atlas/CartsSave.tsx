"use client";

import { useState, useTransition } from "react";
import { saveCart, deleteCart } from "./carts-actions";
import type { CartFilters } from "@/graph/carts-shared";

// Save the current cart + layout + filters as a named view.
export function SaveView({ baseCart, layout, filters }: { baseCart: string; layout: string; filters: CartFilters }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    const n = name.trim();
    if (!n) return;
    start(async () => {
      const r = await saveCart(n, baseCart, layout, filters);
      if (r.ok) { setOpen(false); setName(""); setErr(null); }
      else setErr(r.error ?? "could not save");
    });
  }

  if (!open) return <button className="carts-rail-save" onClick={() => setOpen(true)}>+&nbsp;&nbsp;Save this view</button>;
  return (
    <div className="carts-rail-saveform">
      <input
        autoFocus value={name} placeholder="Name this cart…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setOpen(false); setErr(null); } }}
      />
      <div className="carts-rail-saveform-row">
        <button className="carts-rail-saveconfirm" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        <button className="carts-rail-savecancel" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
      </div>
      {err && <div className="carts-rail-saveerr">{err}</div>}
    </div>
  );
}

export function DeleteCart({ id }: { id: number }) {
  const [pending, start] = useTransition();
  return (
    <button
      className="carts-rail-del" title="Delete cart" aria-label="Delete cart" disabled={pending}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); start(() => { deleteCart(id); }); }}
    >×</button>
  );
}
