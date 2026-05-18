import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";

// Options for discoverLocalProjects. Adds the per-user "extra doc paths"
// feature: globs, relative to each project root, that point at additional
// docs to fold into the profile. Defaults still apply; this just augments.
export type DiscoverOpts = {
  extraDocPaths?: string[]; // glob patterns: "docs/*.md", "SPEC/**/*.md"
  extraDocsBudget?: number; // max files per pattern (default 5)
  extraDocCharLimit?: number; // max chars per file (default 20000)
};

export type LocalProject = {
  slug: string;
  path: string;
  name: string;
  readmeMd: string | null;
  claudeMd: string | null;
  techSummary: string | null;
  profileHash: string;
  active: boolean;
  included?: boolean;
  sensitivity?: "low" | "high";
  llmProvider?: "auto" | "deepseek" | "anthropic";
};

const DOC_NAMES = [
  // Conventional readmes first
  "README.md", "Readme.md", "readme.md", "README.MD",
  // Architectural / design docs
  "SPEC.md", "Spec.md", "spec.md",
  "DESIGN.md", "design.md",
  "ARCHITECTURE.md", "Architecture.md", "architecture.md",
  // Plans / roadmaps (lowest priority - used only if nothing else)
  "PRODUCT_PLAN.md", "PLAN.md", "plan.md",
  "roadmap.md", "ROADMAP.md", "Roadmap.md",
  "ACTION-PLAN.md", "ACTION_PLAN.md", "action-plan.md",
  "AUDIT.md", "AUDIT-REPORT.md", "FULL-AUDIT-REPORT.md",
  "NOTES.md", "OVERVIEW.md",
];
const CLAUDE_NAMES = ["CLAUDE.md", "Claude.md", "claude.md"];
const MANIFEST_NAMES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "requirements.txt"];

// Auto-included aux doc patterns. Applied to every project regardless of the
// user's extra_doc_paths setting — these are the "free win" defaults that give
// the LLM more context for docs-heavy projects without anyone configuring
// anything. Subject to the same per-pattern file count cap + char limit as
// user-configured extras. The user can still narrow these by setting
// extra_doc_paths to something specific (their patterns are appended, not
// replaced), or widen by adding e.g. "spec/**/*.md".
const DEFAULT_AUX_PATTERNS = ["docs/**/*.md"];

export async function discoverLocalProjects(root: string, opts: DiscoverOpts = {}): Promise<LocalProject[]> {
  const entries = await readdir(root, { withFileTypes: true });
  // User-configured extras come AFTER defaults so a user can extend the
  // auto-included set without losing it. Setting extra_doc_paths to e.g.
  // "spec/**/*.md" supplements rather than overrides.
  const userPatterns = (opts.extraDocPaths ?? []).map((s) => s.trim()).filter(Boolean);
  const allPatterns = [...DEFAULT_AUX_PATTERNS, ...userPatterns];
  const out: LocalProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const path = join(root, e.name);
    const docMd = await readFirstExisting(path, DOC_NAMES);
    const claudeMdRaw = await readFirstExisting(path, CLAUDE_NAMES);
    const extraDocs = allPatterns.length > 0
      ? await collectExtraDocs(path, allPatterns, opts.extraDocsBudget ?? 8, opts.extraDocCharLimit ?? 20_000)
      : [];
    // Fold extra docs into the claudeMd field so they ride through to the
    // reasoner without needing a new column. The separator banner stays in
    // place so the LLM can tell what's user-authored vs auto-included.
    const claudeMd = mergeExtraIntoClaudeMd(claudeMdRaw, extraDocs);
    const techSummary = await summarizeTech(path);
    // Discover the project if we have ANY of: a doc file, a CLAUDE.md, or a manifest.
    const hasManifest = await anyExists(path, MANIFEST_NAMES);
    if (!docMd && !claudeMd && !hasManifest) continue;
    const profile = `${docMd ?? ""}\n---\n${claudeMd ?? ""}\n---\n${techSummary ?? ""}`;
    const profileHash = createHash("sha1").update(profile).digest("hex");
    out.push({
      slug: e.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
      path,
      name: e.name,
      readmeMd: docMd,
      claudeMd,
      techSummary,
      profileHash,
      active: claudeMd !== null,
    });
  }
  return out;
}

function mergeExtraIntoClaudeMd(claudeMd: string | null, extras: Array<{ path: string; content: string }>): string | null {
  if (extras.length === 0) return claudeMd;
  const block = extras
    .map((d) => `\n\n# === extra-doc: ${d.path} ===\n${d.content}`)
    .join("");
  return (claudeMd ?? "") + block;
}

