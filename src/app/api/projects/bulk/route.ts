import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";

// POST /api/projects/bulk
//
// Skill-mode day-1 setup endpoint. The CLI scans the user's local
// filesystem for git repos and POSTs the list here in one batch. Each
// row gets upserted into project_profiles, keyed by (user_id, slug).
//
// Body shape:
//   {
//     "projects": [
//       {
//         "slug": "tech-news-site",         // required; URL-safe identifier
//         "githubFullName": "owner/name",   // required; from git remote
//         "name": "Tech News Site",          // optional; defaults to slug
//         "tags": ["typescript", "next.js"], // optional; deduped server-side
//         "primaryLanguage": "TypeScript"    // optional
//       }
//     ]
//   }
//
// Behaviour:
//   - Insert when (user_id, slug) doesn't exist
//   - Update tags + name + githubFullName when the row exists; never
//     overwrite user-edited fields (sensitivity, llm_provider, included)
//   - Sets path = "github:<owner>/<name>" so downstream loaders + UI
//     render consistently
//   - Returns per-row outcome so the CLI can show counts
//
// Idempotent: re-POSTing the same list bumps updated_at but otherwise
// no-ops. Safe to call on every `npx replen` setup.
//
// Auth: same x-digest-token as other MCP endpoints. The token gates
// access to the user_id under which projects get registered.

