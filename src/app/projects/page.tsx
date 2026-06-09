import { db, schema } from "@/db/client";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

// Skill-tier project management. The "approved list" Replen matches against:
// which of your repos are watched (Include), their tags, and the GitHub repo
// each maps to. Projects are normally discovered by the CLI (`npx replen
// sync-projects`), but you can add one by owner/name here, fix an owner that
// drifted (e.g. after a repo moved orgs), or remove a stale/duplicate row.
export default async function Projects() {
  const user = await requireUser();
  const projects = await db
    .select()
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, user.id))
    .orderBy(desc(schema.projectProfiles.included), schema.projectProfiles.slug);

  const totalIncluded = projects.filter((p) => p.included).length;

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 20px" }}>
      <h1>Projects</h1>
      <p className="meta">
        {projects.length} registered · {totalIncluded} watched (included in matching)
      </p>
      <p className="meta">
        <b>Include</b> = Replen watches this repo and matches new libraries / releases / spec changes against it.
        Add a repo below, fix a drifted owner in the GitHub-repo field, or remove a stale/duplicate row.
      </p>

      {/* Add a repo by owner/name. Owner-tolerant: if a project with this repo
          name already exists, this corrects its owner + includes it instead of
          creating a duplicate. */}
      <form
        action={async (form: FormData) => {
          "use server";
          await addProject((form.get("repo") as string) ?? "", (form.get("tags") as string) ?? "");
        }}
        style={{ display: "flex", gap: 8, alignItems: "center", margin: "16px 0", flexWrap: "wrap" }}
      >
        <input name="repo" placeholder="owner/repo (e.g. nsokin/acme-web)" required
          style={{ padding: "4px 8px", fontSize: 13, width: 280, fontFamily: "ui-monospace, monospace" }} />
        <input name="tags" placeholder="tags (optional): nextjs, leaflet, geospatial"
          style={{ padding: "4px 8px", fontSize: 13, width: 280 }} />
        <button type="submit" style={{ padding: "4px 12px", fontSize: 13 }}>+ Add &amp; watch</button>
      </form>

      <table style={{ marginTop: 8, width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Project</th>
            <th>Include</th>
            <th style={{ textAlign: "left" }}>GitHub repo</th>
            <th style={{ textAlign: "left" }} title="Comma-separated tags. Coarse pre-filter before semantic matching.">Tags</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} style={{ opacity: p.included ? 1 : 0.5 }}>
              <td>{p.name}{!p.active && <span className="meta" style={{ marginLeft: 6 }}>(inactive)</span>}</td>
              <td style={{ textAlign: "center" }}>
                <form className="inline" action={async () => { "use server"; await toggleIncluded(p.id, !p.included); }}>
                  <button title={p.included ? "Watched — click to stop watching" : "Not watched — click to watch"}>
                    {p.included ? "✓ in" : "—"}
                  </button>
                </form>
              </td>
              <td>
                <form className="inline" action={async (form: FormData) => { "use server"; await setGithubFullName(p.id, (form.get("ghFullName") as string) ?? ""); }} style={{ display: "inline-flex", gap: 4 }}>
                  <input name="ghFullName" defaultValue={p.githubFullName ?? ""} placeholder="owner/repo"
                    style={{ padding: "1px 4px", fontSize: 12, width: 170, fontFamily: "ui-monospace, monospace" }} />
                  <button style={{ padding: "1px 6px", fontSize: 11 }}>save</button>
                </form>
              </td>
              <td>
                <form className="inline" action={async (form: FormData) => { "use server"; await setProjectTags(p.id, (form.get("tags") as string) ?? ""); }} style={{ display: "inline-flex", gap: 4 }}>
                  <input name="tags" defaultValue={renderTagsCsv(p.tags)} placeholder="tags"
                    style={{ padding: "1px 4px", fontSize: 12, width: 190, fontFamily: "ui-monospace, monospace" }} />
                  <button style={{ padding: "1px 6px", fontSize: 11 }}>save</button>
                </form>
              </td>
              <td>
                <form className="inline" action={async () => { "use server"; await deleteProject(p.id); }}>
                  <button title="Remove this project row (e.g. a stale or duplicate entry)" style={{ padding: "1px 6px", fontSize: 11, color: "#b00" }}>delete</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
}

async function setProjectTags(id: number, value: string) {
  "use server";
  const user = await requireUser();
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid project id");
  const tags = normaliseTags(value);
  await db
    .update(schema.projectProfiles)
    .set({ tags: tags.length > 0 ? JSON.stringify(tags) : null })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}

async function setGithubFullName(id: number, value: string) {
  "use server";
  const user = await requireUser();
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid project id");
  const trimmed = value.trim();
  if (trimmed && !/^[\w.-]{1,80}\/[\w.-]{1,80}$/.test(trimmed)) {
    throw new Error(`invalid github_full_name: ${trimmed} (want owner/name)`);
  }
  await db
    .update(schema.projectProfiles)
    .set({ githubFullName: trimmed || null })
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}

async function deleteProject(id: number) {
  "use server";
  const user = await requireUser();
  if (!Number.isInteger(id) || id <= 0) throw new Error("invalid project id");
  await db
    .delete(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.id, id), eq(schema.projectProfiles.userId, user.id)));
  revalidatePath("/projects");
}

// Add a repo by owner/name and watch it. Owner-tolerant: if a project already
// exists with the same repo NAME (e.g. it was registered under a stale owner),
// correct its owner + include it instead of creating a duplicate.
async function addProject(repo: string, tagsCsv: string) {
  "use server";
  const user = await requireUser();
  const gfn = repo.trim();
  if (!/^[\w.-]{1,80}\/[\w.-]{1,80}$/.test(gfn)) {
    throw new Error(`invalid repo: ${gfn} (want owner/name)`);
  }
  const name = gfn.slice(gfn.indexOf("/") + 1);
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "project";
  const tags = normaliseTags(tagsCsv);
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
  const now = new Date();

  // Owner-tolerant existing check: same repo name under any owner.
  const existing = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, user.id),
      sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${name.toLowerCase()}`,
    ));
  if (existing.length > 0) {
    await db
      .update(schema.projectProfiles)
      .set({ githubFullName: gfn, included: true, active: true, ...(tagsJson ? { tags: tagsJson } : {}), updatedAt: now })
      .where(eq(schema.projectProfiles.id, existing[0].id));
    revalidatePath("/projects");
    return;
  }

  await db
    .insert(schema.projectProfiles)
    .values({
      userId: user.id,
      slug,
      path: `github:${gfn}`,
      name,
      profileHash: "",
      githubFullName: gfn,
      tags: tagsJson,
      included: true,
      active: true,
      updatedAt: now,
    })
    .onConflictDoNothing();
  revalidatePath("/projects");
}

function normaliseTags(value: string): string[] {
  return Array.from(
    new Set(
      (value ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && s.length <= 40)
        .slice(0, 30),
    ),
  );
}

function renderTagsCsv(raw: string | null): string {
  if (!raw) return "";
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((s) => typeof s === "string").join(", ") : "";
  } catch {
    return "";
  }
}