// Translate a simple glob to a regex. Supports "*" (no slash) and "**"
// (any depth). Other regex metacharacters are escaped. Patterns are matched
// against POSIX-style paths relative to the project root.
function globToRegex(glob: string): RegExp {
  // NUL is fine here because globs can never legitimately contain raw NUL.
  // Empty string would build a regex with .* between every char.
  const placeholder = "\u0000";
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, placeholder)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(placeholder, "g"), ".*");
  return new RegExp("^" + escaped + "$");
}

async function collectExtraDocs(
  projectRoot: string,
  patterns: string[],
  perPatternCap: number,
  charLimit: number,
): Promise<Array<{ path: string; content: string }>> {
  const collected: Array<{ path: string; content: string }> = [];
  const regexes = patterns.map(globToRegex);
  // One walk of the tree, gated by perPatternCap counts.
  const counts: number[] = new Array(patterns.length).fill(0);
  const seen = new Set<string>();
  async function walk(rel: string) {
    const abs = rel ? join(projectRoot, rel) : projectRoot;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      for (let i = 0; i < regexes.length; i++) {
        if (counts[i] >= perPatternCap) continue;
        if (regexes[i].test(childRel) && !seen.has(childRel)) {
          seen.add(childRel);
          // Defence in depth against a glob that somehow ranges outside the
          // project root (symlinks, edge cases in the regex). resolve() the
          // candidate and refuse to read anything that escapes projectRoot.
          const absPath = resolve(projectRoot, childRel);
          const rootWithSep = resolve(projectRoot) + sep;
          if (!absPath.startsWith(rootWithSep) && absPath !== resolve(projectRoot)) {
            break;
          }
          try {
            const buf = await readFile(absPath, "utf8");
            collected.push({ path: childRel, content: buf.slice(0, charLimit) });
            counts[i]++;
          } catch { /* unreadable; skip */ }
          break;
        }
      }
    }
  }
  await walk("");
  return collected;
}

async function readFirstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    try {
      const buf = await readFile(join(dir, n), "utf8");
      return buf.slice(0, 20_000);
    } catch {}
  }
  return null;
}

async function anyExists(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    try {
      await readFile(join(dir, n), "utf8");
      return true;
    } catch {}
  }
  return false;
}

async function summarizeTech(dir: string): Promise<string> {
  const parts: string[] = [];
  const pkg = await tryReadJson(join(dir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    parts.push(`node project: ${pkg.name ?? "?"}; deps: ${Object.keys(deps).slice(0, 30).join(", ")}`);
  }
  const py = await tryRead(join(dir, "pyproject.toml"));
  if (py) parts.push("python project (pyproject.toml present)");
  const cargo = await tryRead(join(dir, "Cargo.toml"));
  if (cargo) parts.push("rust project (Cargo.toml present)");
  const goMod = await tryRead(join(dir, "go.mod"));
  if (goMod) parts.push("go project (go.mod present)");
  try {
    const top = await readdir(dir);
    const interesting = top.filter((n) => ["src", "app", "lib", "server", "client", "api"].includes(n));
    if (interesting.length) parts.push(`top-level: ${interesting.join(", ")}`);
  } catch {}
  return parts.join("\n");
}

async function tryRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function tryReadJson(p: string): Promise<any | null> {
  const s = await tryRead(p);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function upsertProjects(projects: LocalProject[], userId: number) {
  const now = new Date();
  for (const p of projects) {
    const existing = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.slug, p.slug)))
      .get();
    if (existing) {
      if (existing.profileHash !== p.profileHash || existing.active !== p.active) {
        // NOTE: included + sensitivity are user-managed via the dashboard.
        // The loader never overwrites them.
        // searchKeywords is wiped on hash change so the gh-search fetcher
        // re-derives them from the fresh content on its next run.
        const hashChanged = existing.profileHash !== p.profileHash;
        await db
          .update(schema.projectProfiles)
          .set({
            path: p.path,
            name: p.name,
            readmeMd: p.readmeMd,
            claudeMd: p.claudeMd,
            techSummary: p.techSummary,
            profileHash: p.profileHash,
            active: p.active,
            ...(hashChanged ? { searchKeywords: null } : {}),
            updatedAt: now,
          })
          .where(eq(schema.projectProfiles.id, existing.id));
      }
    } else {
      // New project: default included=true, sensitivity=low. User can adjust.
      const defaultSensitivity = p.slug.startsWith("acme-") ? "high" : "low";
      await db.insert(schema.projectProfiles).values({
        userId,
        slug: p.slug,
        path: p.path,
        name: p.name,
        readmeMd: p.readmeMd,
        claudeMd: p.claudeMd,
        techSummary: p.techSummary,
        profileHash: p.profileHash,
        active: p.active,
        included: true,
        sensitivity: defaultSensitivity,
        updatedAt: now,
      });
    }
  }
}
