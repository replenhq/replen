"use server";

// Atlas dossier + actions. Clicking a node opens the full picture (the same
// depth the vault notes carry) and lets the user act — the graph is the
// navigation, the dossier is the destination.

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { alternativesFor } from "@/lib/alternatives";
import { computeOverlay } from "@/graph/overlay";
import { resolveOrCreateRepoId } from "@/lib/resolve-repo";
import { embed, facetEmbeddingText, serialiseEmbedding, parseStoredFacetEmbeddings, serialiseFacetEmbeddings } from "@/lib/embeddings";
import { buildUserGraph } from "@/graph/build";
import { revalidatePath } from "next/cache";

// Rebuild the user's graph after a dossier edit and refresh the /atlas page,
// WITHOUT blocking the action response — the click feels instant and the next
// render (revalidate) picks up the rebuilt graph. A rebuild failure is logged,
// never surfaced as a failed save (the underlying write already committed).
function rebuildAndRevalidate(userId: number): void {
  void buildUserGraph(userId, { force: true })
    .then(() => revalidatePath("/atlas"))
    .catch((e) => console.warn("[atlas] post-action graph rebuild failed:", e));
}

export type Dossier = {
  kind: string;
  title: string;
  subtitle?: string | null;
  sections: Array<{ heading: string; items: string[] }>;
  url?: string | null;
  blindspot?: boolean;
  queueSuggestion?: string | null; // prefilled title for the queue button
  // Anchored note (editable in the panel; flows into recall + the vault).
  note?: string | null;
  // Candidate nodes: the full decision log — verdict, where, when, and the
  // agent's complete write-up (the artifact the user's tokens paid for).
  decisions?: Array<{
    verdict: string; score: number | null; effort: string | null; reason: string | null;
    project: string; at: string; oneLine: string | null; writeup: string | null;
  }>;
  // Action contexts per kind — what the panel's buttons operate on.
  tool?: { key: string; plan: string | null; migrateOff: boolean };
  suggestion?: { fullName: string; projectSlug: string | null };
  goal?: { id: number; status: string };
  capability?: { label: string; provenance: string | null };
  project?: { slug: string };
};

const j = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
};

