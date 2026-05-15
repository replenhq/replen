"use client";

import { useEffect, useState } from "react";

// Global keyboard shortcuts. j/k to navigate match rows on the dashboard, s
// to toggle the focused row's star button, h to hide, / to focus the header
// search input. Skipped when the user is typing in an input/textarea.
//
// Implementation: cycles through elements with `.match` class. Each row's
// existing star/hide buttons are kept untouched — we just .click() them when
// the corresponding key fires, so server-action plumbing stays single-source.
export function KeyboardShortcuts() {
  const [focusIdx, setFocusIdx] = useState(-1);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    function getRows(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>(".match"));
    }

    function focusRow(idx: number) {
      const rows = getRows();
      if (rows.length === 0) return;
      const next = Math.max(0, Math.min(rows.length - 1, idx));
      setFocusIdx(next);
      rows.forEach((el, i) => {
        el.style.outline = i === next ? "2px solid #1f3a8a" : "";
        el.style.outlineOffset = i === next ? "2px" : "";
      });
      rows[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    function focusedButton(label: string): HTMLButtonElement | null {
      const rows = getRows();
      if (focusIdx < 0 || focusIdx >= rows.length) return null;
      const row = rows[focusIdx];
      const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
      // Match by visible text — star uses ★/☆, hide uses "hide".
      if (label === "star") return buttons.find((b) => /★|☆/.test(b.textContent ?? "")) ?? null;
      if (label === "hide") return buttons.find((b) => /^hide$/i.test(b.textContent ?? "")) ?? null;
      return null;
    }

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          focusRow(focusIdx < 0 ? 0 : focusIdx + 1);
          break;
        case "k":
          e.preventDefault();
          focusRow(focusIdx < 0 ? 0 : focusIdx - 1);
          break;
        case "s":
          e.preventDefault();
          focusedButton("star")?.click();
          break;
        case "h":
          e.preventDefault();
          focusedButton("hide")?.click();
          break;
        case "/":
          e.preventDefault();
          (document.querySelector('header input[name="q"]') as HTMLInputElement | null)?.focus();
          break;
        case "?":
          e.preventDefault();
          setHint((h) => h ? null : "j/k navigate · s star · h hide · / search · ? toggle hint");
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusIdx]);

  if (!hint) return null;
  return (
    <div style={{
      position: "fixed", bottom: 12, right: 12, padding: "6px 12px",
      background: "#111", color: "#fff", borderRadius: 6, fontSize: 12, zIndex: 1000,
    }}>{hint}</div>
  );
}
