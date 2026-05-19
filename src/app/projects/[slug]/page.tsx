import { db, schema } from "@/db/client";
import { desc, eq, ne, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { assessDocSparsity } from "@/projects/self-improvement";
import { assessDocHealth, type DocHealth } from "@/projects/doc-health";
import type { ProjectSummary } from "@/projects/summarize";
import type { ProjectSearchVectors } from "@/projects/search-vectors";
import type { ProjectActivitySummary } from "@/projects/activity-summary";
import { OpenDocsPRButton } from "@/components/OpenDocsPRButton";
import { RecomputeSummaryButton } from "@/components/RecomputeSummaryButton";

export const dynamic = "force-dynamic";

export default async function ProjectView({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const project = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, slug)))
    .get();
  if (!project) return notFound();

  const matches = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), eq(schema.matches.projectId, project.id), ne(schema.matches.userStatus, "hidden")))
    .orderBy(desc(schema.matches.relevanceScore));

  const cards = await Promise.all(
    matches.map(async (m) => {
      const r = await db.select().from(schema.repos).where(eq(schema.repos.id, m.repoId)).get();
      return { m, r };
    })
  );

  const summary = parseSummary(project.summaryJson);
  const vectors = parseVectors(project.searchVectorsJson);
  const activity = parseActivity(project.activityJson);
  const sparsity = assessDocSparsity(project);
  const docHealth = await assessDocHealth(project.path);
  const hasGithubName = !!project.githubFullName;

  return (
    <>
      <h1>{project.name}</h1>
      <p className="meta">
        {project.path}
        {hasGithubName && <> · {project.githubFullName}</>}
      </p>

      <DocHealthBanner
        health={docHealth}
        sparse={sparsity.sparse}
        hasGithubName={hasGithubName}
        projectId={project.id}
        githubFullName={project.githubFullName}
      />

      {summary && <SummaryCard summary={summary} project={project} />}
      {activity && <ActivityCard activity={activity} generatedAt={project.activityGeneratedAt} />}
      {vectors && <VectorsCard vectors={vectors} project={project} />}
      {!summary && docHealth.verdict !== "sparse" && (
        <div style={{ margin: "12px 0", padding: "12px 16px", border: "1px solid var(--line, rgba(255,255,255,0.1))", borderRadius: 10 }}>
          <p style={{ margin: 0 }}>No Replen summary computed yet. It will land on the next pipeline run.</p>
          <div style={{ marginTop: 8 }}>
            <RecomputeSummaryButton projectId={project.id} label="Compute now" />
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Matches</h2>
      {cards.length === 0 && <p>No matches yet.</p>}
      {cards.map(({ m, r }) => {
        if (!r) return null;
        const writeup = (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
        return (
          <div className="match" key={m.id}>
            <div className="match-head">
              <a className="repo" href={r.url} target="_blank" rel="noreferrer">{r.owner}/{r.name}</a>
              <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
              <span className="meta">{r.stars ?? 0}★</span>
            </div>
            {m.matchedOutcome && (
              <div
                className="meta"
                style={{
                  fontSize: 12,
                  marginTop: 4,
                  padding: "4px 8px",
                  background: "rgba(120, 180, 255, 0.06)",
                  borderLeft: "2px solid rgba(120, 180, 255, 0.4)",
                  borderRadius: 4,
                }}
              >
                Surfaced because you want: <em>{m.matchedOutcome}</em>
                {m.matchedOutcomeSource === "inferred" && (
                  <> · <span className="meta">(inferred, {m.matchedOutcomeConfidence})</span></>
                )}
              </div>
            )}
            <div className="writeup">{writeup}</div>
          </div>
        );
      })}
    </>
  );
}

function DocHealthBanner({
  health,
  sparse,
  hasGithubName,
  projectId,
  githubFullName,
}: {
  health: DocHealth;
  sparse: boolean;
  hasGithubName: boolean;
  projectId: number;
  githubFullName: string | null;
}) {
  const palette = paletteForVerdict(health.verdict);
  return (
    <div
      role={health.verdict === "sparse" ? "alert" : undefined}
      style={{
        margin: "12px 0",
        padding: "12px 16px",
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <strong style={{ textTransform: "capitalize" }}>Docs: {health.verdict.replace("-", " ")}</strong>
        <span className="meta" style={{ fontSize: 12 }}>
          score {health.score}/100 · {health.filesFound.length} file{health.filesFound.length === 1 ? "" : "s"} · {(health.totalBytes / 1024).toFixed(1)}kb
        </span>
      </div>

      {health.reasons.length > 0 && (
        <p style={{ margin: "6px 0 8px" }}>
          {health.verdict === "excellent"
            ? "Replen has plenty to work with on this project."
            : `Gaps: ${health.reasons.join("; ")}.`}
        </p>
      )}

      <details style={{ marginTop: 4 }}>
        <summary className="meta" style={{ fontSize: 12, cursor: "pointer" }}>
          What Replen read ({health.filesFound.length})
        </summary>
        <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
          {health.filesFound
            .slice()
            .sort((a, b) => b.bytes - a.bytes)
            .map((f) => (
              <li key={f.path} style={{ fontSize: 13 }}>
                <code>{f.path}</code>{" "}
                <span className="meta" style={{ fontSize: 11 }}>
                  {(f.bytes / 1024).toFixed(1)}kb · {Math.round(f.ageDays)}d ago
                  {f.stale && <span style={{ color: "rgba(255, 200, 87, 0.85)" }}> · stale</span>}
                </span>
              </li>
            ))}
          {health.filesFound.length === 0 && (
            <li style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>Nothing readable — Replen is flying blind on this project.</li>
          )}
        </ul>
      </details>

      {sparse && hasGithubName && githubFullName && (
        <div style={{ marginTop: 10 }}>
          <OpenDocsPRButton projectId={projectId} projectRepo={githubFullName} />
        </div>
      )}
      {sparse && !hasGithubName && (
        <p className="meta" style={{ fontSize: 12, marginTop: 8 }}>
          Set this project&apos;s GitHub repo (owner/name) below to open a docs handoff PR.
        </p>
      )}
    </div>
  );
}

function paletteForVerdict(verdict: DocHealth["verdict"]): { bg: string; border: string } {
  switch (verdict) {
    case "excellent":
      return { bg: "rgba(120, 220, 140, 0.06)", border: "rgba(120, 220, 140, 0.3)" };
    case "good":
      return { bg: "rgba(120, 180, 255, 0.06)", border: "rgba(120, 180, 255, 0.3)" };
    case "needs-work":
      return { bg: "rgba(255, 200, 87, 0.06)", border: "rgba(255, 200, 87, 0.3)" };
    case "sparse":
      return { bg: "rgba(255, 200, 87, 0.08)", border: "rgba(255, 200, 87, 0.35)" };
  }
}

function parseSummary(raw: string | null): ProjectSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectSummary;
  } catch {
    return null;
  }
}

function parseActivity(raw: string | null): ProjectActivitySummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectActivitySummary;
  } catch {
    return null;
  }
}

