import { createHash } from "node:crypto";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { fetchRepoHead, fetchFile, fetchTree, GitHubApiError, type TreeEntry } from "../github/repo-content";

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
  // Initiative #1: cached activity summary from project_profiles.activity_json.
  // null when the project has no recent activity or the cache hasn't been
  // populated yet. Consumers (score-targeted, reason.ts) gracefully skip the
  // current-work block when null.
  activitySummary?: import("./activity-summary").ProjectActivitySummary | null;
};

// All root-level doc-class files. Ordered so README (the most common entry
// point) appears first in the concatenated profile and the LLM reads it first,
// but every match is included — no first-hit-wins. A repo with README + SPEC
// + ARCHITECTURE gets all three concatenated with file-name delimiters.
const DOC_NAMES = [
  // Conventional readmes
  "README.md", "Readme.md", "readme.md", "README.MD",
  // Architectural / design docs
  "SPEC.md", "Spec.md", "spec.md",
  "DESIGN.md", "design.md",
  "ARCHITECTURE.md", "Architecture.md", "architecture.md",
  // Active-state docs (what's been changing recently — high signal for matching)
  "CHANGELOG.md", "Changelog.md", "changelog.md",
  // Plans / roadmaps
  "PRODUCT_PLAN.md", "PLAN.md", "plan.md",
  "roadmap.md", "ROADMAP.md", "Roadmap.md",
  "ACTION-PLAN.md", "ACTION_PLAN.md", "action-plan.md",
  "AUDIT.md", "AUDIT-REPORT.md", "FULL-AUDIT-REPORT.md",
  "NOTES.md", "OVERVIEW.md",
];
// AI-context / handover files. Same multi-file concat as DOC_NAMES — a repo
// using both CLAUDE.md and AGENTS.md gets both folded in. The .cursorrules and
// .windsurfrules cases are root-level dotfiles from those tools' conventions.
// Cursor's nested .cursor/rules/*.md dir is handled by DEFAULT_AUX_PATTERNS
// below since it can have many files.
const CLAUDE_NAMES = [
  "CLAUDE.md", "Claude.md", "claude.md",
  "AGENTS.md", "agents.md",
  "HANDOVER.md", "Handover.md", "handover.md",
  "HANDOFF.md", "Handoff.md", "handoff.md",
  "GEMINI.md", "Gemini.md", "gemini.md",
  "COPILOT.md", "Copilot.md", "copilot.md",
  ".cursorrules",
  ".windsurfrules",
];
const MANIFEST_NAMES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "requirements.txt"];

// Process / legal / GH-boilerplate docs we deliberately skip even when they'd
// otherwise be in scope. CONTRIBUTING and CODE_OF_CONDUCT are typically pure
// noise for project-shape matching. LICENSE / NOTICE describe legal terms not
// project intent. SECURITY.md as a GH boilerplate is usually a "report at X@"
// notice — when it's a real project-security doc, the user can add it back via
// extra_doc_paths. This list also applies to the collectExtraDocs walker so
// `docs/CONTRIBUTING.md` etc. aren't accidentally folded in.
const DOC_DENY_LIST = new Set([
  "CONTRIBUTING.md", "Contributing.md", "contributing.md",
  "CODE_OF_CONDUCT.md", "Code_of_conduct.md", "code_of_conduct.md",
  "LICENSE", "License", "license",
  "LICENSE.md", "License.md", "license.md",
  "LICENSE.txt", "License.txt", "license.txt",
  "COPYING", "COPYING.md",
  "NOTICE", "Notice", "notice",
  "NOTICE.md", "Notice.md", "notice.md",
  "SECURITY.md", "Security.md", "security.md",
  "SUPPORT.md", "Support.md", "support.md",
  "AUTHORS", "AUTHORS.md",
  "FUNDING.yml",
]);

// Auto-included aux doc patterns. Applied to every project regardless of the
// user's extra_doc_paths setting — these are the "free win" defaults that give
// the LLM more context for docs-heavy projects without anyone configuring
// anything. Subject to the same per-pattern file count cap + char limit as
// user-configured extras. The user can still narrow these by setting
// extra_doc_paths to something specific (their patterns are appended, not
// replaced), or widen by adding e.g. "spec/**/*.md".
const DEFAULT_AUX_PATTERNS = [
  "docs/**/*.md",                    // project's own docs subdir (most common)
  ".cursor/rules/**/*.md",           // Cursor's nested rules dir
  "*-SETUP.md",                      // ops docs at repo root (AUTOMATION-SETUP.md, CRON_SETUP.md, etc.)
  // GitHub spec-kit: when a project uses Spec-Driven Development, each
  // feature gets a .specify/specs/<name>/{spec,plan,tasks,data-model}.md
  // describing exactly what the user is building right now. Far higher
  // signal than inferring from git diff churn — these files literally
  // describe intent, not just "what changed". The constitution.md in
  // .specify/memory/ encodes project-wide principles. See github.com/github/spec-kit.
  ".specify/specs/**/*.md",
  ".specify/memory/*.md",
];

