import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { computeLeaps } from "@/graph/leaps";

// Atlas §1 — Leaps. The non-obvious connection engine over the user's knowledge
// graph. Scope to a repo (owner/name) to get leaps for that project (+ its
// product siblings folded in by the matcher), or omit for the whole portfolio.
//
// GET  /api/graph/leaps?repo=owner/name&limit=12
// POST { repo?, limit? }

async function handle(repoArg: string | undefined, limit: number, userId: number) {
  // Resolve repo → project slug (owner-tolerant), like replen_match.
  let scopeProject: string | undefined;
  if (repoArg && /^[^/]+\/[^/]+$/.test(repoArg)) {
    const lc = repoArg.trim().toLowerCase();
    let p = await db.select({ slug: schema.projectProfiles.slug }).from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, userId), sql`LOWER(${schema.projectProfiles.githubFullName}) = ${lc}`)).get();
    if (!p) {
      const namePart = lc.slice(lc.indexOf("/") + 1);
      p = await db.select({ slug: schema.projectProfiles.slug }).from(schema.projectProfiles)
        .where(and(eq(schema.projectProfiles.userId, userId), sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${namePart}`)).get();
    }
    scopeProject = p?.slug;
    // A caller who asked for leaps "for this repo" must not silently get the
    // whole-portfolio result when the repo isn't registered — that reads as
    // "these leaps are for your repo" when they aren't. Return an explicit
    // empty, flagged result instead.
    if (!scopeProject) {
      return { scopedTo: null, count: 0, leaps: [], note: "repo not registered" as const };
    }
  }
  const leaps = await computeLeaps(userId, { scopeProject, limit });
  return { scopedTo: scopeProject ?? null, count: leaps.length, leaps };
}

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  const url = new URL(req.url);
  const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get("limit") ?? "12", 10) || 12));
  const data = await handle(url.searchParams.get("repo") ?? undefined, limit, auth.userId);
  return NextResponse.json(data, { headers: corsHeaders });
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  let body: { repo?: string; limit?: number } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const limit = Math.min(30, Math.max(1, body.limit ?? 12));
  const data = await handle(body.repo, limit, auth.userId);
  return NextResponse.json(data, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
