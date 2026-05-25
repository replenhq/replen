// Local-filesystem project discovery for day-1 onboarding.
//
// Walks the user's conventional repo roots (~/github/, ~/code/,
// ~/projects/) for git repos, then for each one extracts:
//   - The repo's `owner/name` from `git remote get-url origin`
//   - A slug (from the directory basename, normalised)
//   - A name (from package.json's `name` field if present, else slug)
//   - Auto-suggested tags from the project's manifests
//   - The primary language (best-effort, from manifest type)
//
// Output is shaped for POST /api/projects/bulk on the server. No
// network or LLM calls — pure local filesystem.
//
// Why local-FS instead of asking GitHub via PAT: skill-mode's whole
// pitch is "no API keys to share with us." Auto-detect via GitHub
// API requires a PAT; auto-detect via local git remotes requires
// nothing the user doesn't already have. PAT becomes optional, only
// needed if/when the user wants server-side handoff PRs.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export type DiscoveredProject = {
  /** Absolute filesystem path on the user's machine */
  localPath: string;
  /** URL-safe identifier (from directory basename, lowercased) */
  slug: string;
  /** Human-readable name (from package.json if present, else slug) */
  name: string;
  /** owner/name extracted from git remote */
  githubFullName: string;
  /** Auto-detected tags — language, framework, key deps, topics */
  tags: string[];
  /** Best-effort detected primary language */
  primaryLanguage: string | null;
};

const SCAN_ROOTS = ["github", "code", "projects"]; // immediate children of ~

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

export function discoverProjects(): DiscoveredProject[] {
  const out: DiscoveredProject[] = [];
  const home = homedir();
  for (const root of SCAN_ROOTS) {
    const rootPath = join(home, root);
    if (!existsSync(rootPath)) continue;
    let entries: string[];
    try { entries = readdirSync(rootPath); } catch { continue; }
    for (const dirName of entries) {
      if (dirName.startsWith(".") || dirName === "node_modules") continue;
      const localPath = join(rootPath, dirName);
      try {
        if (!statSync(localPath).isDirectory()) continue;
        if (!existsSync(join(localPath, ".git"))) continue;
      } catch { continue; }

      const githubFullName = readGitRemote(localPath);
      if (!githubFullName) continue; // No GitHub remote → skip; can't register

      const { name, tags, primaryLanguage } = extractMetadata(localPath, dirName);
      const slug = normaliseSlug(dirName);
      out.push({ localPath, slug, name, githubFullName, tags, primaryLanguage });
    }
  }
  return out;
}

function normaliseSlug(dirName: string): string {
  return dirName
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