// GitHub-pull version: iterates the user's existing project_profiles
// rows and fetches docs/manifests via the GitHub API instead of the
// local filesystem mirror. Same DOC_NAMES / CLAUDE_NAMES / glob set,
// same profile-hash construction, same LocalProject output shape — so
// upsertProjects and every downstream consumer (Stage 1, Stage 2, etc.)
// stay unchanged.
//
// New projects must be added separately via autoDetectAndStoreRepos
// (already exists, runs on PAT save and the /projects "Re-detect"
// button). This function only refreshes rows that already exist.
// Rows with no githubFullName set are skipped — they can't be
// addressed via API. Their existing docs stay cached until the user
// sets the repo on /projects.
export type DiscoverResult = {
  projects: LocalProject[];
  // Slugs of project_profiles rows that were skipped because they
  // have no usable github_full_name. The pipeline orchestrator surfaces
  // these in the streamer so the user can see which projects need a
  // repo set on /projects.
  skippedNoRepo: string[];
};

export async function discoverProjectsForUser(
  userId: number,
  token: string,
  opts: DiscoverOpts = {},
): Promise<DiscoverResult> {
  const rows = await db
    .select()
    .from(schema.projectProfiles)
    .where(eq(schema.projectProfiles.userId, userId));

  const userPatterns = (opts.extraDocPaths ?? []).map((s) => s.trim()).filter(Boolean);
  const allPatterns = [...DEFAULT_AUX_PATTERNS, ...userPatterns];
  const perPatternCap = opts.extraDocsBudget ?? 8;
  const charLimit = opts.extraDocCharLimit ?? 20_000;

  const out: LocalProject[] = [];
  const skippedNoRepo: string[] = [];
  for (const row of rows) {
    if (!row.githubFullName || !/^[\w.-]+\/[\w.-]+$/.test(row.githubFullName)) {
      // Only track skips for rows the user actively wants matched —
      // archived / un-included projects don't pollute the streamer.
      if (row.active && row.included) skippedNoRepo.push(row.slug);
      continue;
    }
    const [owner, repoName] = row.githubFullName.split("/");

    let head;
    try {
      head = await fetchRepoHead(owner, repoName, token);
    } catch (e) {
      if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
      console.warn(`[loader] head ${row.githubFullName} failed:`, (e as Error).message);
      continue;
    }
    if (!head) continue; // 404 — repo gone or PAT lost access

    let tree;
    try {
      tree = await fetchTree(owner, repoName, head.headSha, token);
    } catch (e) {
      if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
      console.warn(`[loader] tree ${row.githubFullName} failed:`, (e as Error).message);
      continue;
    }
    if (!tree) continue;
    const blobs = tree.entries.filter((t) => t.type === "blob");
    const blobPaths = new Set(blobs.map((b) => b.path));

    const docMd = await fetchAllByName(owner, repoName, head.headSha, blobPaths, DOC_NAMES, token);
    const claudeMdRaw = await fetchAllByName(owner, repoName, head.headSha, blobPaths, CLAUDE_NAMES, token);
    const extraDocs = allPatterns.length > 0
      ? await fetchExtraDocsByGlob(owner, repoName, head.headSha, blobs, allPatterns, perPatternCap, charLimit, token)
      : [];
    const claudeMd = mergeExtraIntoClaudeMd(claudeMdRaw, extraDocs);
    const techSummary = await buildTechSummaryFromTree(owner, repoName, head.headSha, blobs, blobPaths, token);

    const hasManifest = MANIFEST_NAMES.some((n) => blobPaths.has(n));
    if (!docMd && !claudeMd && !hasManifest) continue;

    const profile = `${docMd ?? ""}\n---\n${claudeMd ?? ""}\n---\n${techSummary ?? ""}`;
    const profileHash = createHash("sha1").update(profile).digest("hex");
    out.push({
      slug: row.slug,
      // Synthetic path: keeps existing UI columns rendering something
      // human-readable, and prefix "github:" makes it obvious this row
      // came from the API path. Filesystem callers that still expect
      // a real path are tracked + retired in commit (6/6).
      path: `github:${row.githubFullName}`,
      name: row.name,
      readmeMd: docMd,
      claudeMd,
      techSummary,
      profileHash,
      active: docMd !== null || claudeMd !== null || techSummary !== null,
    });
  }
  return { projects: out, skippedNoRepo };
}

