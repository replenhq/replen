"use server";

// Drag-to-verdict for the Atlas Carts board. Dropping a card into a verdict
// column records the verdict the canonical way: an append-only triage_events
// row (the same path the in-session skill posts to), then rebuilds the graph so
// the EVALUATED edge reflects it. This IS the triage write-back loop, surfaced
// as a drag. Verdict GENERATION still happens in the user's session; this only
// records a human override on a candidate they already triaged.
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireWritableUser } from "@/lib/auth/demo-mode";
import { resolveOrCreateRepoId } from "@/lib/resolve-repo";
import { buildUserGraph } from "@/graph/build";
import { CARTS, type CartFilters } from "@/graph/carts-shared";
import { revalidatePath } from "next/cache";

const VERDICTS = new Set(["adopt", "port", "cherry-pick", "clean-room", "upgrade", "skip"]);
const BUILTIN = new Set(CARTS.map((c) => c.id));
const LAYOUTS = new Set(["table", "board", "cards", "map", "timeline"]);

// Save (or update) a filtered view as a named cart.
export async function saveCart(
  name: string, baseCart: string, layout: string | null, filters: CartFilters,
): Promise<{ ok: boolean; id?: number; error?: string }> {
  const user = await requireWritableUser();
  name = name.trim().slice(0, 60);
  if (!name) return { ok: false, error: "name required" };
  if (!BUILTIN.has(baseCart)) return { ok: false, error: "unknown cart" };
  const safeLayout = layout && LAYOUTS.has(layout) ? layout : null;
  const clean: CartFilters = {};
  for (const k of ["provenance", "modality", "verdict", "project", "q"] as const) {
    const v = filters[k];
    if (typeof v === "string" && v) clean[k] = v;
  }
  const now = new Date();
  try {
    const r = await db.insert(schema.atlasCarts)
      .values({ userId: user.id, name, baseCart, layout: safeLayout, filtersJson: JSON.stringify(clean), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [schema.atlasCarts.userId, schema.atlasCarts.name], set: { baseCart, layout: safeLayout, filtersJson: JSON.stringify(clean), updatedAt: now } })
      .returning({ id: schema.atlasCarts.id });
    revalidatePath("/atlas");
    return { ok: true, id: r[0]?.id };
  } catch {
    return { ok: false, error: "could not save" };
  }
}

export async function deleteCart(id: number): Promise<{ ok: boolean }> {
  const user = await requireWritableUser();
  await db.delete(schema.atlasCarts).where(and(eq(schema.atlasCarts.id, id), eq(schema.atlasCarts.userId, user.id)));
  revalidatePath("/atlas");
  return { ok: true };
}

export async function setCartVerdict(
  repoFullName: string,
  verdict: string,
  projectSlug: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireWritableUser(); // throws on the read-only demo user
  if (!VERDICTS.has(verdict)) return { ok: false, error: "invalid verdict" };
  const m = /^([^/]+)\/([^/]+)$/.exec(repoFullName.trim());
  if (!m) return { ok: false, error: "bad repo name" };

  const repoId = await resolveOrCreateRepoId(m[1], m[2]);
  if (!projectSlug) return { ok: false, error: "no project context" };
  const proj = await db
    .select({ id: schema.projectProfiles.id })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.slug, projectSlug), eq(schema.projectProfiles.userId, user.id)))
    .get();
  if (!proj) return { ok: false, error: "project not found" };

  // Carry the prior score forward so the Match bar survives a manual move.
  const prior = await db
    .select({ score: schema.triageEvents.score })
    .from(schema.triageEvents)
    .where(and(
      eq(schema.triageEvents.userId, user.id),
      eq(schema.triageEvents.repoId, repoId),
      eq(schema.triageEvents.projectId, proj.id),
    ))
    .orderBy(desc(schema.triageEvents.createdAt))
    .get();

  await db.insert(schema.triageEvents).values({
    userId: user.id,
    repoId,
    projectId: proj.id,
    verdict,
    score: prior?.score ?? null,
    reasonCode: "other",
    oneLine: `Moved to ${verdict} on the Atlas board`,
    createdAt: new Date(),
  });

  // Rebuild the graph so the EVALUATED edge (and the board) reflect the move,
  // then revalidate. Awaited so the next render is the new truth.
  await buildUserGraph(user.id, { force: true });
  revalidatePath("/atlas");
  return { ok: true };
}
