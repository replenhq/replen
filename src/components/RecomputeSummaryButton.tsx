"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recomputeProjectSummary } from "@/app/actions";

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "error"; reason: string };

// Client component for /projects/[slug] "Recompute" button. The server action
// regenerates the summary + persists; we follow up with router.refresh() to
// re-fetch the server-rendered card with the new content.
export function RecomputeSummaryButton({
  projectId,
  label = "Recompute",
  size = "normal",
}: {
  projectId: number;
  label?: string;
  size?: "normal" | "small";
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [, startTransition] = useTransition();

  function onClick() {
    setState({ kind: "pending" });
    startTransition(async () => {
      try {
        const r = await recomputeProjectSummary(projectId);
        if (r.ok) {
          setState({ kind: "success" });
          router.refresh();
          // Briefly show success then return to idle so user can re-run.
          setTimeout(() => setState({ kind: "idle" }), 2500);
        } else {
          setState({ kind: "error", reason: r.reason ?? "unknown error" });
        }
      } catch (e) {
        setState({ kind: "error", reason: (e as Error).message ?? String(e) });
      }
    });
  }

  const style = size === "small" ? { fontSize: 12 } : undefined;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button type="button" onClick={onClick} disabled={state.kind === "pending"} style={style} aria-busy={state.kind === "pending"}>
        {state.kind === "pending" ? "Computing…" :
         state.kind === "success" ? "✓ Updated" :
         label}
      </button>
      {state.kind === "error" && (
        <span style={{ fontSize: 12, color: "var(--amber, #ffc857)" }}>✗ {state.reason}</span>
      )}
    </div>
  );
}
