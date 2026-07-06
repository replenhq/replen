// Field-quality audit across ALL users' active projects. Read-only. Answers the
// question the matcher actually depends on: for every repo, is each grounding
// field POPULATED, CORRECT (domain signal, not just stack), and RICH (descriptors
// + modality, not bare tags)? Prints aggregates + the worst offenders so we know
// what to backfill and where the domain signal really lives.
//
// Usage (host):  ssh your-host 'cd /opt/replen && set -a && . ./.env && set +a && npx tsx src/cli/audit-project-fields.ts'

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";

// Stack/infra tokens — if a project's "domain cloud" is mostly these, it's a
// STACK list (auto-detected at registration), not the domain. Deliberately
// broad; matched on normalised token equality + substring.
const STACK = new Set([
  "python", "typescript", "javascript", "js", "ts", "node", "nodejs", "node.js",
  "fastapi", "flask", "django", "next", "nextjs", "next.js", "react", "vue",
  "svelte", "angular", "express", "nestjs", "rails", "go", "golang", "rust",
  "java", "kotlin", "swift", "php", "laravel", "spring",
  "postgres", "postgresql", "sqlite", "mysql", "redis", "mongodb", "libsql",
  "openai", "anthropic", "deepseek", "llm", "firebase", "supabase",
  "aws", "gcp", "azure", "docker", "kubernetes", "k8s", "vercel", "cloudflare",
  "tailwind", "tailwindcss", "drizzle", "prisma", "sqlalchemy", "graphql",
  "rest", "api", "html", "css", "sass", "webpack", "vite", "esbuild",
]);
const norm = (s: string) => s.trim().toLowerCase();
const isStack = (t: string) => { const n = norm(t); return STACK.has(n) || [...STACK].some((s) => n === s); };

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "—");

