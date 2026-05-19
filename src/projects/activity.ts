// Raw activity probe for a project. Reads recent git activity from the
// local filesystem mirror, optionally fetches open PRs from GitHub when
// the project has a github_full_name set + a token is available.
//
// This is the DATA-ONLY layer. The LLM condenser lives in
// activity-summary.ts and turns this raw blob into the summary that
// feeds Stage 1 / Stage 4 / reasonAboutRepo.
//
// Why a separate layer: keeping the probe pure-data means it's cheap to
// re-run (no LLM call), and we can cache-bust the LLM step on git HEAD
// changes without re-paying the network cost when the activity hasn't
// actually changed.

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const LOOKBACK_DAYS = 30;
const MAX_COMMITS = 100;
// Skip these directories when walking for TODO comments — they dominate
// file count without being relevant signal.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "target",
  ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache",
  "vendor", "tmp", ".pnpm",
]);
// File extensions we'll look inside for TODOs. Limits noise from images,
// lockfiles, etc.
const TODO_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".swift",
  ".md", ".mdx",
]);

export type CommitRow = {
  sha: string;
  isoDate: string;
  subject: string;
};
export type ChangedFile = {
  path: string;
  changes: number;
};
export type TodoCluster = {
  dir: string;
  count: number;
  examples: string[];
};
export type OpenPR = {
  number: number;
  title: string;
  bodyExcerpt: string | null;
  branchHead: string | null;
  updatedAt: string | null;
};

export type ProjectActivity = {
  isGitRepo: boolean;
  headSha: string | null;
  branch: string | null;
  // Last 100 commits within the lookback window. Oldest last.
  commits: CommitRow[];
  // Top files by changes touched in the lookback window. Capped at 25.
  topChangedFiles: ChangedFile[];
  // TODO/FIXME clusters keyed by directory, sorted by count.
  todoClusters: TodoCluster[];
  // Open PRs (if github_full_name + token available). Cap 10.
  openPRs: OpenPR[];
  // Days since the most recent commit. Null when no commits at all.
  daysSinceLastCommit: number | null;
};

export type ProbeOpts = {
  githubFullName?: string | null;
  ghToken?: string | null;
};

export async function probeActivity(projectPath: string, opts: ProbeOpts = {}): Promise<ProjectActivity> {
  // Defence-in-depth: only probe if the directory exists. The loader's
  // mirror can be partially synced.
  try {
    const s = await stat(projectPath);
    if (!s.isDirectory()) {
      return emptyActivity();
    }
  } catch {
    return emptyActivity();
  }

  // Is this even a git repo? We use `git -C <path> rev-parse` rather than
  // checking for a .git directory because the mirror sometimes uses
  // worktrees or git-dir overrides.
  const headSha = await tryGit(projectPath, ["rev-parse", "HEAD"]);
  if (headSha === null) {
    return emptyActivity();
  }

  const branchRaw = await tryGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw ? branchRaw.trim() : null;
  const commits = await readRecentCommits(projectPath);
  const topChangedFiles = await readChangedFiles(projectPath);
  const todoClusters = await scanTodoClusters(projectPath);

  let openPRs: OpenPR[] = [];
  if (opts.githubFullName && opts.ghToken) {
    openPRs = await fetchOpenPRs(opts.githubFullName, opts.ghToken);
  }

  const daysSinceLastCommit = commits.length > 0
    ? Math.floor((Date.now() - new Date(commits[0].isoDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    isGitRepo: true,
    headSha: headSha.trim(),
    branch,
    commits,
    topChangedFiles,
    todoClusters,
    openPRs,
    daysSinceLastCommit,
  };
}

function emptyActivity(): ProjectActivity {
  return {
    isGitRepo: false,
    headSha: null,
    branch: null,
    commits: [],
    topChangedFiles: [],
    todoClusters: [],
    openPRs: [],
    daysSinceLastCommit: null,
  };
}

async function readRecentCommits(projectPath: string): Promise<CommitRow[]> {
  // %H = full sha, %cI = committer ISO date, %s = subject. Newline separators
  // are fragile inside subject lines; use NUL between records and tab between
  // fields instead.
  const out = await tryGit(projectPath, [
    "log",
    `--since=${LOOKBACK_DAYS}.days.ago`,
    `-${MAX_COMMITS}`,
    "--pretty=format:%H\t%cI\t%s%x00",
    "--all",
    "--no-merges",
  ]);
  if (!out) return [];
  return out
    .split("\x00")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec): CommitRow | null => {
      const [sha, isoDate, ...rest] = rec.split("\t");
      if (!sha || !isoDate) return null;
      return { sha, isoDate, subject: rest.join("\t").trim() };
    })
    .filter((r): r is CommitRow => r !== null);
}

