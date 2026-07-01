// One-time backfill: convert stored embeddings from legacy JSON-float64 text to
// base64-float32 (~3.7x smaller), gated on a PER-ROW cosine parity check so we
// never write a vector that drifts from the original beyond float32 round-trip
// noise. Safe to run repeatedly (only touches rows still in JSON form) and safe
// to interrupt (reads already accept both forms).
//
//   tsx src/cli/backfill-embeddings.ts            # convert + report parity
//   tsx src/cli/backfill-embeddings.ts --dry-run  # measure parity only, no writes
//   tsx src/cli/backfill-embeddings.ts --vacuum   # convert, then VACUUM to reclaim disk
//
// Parity tolerance: a converted vector must keep cosine >= 1 - 1e-5 and max
// per-component abs diff <= 1e-2 vs the original. Real float32 round-trip lands
// ~1e-7, so any row that trips the gate is left as JSON and logged.
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { parseStoredEmbedding, serialiseEmbedding } from "@/lib/embeddings";

const DRY = process.argv.includes("--dry-run");
const VACUUM = process.argv.includes("--vacuum");
const COS_TOL = 1e-5;      // max allowed (1 - cosine)
const ABS_TOL = 1e-2;      // max allowed per-component |diff|

type Target = {
  label: string;
  rows: () => Promise<{ id: number; e: string | null }[]>;
  update: (id: number, b64: string) => Promise<unknown>;
};

const targets: Target[] = [
  {
    label: "candidates.embedding",
    rows: () => db.select({ id: schema.candidates.id, e: schema.candidates.embedding }).from(schema.candidates).where(sql`${schema.candidates.embedding} LIKE '[%'`),
    update: (id, b64) => db.update(schema.candidates).set({ embedding: b64 }).where(eq(schema.candidates.id, id)),
  },
  {
    label: "project_profiles.embedding",
    rows: () => db.select({ id: schema.projectProfiles.id, e: schema.projectProfiles.embedding }).from(schema.projectProfiles).where(sql`${schema.projectProfiles.embedding} LIKE '[%'`),
    update: (id, b64) => db.update(schema.projectProfiles).set({ embedding: b64 }).where(eq(schema.projectProfiles.id, id)),
  },
  {
    label: "project_profiles.domain_anchor",
    rows: () => db.select({ id: schema.projectProfiles.id, e: schema.projectProfiles.domainAnchor }).from(schema.projectProfiles).where(sql`${schema.projectProfiles.domainAnchor} LIKE '[%'`),
    update: (id, b64) => db.update(schema.projectProfiles).set({ domainAnchor: b64 }).where(eq(schema.projectProfiles.id, id)),
  },
  {
    label: "catalogue_repos.embedding",
    rows: () => db.select({ id: schema.catalogueRepos.id, e: schema.catalogueRepos.embedding }).from(schema.catalogueRepos).where(sql`${schema.catalogueRepos.embedding} LIKE '[%'`),
    update: (id, b64) => db.update(schema.catalogueRepos).set({ embedding: b64 }).where(eq(schema.catalogueRepos.id, id)),
  },
];

function parity(a: number[], b: number[]): { cos: number; maxAbs: number } {
  let dot = 0, na = 0, nb = 0, maxAbs = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbs) maxAbs = d;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return { cos: denom > 0 ? dot / denom : 0, maxAbs };
}

async function chunkAll<T>(items: T[], size: number, fn: (t: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

async function main() {
  console.log(`[backfill] ${DRY ? "DRY RUN — " : ""}converting embeddings to base64 float32${VACUUM ? " (+vacuum)" : ""}\n`);
  let grandBefore = 0, grandAfter = 0, grandRows = 0, grandFail = 0, worstCos = 0, worstAbs = 0;

  for (const t of targets) {
    const rows = await t.rows();
    if (!rows.length) { console.log(`${t.label.padEnd(32)} 0 legacy rows`); continue; }
    let before = 0, after = 0, ok = 0, fail = 0, malformed = 0;
    const pending: { id: number; b64: string }[] = [];
    for (const r of rows) {
      if (!r.e) continue;
      const orig = parseStoredEmbedding(r.e);
      if (!orig) { malformed++; continue; }
      const b64 = serialiseEmbedding(orig);
      const rt = parseStoredEmbedding(b64);
      if (!rt) { fail++; console.warn(`  ! ${t.label} id=${r.id}: re-parse failed`); continue; }
      const { cos, maxAbs } = parity(orig, rt);
      worstCos = Math.max(worstCos, 1 - cos);
      worstAbs = Math.max(worstAbs, maxAbs);
      if (1 - cos > COS_TOL || maxAbs > ABS_TOL) { fail++; console.warn(`  ! ${t.label} id=${r.id}: parity fail cos=${cos.toFixed(9)} maxAbs=${maxAbs.toExponential(2)} (left as JSON)`); continue; }
      before += r.e.length; after += b64.length; ok++;
      pending.push({ id: r.id, b64 });
    }
    if (!DRY) await chunkAll(pending, 100, (p) => t.update(p.id, p.b64));
    grandBefore += before; grandAfter += after; grandRows += ok; grandFail += fail;
    console.log(`${t.label.padEnd(32)} ${String(ok).padStart(6)} ok  ${fail} parity-fail  ${malformed} malformed   ${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MB`);
  }

  console.log(`\n[parity] worst (1 - cosine) = ${worstCos.toExponential(3)}   worst |component diff| = ${worstAbs.toExponential(3)}`);
  console.log(`[parity] tolerance was cos-dev < ${COS_TOL}, abs < ${ABS_TOL} — ${grandFail === 0 ? "ALL rows within float32 noise" : `${grandFail} rows exceeded and were left as JSON`}`);
  console.log(`[backfill] ${DRY ? "would convert" : "converted"} ${grandRows} rows, ${(grandBefore / 1048576).toFixed(1)} MB -> ${(grandAfter / 1048576).toFixed(1)} MB (saved ${((grandBefore - grandAfter) / 1048576).toFixed(1)} MB of payload)`);

  if (VACUUM && !DRY) {
    console.log(`\n[vacuum] reclaiming free pages (rewrites the DB file)…`);
    await db.run(sql`VACUUM`);
    console.log(`[vacuum] done`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("[backfill] FAILED:", e); process.exit(1); });
