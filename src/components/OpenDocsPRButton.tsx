"use client";

import { useState, useTransition } from "react";
import { openDocsImprovementPR } from "@/app/actions";

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; prUrl: string }
  | { kind: "error"; reason: string };

// Client component because the parent /projects/[slug] is a server component
// and we need useTransition + local state to give the user immediate feedback
// when they click "Open docs PR". Without this the click looks like nothing
// happened — the server action ran, the PR opened on GitHub, but the page
// didn't re-render to reflect it.
export function OpenDocsPRButton({
  projectId,
  projectRepo,
}: {
  projectId: number;
  projectRepo: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [, startTransition] = useTransition();

  function onClick() {
    setState({ kind: "pending" });
    startTransition(async () => {
      try {
        const r = await openDocsImprovementPR(projectId);
        if (r.ok && r.prUrl) {
          setState({ kind: "success", prUrl: r.prUrl });
        } else {
          setState({ kind: "error", reason: r.reason ?? "unknown error" });
        }
      } catch (e) {
        setState({ kind: "error", reason: (e as Error).message ?? String(e) });
      }
    });
  }

  if (state.kind === "success") {
    return (
      <div style={{ fontSize: 13 }}>
        ✓ PR opened:{" "}
        <a href={state.prUrl} target="_blank" rel="noreferrer">
          {state.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
        </a>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button type="button" onClick={onClick} disabled={state.kind === "pending"} aria-busy={state.kind === "pending"}>
        {state.kind === "pending" ? "Opening…" : `Open docs PR on ${projectRepo}`}
      </button>
      {state.kind === "error" && (
        <span style={{ fontSize: 13, color: "var(--amber, #ffc857)" }}>✗ {state.reason}</span>
      )}
    </div>
  );
}