export async function getNodeDossier(kind: string, nodeKey: string): Promise<Dossier | null> {
  const user = await requireUser();
  const node = await db.select().from(schema.graphNodes)
    .where(and(eq(schema.graphNodes.userId, user.id), eq(schema.graphNodes.kind, kind), eq(schema.graphNodes.nodeKey, nodeKey))).get();
  if (!node) return null;
  const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.userId, user.id));
  const edges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.userId, user.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const data = j(node.data);
  const noteRow = await db.select({ note: schema.nodeNotes.note }).from(schema.nodeNotes)
    .where(and(eq(schema.nodeNotes.userId, user.id), eq(schema.nodeNotes.kind, kind), eq(schema.nodeNotes.nodeKey, nodeKey))).get();
  const anchoredNote = noteRow?.note ?? null;

  if (kind === "project") {
    const caps: string[] = [];
    const decisions: string[] = [];
    const tools: string[] = [];
    for (const e of edges) {
      if (e.srcId !== node.id) continue;
      const dst = byId.get(e.dstId);
      if (!dst) continue;
      const ed = j(e.data);
      if (e.kind === "HAS_CAPABILITY") {
        const paths = Array.isArray(ed.paths) ? (ed.paths as string[]) : [];
        caps.push(`${dst.label} · ${ed.provenance ?? "inferred"}${paths.length ? ` — ${paths[0]}` : ""}`);
      }
      if (e.kind === "EVALUATED") decisions.push(`${ed.verdict} — ${dst.label}${ed.reasonCode ? ` (${ed.reasonCode})` : ""}${ed.oneLine ? `: ${ed.oneLine}` : ""}${ed.at ? ` · ${fmtDate(String(ed.at))}` : ""}`);
      if (e.kind === "USES") tools.push(`${dst.label}${ed.version ? `@${ed.version}` : ""}`);
    }
    const profile = await db.select({ summaryJson: schema.projectProfiles.summaryJson, githubFullName: schema.projectProfiles.githubFullName })
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, nodeKey))).get();
    const purpose = (j(profile?.summaryJson ?? null).purpose as string) ?? null;
    const queued = await db.select({ title: schema.queuedActions.title }).from(schema.queuedActions)
      .where(and(eq(schema.queuedActions.userId, user.id), eq(schema.queuedActions.status, "queued"), eq(schema.queuedActions.projectSlug, nodeKey)));
    const sections: Dossier["sections"] = [];
    if (caps.length) sections.push({ heading: `Capabilities (${caps.length})`, items: caps.sort() });
    if (tools.length) sections.push({ heading: `Uses (${tools.length})`, items: tools.sort().slice(0, 40) });
    if (decisions.length) sections.push({ heading: `Decisions (${decisions.length})`, items: decisions });
    if (queued.length) sections.push({ heading: "Queued work", items: queued.map((q) => q.title) });
    const projGoals = await db.select().from(schema.capabilityGoals)
      .where(and(eq(schema.capabilityGoals.userId, user.id), eq(schema.capabilityGoals.status, "active"), eq(schema.capabilityGoals.projectSlug, nodeKey)));
    if (projGoals.length) sections.push({ heading: "Goals", items: projGoals.map((g) => g.label) });
    return {
      kind, title: node.label, subtitle: purpose,
      url: profile?.githubFullName ? `https://github.com/${profile.githubFullName}` : null,
      sections, note: anchoredNote, project: { slug: nodeKey },
    };
  }

  if (kind === "capability") {
    const usedIn: string[] = [];
    const adjacent: string[] = [];
    const fills: string[] = [];
    for (const e of edges) {
      if (e.kind === "HAS_CAPABILITY" && e.dstId === node.id) {
        const src = byId.get(e.srcId);
        const ed = j(e.data);
        const paths = Array.isArray(ed.paths) ? (ed.paths as string[]) : [];
        if (src) usedIn.push(`${src.label} · ${ed.provenance ?? "inferred"}${paths.length ? ` — ${paths.join(", ")}` : ""}`);
      }
      if (e.kind === "ADJACENT_TO" && (e.srcId === node.id || e.dstId === node.id)) {
        const other = byId.get(e.srcId === node.id ? e.dstId : e.srcId);
        if (other) adjacent.push(`${other.label}${e.weight != null ? ` (${e.weight.toFixed(2)})` : ""}`);
      }
      if (e.kind === "FILLS" && e.dstId === node.id) {
        const cand = byId.get(e.srcId);
        if (cand) fills.push(cand.label);
      }
    }
    const blindspot = fills.length === 0;
    const sections: Dossier["sections"] = [];
    if (usedIn.length) sections.push({ heading: `Used in (${usedIn.length})`, items: usedIn.sort() });
    if (fills.length) sections.push({ heading: "Filled by", items: fills });
    else sections.push({ heading: "Coverage", items: ["Blind spot — nothing has ever been evaluated against this capability. Blind-spot scouting searches it on the next pipeline run."] });
    if (adjacent.length) sections.push({ heading: "Adjacent capabilities", items: adjacent.slice(0, 8) });
    const mods = Array.isArray(data.modality) ? (data.modality as string[]) : [];
    const aliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : [];
    if (aliases.length) sections.push({ heading: "Also known as", items: aliases });
    return {
      kind, title: node.label,
      subtitle: [data.themeName ? `theme: ${data.themeName}` : null, data.waypoint ? "waypoint" : null, mods.length ? `modality: ${mods.join(", ")}` : null].filter(Boolean).join(" · ") || null,
      sections, blindspot, note: anchoredNote,
      capability: { label: node.label, provenance: usedIn.some((u) => u.includes("grounded")) ? "grounded" : null },
      queueSuggestion: blindspot ? `Find a library for "${node.label}" (coverage blind spot)` : null,
    };
  }

  if (kind === "candidate") {
    const fullName = String(data.fullName ?? node.label);
    const fillsC: string[] = [];
    for (const e of edges) {
      if (e.kind === "FILLS" && e.srcId === node.id) {
        const cap = byId.get(e.dstId);
        if (cap) fillsC.push(cap.label);
      }
    }
    // The decision log straight from triage_events — NOT the graph edges, so
    // project-less verdicts (the orphan-node case) show too, with the full
    // write-up the agent composed at triage time.
    const [owner, name] = fullName.split("/");
    const repoRow = owner && name ? await db.select({ id: schema.repos.id }).from(schema.repos)
      .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name))).get() : null;
    const decisions: NonNullable<Dossier["decisions"]> = [];
    if (repoRow) {
      const events = await db.select().from(schema.triageEvents)
        .where(and(eq(schema.triageEvents.userId, user.id), eq(schema.triageEvents.repoId, repoRow.id)));
      const latest = new Map<string, typeof events[number]>();
      for (const e of events) {
        const k = String(e.projectId ?? "g");
        const prev = latest.get(k);
        if (!prev || (e.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) latest.set(k, e);
      }
      const slugRows = await db.select({ id: schema.projectProfiles.id, slug: schema.projectProfiles.slug })
        .from(schema.projectProfiles).where(eq(schema.projectProfiles.userId, user.id));
      const slugById2 = new Map(slugRows.map((r) => [r.id, r.slug]));
      for (const e of [...latest.values()].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))) {
        decisions.push({
          verdict: e.verdict, score: e.score, effort: e.effortBand, reason: e.reasonCode,
          project: e.projectId != null ? slugById2.get(e.projectId) ?? "(unknown project)" : "(no project)",
          at: e.createdAt ? e.createdAt.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
          oneLine: e.oneLine, writeup: e.writeup,
        });
      }
    }
    const alts = await alternativesFor(fullName, 3).catch(() => []);
    const sections: Dossier["sections"] = [];
    if (fillsC.length) sections.push({ heading: "Fills", items: fillsC });
    if (alts.length) sections.push({ heading: "Similar maintained libraries", items: alts.map((a) => `${a.fullName}${a.stars ? ` · ${a.stars}★` : ""}${a.adoptedBy ? ` · adopted by ${a.adoptedBy}` : ""}`) });
    return {
      kind, title: fullName,
      subtitle: data.stars != null ? `${data.stars}★` : null,
      url: (data.url as string) ?? `https://github.com/${fullName}`,
      sections, note: anchoredNote, decisions,
    };
  }

  if (kind === "tool") {
    const usedBy: string[] = [];
    for (const e of edges) {
      if (e.kind === "USES" && e.dstId === node.id) {
        const proj = byId.get(e.srcId);
        const v = j(e.data).version;
        if (proj) usedBy.push(`${proj.label}${v ? ` @ ${v}` : ""}`);
      }
    }
    const overlay = await computeOverlay(user.id);
    const o = overlay.get(`tool ${node.nodeKey}`);
    const sections: Dossier["sections"] = [];
    if (usedBy.length) sections.push({ heading: `Used by (${usedBy.length})`, items: usedBy.sort() });
    if (o?.alerts?.length) sections.push({ heading: "Last 14 days", items: o.alerts.map((a) => `[${a.type}/${a.severity}] ${a.title}`) });
    const pref = await db.select().from(schema.toolPrefs)
      .where(and(eq(schema.toolPrefs.userId, user.id), eq(schema.toolPrefs.tool, node.nodeKey))).get();
    return {
      kind, title: node.label,
      subtitle: ["external tool / dependency", pref?.plan ? `plan: ${pref.plan}` : null, pref?.migrateOff ? "migrating off" : null].filter(Boolean).join(" · "),
      sections, note: anchoredNote,
      tool: { key: node.nodeKey, plan: pref?.plan ?? null, migrateOff: pref?.migrateOff ?? false },
      queueSuggestion: o?.alerts?.length ? `Review ${node.label}: ${o.alerts[0].title.slice(0, 80)}` : null,
    };
  }

  if (kind === "suggestion") {
    const fullName = String(data.fullName ?? node.label);
    const suggestedFor: string[] = [];
    const suggestedSlugs: string[] = [];
    for (const e of edges) {
      if (e.kind === "SUGGESTED" && e.dstId === node.id) {
        const proj = byId.get(e.srcId);
        const ed = j(e.data);
        if (proj) { suggestedFor.push(`${proj.label}${ed.status === "starred" ? " · ★ starred" : ""}`); suggestedSlugs.push(proj.nodeKey); }
      }
    }
    const projected = String(data.projected ?? "unknown");
    const alts = await alternativesFor(fullName, 3).catch(() => []);
    const sections: Dossier["sections"] = [
      { heading: "Suggested for", items: suggestedFor.length ? suggestedFor : ["—"] },
      {
        heading: `Projected: ${projected}`,
        items: ["Heuristic from language + licence fit — the real verdict comes from an in-session triage (run /replen in the repo). After triage this node graduates to a candidate with your verdict."],
      },
    ];
    if (alts.length) sections.push({ heading: "Similar maintained libraries", items: alts.map((a) => `${a.fullName}${a.stars ? ` · ${a.stars}★` : ""}${a.adoptedBy ? ` · adopted by ${a.adoptedBy}` : ""}`) });
    return {
      kind, title: fullName,
      subtitle: `suggested · projected ${projected}${data.stars != null ? ` · ${data.stars}★` : ""}`,
      url: (data.url as string) ?? `https://github.com/${fullName}`,
      sections, note: anchoredNote,
      suggestion: { fullName, projectSlug: suggestedSlugs[0] ?? null },
      queueSuggestion: `Triage suggestion ${fullName} (projected: ${projected})`,
    };
  }

  if (kind === "goal") {
    const goalId = Number(data.goalId ?? 0);
    const goalRow = goalId ? await db.select().from(schema.capabilityGoals)
      .where(and(eq(schema.capabilityGoals.id, goalId), eq(schema.capabilityGoals.userId, user.id))).get() : null;
    const sections: Dossier["sections"] = [
      { heading: "What this does", items: [
        "An aspirational capability: it boosts matches that advance it (never counts as 'covered'), and the scouted search hunts for it on every pipeline run.",
      ] },
    ];
    if (goalRow?.descriptor) sections.unshift({ heading: "Descriptor", items: [goalRow.descriptor] });
    return {
      kind, title: node.label,
      subtitle: ["goal", String(data.projectSlug ?? "portfolio-wide"), goalRow ? `since ${fmtDate(goalRow.createdAt.toISOString())}` : null].filter(Boolean).join(" · "),
      sections, note: anchoredNote,
      goal: goalRow ? { id: goalRow.id, status: goalRow.status } : undefined,
    };
  }

  if (kind === "product") {
    const members: string[] = [];
    for (const e of edges) {
      if (e.kind === "MEMBER_OF" && e.dstId === node.id) {
        const proj = byId.get(e.srcId);
        if (proj) members.push(proj.label);
      }
    }
    return { kind, title: node.label, subtitle: "multi-repo product", sections: [{ heading: "Repos", items: members.sort() }] };
  }

  return { kind, title: node.label, sections: [] };
}

