// GitHub-API activity probe. Produces a ProjectActivity that the
// downstream consumers (summariseActivity, reasonAboutRepo, the
// activity-pill UI) all read from. src/projects/activity.ts still
// owns the ProjectActivity type definition.
//
// Data sources per field:
//   commits           — /repos/{o}/{n}/commits?author=<viewer>&since=<30d>
//   topChangedFiles   — (intentionally empty for v1; would require
//                        N+1 commit-detail fetches. v2 can do GraphQL
//                        if the signal turns out to matter.)
//   todoClusters      — /search/code?q=(TODO OR FIXME) repo:{o}/{n}
//   openPRs           — /repos/{o}/{n}/pulls?state=open  (existing call)
//   headSha/branch    — fetchRepoHead

import { fetchRepoHead, GitHubApiError } from "./repo-content";
import type {
  CommitRow,
  ChangedFile,
  TodoCluster,
  OpenPR,
  ProjectActivity,
} from "../projects/activity";

const BASE = "https://api.github.com";
const LOOKBACK_DAYS = 30;
const MAX_COMMITS = 100;
const TODO_SEARCH_CAP = 100;
const OPEN_PR_CAP = 10;

// Cache the authenticated-user login per token for one orchestrator
// process. ~36 projects per run × one /user call each would be wasteful;
// the result is invariant across all projects within a single PAT.
const viewerCache = new Map<string, Promise<string | null>>();

