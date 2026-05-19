// GitHub REST API helpers for reading a user's own project repos. The
// PAT comes from user_settings.githubToken (decrypted upstream via
// readUserSecret); callers pass the decrypted string. We never persist
// or log the token.
//
// All helpers return null on 404 (allowed: file/branch missing) and
// throw GitHubApiError on every other non-2xx. The caller decides
// whether the failure is fatal for its phase or just a missing
// optional input.
//
// Rate-limit handling: when we hit the documented 403+remaining=0
// boundary, we throw with a retryAfterMs so the orchestrator can
// pause the pipeline rather than retrying immediately. There is no
// silent backoff loop in this module — that would mask quota
// exhaustion as latency.

const BASE = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public retryAfterMs?: number,
  ) {
    super(`github api ${status}: ${detail}`);
  }
}

export type GitHubRepoMeta = {
  defaultBranch: string;
  headSha: string;
  pushedAt: string | null;
  archived: boolean;
  size: number;
};

// Single round-trip helper for the cache predicate: "has anything
// changed since we last looked?". Returns the default branch and its
// HEAD sha. Two API calls (repo metadata + ref) — both are cheap and
// the second one is needed for the precise SHA the contents endpoint
// will key off.
export async function fetchRepoHead(
  owner: string,
  name: string,
  token: string,
): Promise<GitHubRepoMeta | null> {
  const repo = await ghGet(token, `${BASE}/repos/${enc(owner)}/${enc(name)}`, true);
  if (!repo) return null;
  const branch = String(repo.default_branch ?? "main");
  const ref = await ghGet(token, `${BASE}/repos/${enc(owner)}/${enc(name)}/git/ref/heads/${enc(branch)}`, true);
  if (!ref) return null;
  const refObj = (ref.object as { sha?: string } | undefined) ?? {};
  return {
    defaultBranch: branch,
    headSha: String(refObj.sha ?? ""),
    pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
    archived: Boolean(repo.archived),
    size: Number(repo.size ?? 0),
  };
}

// Fetch a single file's contents from the repo at a specific ref
// (commit SHA, branch name, or tag). Returns the decoded utf-8 string
// or null if the path doesn't exist. Files >1MB go through the blobs
// endpoint per GitHub docs; we cap at 1MB for safety since READMEs
// and manifests are never that large in practice.
export async function fetchFile(
  owner: string,
  name: string,
  path: string,
  token: string,
  ref?: string,
): Promise<string | null> {
  const url = `${BASE}/repos/${enc(owner)}/${enc(name)}/contents/${path
    .split("/")
    .map(enc)
    .join("/")}${ref ? `?ref=${enc(ref)}` : ""}`;
  const r = await ghGet(token, url, true);
  if (!r) return null;
  if (Array.isArray(r)) return null; // path is a directory
  if (r.type !== "file") return null;
  if (typeof r.content !== "string") return null;
  // GitHub returns content base64-encoded with newlines every 60
  // chars when encoding === "base64". Strip and decode.
  const cleaned = r.content.replace(/\s+/g, "");
  try {
    return Buffer.from(cleaned, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export type TreeEntry = { path: string; type: "blob" | "tree"; size?: number; sha: string };

// Recursive tree listing for a given ref. One API call returns every
// file path in the repo (up to GitHub's 100k entries / 7MB response
// cap). Used for glob-matching (docs/**/*.md, .specify/**/*.md) so we
// don't have to walk dirs with N round-trips.
//
// When truncated === true, callers should fall back to per-path
// fetches for the patterns they care about. In practice no replen
// user has a 100k-file repo.
export async function fetchTree(
  owner: string,
  name: string,
  ref: string,
  token: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean } | null> {
  const r = await ghGet(token, `${BASE}/repos/${enc(owner)}/${enc(name)}/git/trees/${enc(ref)}?recursive=1`, true);
  if (!r) return null;
  const raw = Array.isArray(r.tree) ? r.tree : [];
  const entries: TreeEntry[] = raw
    .filter((e: { type?: unknown }) => e && (e.type === "blob" || e.type === "tree"))
    .map((e: { path: string; type: "blob" | "tree"; size?: number; sha: string }) => ({
      path: e.path,
      type: e.type,
      size: e.size,
      sha: e.sha,
    }));
  return { entries, truncated: Boolean(r.truncated) };
}

// Internal: one fetch + status routing. allow404 lets callers
// distinguish "file genuinely missing" from "auth/permission/quota
// problem"; only the former returns null.
async function ghGet(token: string, url: string, allow404: boolean): Promise<Record<string, unknown> | null> {
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
    throw new GitHubApiError(0, `network: ${(e as Error).message}`);
  }
  if (res.status === 404 && allow404) return null;
  if (res.status === 403 || res.status === 429) {
    // Distinguish "primary rate limit hit" (x-ratelimit-remaining=0)
    // from "secondary rate limit" (no remaining=0 but a Retry-After
    // header or abuse-detection body). Both block further calls.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetAt = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const retryAfterHeader = Number(res.headers.get("retry-after") ?? 0) * 1000;
    const retryAfterMs = retryAfterHeader || (resetAt ? Math.max(0, resetAt - Date.now()) : undefined);
    const detail = remaining === "0" ? "primary rate limit exhausted" : "forbidden or secondary rate limit";
    throw new GitHubApiError(res.status, detail, retryAfterMs);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new GitHubApiError(res.status, detail || res.statusText);
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new GitHubApiError(res.status, `bad json: ${(e as Error).message}`);
  }
}

// URI-encode a single path segment. encodeURIComponent encodes "/" too,
// which is what we want when "/" inside a path segment should escape.
function enc(s: string): string {
  return encodeURIComponent(s);
}
