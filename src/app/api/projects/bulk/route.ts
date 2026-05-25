import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, inArray } from "drizzle-orm";
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
      name: (typeof p.name === "string" && p.name.trim().length > 0 ? p.name.trim() : slug).slice(0, 80),
      tags,
      primaryLanguage: lang,
    });
  }

  // One round-trip query for existing rows; we know the userId is auth'd.
  const slugs = cleaned.map((c) => c.slug);
  const existing = await db
    .select({
      id: schema.projectProfiles.id,
      slug: schema.projectProfiles.slug,
    })
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, auth.userId),
      inArray(schema.projectProfiles.slug, slugs),
    ));
  const existingBySlug = new Map(existing.map((r) => [r.slug, r.id]));

  const now = new Date();
  let created = 0;
  let updated = 0;
  for (const c of cleaned) {
    const tagsJson = c.tags && c.tags.length > 0 ? JSON.stringify(c.tags) : null;
    const path = `github:${c.githubFullName}`;
    const existingId = existingBySlug.get(c.slug);
    if (existingId) {
      // Update only the fields the CLI is authoritative about. Don't
      // touch user-managed fields (included, sensitivity, llm_provider).
      // Don't bump profile_hash here — that's the loader's job.
      await db
        .update(schema.projectProfiles)
        .set({
          name: c.name,
          githubFullName: c.githubFullName,
          path,
          ...(tagsJson ? { tags: tagsJson } : {}),
          updatedAt: now,
        })
        .where(eq(schema.projectProfiles.id, existingId));
      updated++;
    } else {
      // First-time insert. profile_hash is required (notNull) but we
      // don't have any docs yet — set a placeholder; the loader will
      // overwrite on its next pass when it pulls README/CLAUDE.md
      // from GitHub.
      await db.insert(schema.projectProfiles).values({
        userId: auth.userId,
        slug: c.slug,
        path,
        name: c.name,
        githubFullName: c.githubFullName,
        profileHash: "pending-loader",
        active: true,
        included: true,
        sensitivity: "low",
        llmProvider: "auto",
        ...(tagsJson ? { tags: tagsJson } : {}),
        updatedAt: now,
      });
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
