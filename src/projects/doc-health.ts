// Per-project doc health probe. Walks the project root + docs/ subdir to
// build a file-level inventory (name, bytes, mtime), then scores how well
// Replen can read this project. Surfaces missing canonical files, thin
// files, and stale files (≥30d untouched) so the user can act on the gaps
// — typically by opening a docs PR back to their own repo.
//
// This is the richer cousin of assessDocSparsity in self-improvement.ts.
// Sparsity is a binary yes/no used to decide whether to auto-propose a
// handoff PR; DocHealth is the surface shown on /projects/[slug] so the
// user can see what Replen actually read and where the gaps are.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// 30 days. With modern AI-assisted dev cycles, a doc untouched for a month
// is a real signal that it's drifted from the code — not a 6-month "still
// fresh" window. User-tunable later if it turns out to be too aggressive.
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// A README under 500 chars is title + a sentence — not enough context.
// Same threshold the sparsity check uses; kept in sync deliberately.
export const THIN_README_CHARS = 500;

// Doc files we look for at the project root. Mirrors loader.ts but case-
// folded to match what users actually commit (README.md vs readme.md).
const ROOT_DOC_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "SPEC.md",
  "ARCHITECTURE.md",
  "DESIGN.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "PRODUCT_PLAN.md",
  "PLAN.md",
];
const AI_HANDOVER_NAMES = [
  "CLAUDE.md",
  "AGENTS.md",
  "HANDOVER.md",
  "HANDOFF.md",
  "GEMINI.md",
  "COPILOT.md",
  ".cursorrules",
  ".windsurfrules",
];

export type DocFile = {
  path: string; // relative to project root, POSIX-style
  bytes: number;
  mtimeMs: number;
  ageDays: number;
  stale: boolean;
};

export type DocHealth = {
  filesFound: DocFile[];
  hasReadme: boolean;
  readmeBytes: number;
  hasAiHandover: boolean; // any of CLAUDE/AGENTS/HANDOVER/etc.
  hasDocsDir: boolean; // ≥1 file in docs/
  docsDirFileCount: number;
  staleFiles: DocFile[]; // ≥30d untouched
  totalBytes: number;
  score: number; // 0-100
  scoreBreakdown: {
    readme: number; // /30
    aiHandover: number; // /25
    docsDir: number; // /20
    freshness: number; // /25
  };
  verdict: "excellent" | "good" | "needs-work" | "sparse";
  reasons: string[]; // human-readable gaps, used in banners
};

// Probes the filesystem under `projectPath` for canonical doc files and
// returns a complete health snapshot. Cheap enough to run per page-load —
// 1 readdir of root + 1 walk of docs/ capped at 50 files. No external
// network calls.
export async function assessDocHealth(projectPath: string): Promise<DocHealth> {
  const now = Date.now();
  const filesFound: DocFile[] = [];
  let readmeBytes = 0;
  let hasReadme = false;
  let hasAiHandover = false;

  // Root-level docs
  for (const name of [...ROOT_DOC_NAMES, ...AI_HANDOVER_NAMES]) {
    const file = await statIfExists(join(projectPath, name));
    if (!file) continue;
    const ageDays = (now - file.mtimeMs) / (24 * 60 * 60 * 1000);
    filesFound.push({
      path: name,
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
      ageDays,
      stale: now - file.mtimeMs > STALE_AFTER_MS,
    });
    if (/^readme\.md$/i.test(name)) {
      hasReadme = true;
      readmeBytes = Math.max(readmeBytes, file.bytes);
    }
    if (AI_HANDOVER_NAMES.includes(name)) {
      hasAiHandover = true;
    }
  }

  // docs/ subdir — only count .md files, capped to keep this bounded.
  const docsDirFiles = await walkDocsDir(join(projectPath, "docs"), 50);
  for (const f of docsDirFiles) {
    const ageDays = (now - f.mtimeMs) / (24 * 60 * 60 * 1000);
    filesFound.push({
      path: `docs/${f.relPath}`,
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      ageDays,
      stale: now - f.mtimeMs > STALE_AFTER_MS,
    });
  }
  const docsDirFileCount = docsDirFiles.length;
  const hasDocsDir = docsDirFileCount > 0;

  const staleFiles = filesFound.filter((f) => f.stale);
  const totalBytes = filesFound.reduce((s, f) => s + f.bytes, 0);

  // Scoring. Each component is a hard cutoff or a gradient.
  const readmeScore = hasReadme
    ? readmeBytes >= THIN_README_CHARS
      ? 30
      : Math.round((readmeBytes / THIN_README_CHARS) * 30) // gradient for thin readmes
    : 0;
  const aiHandoverScore = hasAiHandover ? 25 : 0;
  const docsDirScore = hasDocsDir ? (docsDirFileCount >= 3 ? 20 : Math.round((docsDirFileCount / 3) * 20)) : 0;
  // Freshness: 25 if no stale files OR no files at all (don't double-penalise
  // — missing files already cost points above). Gradient down to 0 when
  // every found file is stale.
  const freshnessScore =
    filesFound.length === 0
      ? 0
      : staleFiles.length === 0
        ? 25
        : Math.round(25 * (1 - staleFiles.length / filesFound.length));

  const score = readmeScore + aiHandoverScore + docsDirScore + freshnessScore;
  const verdict: DocHealth["verdict"] =
    score >= 80 ? "excellent" : score >= 60 ? "good" : score >= 40 ? "needs-work" : "sparse";

  const reasons: string[] = [];
  if (!hasReadme) reasons.push("no README.md");
  else if (readmeBytes < THIN_README_CHARS) reasons.push(`README is only ${readmeBytes} chars`);
  if (!hasAiHandover) reasons.push("no CLAUDE.md / AGENTS.md");
  if (!hasDocsDir) reasons.push("no docs/ section");
  if (staleFiles.length > 0) {
    const oldest = staleFiles.reduce((a, b) => (a.ageDays > b.ageDays ? a : b));
    reasons.push(
      `${staleFiles.length} stale doc${staleFiles.length === 1 ? "" : "s"} (oldest: ${oldest.path}, ${Math.round(oldest.ageDays)}d)`,
    );
  }

  return {
    filesFound,
    hasReadme,
    readmeBytes,
    hasAiHandover,
    hasDocsDir,
    docsDirFileCount,
    staleFiles,
    totalBytes,
    score,
    scoreBreakdown: {
      readme: readmeScore,
      aiHandover: aiHandoverScore,
      docsDir: docsDirScore,
      freshness: freshnessScore,
    },
    verdict,
    reasons,
  };
}

async function statIfExists(absPath: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return null;
    return { bytes: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

// Walks docs/ recursively, returning .md files only. Skips node_modules and
// other dotdirs. Caps total file count to bound the walk.
async function walkDocsDir(
  docsDirPath: string,
  cap: number,
): Promise<Array<{ relPath: string; bytes: number; mtimeMs: number }>> {
  const out: Array<{ relPath: string; bytes: number; mtimeMs: number }> = [];
  async function walk(rel: string) {
    if (out.length >= cap) return;
    const abs = rel ? join(docsDirPath, rel) : docsDirPath;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(md|mdx)$/i.test(e.name)) continue;
      const s = await statIfExists(join(docsDirPath, childRel));
      if (s) out.push({ relPath: childRel, bytes: s.bytes, mtimeMs: s.mtimeMs });
    }
  }
  await walk("");
  return out;
}