async function fetchAllByName(
  owner: string,
  repoName: string,
  ref: string,
  blobPaths: Set<string>,
  names: string[],
  token: string,
): Promise<string | null> {
  const parts: string[] = [];
  for (const n of names) {
    if (DOC_DENY_LIST.has(n)) continue;
    if (!blobPaths.has(n)) continue;
    try {
      const content = await fetchFile(owner, repoName, n, token, ref);
      if (!content) continue;
      parts.push(`# === file: ${n} ===\n${content.slice(0, 20_000)}`);
    } catch (e) {
      if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
      // Other failures (transient 5xx etc.): skip this file, the rest
      // of the project's docs still get folded in.
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

async function fetchExtraDocsByGlob(
  owner: string,
  repoName: string,
  ref: string,
  blobs: TreeEntry[],
  patterns: string[],
  perPatternCap: number,
  charLimit: number,
  token: string,
): Promise<Array<{ path: string; content: string }>> {
  const collected: Array<{ path: string; content: string }> = [];
  const regexes = patterns.map(globToRegex);
  const counts = new Array(patterns.length).fill(0);
  const seen = new Set<string>();
  for (const b of blobs) {
    if (b.path.startsWith("node_modules/") || b.path.includes("/node_modules/")) continue;
    // Mirror the filesystem walker's dot-dir rule: skip dot-dirs unless
    // they're a tool we explicitly want (Cursor, spec-kit). For these we
    // already added globs in DEFAULT_AUX_PATTERNS, so the regex match
    // gates inclusion anyway — this just keeps loops tight on big trees.
    if (b.path.startsWith(".") && !b.path.startsWith(".cursor/") && !b.path.startsWith(".specify/")) continue;
    const base = b.path.includes("/") ? b.path.slice(b.path.lastIndexOf("/") + 1) : b.path;
    if (DOC_DENY_LIST.has(base)) continue;
    for (let i = 0; i < regexes.length; i++) {
      if (counts[i] >= perPatternCap) continue;
      if (regexes[i].test(b.path) && !seen.has(b.path)) {
        seen.add(b.path);
        try {
          const content = await fetchFile(owner, repoName, b.path, token, ref);
          if (content) {
            collected.push({ path: b.path, content: content.slice(0, charLimit) });
            counts[i]++;
          }
        } catch (e) {
          if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
          // skip
        }
        break;
      }
    }
  }
  return collected;
}

async function buildTechSummaryFromTree(
  owner: string,
  repoName: string,
  ref: string,
  blobs: TreeEntry[],
  blobPaths: Set<string>,
  token: string,
): Promise<string> {
  const parts: string[] = [];
  if (blobPaths.has("package.json")) {
    try {
      const raw = await fetchFile(owner, repoName, "package.json", token, ref);
      if (raw) {
        const pkg = JSON.parse(raw) as { name?: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        parts.push(`node project: ${pkg.name ?? "?"}; deps: ${Object.keys(deps).slice(0, 30).join(", ")}`);
      }
    } catch (e) {
      if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
      // malformed package.json: skip the node-deps line
    }
  }
  if (blobPaths.has("pyproject.toml")) parts.push("python project (pyproject.toml present)");
  if (blobPaths.has("Cargo.toml")) parts.push("rust project (Cargo.toml present)");
  if (blobPaths.has("go.mod")) parts.push("go project (go.mod present)");
  // Top-level dirs: derive from the tree paths so we don't need a
  // separate listing call.
  const topDirs = new Set<string>();
  for (const b of blobs) {
    const slash = b.path.indexOf("/");
    if (slash > 0) topDirs.add(b.path.slice(0, slash));
  }
  const interesting = ["src", "app", "lib", "server", "client", "api"].filter((d) => topDirs.has(d));
  if (interesting.length) parts.push(`top-level: ${interesting.join(", ")}`);
  return parts.join("\n");
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

export async function upsertProjects(projects: LocalProject[], userId: number) {
  const now = new Date();
  for (const p of projects) {
    const existing = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.slug, p.slug)))
      .get();
    if (existing) {
      // `path` is included in the change check so a renamed mirror dir
      // (e.g. /opt/oss-digest/projects-mirror → /opt/replen/projects-mirror)
      // doesn't silently leave existing rows pointing at a now-missing
      // location. Without this, activity/dep-health probes return empty
      // and the writeups appear "dormant" with no error.
      if (existing.profileHash !== p.profileHash || existing.active !== p.active || existing.path !== p.path) {
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
