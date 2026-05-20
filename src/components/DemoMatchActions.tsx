"use client";

import { useState } from "react";
import { Icon } from "./Icons";

// Visual-only replacement for a match card's action row when the
// session is in demo mode. Mirrors the real buttons (Star /
// Bookmark / Hide / handoff PR / thumbs up / thumbs down) so a demo
// visitor sees the actual UX flow — click Star, button changes to
// Starred and a "Handoff PR" link appears — but every click just
// flips local React state and never hits a server action. No risk
// of demo writes; no "Error <digest>" surface.

type Props = {
  isGA: boolean;
  hasProject: boolean;
};

export function DemoMatchActions({ isGA, hasProject }: Props) {
  // Match-card primary action state: unsaved → starred → handoff PR opened.
  const [saved, setSaved] = useState(false);
  const [handoffPrUrl, setHandoffPrUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<"good" | "bad" | null>(null);
  const [hidden, setHidden] = useState(false);

  if (hidden) {
    return (
      <div className="actions">
        <span className="meta" style={{ fontSize: 12 }}>
          Hidden. <button
            type="button"
            onClick={() => setHidden(false)}
            style={{ background: "none", border: "none", color: "var(--amber)", cursor: "pointer", padding: 0, fontSize: 12 }}
          >
            Undo
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="actions">
      {!saved && !isGA && (
        <button
          type="button"
          className="primary"
          onClick={() => {
            setSaved(true);
            // Star also opens a handoff PR for project-bound matches —
            // mirror that in the demo by setting a synthetic PR URL.
            if (hasProject) {
              setHandoffPrUrl("https://github.com/replenhq/sandbox-nextapp/pull/demo-42");
            }
          }}
          title="Star"
        >
          <Icon name="star" /> Star &amp; open handoff PR
        </button>
      )}
      {!saved && isGA && (
        <button
          type="button"
          className="primary"
          onClick={() => setSaved(true)}
          title="Bookmark for later"
        >
          <Icon name="bookmark" /> Bookmark for later
        </button>
      )}
      {saved && (
        <button
          type="button"
          className="selected"
          onClick={() => { setSaved(false); setHandoffPrUrl(null); }}
          title={isGA ? "Remove bookmark" : "Unstar"}
        >
          <Icon name={isGA ? "bookmark-fill" : "star-fill"} /> {isGA ? "Bookmarked" : "Starred"}
        </button>
      )}
      {handoffPrUrl && (
        <a
          className="btn selected"
          href={handoffPrUrl}
          target="_blank"
          rel="noreferrer"
          style={{ textDecoration: "none" }}
          onClick={(e) => e.preventDefault()}
          title="Handoff PR opened on the project's GitHub repo"
        >
          <Icon name="external" /> Handoff PR
        </a>
      )}
      <button
        type="button"
        className={feedback === "good" ? "selected" : ""}
        onClick={() => setFeedback(feedback === "good" ? null : "good")}
        title="Useful"
        aria-label="Useful"
      >
        <Icon name="thumbs-up" />
      </button>
      <button
        type="button"
        className={feedback === "bad" ? "selected" : ""}
        onClick={() => setFeedback(feedback === "bad" ? null : "bad")}
        title="Not useful"
        aria-label="Not useful"
      >
        <Icon name="thumbs-down" />
      </button>
      <span className="spacer" />
      <button
        type="button"
        className="ghost"
        onClick={() => setHidden(true)}
        title="Hide"
      >
        <Icon name="hide" /> Hide
      </button>
    </div>
  );
}