async function main() {
  const rows = await db
    .select({
      slug: schema.projectProfiles.slug, userId: schema.projectProfiles.userId,
      tags: schema.projectProfiles.tags, summaryJson: schema.projectProfiles.summaryJson,
      facetEmbeddings: schema.projectProfiles.facetEmbeddings, embedding: schema.projectProfiles.embedding,
      depVersions: schema.projectProfiles.depVersions, readmeMd: schema.projectProfiles.readmeMd,
      claudeMd: schema.projectProfiles.claudeMd,
    })
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.active, true));

  type Row = {
    slug: string; user: number; hasSummary: boolean; hasPurpose: boolean;
    keyCaps: number; caps: number; capsDesc: number; capsMod: number;
    tagsN: number; domainTags: number; stackTags: number; stackDominated: boolean;
    facets: boolean; centroid: boolean; versions: boolean; readmeLen: number; claude: boolean;
  };
  const out: Row[] = [];
  for (const r of rows) {
    let purpose = "", keyCaps = 0, caps = 0, capsDesc = 0, capsMod = 0, hasSummary = false;
    try {
      const s = r.summaryJson ? JSON.parse(r.summaryJson) : null;
      if (s) {
        hasSummary = true;
        purpose = typeof s.purpose === "string" ? s.purpose.trim() : "";
        keyCaps = arr(s.keyCapabilities).length;
        const cs = arr(s.capabilities) as Array<{ descriptor?: string; modality?: unknown[] }>;
        caps = cs.length;
        capsDesc = cs.filter((c) => typeof c?.descriptor === "string" && c.descriptor.trim().length > 0).length;
        capsMod = cs.filter((c) => Array.isArray(c?.modality) && c.modality.length > 0).length;
      }
    } catch { /* malformed */ }
    let tagsArr: string[] = [];
    try { const t = r.tags ? JSON.parse(r.tags) : null; if (Array.isArray(t)) tagsArr = t.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
    const stackTags = tagsArr.filter(isStack).length;
    const domainTags = tagsArr.length - stackTags;
    out.push({
      slug: r.slug ?? "?", user: r.userId ?? 0, hasSummary, hasPurpose: purpose.length > 0,
      keyCaps, caps, capsDesc, capsMod,
      tagsN: tagsArr.length, domainTags, stackTags, stackDominated: tagsArr.length > 0 && stackTags / tagsArr.length >= 0.6,
      facets: !!r.facetEmbeddings, centroid: !!r.embedding, versions: !!r.depVersions,
      readmeLen: (r.readmeMd ?? "").length, claude: !!(r.claudeMd ?? "").trim(),
    });
  }

  const N = out.length;
  const c = (f: (r: Row) => boolean) => out.filter(f).length;
  const sum = (f: (r: Row) => number) => out.reduce((a, r) => a + f(r), 0);
  const users = new Set(out.map((r) => r.user)).size;

  console.log(`\n# Project field-quality audit — ${N} active projects across ${users} user(s)\n`);
  console.log(`## Populated?`);
  console.log(`- summary present:        ${c((r) => r.hasSummary)}/${N}  (${pct(c((r) => r.hasSummary), N)})`);
  console.log(`- purpose non-empty:      ${c((r) => r.hasPurpose)}/${N}  (${pct(c((r) => r.hasPurpose), N)})`);
  console.log(`- tags present:           ${c((r) => r.tagsN > 0)}/${N}  (${pct(c((r) => r.tagsN > 0), N)})`);
  console.log(`- facet vectors present:  ${c((r) => r.facets)}/${N}  (${pct(c((r) => r.facets), N)})`);
  console.log(`- centroid present:       ${c((r) => r.centroid)}/${N}  (${pct(c((r) => r.centroid), N)})`);
  console.log(`- dep_versions present:   ${c((r) => r.versions)}/${N}  (${pct(c((r) => r.versions), N)})`);

  console.log(`\n## Correct? (domain signal vs stack pollution)`);
  console.log(`- tags STACK-DOMINATED (≥60% stack): ${c((r) => r.stackDominated)}/${N}  (${pct(c((r) => r.stackDominated), N)})  ← these have no usable domain cloud`);
  console.log(`- tags with ZERO domain terms:       ${c((r) => r.tagsN > 0 && r.domainTags === 0)}/${N}`);
  console.log(`- avg domain tags / project:         ${(sum((r) => r.domainTags) / Math.max(1, N)).toFixed(1)}`);

  console.log(`\n## Rich? (descriptors + modality, not bare)`);
  const withCaps = out.filter((r) => r.caps > 0);
  console.log(`- projects with ≥1 capability:        ${withCaps.length}/${N}`);
  console.log(`- capabilities total:                 ${sum((r) => r.caps)}  (avg ${(sum((r) => r.caps) / Math.max(1, withCaps.length)).toFixed(1)}/project)`);
  console.log(`- capabilities WITH a descriptor:     ${sum((r) => r.capsDesc)}/${sum((r) => r.caps)}  (${pct(sum((r) => r.capsDesc), sum((r) => r.caps))})  ← bare facets are the collision surface`);
  console.log(`- capabilities WITH a modality:       ${sum((r) => r.capsMod)}/${sum((r) => r.caps)}  (${pct(sum((r) => r.capsMod), sum((r) => r.caps))})`);

  console.log(`\n## Worst offenders (stack-dominated tags OR no descriptors OR thin docs)`);
  const bad = out
    .map((r) => {
      const problems: string[] = [];
      if (r.stackDominated || (r.tagsN > 0 && r.domainTags === 0)) problems.push(`tags=stack(${r.stackTags}/${r.tagsN})`);
      if (r.tagsN === 0) problems.push("NO tags");
      if (r.caps > 0 && r.capsDesc === 0) problems.push("0 descriptors");
      if (!r.hasPurpose) problems.push("no purpose");
      if (!r.facets) problems.push("no facets");
      if (r.readmeLen < 300 && !r.claude) problems.push(`thin docs(readme=${r.readmeLen})`);
      return { slug: r.slug, user: r.user, problems };
    })
    .filter((r) => r.problems.length > 0)
    .sort((a, b) => b.problems.length - a.problems.length);
  for (const b of bad.slice(0, 40)) console.log(`  u${b.user} ${b.slug.padEnd(34)} ${b.problems.join(", ")}`);
  console.log(`\n  (${bad.length}/${N} projects have ≥1 field-quality problem)\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
