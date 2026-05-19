import type { schema } from "@/db/client";
import { setInsightStatus } from "@/app/actions";
import { Icon } from "./Icons";

type Insight = typeof schema.matchInsights.$inferSelect;

type InsightWithEvidence = Insight & {
  evidence: { id: number; repoOwner: string; repoName: string; projectSlug: string | null }[];
};

// Initiative #3: surfaces synthesised meta-insights above the per-project
// match list. Server component — relies on server-action forms for star /
// hide, same pattern as match cards.
//
// Visual: a "This week's insights" header followed by 1-N cards. Hidden
// insights are filtered upstream; this component only renders the live
// ones. Starred sort first, then unread by recency.
export function InsightsStrip({ insights }: { insights: InsightWithEvidence[] }) {
  if (insights.length === 0) return null;

  return (
    <section className="insights-strip">
      <h2 className="insights-strip-heading">
        <span>This week’s insights</span>
        <span className="meta" style={{ fontWeight: 400, marginLeft: 8 }}>
          {insights.length}
        </span>
      </h2>
      {insights.map((i) => (
        <InsightCard key={i.id} insight={i} />
      ))}
    </section>
  );
}

function InsightCard({ insight }: { insight: InsightWithEvidence }) {
  const isStarred = insight.userStatus === "starred";
  const themes = parseThemes(insight.themes);
  return (
    <article className="insight">
      <div className="insight-head">
        <span className={`tag insight-kind insight-kind-${insight.kind}`} title={kindTitle(insight.kind)}>
          {kindLabel(insight.kind)}
        </span>
        {insight.primaryProjectSlug && (
          <a
            href={`/?project=${insight.primaryProjectSlug}`}
            className="tag project-tag"
            title={`Show only ${insight.primaryProjectSlug} matches`}
          >
            📁 {insight.primaryProjectSlug}
          </a>
        )}
        {themes.slice(0, 4).map((t) => (
          <span key={t} className="tag" style={{ fontFamily: "ui-monospace, monospace" }}>{t}</span>
        ))}
        <span className="meta">{insight.evidence.length} match{insight.evidence.length === 1 ? "" : "es"}</span>
      </div>
      <h3 className="insight-title">{insight.title}</h3>
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
    </article>
  );
}

function kindLabel(kind: string): string {
  if (kind === "topic") return "✨ Topic";
  if (kind === "cross-project") return "🔀 Cross-project";
  if (kind === "approach") return "🧭 Approach";
  return kind;
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
