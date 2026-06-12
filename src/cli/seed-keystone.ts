// Seed Keystone from seeds/keystone/*.json — idempotent upsert of capabilities,
// solutions, and the fills / better_than edges between them. Embeds capability
// + solution text so a user's facet can later be matched to a Keystone
// capability. Re-run any time; small committed seeds, grows with each phase.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { db, schema } from "../db/client";
import { eq, and } from "drizzle-orm";
import { embed } from "../lib/embeddings";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Seed = {
  capabilities?: Array<{ label: string; domain?: string; parent?: string; modality?: string[] }>;
  solutions?: Array<{ kind: string; name: string; source?: string; description?: string; attributes?: Record<string, unknown> }>;
  better_than?: Array<{ winner: string; loser: string; task: string; metric?: string; margin?: number; source?: string }>;
};

async function upsertCapability(label: string, domain: string | null, modality: string[] | null): Promise<number> {
  const nl = norm(label);
  const existing = await db.select({ id: schema.keystoneCapabilities.id }).from(schema.keystoneCapabilities).where(eq(schema.keystoneCapabilities.normLabel, nl)).get();
  const emb = await embed(label).then((r) => r?.vector ?? null).catch(() => null);
  if (existing) {
    await db.update(schema.keystoneCapabilities).set({ label, domain, modality: modality ? JSON.stringify(modality) : null, embedding: emb ? JSON.stringify(emb) : undefined, updatedAt: new Date() }).where(eq(schema.keystoneCapabilities.id, existing.id));
    return existing.id;
  }
  const r = await db.insert(schema.keystoneCapabilities).values({ label, normLabel: nl, domain, modality: modality ? JSON.stringify(modality) : null, embedding: emb ? JSON.stringify(emb) : null, createdAt: new Date() }).returning({ id: schema.keystoneCapabilities.id }).get();
  return r.id;
}

async function upsertSolution(kind: string, name: string, source: string | null, description: string | null, attributes: Record<string, unknown> | undefined): Promise<number> {
  const nn = norm(name);
  const existing = await db.select({ id: schema.keystoneSolutions.id }).from(schema.keystoneSolutions).where(and(eq(schema.keystoneSolutions.kind, kind), eq(schema.keystoneSolutions.normName, nn))).get();
  // A PRACTICE's vector is its APPLICABILITY (description + the project signals
  // that indicate it fits), so shape-fit matching works — does a project's
  // profile look like a project that NEEDS this practice, regardless of domain.
  // A tool/model's vector is just name + description.
  const signals = (attributes?.signals as string[] | undefined) ?? [];
  const embedText = kind === "practice"
    ? `${description ?? name}${signals.length ? ` Signals a project needs this: ${signals.join(", ")}.` : ""}`
    : `${name}. ${description ?? ""}`;
  const emb = await embed(embedText).then((r) => r?.vector ?? null).catch(() => null);
  if (existing) {
    await db.update(schema.keystoneSolutions).set({ name, source, description, attributes: attributes ? JSON.stringify(attributes) : null, embedding: emb ? JSON.stringify(emb) : undefined, updatedAt: new Date() }).where(eq(schema.keystoneSolutions.id, existing.id));
    return existing.id;
  }
  const r = await db.insert(schema.keystoneSolutions).values({ kind, name, normName: nn, source, description, attributes: attributes ? JSON.stringify(attributes) : null, embedding: emb ? JSON.stringify(emb) : null, createdAt: new Date() }).returning({ id: schema.keystoneSolutions.id }).get();
  return r.id;
}

async function ensureEdge(fromKind: string, fromId: number, toKind: string, toId: number, kind: string, attributes: Record<string, unknown> | null, source: string): Promise<void> {
  const dup = await db.select({ id: schema.keystoneEdges.id }).from(schema.keystoneEdges)
    .where(and(eq(schema.keystoneEdges.fromKind, fromKind), eq(schema.keystoneEdges.fromId, fromId), eq(schema.keystoneEdges.toKind, toKind), eq(schema.keystoneEdges.toId, toId), eq(schema.keystoneEdges.kind, kind))).get();
  if (dup) {
    await db.update(schema.keystoneEdges).set({ attributes: attributes ? JSON.stringify(attributes) : null, source }).where(eq(schema.keystoneEdges.id, dup.id));
    return;
  }
  await db.insert(schema.keystoneEdges).values({ fromKind, fromId, toKind, toId, kind, attributes: attributes ? JSON.stringify(attributes) : null, source, createdAt: new Date() });
}

async function main() {
  const dir = join(process.cwd(), "seeds", "keystone");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const capId = new Map<string, number>();
  const solId = new Map<string, number>();
  for (const f of files) {
    const seed = JSON.parse(readFileSync(join(dir, f), "utf8")) as Seed;
    for (const c of seed.capabilities ?? []) capId.set(norm(c.label), await upsertCapability(c.label, c.domain ?? null, c.modality ?? null));
    // is-a edges (after all caps exist)
    for (const c of seed.capabilities ?? []) {
      if (c.parent && capId.has(norm(c.parent)) && capId.has(norm(c.label))) {
        await db.update(schema.keystoneCapabilities).set({ parentId: capId.get(norm(c.parent)) }).where(eq(schema.keystoneCapabilities.id, capId.get(norm(c.label))!));
        await ensureEdge("capability", capId.get(norm(c.label))!, "capability", capId.get(norm(c.parent))!, "is_a", null, "seed");
      }
    }
    for (const s of seed.solutions ?? []) {
      const id = await upsertSolution(s.kind, s.name, s.source ?? null, s.description ?? null, s.attributes);
      solId.set(norm(s.name), id);
      for (const cap of (s.attributes?.fills as string[] | undefined) ?? []) {
        if (capId.has(norm(cap))) await ensureEdge("solution", id, "capability", capId.get(norm(cap))!, "fills", null, "seed");
      }
    }
    for (const b of seed.better_than ?? []) {
      if (solId.has(norm(b.winner)) && solId.has(norm(b.loser))) {
        await ensureEdge("solution", solId.get(norm(b.winner))!, "solution", solId.get(norm(b.loser))!, "better_than", { task: b.task, metric: b.metric, margin: b.margin, source: b.source }, "benchmark");
      }
    }
  }
  const caps = await db.select().from(schema.keystoneCapabilities);
  const sols = await db.select().from(schema.keystoneSolutions);
  const edges = await db.select().from(schema.keystoneEdges);
  console.log(`Keystone seeded: ${caps.length} capabilities, ${sols.length} solutions, ${edges.length} edges`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