async function readChangedFiles(projectPath: string): Promise<ChangedFile[]> {
  // `git log --numstat` lists "<adds>\t<dels>\t<path>" lines per file per
  // commit. Sum changes across the lookback window, top 25.
  const out = await tryGit(projectPath, [
    "log",
    `--since=${LOOKBACK_DAYS}.days.ago`,
    "--numstat",
    "--pretty=format:",
    "--all",
    "--no-merges",
  ]);
  if (!out) return [];
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const adds = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    const dels = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
    const path = parts[2];
    // Skip noise: lockfiles, build artefacts, generated code.
    if (isNoisePath(path)) continue;
    counts.set(path, (counts.get(path) ?? 0) + adds + dels);
  }
  return [...counts.entries()]
    .map(([path, changes]) => ({ path, changes }))
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 25);
}

function isNoisePath(path: string): boolean {
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|Pipfile\.lock|uv\.lock)$/.test(path)) return true;
  if (/(^|\/)(dist|build|out|coverage|\.next|target|node_modules|vendor)\//.test(path)) return true;
  if (/\.(min\.js|min\.css|map|snap|generated\.[a-z]+)$/.test(path)) return true;
  // Drizzle snapshot JSONs are auto-generated diffs of the entire schema;
  // they touch thousands of lines per migration but reflect zero actual
  // dev intent. Equivalent for Prisma / Sequelize would land here too.
  if (/(^|\/)migrations\/(meta\/|.*snapshot\.(json|prisma))/.test(path)) return true;
  // Lock-style binary diffs that aren't code: SVG icons, fonts, schema
  // exports. Not always noise but rarely useful in a "what are they
  // building" summary.
  if (/\.(svg|png|jpg|jpeg|gif|woff2?|ttf|ico)$/.test(path)) return true;
  return false;
}

// Recursively walk for files containing TODO/FIXME/XXX comments. Cluster
// by the file's parent directory. Cheap: stops descending into known noise
// dirs, only reads files of known source extensions, caps total bytes.
async function scanTodoClusters(projectPath: string, charLimit = 200_000): Promise<TodoCluster[]> {
  type Hit = { dir: string; line: string };
  const hits: Hit[] = [];
  let bytesRead = 0;
  async function walk(rel: string) {
    if (bytesRead >= charLimit) return;
    const abs = rel ? join(projectPath, rel) : projectPath;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (bytesRead >= charLimit) return;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = e.name.slice(dot).toLowerCase();
      if (!TODO_EXTS.has(ext)) continue;
      try {
        const buf = await readFile(join(projectPath, childRel), "utf8");
        bytesRead += buf.length;
        if (!/\b(TODO|FIXME|XXX)\b/.test(buf)) continue;
        const dir = childRel.includes("/") ? childRel.slice(0, childRel.lastIndexOf("/")) : ".";
        for (const line of buf.split("\n")) {
          if (/\b(TODO|FIXME|XXX)\b/.test(line)) {
            hits.push({ dir, line: line.trim().slice(0, 200) });
          }
        }
      } catch { /* unreadable; skip */ }
    }
  }
  await walk("");

  // Cluster by directory.
  const byDir = new Map<string, string[]>();
  for (const h of hits) {
    if (!byDir.has(h.dir)) byDir.set(h.dir, []);
    byDir.get(h.dir)!.push(h.line);
  }
  return [...byDir.entries()]
    .map(([dir, lines]) => ({ dir, count: lines.length, examples: lines.slice(0, 3) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function fetchOpenPRs(fullName: string, token: string): Promise<OpenPR[]> {
  const url = `https://api.github.com/repos/${fullName}/pulls?state=open&per_page=10&sort=updated&direction=desc`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "replen/0.1",
      },
    });
    if (!res.ok) {
      console.warn(`[activity] PR fetch for ${fullName} -> ${res.status}`);
      return [];
    }
    const items = (await res.json()) as Array<{
      number?: number;
      title?: string;
      body?: string;
      head?: { ref?: string };
      updated_at?: string;
    }>;
    return items
      .filter((p): p is { number: number; title: string } & Record<string, unknown> => typeof p.number === "number" && typeof p.title === "string")
      .map((p) => ({
        number: p.number,
        title: p.title,
        bodyExcerpt: typeof p.body === "string" && p.body.trim().length > 0 ? p.body.slice(0, 500) : null,
        branchHead: (p.head as { ref?: string } | undefined)?.ref ?? null,
        updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
      }));
  } catch (e) {
    console.warn(`[activity] PR fetch failed for ${fullName}: ${(e as Error).message}`);
    return [];
  }
}

// Defence-in-depth git wrapper. Uses spawn (not exec) so subjects can carry
// arbitrary characters without shell-injection concerns. Returns trimmed
// stdout on exit 0, null otherwise.
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // Defence-in-depth: bound runtime + memory in case of pathological
      // repos. 8s is plenty for log/rev-parse on local mirrors.
      timeout: 8000,
    });
    const chunks: Buffer[] = [];
    let stderrBytes = 0;
    proc.stdout.on("data", (b: Buffer) => chunks.push(b));
    proc.stderr.on("data", (b: Buffer) => { stderrBytes += b.length; });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        if (stderrBytes > 0) {
          // Don't log stderr verbatim — it can contain private paths.
          // Just note the failure with the exit code.
          console.warn(`[activity] git ${args[0]} exited ${code} in ${cwd}`);
        }
        resolve(null);
      }
    });
  });
}
