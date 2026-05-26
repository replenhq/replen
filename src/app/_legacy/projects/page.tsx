import { db, schema } from "@/db/client";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { reprocessForUser } from "@/scheduler/reprocess-matches";
import { readUserSecret } from "@/lib/user-secrets";
import { autoDetectAndStoreRepos } from "@/lib/github-repo-detect";
import { assessDocSparsity } from "@/projects/self-improvement";
import { OpenDocsPRButton } from "@/components/OpenDocsPRButton";
import { Icon } from "@/components/Icons";

export const dynamic = "force-dynamic";

export default async function Projects() {
  const user = await requireUser();
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, user.id))
    .orderBy(desc(schema.projectProfiles.included), schema.projectProfiles.slug);

  const matchCounts = await db
    .select({ pid: schema.matches.projectId, c: sql<number>`count(*)` })
    .from(schema.matches)
    .where(eq(schema.matches.userId, user.id))
    .groupBy(schema.matches.projectId);
  const matchMap = new Map(matchCounts.map((r) => [r.pid, Number(r.c)]));

  const totalIncluded = projects.filter((p) => p.included).length;
  const totalHigh = projects.filter((p) => p.sensitivity === "high").length;

  return (
    <>
      <h1>Projects</h1>
      <p className="meta">
        {projects.length} discovered · {totalIncluded} included in matching · {totalHigh} marked sensitive
      </p>
      <p className="meta">
        <b>Include</b>: matched against new repos. <b>Sensitive</b>: tag (sensitive projects route to Claude).{" "}
        <b>Model</b>: <code>auto</code> follows sensitivity. <b>GitHub repo</b>: target for the handoff-PR action.{" "}
        Repos are auto-detected from your GitHub PAT when you save a new token on <a href="/settings">/settings</a>.
        <form action={autoDetectGithubRepos} style={{ display: "inline", marginLeft: 8 }}>
          <button type="submit" title="Re-run the GitHub PAT → project_slug match. Useful if you created new repos since the PAT was saved.">
            re-detect now
          </button>
        </form>
      </p>
      <table style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Project</th>
            <th>Include</th>
            <th>Sensitive</th>
            <th>Model</th>
            <th style={{ textAlign: "center" }} title="Docs health: ✓ when README+CLAUDE.md give Replen enough to work with; ⚠ when too sparse for accurate matching — click to open a docs-improvement PR.">Docs</th>
            <th style={{ textAlign: "right" }}>Matches</th>
            <th></th>
            <th>GitHub repo</th>
            <th title="Comma-separated tags (auto-extracted from package.json / pyproject.toml on first sync). Used by filter mode B on /settings to pre-filter the inventory before sending candidates to the skill for triage. Edit freely; re-run 'npx replen sync-projects' to refresh from manifests.">Tags <span style={{ fontWeight: 400, fontSize: 11, color: "rgba(0,0,0,0.5)" }}>(auto)</span></th>
            <th title="github:owner/name when sourced via API. Filesystem paths shown for rows that haven't refreshed since the GitHub-pull rebuild — they'll switch on next pipeline run once a repo is set.">Source</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const effective =
              p.llmProvider === "auto" ? (p.sensitivity === "high" ? "anthropic" : "deepseek") : p.llmProvider;
            // Surfaces "needs a GitHub repo set" inline. Replen reads
            // each project's docs/manifests/activity via the GitHub API
            // now (no more laptop sync), so a project with no
            // github_full_name silently can't be matched against new
            // OSS — its cached docs go stale and Init #1/#2 never fire
            // for it. Warning + amber tint on the repo input makes the
            // fix obvious.
            const needsRepo = p.included && p.active && !p.githubFullName;
            return (
              <tr key={p.id} style={{ opacity: p.included ? 1 : 0.45 }}>
                <td>
                  <a href={`/projects/${p.slug}`}>{p.name}</a>
                  {needsRepo && (
                    <span
                      title="Replen reads this project via the GitHub API. Set the owner/repo on the right so Init #1 (activity matching), Init #2 (prune), and doc refresh can fire."
                      style={{ marginLeft: 6, color: "var(--amber, #ffc857)", cursor: "help", display: "inline-flex", verticalAlign: "middle" }}
                      aria-label="needs GitHub repo"
                    >
                      <Icon name="warning" size={13} />
                    </span>
                  )}
                </td>
                <td>
                  <form className="inline" action={async () => { "use server"; await toggleIncluded(p.id, !p.included); }}>
                    <button>{p.included ? <><Icon name="check" size={11} /> in</> : "-"}</button>
                  </form>
                </td>
                <td>
                  <form className="inline" action={async () => { "use server"; await toggleSensitivity(p.id, p.sensitivity === "high" ? "low" : "high"); }}>
                    <button style={p.sensitivity === "high" ? { background: "#ffadad", color: "#1a1a1a" } : undefined}>
                      {p.sensitivity === "high" ? (
                        <><Icon name="shield" size={12} /> high</>
                      ) : "low"}
                    </button>
                  </form>
                </td>
                <td>
                  <form className="inline" action={async () => { "use server"; await cycleLlmProvider(p.id, p.llmProvider); }}>
                    <button
                      title={`Click to cycle: auto → deepseek → anthropic. Currently routes to ${effective}.`}
                      style={{
                        background:
                          p.llmProvider === "anthropic" ? "#cce5ff" : p.llmProvider === "deepseek" ? "#fff3cd" : "transparent",
                        color: p.llmProvider === "auto" ? undefined : "#1a1a1a",
                        fontFamily: "ui-monospace, monospace",
                      }}
                    >
                      {p.llmProvider}
                      {p.llmProvider === "auto" && <span style={{ opacity: 0.55 }}> · {effective}</span>}
                    </button>
                  </form>
                </td>
                <td style={{ textAlign: "center" }}>{renderDocsCell(p)}</td>
                <td style={{ textAlign: "right" }}>{matchMap.get(p.id) ?? 0}</td>
                <td>
                  {(matchMap.get(p.id) ?? 0) > 0 && (
                    <form className="inline" action={async () => { "use server"; await reanalyzeProject(p.slug); }}>
                      <button title={`Re-runs reasoning for all ${matchMap.get(p.id)} matches in ${p.name} using the current model setting. Background job; refresh /runs to track.`}>
                        re-analyze
                      </button>
                    </form>
                  )}
                </td>
                <td>
                  <form className="inline" action={async (form: FormData) => { "use server"; await setGithubFullName(p.id, (form.get("ghFullName") as string) ?? ""); }} style={{ display: "inline-flex", gap: 4 }}>
                    <input
                      name="ghFullName"
                      defaultValue={p.githubFullName ?? ""}
                      placeholder="owner/repo"
                      style={{
                        padding: "1px 4px",
                        fontSize: 12,
                        width: 150,
                        fontFamily: "ui-monospace, monospace",
                        ...(needsRepo
                          ? { background: "rgba(255, 200, 87, 0.18)", borderColor: "rgba(255, 200, 87, 0.6)" }
                          : {}),
                      }}
                    />
                    <button title="Save GitHub repo. Replen uses this to fetch docs/activity/manifests via the API and to open handoff PRs." style={{ padding: "1px 6px", fontSize: 11 }}>save</button>
                  </form>
                </td>
                <td>
                  <form className="inline" action={async (form: FormData) => { "use server"; await setProjectTags(p.id, (form.get("tags") as string) ?? ""); }} style={{ display: "inline-flex", gap: 4 }}>
                    <input
                      name="tags"
                      defaultValue={renderTagsCsv(p.tags)}
                      placeholder="typescript, next.js, news"
                      style={{
                        padding: "1px 4px",
                        fontSize: 12,
                        width: 180,
                        fontFamily: "ui-monospace, monospace",
                      }}
                    />
                    <button title="Save tags (comma-separated). Used by filter mode 'tags' on /settings to pre-filter the inventory before sending to the skill." style={{ padding: "1px 6px", fontSize: 11 }}>save</button>
                  </form>
                </td>
                <td className="path">{p.path}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// Renders the Docs column cell. Three states:
//   sparse + has github repo  → compact "✏ docs PR" button (one click → PR)
//   sparse + no github repo   → "⚠ set repo" link to /projects/<slug>
//   not sparse                → "✓"
// The pipeline already streams a "Sparse docs in <slug>" event during a run;
// this surfaces the same call-to-action persistently on the listing so the
// user can act on it after the run has finished and the streamer has scrolled
// away.
function renderDocsCell(p: typeof schema.projectProfiles.$inferSelect) {
  const sparsity = assessDocSparsity({ readmeMd: p.readmeMd, claudeMd: p.claudeMd });
  if (!sparsity.sparse) {
    return (
      <span title="Docs healthy" style={{ display: "inline-flex", color: "var(--green, #6fce82)" }} aria-label="docs healthy">
        <Icon name="check" size={14} />
      </span>
    );
  }
  const reasonTitle = `Sparse docs: ${sparsity.reasons.join("; ")}`;
  if (p.githubFullName) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={reasonTitle}>
        <span style={{ display: "inline-flex", color: "var(--amber, #ffc857)" }} aria-label="sparse docs">
          <Icon name="warning" size={13} />
        </span>
        <OpenDocsPRButton projectId={p.id} projectRepo={p.githubFullName} variant="compact" />
      </span>
    );
  }
  return (
    <a
      href={`/projects/${p.slug}`}
      title={`${reasonTitle}. Set this project's GitHub repo on /projects/${p.slug} to enable the docs PR action.`}
      style={{ color: "var(--amber, #ffc857)", textDecoration: "none", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      <Icon name="warning" size={12} /> set repo
    </a>
  );
}

async function toggleIncluded(id: number, value: boolean) {
  "use server";
  const user = await requireUser();
  await db
    .update(schema.projectProfiles)
    .set({ included: value })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
  revalidatePath("/");
}

async function toggleSensitivity(id: number, value: "low" | "high") {
  "use server";
  const user = await requireUser();
  await db
    .update(schema.projectProfiles)
    .set({ sensitivity: value })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}

// Per-user reanalyze throttle. Single-process: replen is one systemd unit,
// so an in-memory Map is enough. If we ever scale to multiple replicas, move
// this to the DB (e.g. a reprocess_runs table).
const reanalyzeLastStart = new Map<number, number>();
const REANALYZE_COOLDOWN_MS = 30_000;

async function reanalyzeProject(slug: string) {
  "use server";
  const user = await requireUser();
  if (typeof slug !== "string" || !/^[a-z0-9_-]{1,80}$/.test(slug)) {
    throw new Error("invalid slug");
  }
  const now = Date.now();
  const last = reanalyzeLastStart.get(user.id) ?? 0;
  if (now - last < REANALYZE_COOLDOWN_MS) {
    console.warn(`[reanalyze] user=${user.id} cooldown ${Math.round((REANALYZE_COOLDOWN_MS - (now - last)) / 1000)}s - ignoring`);
    return;
  }
  reanalyzeLastStart.set(user.id, now);
  void reprocessForUser(user.id, { projectSlug: slug, forceAll: true, limit: 200 })
    .catch((e) => console.error(`[reanalyze ${slug}]`, e));
  revalidatePath("/projects");
  revalidatePath("/");
}

async function cycleLlmProvider(id: number, current: string) {
  "use server";
  const user = await requireUser();
  const next = current === "auto" ? "deepseek" : current === "deepseek" ? "anthropic" : "auto";
  await db
    .update(schema.projectProfiles)
    .set({ llmProvider: next })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}

async function autoDetectGithubRepos() {
  "use server";
  const user = await requireUser();
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const tokenStored = settings?.githubToken ?? settings?.githubWriteToken ?? null;
  if (!tokenStored) throw new Error("add a GitHub PAT on /settings first");
  let token = "";
  try { token = (await readUserSecret(user.id, "githubToken", tokenStored, "auto-detect")) ?? ""; } catch {}
  if (!token) throw new Error("could not decrypt GitHub PAT");
  await autoDetectAndStoreRepos(user.id, token);
  revalidatePath("/projects");
}

// Skill-mode: per-project tag list (filter mode B). Comma-separated
// input → JSON-stringified array on storage. Normalises whitespace
// + lowercases + dedups + caps token count.
async function setProjectTags(id: number, value: string) {
  "use server";
  const user = await requireUser();
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid project id");
  const tags = Array.from(
    new Set(
      value
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && s.length <= 40)
        .slice(0, 30),
    ),
  );
  const stored = tags.length > 0 ? JSON.stringify(tags) : null;
  await db
    .update(schema.projectProfiles)
    .set({ tags: stored })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}

// Stored JSON → CSV for the input field. Defensive on malformed JSON.
function renderTagsCsv(raw: string | null): string {
  if (!raw) return "";
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((s) => typeof s === "string").join(", ") : "";
  } catch {
    return "";
  }
}

async function setGithubFullName(id: number, value: string) {
  "use server";
  const user = await requireUser();
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid project id");
  const trimmed = value.trim();
  // Allow blank (clear it) or strict owner/name format.
  if (trimmed && !/^[\w.-]{1,80}\/[\w.-]{1,80}$/.test(trimmed)) {
    throw new Error(`invalid github_full_name: ${trimmed} (want owner/name)`);
  }
  await db
    .update(schema.projectProfiles)
    .set({ githubFullName: trimmed || null })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}