type BulkProjectInput = {
  slug?: string;
  githubFullName?: string;
  name?: string;
  tags?: string[];
  primaryLanguage?: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const REPO_RE = /^[\w.-]{1,80}\/[\w.-]{1,80}$/;

function normaliseTag(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const trimmed = t.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  return trimmed;
}

// Scaffold/template default names that aren't real project names. When a
// repo's package.json (or the CLI) hands us one of these, it's noise — four
// repos cloned from the same starter all call themselves "nextn". Fall back
// to the GitHub repo name instead so the display label is the actual repo.
const GENERIC_NAMES = new Set([
  "nextn", "next-app", "create-next-app", "nextjs", "next", "my-app", "myapp",
  "my-project", "myproject", "app", "web", "webapp", "frontend", "backend",
  "client", "server", "project", "vite-project", "vite-app", "react-app",
  "turborepo", "my-turborepo", "monorepo", "example", "template", "starter",
  "boilerplate", "hello-world", "test", "demo", "untitled",
]);
const isGenericName = (n: string) => GENERIC_NAMES.has(n.trim().toLowerCase());

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: { projects?: BulkProjectInput[] };
  try {
    body = (await req.json()) as { projects?: BulkProjectInput[] };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  if (!Array.isArray(body.projects) || body.projects.length === 0) {
    return NextResponse.json({ error: "projects array required (non-empty)" }, { status: 400, headers: corsHeaders });
  }
  if (body.projects.length > 200) {
    return NextResponse.json({ error: "max 200 projects per call" }, { status: 400, headers: corsHeaders });
  }

  // Validate + normalise inputs up front. Reject the whole batch on bad
  // input rather than silent-drop bad rows — the CLI sent us a list it
  // expects to fully land.
  type CleanInput = {
    slug: string;
    githubFullName: string;
    name: string;
    tags: string[] | null;
    primaryLanguage: string | null;
  };
  const cleaned: CleanInput[] = [];
  for (const p of body.projects) {
    const slug = (p.slug ?? "").toString().trim();
    const gfn = (p.githubFullName ?? "").toString().trim();
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json({ error: `invalid slug: ${slug.slice(0, 30)}` }, { status: 400, headers: corsHeaders });
    }
    if (!REPO_RE.test(gfn)) {
      return NextResponse.json({ error: `invalid githubFullName: ${gfn.slice(0, 50)} (want owner/name)` }, { status: 400, headers: corsHeaders });
    }
    const tags = Array.isArray(p.tags)
      ? Array.from(new Set(p.tags.map(normaliseTag).filter((t): t is string => t !== null))).slice(0, 30)
      : null;
    const lang = typeof p.primaryLanguage === "string" && p.primaryLanguage.trim().length > 0
      ? p.primaryLanguage.trim().slice(0, 40)
      : null;
    cleaned.push({
      slug,
      githubFullName: gfn,
      name: (() => {
        const raw = typeof p.name === "string" ? p.name.trim() : "";
        // Real package.json name wins; a generic scaffold name or empty falls
        // back to the GitHub repo name (last path segment of owner/name).
        if (raw.length > 0 && !isGenericName(raw)) return raw.slice(0, 80);
        return (gfn.split("/").pop() || slug).slice(0, 80);
      })(),
      tags,
      primaryLanguage: lang,
    });
  }

  // Load all of this user's existing rows once. Identity is
  // github_full_name (stable across folder/org renames); slug is a
  // mutable display label. Matching on gfn — not slug — is what stops a
  // renamed folder or an org rename from minting a fresh
  // slug and inserting a duplicate row.
  const existing = await db
    .select({
      id: schema.projectProfiles.id,
      slug: schema.projectProfiles.slug,
      githubFullName: schema.projectProfiles.githubFullName,
    })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, auth.userId));

  const gfnKey = (g: string | null | undefined) => (g ?? "").trim().toLowerCase();
  const byGfn = new Map<string, { id: number; slug: string }>();
  const bySlug = new Map<string, { id: number; gfn: string | null }>();
  for (const r of existing) {
    if (r.githubFullName) byGfn.set(gfnKey(r.githubFullName), { id: r.id, slug: r.slug });
    bySlug.set(r.slug, { id: r.id, gfn: r.githubFullName ?? null });
  }
  // Pick a slug that won't violate uniq_profile_user_slug as we rename
  // rows / insert within this batch (bySlug is kept current below).
  const freeSlug = (want: string, owner: string, selfId: number | null): string => {
    const taken = (s: string) => { const row = bySlug.get(s); return !!row && row.id !== selfId; };
    if (!taken(want)) return want;
    const suffixed = `${want}-${owner}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return taken(suffixed) ? `${want}-${selfId ?? "x"}`.slice(0, 80) : suffixed;
  };

  const now = new Date();
  let created = 0;
  let updated = 0;
  for (const c of cleaned) {
    const tagsJson = c.tags && c.tags.length > 0 ? JSON.stringify(c.tags) : null;
    const path = `github:${c.githubFullName}`;
    const owner = c.githubFullName.split("/")[0] ?? "x";

    // Prefer a gfn match. Fall back to a slug match ONLY when that row has
    // no gfn yet (a legacy/stale row) — a shared slug across two different
    // repos must not let one hijack the other's row.
    let target = byGfn.get(gfnKey(c.githubFullName)) ?? null;
    if (!target) {
      const s = bySlug.get(c.slug);
      if (s && !s.gfn) target = { id: s.id, slug: c.slug };
    }

    if (target) {
      // Rename the slug to the new canonical value when it's free; keep the
      // old slug if the new one belongs to a different repo.
      const newSlug = freeSlug(c.slug, owner, target.id);
      await db
        .update(schema.projectProfiles)
        .set({
          slug: newSlug,
          name: c.name,
          githubFullName: c.githubFullName,
          path,
          ...(tagsJson ? { tags: tagsJson } : {}),
          ...(c.primaryLanguage ? { primaryLanguage: c.primaryLanguage } : {}),
          updatedAt: now,
        })
        .where(eq(schema.projectProfiles.id, target.id));
      // Keep the in-memory maps consistent for later rows in this batch.
      if (newSlug !== target.slug) bySlug.delete(target.slug);
      bySlug.set(newSlug, { id: target.id, gfn: c.githubFullName });
      byGfn.set(gfnKey(c.githubFullName), { id: target.id, slug: newSlug });
      updated++;
    } else {
      // First-time insert. profile_hash is required (notNull) but we don't
      // have docs yet — placeholder; the loader overwrites on its next pass.
      const slug = freeSlug(c.slug, owner, null);
      const inserted = await db.insert(schema.projectProfiles).values({
        userId: auth.userId,
        slug,
        path,
        name: c.name,
        githubFullName: c.githubFullName,
        profileHash: "pending-loader",
        active: true,
        included: true,
        sensitivity: "low",
        llmProvider: "auto",
        ...(tagsJson ? { tags: tagsJson } : {}),
        ...(c.primaryLanguage ? { primaryLanguage: c.primaryLanguage } : {}),
        updatedAt: now,
      }).returning({ id: schema.projectProfiles.id });
      const newId = inserted[0]?.id ?? -1;
      bySlug.set(slug, { id: newId, gfn: c.githubFullName });
      byGfn.set(gfnKey(c.githubFullName), { id: newId, slug });
      created++;
    }
  }

  return NextResponse.json(
    { ok: true, created, updated, total: cleaned.length },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
