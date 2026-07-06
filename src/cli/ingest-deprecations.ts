// Workstream B, first slice (#5): grow Keystone `better_than` from PUBLIC data
// instead of hand-seeding. The npm registry exposes a per-version `deprecated`
// message, and maintainers routinely name the successor ("use X instead",
// "replaced by Y"). We read those for the packages the portfolio actually uses,
// parse the successor CONSERVATIVELY, verify it resolves, and upsert a
// `better_than` edge (successor ▸ deprecated) with source="ingested".
//
// Public data only (registry.npmjs.org) — no user code leaves the machine; the
// edges are facts about packages, not user data. Idempotent + reversible
// (delete where source='ingested'). Cross-user-safe: Keystone is global.
//
// Usage:
//   ssh your-host 'cd /opt/replen && node --env-file=.env --import=tsx src/cli/ingest-deprecations.ts'
//   …optionally  --packages lodash,request,@hapi/joi   --limit 400   --dry

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { parseDepVersionNames } from "../fetchers/stack-watch/registry";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes("--dry");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const looksLikePkg = (s: string) => /^@?[a-z0-9][a-z0-9._/-]{1,100}$/.test(s) && !s.includes(" ");

// Conservative successor extraction from a deprecation message.
function parseSuccessor(msg: string, self: string): string | null {
  const pats = [
    // "use X instead" / "use X package instead" (allow up to 3 words between)
    /\b(?:use|install)\s+`?([@a-z0-9][@a-z0-9._/-]*)`?(?:\s+[a-z]+){0,3}\s+instead\b/i,
    /\b(?:replaced|superseded)\s+by\s+`?([@a-z0-9][@a-z0-9._/-]*)`?/i,
    /\b(?:migrate|switch|moved)\s+to\s+`?([@a-z0-9][@a-z0-9._/-]*)`?/i,
  ];
  for (const p of pats) {
    const m = msg.match(p);
    if (m && m[1]) {
      const cand = m[1].replace(/[.,]$/, "");
      if (looksLikePkg(cand) && norm(cand) !== norm(self)) return cand;
    }
  }
  return null;
}

type Reg = { "dist-tags"?: { latest?: string }; versions?: Record<string, { deprecated?: string | boolean }>; deprecated?: string };
async function fetchPkg(name: string): Promise<Reg | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return (await r.json()) as Reg;
  } catch { return null; }
}
function deprecationMsg(reg: Reg): string | null {
  const latest = reg["dist-tags"]?.latest;
  const v = latest && reg.versions ? reg.versions[latest] : undefined;
  const d = v?.deprecated ?? reg.deprecated;
  return typeof d === "string" && d.trim().length > 3 ? d.trim() : null;
}

async function upsertSolution(name: string, desc: string | null): Promise<number> {
  const nn = norm(name);
  const existing = await db.select({ id: schema.keystoneSolutions.id })
    .from(schema.keystoneSolutions)
    .where(and(eq(schema.keystoneSolutions.kind, "library"), eq(schema.keystoneSolutions.normName, nn))).get();
  if (existing) return existing.id;
  const row = await db.insert(schema.keystoneSolutions)
    .values({ kind: "library", name, normName: nn, source: "ingested", description: desc, createdAt: new Date() })
    .returning({ id: schema.keystoneSolutions.id }).get();
  return row.id;
}
async function edgeExists(fromId: number, toId: number): Promise<boolean> {
  const e = await db.select({ id: schema.keystoneEdges.id }).from(schema.keystoneEdges)
    .where(and(eq(schema.keystoneEdges.kind, "better_than"), eq(schema.keystoneEdges.fromId, fromId), eq(schema.keystoneEdges.toId, toId))).get();
  return !!e;
}

async function main() {
  // Package list: explicit --packages, else the Node deps the portfolio uses.
  let pkgs: string[];
  if (arg("packages")) {
    pkgs = arg("packages")!.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const profs = await db.select({ dv: schema.projectProfiles.depVersions }).from(schema.projectProfiles);
    const set = new Set<string>();
    for (const p of profs) for (const d of parseDepVersionNames(p.dv ?? null)) if (looksLikePkg(d)) set.add(d);
    pkgs = [...set];
  }
  const limit = parseInt(arg("limit") ?? "500", 10);
  pkgs = pkgs.slice(0, limit);
  console.log(`\n# B/slice-1 — npm deprecation → Keystone better_than${DRY ? " (DRY RUN)" : ""}`);
  console.log(`Checking ${pkgs.length} packages…\n`);

  let deprecated = 0, withSuccessor = 0, edgesAdded = 0, alreadyHad = 0;
  const BATCH = 10;
  for (let i = 0; i < pkgs.length; i += BATCH) {
    const batch = pkgs.slice(i, i + BATCH);
    const regs = await Promise.all(batch.map(fetchPkg));
    for (let j = 0; j < batch.length; j++) {
      const name = batch[j], reg = regs[j];
      if (!reg) continue;
      const msg = deprecationMsg(reg);
      if (!msg) continue;
      deprecated++;
      const succ = parseSuccessor(msg, name);
      if (!succ) { console.log(`  · ${name}: deprecated, no parseable successor — "${msg.slice(0, 70)}"`); continue; }
      const succReg = await fetchPkg(succ);
      if (!succReg || deprecationMsg(succReg)) { console.log(`  · ${name} → ${succ}: successor unresolved/also-deprecated, skipping`); continue; }
      withSuccessor++;
      if (DRY) { console.log(`  ✓ ${succ}  better_than  ${name}   (dry)`); edgesAdded++; continue; }
      const loserId = await upsertSolution(name, `deprecated: ${msg.slice(0, 140)}`);
      const winnerId = await upsertSolution(succ, null);
      if (await edgeExists(winnerId, loserId)) { alreadyHad++; continue; }
      await db.insert(schema.keystoneEdges).values({
        fromKind: "solution", fromId: winnerId, toKind: "solution", toId: loserId, kind: "better_than",
        weight: null, attributes: JSON.stringify({ task: "general", source: `npm-deprecation: ${msg.slice(0, 160)}` }),
        source: "ingested", createdAt: new Date(),
      });
      edgesAdded++;
      console.log(`  ✓ ${succ}  better_than  ${name}`);
    }
  }
  console.log(`\nSummary: ${pkgs.length} checked · ${deprecated} deprecated · ${withSuccessor} with resolved successor · ${edgesAdded} edges added${alreadyHad ? ` · ${alreadyHad} already present` : ""}.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
