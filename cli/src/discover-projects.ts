// Local-filesystem project discovery for day-1 onboarding.
//
// Recursively walks a list of root dirs (provided by discover-roots.ts),
// finds every git repo, and for each one extracts:
//   - The repo's `owner/name` from `git remote get-url origin`
//   - A slug derived from the GITHUB repo name (so a local folder named
//     "drone" whose remote is acme/acme registers with slug "acme",
//     matching what shows on GitHub). Falls back to dirname for repos
//     without a GitHub remote.
//   - A name (from package.json's `name` field if present, else slug)
//   - Auto-suggested tags from the project's manifests
//   - The primary language (best-effort, from manifest type)
//
// Output is shaped for POST /api/projects/bulk on the server. No
// network or LLM calls — pure local filesystem.
//
// Why local-FS instead of asking GitHub via PAT: the whole pitch is
// "no API keys to share with us." Auto-detect via GitHub API requires
// a PAT; auto-detect via local git remotes requires nothing the user
// doesn't already have. PAT becomes optional, only needed if/when the
// user wants server-side handoff PRs.

import { type Dirent, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";

export type DiscoveredProject = {
  /** Absolute filesystem path on the user's machine */
  localPath: string;
  /** URL-safe identifier — GitHub repo name when remote present, else dirname */
  slug: string;
  /** Human-readable name (from package.json if present, else slug) */
  name: string;
  /** owner/name extracted from git remote; null if no GitHub remote */
  githubFullName: string | null;
  /** Auto-detected tags — language, framework, key deps, topics */
  tags: string[];
  /** Best-effort detected primary language */
  primaryLanguage: string | null;
};

export type DiscoveryResult = {
  /** Projects with a GitHub remote — eligible for registration */
  projects: DiscoveredProject[];
  /** Repos found locally but skipped because they have no GitHub remote */
  nonGithubSkipped: number;
  /** Actual root dirs that were walked (after dedup) */
  scannedRoots: string[];
};

// Hard maximum directory depth to walk from each root. depth=0 is the
// root itself, depth=1 its immediate children, etc. 4 covers the
// "workspace dir with sibling repos" pattern (e.g. ~/projects/drone/
// containing ~/projects/drone/flight-controller/.git, where the
// flight-controller dir is at depth 2 from ~/projects).
const MAX_DEPTH = 4;

// Directory names to skip outright during the walk. Mix of: build
// artifacts that pollute repo-counting, package caches that can be
// huge, and macOS / Linux home subdirs that never contain user code.
const EXCLUDE_NAMES = new Set<string>([
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  "vendor",
  ".cache",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".turbo",
  ".terraform",
  ".venv",
  "venv",
  "__pycache__",
  // macOS system / media dirs
  "Library",
  "Applications",
  "System",
  "Pictures",
  "Movies",
  "Music",
  "Downloads",
  "Public",
  "Desktop",
  // Linux equivalents
  ".local",
  ".config",
  "snap",
]);

// Manifest-derived tag mappings. Each pattern matches a dep name (or
// a substring) and yields one or more tags. Ordered by specificity:
// more-specific patterns first so e.g. "next" doesn't accidentally
// tag a "next-auth-only" project as "next.js".
const DEP_TO_TAGS: Array<{ match: RegExp; tags: string[] }> = [
  // Frontend frameworks (Node)
  { match: /^next$/, tags: ["next.js"] },
  { match: /^react$/, tags: ["react"] },
  { match: /^vue$/, tags: ["vue"] },
  { match: /^svelte$/, tags: ["svelte"] },
  { match: /^solid-js$/, tags: ["solid"] },
  { match: /^astro$/, tags: ["astro"] },
  { match: /^remix-run\//, tags: ["remix"] },
  // Backend / runtime
  { match: /^express$/, tags: ["express"] },
  { match: /^fastify$/, tags: ["fastify"] },
  { match: /^hono$/, tags: ["hono"] },
  { match: /^nestjs\//, tags: ["nestjs"] },
  // Database / ORM
  { match: /^prisma$/, tags: ["prisma"] },
  { match: /^@prisma\/client$/, tags: ["prisma"] },
  { match: /^drizzle-orm/, tags: ["drizzle"] },
  { match: /^kysely$/, tags: ["kysely"] },
  { match: /^typeorm$/, tags: ["typeorm"] },
  { match: /^mongoose$/, tags: ["mongoose"] },
  { match: /postgres|pg$/, tags: ["postgres"] },
  { match: /^mysql/, tags: ["mysql"] },
  { match: /^redis|^ioredis$/, tags: ["redis"] },
  // Queue / async
  { match: /^bullmq$/, tags: ["bullmq", "queue"] },
  { match: /^bee-queue$/, tags: ["bee-queue", "queue"] },
  { match: /^node-cron$/, tags: ["cron"] },
  // LLM / AI
  { match: /^openai$/, tags: ["openai"] },
  { match: /^@anthropic-ai\//, tags: ["anthropic"] },
  { match: /^langchain/, tags: ["langchain"] },
  // Auth
  { match: /^next-auth$/, tags: ["next-auth"] },
  { match: /^@auth\//, tags: ["next-auth"] },
  { match: /firebase/, tags: ["firebase"] },
  // Cloud / hosting
  { match: /^@aws-sdk\//, tags: ["aws"] },
  { match: /^@vercel\//, tags: ["vercel"] },
  { match: /^@cloudflare\//, tags: ["cloudflare"] },
  // Web3
  { match: /^viem$/, tags: ["viem", "web3"] },
  { match: /^ethers$/, tags: ["ethers", "web3"] },
  { match: /^wagmi$/, tags: ["wagmi", "web3"] },
  { match: /^@matterlabs\//, tags: ["zksync"] },
  // Image / media
  { match: /^sharp$/, tags: ["images"] },
  { match: /^@napi-rs\/canvas$/, tags: ["canvas", "images"] },
  { match: /ffmpeg/, tags: ["ffmpeg"] },
  // Python (matches go through the same loop on requirements.txt)
  { match: /^torch$/, tags: ["pytorch"] },
  { match: /^tensorflow$/, tags: ["tensorflow"] },
  { match: /^fastapi$/, tags: ["fastapi"] },
  { match: /^flask$/, tags: ["flask"] },
  { match: /^django$/, tags: ["django"] },
  { match: /^segmentation-models-pytorch$/, tags: ["pytorch", "segmentation"] },
  { match: /^albumentations$/, tags: ["augmentation"] },
  { match: /^scikit-learn$/, tags: ["ml"] },
];

/**
 * Walk the given roots recursively (depth-capped, excluded dirs skipped)
 * and return every git repo found, partitioned by whether it has a
 * GitHub origin remote. Repos without a GitHub remote are counted but
 * not registered — they're surfaced to the user as transparency rather
 * than silently dropped.
 *
 * Deduplicates by absolute `localPath` (so overlapping roots like
 * `~/projects` and `~/projects/drone` don't double-register the inner
 * repos) and by `githubFullName` (so cloning the same repo to two
 * paths doesn't create two project rows).
 *
 * Slug = the local directory basename (normalised). When two repos in
 * the discovery result would share a slug (e.g. `flight-controller`
 * under both `~/projects/drone/` and `~/work/sandbox/`), the second+
 * gets `-<owner>` appended to disambiguate. Keeps slugs short for the
 * common case while preventing server-side `uniq_profile_user_slug`
 * collisions.
 *
 * Identity is `githubFullName` on the server side; slug is just the
 * URL-safe display label. So a local `~/projects/drone/` whose remote
 * is `acme/acme` keeps slug `drone` (matching how you think of it
 * locally) while still registering correctly against `acme/acme` on
 * the dashboard.
 */
export function discoverProjects(roots: string[]): DiscoveryResult {
  const seenPaths = new Set<string>();
  const seenGithub = new Set<string>();
  const projects: DiscoveredProject[] = [];
  let nonGithubSkipped = 0;
  const scannedRoots = Array.from(new Set(roots.filter(existsAndIsDir)));

  for (const root of scannedRoots) {
    for (const repoPath of walkForGitRepos(root, 0)) {
      if (seenPaths.has(repoPath)) continue;
      seenPaths.add(repoPath);

      const githubFullName = readGitRemote(repoPath);
      const dirName = basename(repoPath);

      if (!githubFullName) {
        nonGithubSkipped++;
        continue;
      }
      if (seenGithub.has(githubFullName)) continue;
      seenGithub.add(githubFullName);

      const { name, tags, primaryLanguage } = extractMetadata(repoPath, dirName);
      projects.push({
        localPath: repoPath,
        slug: normaliseSlug(dirName),
        name,
        githubFullName,
        tags,
        primaryLanguage,
      });
    }
  }

  // In-discovery slug disambiguation. Same-name dirs under different
  // parents (e.g. `~/projects/drone/flight-controller` +
  // `~/work/flight-controller`) would otherwise collide on the server's
  // `uniq_profile_user_slug` index. Suffix the second+ occurrence with
  // the GitHub owner so it remains unique per user.
  disambiguateSlugs(projects);

  return { projects, nonGithubSkipped, scannedRoots };
}

function disambiguateSlugs(projects: DiscoveredProject[]): void {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.slug, (counts.get(p.slug) ?? 0) + 1);
  const used = new Set<string>();
  for (const p of projects) {
    if ((counts.get(p.slug) ?? 0) <= 1 && !used.has(p.slug)) {
      used.add(p.slug);
      continue;
    }
    const owner = (p.githubFullName ?? "").split("/")[0] ?? "";
    let candidate = normaliseSlug(`${p.slug}-${owner}`);
    let n = 2;
    while (used.has(candidate)) {
      candidate = normaliseSlug(`${p.slug}-${owner}-${n++}`);
    }
    p.slug = candidate;
    used.add(candidate);
  }
}

/**
 * Generator: yields the absolute path of every git repo found under
 * `dir`, up to `MAX_DEPTH`. Stops recursing into a directory once a
 * `.git/` is found there (treats it as a repo boundary — submodules
 * and nested-clone edge cases aren't worth complicating the walker).
 */
function* walkForGitRepos(dir: string, depth: number): Generator<string> {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Is this dir itself a repo? Yield + stop recursing.
  if (entries.some((e) => e.name === ".git" && (e.isDirectory() || e.isSymbolicLink()))) {
    yield dir;
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    yield* walkForGitRepos(join(dir, entry.name), depth + 1);
  }
}

function existsAndIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function normaliseSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

// Run `git remote get-url origin` in the repo. Returns owner/name on
// success, null otherwise. Tolerates non-GitHub remotes (returns null
// so the repo is skipped).
function readGitRemote(repoPath: string): string | null {
  let url: string;
  try {
    url = execSync("git remote get-url origin", {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
  // Match both HTTPS (https://github.com/owner/name[.git]) and SSH
  // (git@github.com:owner/name[.git]) formats.
  const m = url.match(/github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function extractMetadata(repoPath: string, fallbackName: string): {
  name: string;
  tags: string[];
  primaryLanguage: string | null;
} {
  const tags = new Set<string>();
  let name = fallbackName;
  let primaryLanguage: string | null = null;

  // Node: package.json
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    primaryLanguage = "TypeScript"; // updated below if no TS detected
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        keywords?: string[];
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (typeof pkg.name === "string" && pkg.name.length > 0) name = pkg.name;
      if (Array.isArray(pkg.keywords)) {
        for (const k of pkg.keywords) {
          if (typeof k === "string" && k.length > 0 && k.length <= 40) {
            tags.add(k.toLowerCase());
          }
        }
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      // Detect TS vs JS from presence of typescript in deps.
      if (deps["typescript"] !== undefined) {
        tags.add("typescript");
        primaryLanguage = "TypeScript";
      } else {
        // Look for *.ts files at top level to decide TS vs JS.
        try {
          const top = readdirSync(repoPath);
          if (top.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
            tags.add("typescript");
            primaryLanguage = "TypeScript";
          } else {
            tags.add("javascript");
            primaryLanguage = "JavaScript";
          }
        } catch { /* ignore */ }
      }
      // Match deps against the tag mapping.
      for (const depName of Object.keys(deps)) {
        for (const { match, tags: ts } of DEP_TO_TAGS) {
          if (match.test(depName)) {
            for (const t of ts) tags.add(t);
          }
        }
      }
    } catch { /* malformed package.json — skip */ }
  }

  // Python: pyproject.toml / requirements.txt
  const pyprojectPath = join(repoPath, "pyproject.toml");
  const requirementsPath = join(repoPath, "requirements.txt");
  if (existsSync(pyprojectPath) || existsSync(requirementsPath)) {
    primaryLanguage = "Python";
    tags.add("python");
    const text = [pyprojectPath, requirementsPath]
      .filter((p) => existsSync(p))
      .map((p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } })
      .join("\n");
    // Pull dep names from "<name>>=<ver>" / "<name>==<ver>" / quoted strings.
    const depMatches = text.matchAll(/^\s*["']?([a-zA-Z0-9][\w.-]*)["']?\s*[><=!~]/gm);
    for (const dm of depMatches) {
      const depName = dm[1].toLowerCase();
      for (const { match, tags: ts } of DEP_TO_TAGS) {
        if (match.test(depName)) {
          for (const t of ts) tags.add(t);
        }
      }
    }
  }

  // Rust: Cargo.toml
  if (existsSync(join(repoPath, "Cargo.toml"))) {
    primaryLanguage = primaryLanguage ?? "Rust";
    tags.add("rust");
  }

  // Go: go.mod
  if (existsSync(join(repoPath, "go.mod"))) {
    primaryLanguage = primaryLanguage ?? "Go";
    tags.add("go");
  }

  // Solidity (web3 contracts under hardhat/foundry)
  if (existsSync(join(repoPath, "hardhat.config.js")) ||
      existsSync(join(repoPath, "hardhat.config.ts")) ||
      existsSync(join(repoPath, "foundry.toml"))) {
    tags.add("solidity");
    tags.add("web3");
  }

  // Cap total tags so a kitchen-sink monorepo doesn't blow up the row.
  return {
    name,
    tags: Array.from(tags).slice(0, 25),
    primaryLanguage,
  };
}
