// Opens a PR in the user's own repo with a handoff.md file describing a
// starred OSS match. Used by the dashboard's "create handoff" action.
//
// All calls go through the GitHub REST API with the user's write-scoped PAT.
// Errors throw - callers should catch and surface to the user.

const API = "https://api.github.com";

type GhClient = { token: string };

function gh(client: GhClient, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${client.token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "replen",
      ...(init.headers ?? {}),
    },
  });
}

async function ghJson<T = any>(client: GhClient, path: string, init?: RequestInit): Promise<T> {
  const res = await gh(client, path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

export type CreateHandoffPRInput = {
  token: string;          // write-scoped PAT
  ownerRepo: string;      // "owner/name" of the user's project repo
  filePath: string;       // e.g. ".digest/handoffs/roboflow-supervision-20260514.md"
  fileContent: string;    // the markdown
  branch: string;         // new branch name
  prTitle: string;
  prBody: string;
};

export type CreateHandoffPRResult = {
  prUrl: string;          // html_url of the PR
  skipped?: "file_exists"; // already-existing file → no PR created
};

export async function createHandoffPR(input: CreateHandoffPRInput): Promise<CreateHandoffPRResult> {
  const [owner, repo] = input.ownerRepo.split("/");
  if (!owner || !repo) throw new Error(`bad ownerRepo: ${input.ownerRepo}`);

  const client: GhClient = { token: input.token };

  const repoInfo = await ghJson<{ default_branch: string; permissions?: { push?: boolean } }>(
    client,
    `/repos/${owner}/${repo}`
  );
  if (repoInfo.permissions && repoInfo.permissions.push === false) {
    throw new Error(`PAT does not have push access to ${input.ownerRepo}`);
  }
  const defaultBranch = repoInfo.default_branch;

  const existsRes = await gh(
    client,
    `/repos/${owner}/${repo}/contents/${encodeURIPathSegments(input.filePath)}?ref=${encodeURIComponent(defaultBranch)}`
  );
  if (existsRes.ok) {
    return { prUrl: "", skipped: "file_exists" };
  }

  const tip = await ghJson<{ object: { sha: string } }>(
    client,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
  );

  // 422 here means the branch already exists — fine on retry.
  const branchRes = await gh(client, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: tip.object.sha }),
  });
  if (!branchRes.ok && branchRes.status !== 422) {
    const body = await branchRes.text().catch(() => "");
    throw new Error(`branch create failed: ${branchRes.status} ${body.slice(0, 300)}`);
  }

  await ghJson(client, `/repos/${owner}/${repo}/contents/${encodeURIPathSegments(input.filePath)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: `digest: handoff for ${input.prTitle.replace(/^Handoff: /, "")}`,
      content: Buffer.from(input.fileContent, "utf8").toString("base64"),
      branch: input.branch,
    }),
  });

  const pr = await ghJson<{ html_url: string }>(client, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.prTitle,
      head: input.branch,
      base: defaultBranch,
      body: input.prBody,
    }),
  });

  return { prUrl: pr.html_url };
}

function encodeURIPathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// Reads the live state of a PR by URL. Returns 'open' | 'closed' | 'merged'.
// The handoff PR URL is stored as `https://github.com/<owner>/<repo>/pull/<n>`;
// we extract owner/repo/number to query the API directly.
export type PrState = "open" | "closed" | "merged" | "missing";

export async function fetchPrState(token: string, prUrl: string): Promise<PrState> {
  const m = prUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!m) return "missing";
  const [, owner, repo, num] = m;
  try {
    const pr = await ghJson<{ state: "open" | "closed"; merged: boolean }>(
      { token },
      `/repos/${owner}/${repo}/pulls/${num}`,
    );
    if (pr.merged) return "merged";
    return pr.state;
  } catch (e) {
    console.warn(`[fetchPrState] ${prUrl} → ${(e as Error).message}`);
    return "missing";
  }
}
