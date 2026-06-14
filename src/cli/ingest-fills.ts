// Workstream B, fills slice (#5): populate Keystone `fills` edges (solution →
// capability) from the catalogue's capability classification, so the "covered"
// down-rank (#1) actually fires. A dep the user has that `fills` capability X
// makes a NEW candidate for X redundant — but coveredCapabilities() can only see
// that if the fills edge exists. We bootstrap those edges from the deps the
// portfolio actually uses that the catalogue already classified (bounded — we do
// NOT dump all 4243 catalogue repos into Keystone; only real, used deps).
//
// Public facts (package → capability), no user code. Idempotent; source='ingested'.
// Usage: ssh prod-server 'cd /opt/replen && node --env-file=.env --import=tsx src/cli/ingest-fills.ts [--dry]'

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { parseDepVersionNames } from "../fetchers/stack-watch/registry";

const DRY = process.argv.includes("--dry");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function upsertCapability(label: string): Promise<number> {
  const nl = norm(label);
  const ex = await db.select({ id: schema.keystoneCapabilities.id }).from(schema.keystoneCapabilities)
    .where(eq(schema.keystoneCapabilities.normLabel, nl)).get();
  if (ex) return ex.id;
  const row = await db.insert(schema.keystoneCapabilities)
    .values({ label, normLabel: nl, createdAt: new Date() }).returning({ id: schema.keystoneCapabilities.id }).get();
  return row.id;
}
async function upsertSolution(name: string): Promise<number> {
  const nn = norm(name);
  const ex = await db.select({ id: schema.keystoneSolutions.id }).from(schema.keystoneSolutions)
    .where(and(eq(schema.keystoneSolutions.kind, "library"), eq(schema.keystoneSolutions.normName, nn))).get();
  if (ex) return ex.id;
  const row = await db.insert(schema.keystoneSolutions)
    .values({ kind: "library", name, normName: nn, source: "ingested", createdAt: new Date() }).returning({ id: schema.keystoneSolutions.id }).get();
  return row.id;
}
async function fillsExists(solId: number, capId: number): Promise<boolean> {
  const e = await db.select({ id: schema.keystoneEdges.id }).from(schema.keystoneEdges)
    .where(and(eq(schema.keystoneEdges.kind, "fills"), eq(schema.keystoneEdges.fromId, solId), eq(schema.keystoneEdges.toId, capId))).get();
  return !!e;
}

async function main() {
  // user deps (Node names from depVersions)
  const profs = await db.select({ dv: schema.projectProfiles.depVersions }).from(schema.projectProfiles);
  const deps = new Set<string>();
  for (const p of profs) for (const d of parseDepVersionNames(p.dv ?? null)) deps.add(d.toLowerCase());

  // catalogue rows for those deps that carry capability classifications
  const rows = await db.select({ name: schema.catalogueRepos.name, caps: schema.catalogueRepos.capabilities })
    .from(schema.catalogueRepos)
    .where(sql`lower(${schema.catalogueRepos.name}) IN (${sql.join([...deps].map((d) => sql`${d}`), sql`, `)})`);

  console.log(`\n# B/fills — catalogue capabilities → Keystone fills edges${DRY ? " (DRY)" : ""}`);
  let pairs = 0, added = 0, hadAlready = 0, caps = 0;
  for (const r of rows) {
    let labels: string[] = [];
    try { labels = r.caps ? (JSON.parse(r.caps) as string[]).filter((x) => typeof x === "string") : []; } catch { /* */ }
    for (const label of labels) {
      if (!label.trim()) continue;
      pairs++;
      if (DRY) { added++; continue; }
      const capId = await upsertCapability(label);
      const solId = await upsertSolution(r.name);
      if (await fillsExists(solId, capId)) { hadAlready++; continue; }
      await db.insert(schema.keystoneEdges).values({
        fromKind: "solution", fromId: solId, toKind: "capability", toId: capId, kind: "fills",
        weight: null, attributes: null, source: "ingested", createdAt: new Date(),
      });
      added++;
    }
  }
  console.log(`Summary: ${rows.length} deps matched the catalogue · ${pairs} (dep,capability) pairs · ${added} fills edges added${hadAlready ? ` · ${hadAlready} already present` : ""}.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