export async function queueFromAtlas(title: string, projectSlug?: string | null): Promise<{ ok: boolean; id?: number }> {
  const user = await requireUser();
  const clean = title.trim().slice(0, 140);
  if (!clean) return { ok: false };
  const inserted = await db.insert(schema.queuedActions).values({
    userId: user.id, kind: "custom", refId: null, title: clean,
    note: "queued from the Atlas view", projectSlug: projectSlug ?? null,
    status: "queued", createdAt: new Date(),
  }).returning({ id: schema.queuedActions.id }).get();
  return { ok: true, id: inserted?.id };
}

// ── Atlas as input — judgment flowing back into the engine ──────────────────

// Star / dismiss a suggestion straight from the graph (same state machine the
// in-session skill drives via /api/state). The node graduates/disappears on
// the next graph rebuild.
export async function suggestionAction(fullName: string, action: "star" | "dismiss", projectSlug?: string | null): Promise<{ ok: boolean }> {
  const user = await requireUser();
  if (!/^[^/]+\/[^/]+$/.test(fullName)) return { ok: false };
  const [owner, name] = fullName.split("/");
  const repoId = await resolveOrCreateRepoId(owner, name);
  let projectId: number | null = null;
  if (projectSlug) {
    const p = await db.select({ id: schema.projectProfiles.id }).from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, projectSlug))).get();
    projectId = p?.id ?? null;
  }
  const status = action === "star" ? "starred" : "hidden";
  const now = new Date();
  const existing = await db.select().from(schema.userMatchState)
    .where(and(
      eq(schema.userMatchState.userId, user.id),
      eq(schema.userMatchState.repoId, repoId),
      projectId === null ? sql`${schema.userMatchState.projectId} IS NULL` : eq(schema.userMatchState.projectId, projectId),
    )).get();
  if (existing) {
    await db.update(schema.userMatchState).set({ status, actionAt: now })
      .where(eq(schema.userMatchState.id, existing.id));
  } else {
    await db.insert(schema.userMatchState).values({
      userId: user.id, repoId, projectId, status, actionAt: now, surfacedAt: now, surfacedCount: 1,
    });
  }
  rebuildAndRevalidate(user.id);
  return { ok: true };
}

