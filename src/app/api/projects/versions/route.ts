import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";

// Version reporting — the in-session agent posts the project's pinned
// dependency/runtime versions (names + versions ONLY, never code). This is
// what turns "worth checking your pins" into "affects acme (3.10.12)" in
// deadlines, alerts, and the weekly brief. Runtimes use canonical keys
// (node, python, postgres, …); deps use their manifest names.
//
// Body: { repo?: "owner/name", versions: Record<string, string> }
// Full replace per call — the agent reads the live lockfile, so what it
// sends IS the current truth; merging would preserve removed deps.

type Body = { repo?: string; versions?: unknown };

const MAX_ENTRIES = 500;
const MAX_NAME = 120;
const MAX_VERSION = 64;

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  if (!body.versions || typeof body.versions !== "object" || Array.isArray(body.versions)) {
    return NextResponse.json({ error: "versions must be an object of { name: version }" }, { status: 400, headers: corsHeaders });
  }

  // Owner-tolerant project resolution (same pattern as /capabilities).
  const repoFilter = body.repo?.trim().toLowerCase();
  if (!repoFilter) return NextResponse.json({ error: "repo ('owner/name') required" }, { status: 400, headers: corsHeaders });
  let p = await db.select({ id: schema.projectProfiles.id }).from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, auth.userId), sql`LOWER(${schema.projectProfiles.githubFullName}) = ${repoFilter}`)).get() ?? null;
  if (!p && repoFilter.includes("/")) {
    const namePart = repoFilter.slice(repoFilter.indexOf("/") + 1);
    p = await db.select({ id: schema.projectProfiles.id }).from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, auth.userId),
        sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${namePart}`,
      )).get() ?? null;
  }
  if (!p) return NextResponse.json({ error: "project not found for this user" }, { status: 404, headers: corsHeaders });

  const clean: Record<string, string> = {};
  let stored = 0;
  for (const [k, v] of Object.entries(body.versions as Record<string, unknown>)) {
    if (stored >= MAX_ENTRIES) break;
    if (typeof v !== "string") continue;
    const name = k.trim().toLowerCase().slice(0, MAX_NAME);
    const version = v.trim().replace(/^[\^~>=<]+/, "").slice(0, MAX_VERSION); // strip range operators
    if (!name || !version) continue;
    clean[name] = version;
    stored++;
  }

  await db.update(schema.projectProfiles)
    .set({ depVersions: JSON.stringify(clean), updatedAt: new Date() })
    .where(eq(schema.projectProfiles.id, p.id));

  return NextResponse.json({ ok: true, stored }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
