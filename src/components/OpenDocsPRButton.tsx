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
  variant = "default",
}: {
  projectId: number;
  projectRepo: string;
  // 'compact' renders a small in-table button suitable for the /projects
  // listing; default is the wider button used on /projects/<slug>.
  variant?: "default" | "compact";
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const compact = variant === "compact";

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
    const shortPath = state.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
    return (
      <span style={{ fontSize: compact ? 11 : 13 }}>
        ✓ <a href={state.prUrl} target="_blank" rel="noreferrer">{compact ? "PR opened" : shortPath}</a>
      </span>
    );
  }

  const label = compact
    ? (state.kind === "pending" ? "Opening…" : "✏ docs PR")
    : (state.kind === "pending" ? "Opening…" : `Open docs PR on ${projectRepo}`);
  const buttonStyle = compact ? { padding: "1px 8px", fontSize: 11 } : undefined;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={state.kind === "pending"}
        aria-busy={state.kind === "pending"}
        style={buttonStyle}
        title={compact ? `Open a docs improvement PR on ${projectRepo}` : undefined}
      >
        {label}
      </button>
      {state.kind === "error" && (
        <span style={{ fontSize: compact ? 11 : 13, color: "var(--amber, #ffc857)" }} title={state.reason}>
          ✗
        </span>
      )}
    </span>
  );
}