// Plan/tier + migrate-off intent on a tool. Plan personalises the pricing
// watch; migrate-off mutes that vendor's release noise and marks the node.
export async function setToolPref(tool: string, pref: { plan?: string | null; migrateOff?: boolean }): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const key = tool.trim().toLowerCase().slice(0, 120);
  if (!key) return { ok: false };
  const now = new Date();
  const existing = await db.select().from(schema.toolPrefs)
    .where(and(eq(schema.toolPrefs.userId, user.id), eq(schema.toolPrefs.tool, key))).get();
  const plan = pref.plan !== undefined ? (pref.plan?.trim().slice(0, 60) || null) : existing?.plan ?? null;
  const migrateOff = pref.migrateOff !== undefined ? pref.migrateOff : existing?.migrateOff ?? false;
  if (existing) {
    await db.update(schema.toolPrefs).set({ plan, migrateOff, updatedAt: now }).where(eq(schema.toolPrefs.id, existing.id));
  } else {
    await db.insert(schema.toolPrefs).values({ userId: user.id, tool: key, plan, migrateOff, updatedAt: now });
  }
  rebuildAndRevalidate(user.id);
  return { ok: true };
}

// A goal: a capability the user WANTS. Embedded once; from then on it's an
// aspirational facet in matching, a scouted search term, and a graph node.
export async function addGoal(label: string, opts: { descriptor?: string; projectSlug?: string | null } = {}): Promise<{ ok: boolean; id?: number }> {
  const user = await requireUser();
  const clean = label.trim().slice(0, 120);
  if (!clean) return { ok: false };
  let embedding: string | null = null;
  try {
    const r = await embed(facetEmbeddingText(clean, opts.descriptor?.trim() || null));
    if (r) embedding = serialiseEmbedding(r.vector);
  } catch { /* goal still works keyword-wise; embedding backfills on edit */ }
  const inserted = await db.insert(schema.capabilityGoals).values({
    userId: user.id, projectSlug: opts.projectSlug ?? null, label: clean,
    descriptor: opts.descriptor?.trim().slice(0, 500) || null,
    status: "active", embedding, createdAt: new Date(),
  }).returning({ id: schema.capabilityGoals.id }).get();
  rebuildAndRevalidate(user.id);
  return { ok: true, id: inserted?.id };
}

