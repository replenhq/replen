import type { schema } from "@/db/client";
import { OpenDocsPRButton } from "./OpenDocsPRButton";
import { Icon } from "./Icons";

export type SparseProject = {
  id: number;
  slug: string;
  name: string;
  githubFullName: string | null;
  reasons: string[]; // e.g. ["README is only 139 chars", "no CLAUDE.md"]
};

// Renders a collapsed <details> at the top of the feed when ≥1 of
// the user's active+included projects has thin docs. Closed by
// default so it doesn't dominate the feed; the user expands to see
// the per-project action list. Each row inside is a one-liner so
// the expanded list also stays compact even with 10+ sparse
// projects.
//
// Why this surface at all: sparse docs are a precondition for
// accurate matching. Without them every result for that project is
// closer to "best guess" than "actually fits". The handoff PR drops
// a markdown file teaching the local AI (Claude Code / Codex / etc.)
// what good docs need to contain, so the user's next run benefits.
export function SparseDocsCards({ projects }: { projects: SparseProject[] }) {
  if (projects.length === 0) return null;
  return (
    <details className="sparse-docs-strip">
      <summary className="sparse-docs-summary">
        <span className="sparse-docs-summary-label">
          <Icon name="doc" /> Improve docs to sharpen matching
        </span>
        <span className="sparse-docs-summary-count">{projects.length}</span>
        <span className="sparse-docs-summary-hint">click to expand</span>
      </summary>
      <p className="sparse-docs-strip-intro">
        These projects don&rsquo;t give Replen enough to match accurately.
        Opening a docs PR drops a handoff file that tells your local AI
        (Claude Code, Codex, Cursor) what sections to write and at what
        level of detail.
      </p>
      <ul className="sparse-docs-list">
        {projects.map((p) => <SparseDocsRow key={p.id} project={p} />)}
      </ul>
    </details>
  );
}

function SparseDocsRow({ project }: { project: SparseProject }) {
  return (
    <li className="sparse-docs-row">
      <a href={`/projects/${project.slug}`} className="sparse-docs-slug" title={`Open ${project.slug}`}>
        <Icon name="folder" /> {project.slug}
      </a>
      <span className="sparse-docs-reason">{project.reasons.join("; ")}</span>
      <span className="sparse-docs-action">
        {project.githubFullName ? (
          <OpenDocsPRButton projectId={project.id} projectRepo={project.githubFullName} variant="compact" />
        ) : (
          <a className="sparse-docs-set-repo" href={`/projects/${project.slug}`} title="Set GitHub repo first">
            <Icon name="warning" /> set repo
          </a>
        )}
      </span>
    </li>
  );
}

export function buildSparseProject(
  row: Pick<typeof schema.projectProfiles.$inferSelect, "id" | "slug" | "name" | "githubFullName">,
  reasons: string[],
): SparseProject {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    githubFullName: row.githubFullName ?? null,
    reasons,
  };
}
