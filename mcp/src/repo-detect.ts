// Best-effort detection of the GitHub repo the MCP was spawned inside.
//
// Claude Code spawns the MCP with process.cwd() set to whatever directory the
// user ran `claude` from — typically the root of a project repo. We use that
// to default the `repo` filter on tools like replen_match, so
// `/replen` inside british-housing shows british-housing matches rather than
// every match across every project the user has.
//
// Failure modes are all silent: if we can't detect a repo (no git, no origin,
// detached HEAD, etc.) we return null and the tools fall back to user-scoped
// behaviour (the pre-0.2.x default).

import { execFileSync } from "node:child_process";

export type DetectedRepo = {
  /** GitHub-style "owner/name" identifier matching project_profiles.githubFullName. */
  ownerRepo: string;
  /** Filesystem path to the git toplevel — kept so we can re-read HEAD per call. */
  toplevel: string;
};

/**
 * Current git HEAD SHA of a repo, read FRESH. The MCP process lives for the whole
 * (possibly weeks-long) session, so HEAD must be read at request time — not once
 * at spawn — for drift detection to work in long sessions. Returns null on any
 * failure (detached/empty repo, no git). `dir` is the toplevel from detectCurrentRepo.
 */
export function gitHead(dir: string): string | null {
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(head) ? head.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function detectCurrentRepo(cwd: string = process.cwd()): DetectedRepo | null {
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (!toplevel) return null;

  let remoteUrl: string;
  try {
    remoteUrl = execFileSync("git", ["-C", toplevel, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }

  const ownerRepo = parseGithubOwnerRepo(remoteUrl);
  if (!ownerRepo) return null;

  return { ownerRepo, toplevel };
}

// Accepts both common GitHub remote URL forms:
//   git@github.com:owner/name.git
//   https://github.com/owner/name.git
//   https://github.com/owner/name
//   ssh://git@github.com/owner/name.git
// Returns "owner/name" with the .git suffix stripped. Returns null when the
// remote isn't a GitHub URL (we deliberately don't try to handle GitLab /
// Bitbucket here — replen's handoff PR mechanism is GitHub-only).
export function parseGithubOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const httpsMatch = trimmed.match(/^(?:https?|ssh):\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+)$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  return null;
}