// "Currently building" panel. Shows what the pipeline detected the user
// has been actively working on in this project (themes, recent files,
// summary). Initiative #1: this is the same data the matcher uses to
// grade candidates against current work, surfaced so the user can verify
// what Replen "sees" of their activity.
function ActivityCard({
  activity,
  generatedAt,
}: {
  activity: ProjectActivitySummary;
  generatedAt: Date | null;
}) {
  // Dormant projects render a quieter version — useful confirmation that
  // Replen has looked, just hasn't found recent work to anchor on.
  if (activity.state === "dormant" || !activity.summary) {
    return (
      <div
        style={{
          margin: "12px 0",
          padding: "12px 16px",
          border: "1px dashed var(--line, rgba(255,255,255,0.1))",
          borderRadius: 10,
          fontSize: 13,
          color: "var(--dim)",
        }}
      >
        <strong style={{ color: "var(--fg)" }}>Currently building</strong>
        <span className="meta" style={{ marginLeft: 8, fontSize: 12 }}>
          dormant
          {activity.daysSinceLastCommit !== null && (
            <> · last commit {activity.daysSinceLastCommit}d ago</>
          )}
          {generatedAt && <> · checked {formatAge(generatedAt)}</>}
        </span>
        <p style={{ margin: "6px 0 0", fontSize: 13 }}>
          No recent activity detected. Matches will grade against the project&apos;s general docs, not current work.
        </p>
      </div>
    );
  }
  return (
    <div
      style={{
        margin: "12px 0",
        padding: "16px 20px",
        border: "1px solid var(--amber-line, rgba(255, 200, 87, 0.35))",
        background: "var(--amber-soft, rgba(255, 200, 87, 0.05))",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 16, color: "var(--amber)" }}>Currently building</h2>
        <span className="meta" style={{ fontSize: 12 }}>
          {activity.daysSinceLastCommit !== null && (
            <>last commit {activity.daysSinceLastCommit}d ago · </>
          )}
          {generatedAt && <>refreshed {formatAge(generatedAt)}</>}
        </span>
      </div>
      <p style={{ margin: "0 0 10px", fontSize: 14, lineHeight: 1.55 }}>{activity.summary}</p>
      {activity.themes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {activity.themes.map((t) => (
            <span
              key={t}
              className="tag"
              style={{
                background: "rgba(255, 200, 87, 0.10)",
                color: "var(--amber)",
                border: "1px solid rgba(255, 200, 87, 0.25)",
                fontSize: 11.5,
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {activity.topFiles.length > 0 && (
        <details>
          <summary className="meta" style={{ fontSize: 12, cursor: "pointer" }}>
            Recent files ({activity.topFiles.length})
          </summary>
          <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 13 }}>
            {activity.topFiles.map((f) => (
              <li key={f}>
                <code style={{ fontSize: 12.5 }}>{f}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="meta" style={{ fontSize: 11, marginTop: 10 }}>
        This drives match grading: candidates that fit your current work score higher and reference the themes above by name.
      </p>
    </div>
  );
}

function parseVectors(raw: string | null): ProjectSearchVectors | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectSearchVectors;
  } catch {
    return null;
  }
}

function VectorsCard({
  vectors,
  project,
}: {
  vectors: ProjectSearchVectors;
  project: typeof schema.projectProfiles.$inferSelect;
}) {
  const hasVectors = vectors.vectors.length > 0;
  const hasSkipped = vectors.skippedLowConfidence.length > 0;
  if (!hasVectors && !hasSkipped) return null;
  return (
    <div
      style={{
        margin: "12px 0",
        padding: "16px 20px",
        border: "1px solid var(--line, rgba(255,255,255,0.1))",
        borderRadius: 10,
      }}
    >
      <h2 style={{ margin: "0 0 6px" }}>Replen is searching for…</h2>
      <p className="meta" style={{ marginTop: 0, fontSize: 12 }}>
        {hasVectors
          ? `${vectors.vectors.length} outcome${vectors.vectors.length === 1 ? "" : "s"} mapped to GitHub queries.`
          : `No outcomes concrete enough to search on yet — add specifics to your CLAUDE.md.`}
        {hasVectors && vectors.confidenceFloor === "medium" && (
          <> Working from inferred outcomes (no high-confidence ones found) — Stage 4 applies a stricter relevance bar.</>
        )}
      </p>

      {vectors.vectors.map((v, i) => (
        <div
          key={i}
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: i === 0 ? "none" : "1px dashed var(--line, rgba(255,255,255,0.08))",
          }}
        >
          <div style={{ fontWeight: 600 }}>{v.outcome}</div>
          <div className="meta" style={{ fontSize: 11, marginTop: 2 }}>
            {v.outcomeSource === "user" ? "from your docs" : "inferred"} ·{" "}
            {v.outcomeConfidence}
            {v.languageConstraint && v.languageConstraint.length > 0 && (
              <> · lang: {v.languageConstraint.join(" / ")}</>
            )}
          </div>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {v.queryTerms.map((t, j) => (
              <code
                key={j}
                style={{
                  fontSize: 12,
                  padding: "2px 6px",
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 4,
                }}
              >
                {t}
              </code>
            ))}
          </div>
          {v.reasoning && (
            <details style={{ marginTop: 6 }}>
              <summary className="meta" style={{ fontSize: 12, cursor: "pointer" }}>
                Why these queries?
              </summary>
              <p style={{ marginTop: 4, fontSize: 13 }}>{v.reasoning}</p>
            </details>
          )}
        </div>
      ))}

      {hasSkipped && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px dashed var(--line, rgba(255,255,255,0.08))" }}>
          <strong style={{ fontSize: 13 }}>Replen isn&apos;t sure about these:</strong>
          <p className="meta" style={{ fontSize: 12, marginTop: 4 }}>
            Add these to your CLAUDE.md or README to make them explicit — Replen will pick them up on the next refresh.
          </p>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {vectors.skippedLowConfidence.map((s, i) => (
              <li key={i} style={{ fontSize: 13 }}>
                {s.outcome}{" "}
                <span className="meta" style={{ fontSize: 11 }}>({s.confidence})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {project.searchVectorsGeneratedAt && (
        <p className="meta" style={{ fontSize: 11, marginTop: 12 }}>
          computed {formatAge(project.searchVectorsGeneratedAt)}
        </p>
      )}
    </div>
  );
}

function formatAge(at: Date): string {
  const min = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60000));
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / (60 * 24))} d ago`;
}

function SummaryCard({
  summary,
  project,
}: {
  summary: ProjectSummary;
  project: typeof schema.projectProfiles.$inferSelect;
}) {
  const generated = project.summaryGeneratedAt;
  const ageMin = generated ? Math.max(0, Math.floor((Date.now() - generated.getTime()) / 60000)) : null;
  const ageLabel =
    ageMin === null ? "?" :
    ageMin < 60 ? `${ageMin} min ago` :
    ageMin < 60 * 24 ? `${Math.floor(ageMin / 60)} h ago` :
    `${Math.floor(ageMin / (60 * 24))} d ago`;
  return (
    <div
      style={{
        margin: "12px 0",
        padding: "16px 20px",
        border: "1px solid var(--line, rgba(255,255,255,0.1))",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Replen sees this project as…</h2>
        <span className="meta" style={{ fontSize: 12 }}>
          {summary.sourceFiles.length > 0 ? `from ${summary.sourceFiles.join(" + ")} · ` : ""}
          computed {ageLabel}
        </span>
        <div style={{ marginLeft: "auto" }}>
          <RecomputeSummaryButton projectId={project.id} size="small" />
        </div>
      </div>

      <p style={{ marginTop: 0 }}>{summary.purpose}</p>

      {summary.keyCapabilities.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Key capabilities</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {summary.keyCapabilities.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.outcomeGoals.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Outcome goals</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {summary.outcomeGoals.map((g, i) => (
              <li key={i}>
                {g.statement}{" "}
                <span className="meta" style={{ fontSize: 11 }}>
                  ({g.source === "user" ? "from docs" : `inferred, ${g.confidence}`})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {Object.keys(summary.currentTech).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Current tech</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {Object.entries(summary.currentTech).map(([area, tech]) => (
              <li key={area}>
                <code>{area}</code>: {tech}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.crossRepoDependencies.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Cross-repo dependencies</strong>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {summary.crossRepoDependencies.map((d, i) => (
              <li key={i}>
                {d.direction === "consumes_from" ? "Consumes from" : "Feeds into"}{" "}
                <code>{d.target}</code>: {d.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.languageSignals.hardConstraints.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Hard language constraints</strong>{" "}
          <span className="meta" style={{ fontSize: 12 }}>(rest of the project is language-agnostic)</span>
          <ul style={{ margin: "6px 0 0 18px" }}>
            {summary.languageSignals.hardConstraints.map((c, i) => (
              <li key={i}>
                {c.capability} → {c.allowedLanguages.join(" / ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

