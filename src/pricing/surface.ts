// Pricing watch — the surfacing side. One calm "P.s." line in the inventory
// footnote when a tool the user's product actually uses changed its pricing.
// Never a writeup, never a candidate row: pricing changes are awareness, not
// triage work. Each change is shown to a user at most once (pricing_surfaces),
// at most one line per response, and only within the recency window.

import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client";
import { userToolTokens } from "../lib/detect-tokens";

const SURFACE_WINDOW_DAYS = Math.max(1, parseInt(process.env.REPLEN_PRICING_SURFACE_DAYS ?? "14", 10) || 14);

// Build the user's "tools I use" token set from product deps + project tags.
// Shared with the announcement sources (src/lib/detect-tokens.ts).
export const pricingUserTokens = (productDeps: Set<string>, tags: Set<string>): Set<string> =>
  userToolTokens(productDeps, tags);

// `token` — the matched detect-token (the user-side tool identity, e.g.
// "supabase"); lets the caller deep-link the Atlas tool node for "where do I
// use this". Null only if token parsing fails post-match.
export type PricingPs = { changeId: number; line: string; token: string | null };

// The most recent unseen pricing change for a tool this user uses, as a short
// footnote line (without the "P.s. " prefix). Null when there's nothing — the
// overwhelmingly common case.
export async function pricingPs(userId: number, userTokens: Set<string>): Promise<PricingPs | null> {
  if (userTokens.size === 0) return null;
  const since = new Date(Date.now() - SURFACE_WINDOW_DAYS * 24 * 3600 * 1000);
  const changes = await db
    .select({
      id: schema.pricingChanges.id,
      toolId: schema.pricingChanges.toolId,
      detectedAt: schema.pricingChanges.detectedAt,
      summary: schema.pricingChanges.summary,
      plan: schema.pricingChanges.plan,
      vendor: schema.pricingTools.vendor,
      tool: schema.pricingTools.tool,
      detectTokens: schema.pricingTools.detectTokens,
    })
    .from(schema.pricingChanges)
    .innerJoin(schema.pricingTools, eq(schema.pricingChanges.toolId, schema.pricingTools.id))
    .where(gte(schema.pricingChanges.detectedAt, since));
  if (!changes.length) return null;

  const seen = new Set(
    (await db.select({ changeId: schema.pricingSurfaces.changeId }).from(schema.pricingSurfaces)
      .where(and(eq(schema.pricingSurfaces.userId, userId), gte(schema.pricingSurfaces.surfacedAt, since))))
      .map((r) => r.changeId),
  );
  // Also exclude anything ever surfaced (window query above is an optimisation;
  // the unique index makes re-inserts no-ops, but don't re-show old changes).
  const allSeen = new Set(
    (await db.select({ changeId: schema.pricingSurfaces.changeId }).from(schema.pricingSurfaces)
      .where(eq(schema.pricingSurfaces.userId, userId))).map((r) => r.changeId),
  );
  for (const s of seen) allSeen.add(s);

  // Declared plans ("we're on Supabase Pro" — tool_prefs, set from the Atlas
  // tool dossier) personalise ranking and wording: a change touching YOUR
  // plan leads; a tier you're verifiably NOT on demotes.
  const prefs = await db.select().from(schema.toolPrefs).where(eq(schema.toolPrefs.userId, userId));
  const planByToken = new Map<string, string>();
  for (const p of prefs) if (p.plan) planByToken.set(p.tool, p.plan.toLowerCase());
  const planScore = (c: typeof changes[number]): number => {
    let toks: string[] = [];
    try { toks = JSON.parse(c.detectTokens ?? "[]"); } catch { /* */ }
    const declared = toks.map((t) => planByToken.get(t)).find(Boolean);
    if (!declared) return 0;
    if (c.plan && declared.includes(c.plan.toLowerCase())) return 2; // their plan moved
    if (c.plan) return -1; // a tier they're verifiably not on
    return 1; // their tool, plan unclear
  };

  const eligible = changes
    .filter((c) => !allSeen.has(c.id))
    .filter((c) => {
      let toks: string[] = [];
      try { toks = JSON.parse(c.detectTokens ?? "[]"); } catch { /* */ }
      return toks.some((t) => userTokens.has(t));
    })
    .sort((a, b) => planScore(b) - planScore(a) || b.detectedAt.getTime() - a.detectedAt.getTime());
  if (!eligible.length) return null;

  const c = eligible[0];
  // Display name: the tool when it's more specific than the vendor
  // ("Amazon S3"), the vendor when they're the same thing ("Supabase").
  const name = c.tool.toLowerCase().includes(c.vendor.toLowerCase().split(" ")[0]) || c.tool === c.vendor
    ? c.tool
    : `${c.vendor} ${c.tool}`;
  const line = c.plan
    ? planScore(c) === 2
      ? `${name} changed pricing on YOUR plan (${c.summary}) — worth a look.`
      : `${name} updated their pricing (${c.summary}) — worth a look.`
    : `${name}'s pricing page changed — worth a look.`;
  let cToks: string[] = [];
  try { cToks = JSON.parse(c.detectTokens ?? "[]"); } catch { /* */ }
  return { changeId: c.id, line, token: cToks.find((t) => userTokens.has(t)) ?? null };
}
