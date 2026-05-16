import { readRunOrEnv } from "../analyzer/run-context";

const GH_API = "https://api.github.com";

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "replen/0.1",
    accept: "application/vnd.github+json",
  };
  const tok = readRunOrEnv("githubToken", "GITHUB_TOKEN");
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

export type RepoMeta = {
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  pushedAt: string | null;
  createdAt: string | null;
  defaultBranch: string;
  language: string | null;
  license: string | null;
  archived: boolean;
  disabled: boolean;
};

export async function fetchRepoMeta(owner: string, name: string): Promise<RepoMeta | null> {
  const res = await fetch(`${GH_API}/repos/${owner}/${name}`, { headers: headers() });
  if (!res.ok) return null;
  const j: any = await res.json();
  return {
    owner: j.owner?.login ?? owner,
    name: j.name,
    description: j.description,
    stars: j.stargazers_count ?? 0,
    forks: j.forks_count ?? 0,
    pushedAt: j.pushed_at ?? null,
    createdAt: j.created_at ?? null,
    defaultBranch: j.default_branch ?? "main",
    language: j.language ?? null,
    license: j.license?.spdx_id ?? null,
    archived: !!j.archived,
    disabled: !!j.disabled,
  };
}

// Hard cap on README bytes. Bigger than any legitimate human-written README;
// the analyzer slices to 15K downstream anyway. Without a cap, a 100MB
// README would load entirely into memory before slicing.
const README_MAX_BYTES = 512 * 1024;

export async function fetchReadme(owner: string, name: string): Promise<{ sha: string; md: string } | null> {
  const res = await fetch(`${GH_API}/repos/${owner}/${name}/readme`, {
    headers: { ...headers(), accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok) return null;
  // Stream-read up to README_MAX_BYTES then abort. Avoids reading a
  // gigantic file into memory before slicing.
  const reader = res.body?.getReader();
  if (!reader) {
    const md = (await res.text()).slice(0, README_MAX_BYTES);
    return { sha: await sha1(md), md };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < README_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  const md = new TextDecoder("utf-8").decode(Buffer.concat(chunks)).slice(0, README_MAX_BYTES);
  const sha = await sha1(md);
  return { sha, md };
}

export async function fetchContributorCount(owner: string, name: string): Promise<number> {
  // per_page=1 + Link header gives an exact count cheaply
  const res = await fetch(`${GH_API}/repos/${owner}/${name}/contributors?per_page=1&anon=true`, {
    headers: headers(),
  });
  if (!res.ok) return 0;
  const link = res.headers.get("link");
  if (link) {
    const m = link.match(/page=(\d+)>;\s*rel="last"/);
    if (m) return parseInt(m[1], 10);
  }
  const arr = (await res.json()) as unknown[];
  return Array.isArray(arr) ? arr.length : 0;
}

export async function fetchFileContent(owner: string, name: string, path: string, ref: string): Promise<string | null> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${name}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { headers: { ...headers(), accept: "application/vnd.github.raw+json" } }
  );
  if (!res.ok) return null;
  return await res.text();
}

async function sha1(s: string) {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