export async function resolveGoal(id: number, outcome: "done" | "dropped"): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const row = await db.select({ id: schema.capabilityGoals.id }).from(schema.capabilityGoals)
    .where(and(eq(schema.capabilityGoals.id, id), eq(schema.capabilityGoals.userId, user.id))).get();
  if (!row) return { ok: false };
  await db.update(schema.capabilityGoals).set({ status: outcome, resolvedAt: new Date() })
    .where(eq(schema.capabilityGoals.id, id));
  rebuildAndRevalidate(user.id);
  return { ok: true };
}

// Capability curation: rename / merge / delete / confirm. Applied to the
// stored facets immediately AND persisted as a rule (capability_curations) so
// regeneration can't resurrect a deleted/renamed label.
const normCap = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export async function curateCapability(
  label: string,
  action: "delete" | "rename" | "merge" | "confirm",
  target?: string,
): Promise<{ ok: boolean; touched: number }> {
  const user = await requireUser();
  const key = normCap(label);
  if (!key) return { ok: false, touched: 0 };
  const targetClean = target?.trim().slice(0, 120);
  if ((action === "rename" || action === "merge") && !targetClean) return { ok: false, touched: 0 };

  // 1. Persist the rule (upsert by normalized label).
  await db.insert(schema.capabilityCurations)
    .values({ userId: user.id, normLabel: key, action, target: targetClean ?? null, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.capabilityCurations.userId, schema.capabilityCurations.normLabel],
      set: { action, target: targetClean ?? null },
    });

  // 2. Apply to every project's stored facets right now.
  const projects = await db.select().from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, user.id));
  let touched = 0;
  for (const p of projects) {
    const facets = parseStoredFacetEmbeddings(p.facetEmbeddings ?? null);
    if (!facets.length) continue;
    let changed = false;
    const next = [];
    for (const f of facets) {
      if (normCap(f.label) !== key) { next.push(f); continue; }
      changed = true;
      if (action === "delete") continue; // drop it
      if (action === "rename" || action === "merge") next.push({ ...f, label: targetClean! });
      if (action === "confirm") next.push({ ...f, provenance: "grounded" as const });
    }
    if (changed) {
      touched++;
      // Keep the stored hash so the facet cache stays coherent.
      let hash = "";
      try { hash = (JSON.parse(p.facetEmbeddings ?? "{}") as { hash?: string }).hash ?? ""; } catch { /* */ }
      await db.update(schema.projectProfiles)
        .set({ facetEmbeddings: serialiseFacetEmbeddings({ hash, facets: next }), updatedAt: new Date() })
        .where(eq(schema.projectProfiles.id, p.id));
    }
  }
  rebuildAndRevalidate(user.id);
  return { ok: true, touched };
}

// Anchored note on a node — flows into recall + the vault.
export async function setNodeNote(kind: string, nodeKey: string, note: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const clean = note.trim().slice(0, 2000);
  const k = kind.slice(0, 40);
  const nk2 = nodeKey.slice(0, 200);
  if (!k || !nk2) return { ok: false };
  if (!clean) {
    await db.delete(schema.nodeNotes)
      .where(and(eq(schema.nodeNotes.userId, user.id), eq(schema.nodeNotes.kind, k), eq(schema.nodeNotes.nodeKey, nk2)));
    return { ok: true };
  }
  await db.insert(schema.nodeNotes)
    .values({ userId: user.id, kind: k, nodeKey: nk2, note: clean, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.nodeNotes.userId, schema.nodeNotes.kind, schema.nodeNotes.nodeKey],
      set: { note: clean, updatedAt: new Date() },
    });
  return { ok: true };
}