export async function probeActivityViaApi(
  owner: string,
  name: string,
  token: string,
): Promise<ProjectActivity> {
  const head = await fetchRepoHead(owner, name, token);
  if (!head) {
    return emptyActivity();
  }
  if (head.archived) {
    // Archived repo: still surface the head SHA so the cache predicate
    // works, but skip the rest. No fresh activity is coming.
    return { ...emptyActivity(), isGitRepo: true, headSha: head.headSha, branch: head.defaultBranch };
  }

  const viewer = await getViewerLogin(token);
  const commits = await fetchCommits(owner, name, viewer, token);
  const todoClusters = await fetchTodoClusters(owner, name, token);
  const openPRs = await fetchOpenPRs(owner, name, token);

  const daysSinceLastCommit = commits.length > 0
    ? Math.floor((Date.now() - new Date(commits[0].isoDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    isGitRepo: true,
    headSha: head.headSha,
    branch: head.defaultBranch,
    commits,
    topChangedFiles: [] as ChangedFile[],
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

async function getViewerLogin(token: string): Promise<string | null> {
  let p = viewerCache.get(token);
  if (!p) {
    p = (async () => {
      const r = await ghJson(token, `${BASE}/user`);
      if (!r) return null;
      return typeof r.login === "string" ? r.login : null;
    })();
    viewerCache.set(token, p);
  }
  return p;
}

async function fetchCommits(owner: string, name: string, viewer: string | null, token: string): Promise<CommitRow[]> {
  // `since` must be ISO-8601. We filter author-side so the result is
  // "what the user did in this repo" — collaborators' commits in the
  // user's own repo aren't activity-aware-matching signal for them.
  // When viewer login is unknown (rare: /user returned null), don't
  // filter — return ALL recent commits. Better signal-from-noise than
  // returning empty.
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const qs = new URLSearchParams({
    since,
    per_page: String(MAX_COMMITS),
  });
  if (viewer) qs.set("author", viewer);
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?${qs.toString()}`;
  // /commits returns a JSON ARRAY at the top level, so we can't use
  // ghJson (typed as Record). Raw fetch.
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "replen",
      },
    });
  } catch (e) {
    console.warn(`[activity-api] commits fetch failed: ${(e as Error).message}`);
    return [];
  }
  if (res.status === 409) {
    // 409 = empty repo (no default branch yet). Treat as no commits.
    return [];
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw await rateLimitError(res);
    }
    console.warn(`[activity-api] commits returned ${res.status}`);
    return [];
  }
  type RawCommit = {
    sha?: string;
    commit?: {
      message?: string;
      author?: { date?: string };
      committer?: { date?: string };
    };
  };
  let items: RawCommit[] = [];
  try { items = (await res.json()) as RawCommit[]; }
  catch { return []; }
  return items
    .map((c): CommitRow | null => {
      if (!c?.sha || !c.commit) return null;
      const isoDate = c.commit.committer?.date ?? c.commit.author?.date ?? null;
      if (!isoDate) return null;
      // First line of the commit message is the subject; same convention
      // git log uses.
      const subject = (c.commit.message ?? "").split("\n")[0].trim();
      return { sha: c.sha, isoDate, subject };
    })
    .filter((c): c is CommitRow => c !== null);
}

async function fetchTodoClusters(owner: string, name: string, token: string): Promise<TodoCluster[]> {
  // GitHub code-search syntax: literal terms + repo qualifier. We don't
  // need text-match details — just the path-per-hit so we can cluster
  // by dir. Public repos must be indexed; for very new private repos
  // there's a brief indexing lag (search may temporarily return [] until
  // the repo is indexed).
  const q = `(TODO OR FIXME) repo:${owner}/${name}`;
  const url = `${BASE}/search/code?q=${encodeURIComponent(q)}&per_page=${TODO_SEARCH_CAP}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "replen",
      },
    });
  } catch (e) {
    console.warn(`[activity-api] todo search failed: ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    // Search has stricter rate limits (10/min for authenticated users).
    // If we exhaust them, just return [] for this project rather than
    // failing the whole pipeline — TODOs are not load-bearing signal.
    if (res.status === 403 || res.status === 429) {
      console.warn(`[activity-api] todo search rate-limited for ${owner}/${name}`);
      return [];
    }
    console.warn(`[activity-api] todo search returned ${res.status} for ${owner}/${name}`);
    return [];
  }
  type SearchRes = { items?: Array<{ path?: string }> };
  let body: SearchRes = {};
  try { body = (await res.json()) as SearchRes; } catch { return []; }
  const items = body.items ?? [];
  // Group by enclosing directory, like the filesystem version did.
  const byDir = new Map<string, number>();
  for (const it of items) {
    if (typeof it.path !== "string") continue;
    const dir = it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/")) : ".";
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  return [...byDir.entries()]
    .map(([dir, count]) => ({ dir, count, examples: [] as string[] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function fetchOpenPRs(owner: string, name: string, token: string): Promise<OpenPR[]> {
  const url = `${BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=${OPEN_PR_CAP}&sort=updated&direction=desc`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "replen",
      },
    });
  } catch (e) {
    console.warn(`[activity-api] PR fetch for ${owner}/${name} failed: ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      console.warn(`[activity-api] PR fetch rate-limited for ${owner}/${name}`);
      return [];
    }
    console.warn(`[activity-api] PR fetch ${owner}/${name} -> ${res.status}`);
    return [];
  }
  type RawPR = {
    number?: number;
    title?: string;
    body?: string;
    head?: { ref?: string };
    updated_at?: string;
  };
  let items: RawPR[] = [];
  try { items = (await res.json()) as RawPR[]; } catch { return []; }
  return items
    .filter((p): p is RawPR & { number: number; title: string } => typeof p.number === "number" && typeof p.title === "string")
    .map((p) => ({
      number: p.number,
      title: p.title,
      bodyExcerpt: typeof p.body === "string" && p.body.trim().length > 0 ? p.body.slice(0, 500) : null,
      branchHead: (p.head as { ref?: string } | undefined)?.ref ?? null,
      updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
    }));
}

// Internal: JSON fetch returning an object (not array). Used for
// /user. Endpoints that return arrays go through raw fetch instead.
async function ghJson(token: string, url: string): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "replen",
      },
    });
  } catch (e) {
    console.warn(`[activity-api] fetch failed: ${(e as Error).message}`);
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) throw await rateLimitError(res);
    return null;
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch { return null; }
}

async function rateLimitError(res: Response): Promise<GitHubApiError> {
  const resetAt = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
  const retryAfterHeader = Number(res.headers.get("retry-after") ?? 0) * 1000;
  const retryAfterMs = retryAfterHeader || (resetAt ? Math.max(0, resetAt - Date.now()) : undefined);
  return new GitHubApiError(res.status, "rate-limited", retryAfterMs);
}
