import type { schema } from "@/db/client";
import { setInsightStatus } from "@/app/actions";
import { Icon } from "./Icons";

type Insight = typeof schema.matchInsights.$inferSelect;

type InsightWithEvidence = Insight & {
  evidence: { id: number; repoOwner: string; repoName: string; projectSlug: string | null }[];
};

// Initiative #3: surfaces synthesised meta-insights above the per-project
// match list. Two-level disclosure to keep the feed scannable:
//
//   1. Outer <details> "This week's insights · N · click to expand"
//      collapsed by default. One click reveals the title list.
//   2. Each insight is its own <details> whose summary is the head row
//      (kind + project + themes + match count) plus the title. Click
//      to expand body + evidence + actions.
//
// Bodies can be 200-400 words each; collapsing twice means the user
// reads at most one full body at a time and can scan titles cheaply.
// Native <details> means no JS state, no client component required.
export function InsightsStrip({ insights }: { insights: InsightWithEvidence[] }) {
  if (insights.length === 0) return null;

  return (
    <details className="insights-strip">
      <summary className="insights-strip-summary">
        <span className="insights-strip-label">
          <Icon name="sparkles" /> This week&rsquo;s insights
        </span>
        <span className="insights-strip-count">{insights.length}</span>
        <span className="insights-strip-hint">click to expand</span>
      </summary>
      <div className="insights-list">
        {insights.map((i) => (
          <InsightCard key={i.id} insight={i} />
        ))}
      </div>
    </details>
  );
}

function InsightCard({ insight }: { insight: InsightWithEvidence }) {
  const isStarred = insight.userStatus === "starred";
  const themes = parseThemes(insight.themes);
  return (
    <details className="insight">
      <summary className="insight-summary">
        <div className="insight-head">
          <span className={`tag insight-kind insight-kind-${insight.kind}`} title={kindTitle(insight.kind)}>
            <KindIcon kind={insight.kind} /> {kindLabel(insight.kind)}
          </span>
          {insight.primaryProjectSlug && (
            <span className="tag project-tag" title={`Project: ${insight.primaryProjectSlug}`}>
              <Icon name="folder" /> {insight.primaryProjectSlug}
            </span>
          )}
          {themes.slice(0, 3).map((t) => (
            <span key={t} className="tag" style={{ fontFamily: "ui-monospace, monospace" }}>{t}</span>
          ))}
          <span className="meta">{insight.evidence.length} match{insight.evidence.length === 1 ? "" : "es"}</span>
        </div>
        <h3 className="insight-title">{insight.title}</h3>
      </summary>
      <div className="insight-body">{insight.bodyMd}</div>
      {insight.evidence.length > 0 && (
        <details className="insight-evidence">
          <summary>Evidence: {insight.evidence.length} match{insight.evidence.length === 1 ? "" : "es"}</summary>
          <ul>
            {insight.evidence.map((e) => (
              <li key={e.id}>
                <a href={`/repo/${e.repoOwner}/${e.repoName}`}>
                  {e.repoOwner}/{e.repoName}
                </a>
                {e.projectSlug && (
                  <>
                    {" "}<span className="meta">→ {e.projectSlug}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="actions">
        <form className="inline" action={async () => {
          "use server";
          await setInsightStatus(insight.id, isStarred ? "unread" : "starred");
        }}>
          <button type="submit" className={isStarred ? "selected" : ""} title={isStarred ? "Unstar insight" : "Star insight (pin to feed)"}>
            <Icon name={isStarred ? "star-fill" : "star"} /> {isStarred ? "Starred" : "Star"}
          </button>
        </form>
        <span className="spacer" />
        <form className="inline" action={async () => {
          "use server";
          await setInsightStatus(insight.id, "hidden");
        }}>
          <button type="submit" className="ghost" title="Hide this insight">
            <Icon name="hide" /> Hide
          </button>
        </form>
      </div>
    </details>
  );
}

function kindLabel(kind: string): string {
  if (kind === "topic") return "Topic";
  if (kind === "cross-project") return "Cross-project";
  if (kind === "approach") return "Approach";
  return kind;
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "topic") return <Icon name="sparkles" />;
  if (kind === "cross-project") return <Icon name="split" />;
  if (kind === "approach") return <Icon name="compass" />;
  return null;
}

function kindTitle(kind: string): string {
  if (kind === "topic") return "Several repos this week share a topic or technical theme.";
  if (kind === "cross-project") return "The same pattern hit multiple of your projects this week.";
  if (kind === "approach") return "Multiple matches share the same integration approach this week.";
  return kind;
}

function parseThemes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
