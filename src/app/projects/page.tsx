import { db, schema } from "@/db/client";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { reprocessForUser } from "@/scheduler/reprocess-matches";
import { readUserSecret } from "@/lib/user-secrets";
import { autoDetectAndStoreRepos } from "@/lib/github-repo-detect";

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
            <th style={{ textAlign: "center" }}>CLAUDE.md</th>
            <th style={{ textAlign: "right" }}>Matches</th>
            <th></th>
            <th>GitHub repo</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const effective =
              p.llmProvider === "auto" ? (p.sensitivity === "high" ? "anthropic" : "deepseek") : p.llmProvider;
            return (
              <tr key={p.id} style={{ opacity: p.included ? 1 : 0.45 }}>
                <td><a href={`/projects/${p.slug}`}>{p.name}</a></td>
                <td>
                  <form className="inline" action={async () => { "use server"; await toggleIncluded(p.id, !p.included); }}>
                    <button>{p.included ? "✓ in" : "-"}</button>
                  </form>
                </td>
                <td>
                  <form className="inline" action={async () => { "use server"; await toggleSensitivity(p.id, p.sensitivity === "high" ? "low" : "high"); }}>
                    <button style={p.sensitivity === "high" ? { background: "#ffadad", color: "#1a1a1a" } : undefined}>
                      {p.sensitivity === "high" ? "🔒 high" : "low"}
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
                <td style={{ textAlign: "center" }}>{p.claudeMd ? "✓" : "-"}</td>
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
                      style={{ padding: "1px 4px", fontSize: 12, width: 150, fontFamily: "ui-monospace, monospace" }}
                    />
                    <button title="Save GitHub repo for handoff PRs" style={{ padding: "1px 6px", fontSize: 11 }}>save</button>
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
