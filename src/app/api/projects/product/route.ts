import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq, sql } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { deriveProductKey } from "@/projects/product-key";

// Multi-repo products — manual override. Repos sharing a product_key are one
// product (matching unions their capabilities). Auto-grouping is by name-stem,
// which catches acme-web/acme-cv but not differently-named siblings (clinic-api /
// billing-svc). This stitches those together.
//
// Body: { repo?: "owner/name", repoId?: number,
//         sameProductAs?: "owner/name"|slug,   // join this repo's product
//         productKey?: string }                // or set an explicit group key
//
// Project resolution is owner-tolerant (exact github_full_name, then repo name,
// then slug).

type Body = { repo?: string; repoId?: number; sameProductAs?: string; productKey?: string };

async function resolveProject(userId: number, ref: string): Promise<typeof schema.projectProfiles.$inferSelect | null> {
  const r = ref.trim().toLowerCase();
  // exact github_full_name
  let p = await db.select().from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), sql`LOWER(${schema.projectProfiles.githubFullName}) = ${r}`)).get() ?? null;
  if (p) return p;
  // by repo name (owner-tolerant)
  if (r.includes("/")) {
    const namePart = r.slice(r.indexOf("/") + 1);
    const byName = await db.select().from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, userId),
        sql`LOWER(substr(${schema.projectProfiles.githubFullName}, instr(${schema.projectProfiles.githubFullName}, '/') + 1)) = ${namePart}`));
    if (byName.length) return byName[0];
  }
  // by slug
  p = await db.select().from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, userId), sql`LOWER(${schema.projectProfiles.slug}) = ${r}`)).get() ?? null;
  return p;
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders }); }

  // Resolve the target project.
  let project: typeof schema.projectProfiles.$inferSelect | null = null;
  if (typeof body.repoId === "number") {
    project = await db.select().from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.id, body.repoId), eq(schema.projectProfiles.userId, auth.userId))).get() ?? null;
  } else if (typeof body.repo === "string") {
    project = await resolveProject(auth.userId, body.repo);
  } else {
    return NextResponse.json({ error: "must specify repo ('owner/name') or repoId" }, { status: 400, headers: corsHeaders });
  }
  if (!project) return NextResponse.json({ error: "project not found — register it first" }, { status: 404, headers: corsHeaders });

  // Determine the product key to assign.
  let productKey: string | null = null;
  if (typeof body.sameProductAs === "string" && body.sameProductAs.trim()) {
    const other = await resolveProject(auth.userId, body.sameProductAs);
    if (!other) return NextResponse.json({ error: `sameProductAs repo not found: ${body.sameProductAs}` }, { status: 404, headers: corsHeaders });
    productKey = other.productKey ?? deriveProductKey(other.githubFullName) ?? other.slug;
  } else if (typeof body.productKey === "string" && body.productKey.trim()) {
    productKey = body.productKey.trim().toLowerCase();
    // Bound it: productKey is a slug-like grouping token, not free text.
    if (productKey.length > 100 || !/^[a-z0-9._/-]+$/.test(productKey)) {
      return NextResponse.json({ error: "productKey must be <=100 chars of [a-z0-9._/-]" }, { status: 400, headers: corsHeaders });
    }
  } else {
    return NextResponse.json({ error: "specify sameProductAs (a repo to group with) or productKey" }, { status: 400, headers: corsHeaders });
  }

  await db.update(schema.projectProfiles).set({ productKey, updatedAt: new Date() }).where(eq(schema.projectProfiles.id, project.id));

  // Report the product's current repos.
  const all = await db.select({ slug: schema.projectProfiles.slug, gh: schema.projectProfiles.githubFullName, pk: schema.projectProfiles.productKey })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, auth.userId), eq(schema.projectProfiles.active, true), eq(schema.projectProfiles.included, true)));
  const members = all.filter((p) => (p.pk ?? deriveProductKey(p.gh)) === productKey).map((p) => p.slug);

  return NextResponse.json({ ok: true, project: project.slug, productKey, productRepos: members }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
