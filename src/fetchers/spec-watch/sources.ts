// Per-kind adapters that turn a spec source into recent "what changed" items.
// Each adapter is best-effort and self-contained: a failure throws and the
// fetcher skips that source rather than failing the whole run.

import type { SpecSource } from "./registry";

export type SpecItem = {
  sourceItemId: string; // stable per (source, item) for ON CONFLICT dedup
  title: string;
  url: string;
  githubUrl: string | null;
  postedAt: Date | null;
  summary: string | null;
};

const GH_HEADERS = (token?: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  "user-agent": "replen/spec-watch",
  "x-github-api-version": "2022-11-28",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

export async function fetchRecentForSource(
  source: SpecSource,
  opts: { sinceMs: number; ghToken?: string; maxItems: number },
): Promise<SpecItem[]> {
  switch (source.kind) {
    case "eip":
      return fetchEipLike(source, opts);
    case "tc39":
      return fetchTc39(source, opts);
    case "browser":
      return fetchChromeStatus(source, opts);
    default:
      return [];
  }
}

// EIPs / ERCs: recent commits to the standards repo. Commit subjects look like
// "Update EIP-8146: ..." / "Add ERC-7710: ...". We extract the standard number,
// keep the LATEST commit per number (a standard touched 3× this week is one
// item, not three), and cap.
async function fetchEipLike(source: SpecSource, opts: { sinceMs: number; ghToken?: string; maxItems: number }): Promise<SpecItem[]> {
  const repo = source.githubRepo;
  if (!repo) return [];
  const since = new Date(opts.sinceMs).toISOString();
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100`,
    { headers: GH_HEADERS(opts.ghToken) },
  );
  if (!res.ok) throw new Error(`GET commits ${repo} → ${res.status}`);
  const commits = (await res.json()) as Array<{
    sha: string;
    html_url: string;
    commit: { message: string; author: { date: string } | null };
  }>;

  // standard number -> best (latest) item
  const byStd = new Map<string, SpecItem>();
  const re = /\b(EIP|ERC)-?(\d{1,5})\b/i;
  for (const c of commits) {
    const subject = (c.commit.message || "").split("\n")[0].trim();
    const m = subject.match(re);
    if (!m) continue; // not a standard-bearing commit (CI, lint, etc.)
    const std = `${m[1].toUpperCase()}-${m[2]}`;
    const dateMs = c.commit.author?.date ? Date.parse(c.commit.author.date) : NaN;
    const postedAt = Number.isFinite(dateMs) ? new Date(dateMs) : null;
    const prev = byStd.get(std);
    if (prev && prev.postedAt && postedAt && prev.postedAt >= postedAt) continue;
    // Subjects read like "Update EIP-8146: <desc>" / "Add ERC-7964: <desc>".
    // Prefer the text after the first colon; else strip the leading verb + the
    // standard token so we don't show "Update :".
    const desc = subject.includes(":")
      ? subject.slice(subject.indexOf(":") + 1).trim()
      : subject.replace(re, "").replace(/^(update|add|create|edit|fix|merge|move)\b/i, "").replace(/^[\s:–-]+/, "").trim();
    byStd.set(std, {
      sourceItemId: `${std}@${c.sha.slice(0, 12)}`,
      title: `${std}: ${desc || "updated"}`,
      url: c.html_url,
      githubUrl: `https://github.com/${repo}`,
      postedAt,
      summary: subject,
    });
  }
  return topByDate([...byStd.values()], opts.maxItems);
}

// TC39: recent commits to tc39/proposals. Stage advancements read like
// "Iterator Join to stage 3, per 2026.05.20 TC39". We keep only commits that
// mention a stage move — those are the meaningful "JS is getting X" signals.
async function fetchTc39(source: SpecSource, opts: { sinceMs: number; ghToken?: string; maxItems: number }): Promise<SpecItem[]> {
  const repo = source.githubRepo;
  if (!repo) return [];
  const since = new Date(opts.sinceMs).toISOString();
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100`,
    { headers: GH_HEADERS(opts.ghToken) },
  );
  if (!res.ok) throw new Error(`GET commits ${repo} → ${res.status}`);
  const commits = (await res.json()) as Array<{
    sha: string;
    html_url: string;
    commit: { message: string; author: { date: string } | null };
  }>;

  const out: SpecItem[] = [];
  const stageRe = /\bstage\s*([0-4])\b/i;
  for (const c of commits) {
    const subject = (c.commit.message || "").split("\n")[0].trim();
    const m = subject.match(stageRe);
    if (!m) continue;
    const dateMs = c.commit.author?.date ? Date.parse(c.commit.author.date) : NaN;
    out.push({
      sourceItemId: `tc39@${c.sha.slice(0, 12)}`,
      title: `TC39: ${subject}`,
      url: c.html_url,
      githubUrl: `https://github.com/${repo}`,
      postedAt: Number.isFinite(dateMs) ? new Date(dateMs) : null,
      summary: subject,
    });
  }
  return topByDate(out, opts.maxItems);
}

// Chrome Platform Status: deprecated/removed web-platform features in the
// recent stable + beta milestones. The API prefixes its JSON with an XSSI
// guard (")]}'\n") which we strip before parsing.
async function fetchChromeStatus(source: SpecSource, opts: { sinceMs: number; maxItems: number }): Promise<SpecItem[]> {
  // The channel's milestone number is `mstone` (fallback `version`), NOT
  // `milestone`. Deprecations/removals are sparse per release, so scan the
  // current stable/beta/dev plus the two milestones below stable.
  const channels = await chromeJson<Record<string, { mstone?: number; version?: number }>>("https://chromestatus.com/api/v0/channels");
  const milestones = new Set<number>();
  for (const key of ["stable", "beta", "dev"]) {
    const ch = channels?.[key];
    const m = ch?.mstone ?? ch?.version;
    if (typeof m === "number") milestones.add(m);
  }
  const stable = channels?.stable?.mstone ?? channels?.stable?.version;
  if (typeof stable === "number") {
    milestones.add(stable - 1);
    milestones.add(stable - 2);
  }
  if (milestones.size === 0) return [];

  const out: SpecItem[] = [];
  for (const ms of milestones) {
    const data = await chromeJson<{ features_by_type?: Record<string, Array<{ id: number; name: string; summary?: string }>> }>(
      `https://chromestatus.com/api/v0/features?milestone=${ms}`,
    ).catch(() => null);
    const buckets = data?.features_by_type ?? {};
    for (const [bucket, feats] of Object.entries(buckets)) {
      const b = bucket.toLowerCase();
      if (!b.includes("deprecat") && !b.includes("remov")) continue; // only deprecations/removals
      for (const f of feats) {
        out.push({
          sourceItemId: `chrome-${f.id}-m${ms}`,
          title: `Chrome ${ms}: ${bucket} — ${f.name}`,
          url: `https://chromestatus.com/feature/${f.id}`,
          githubUrl: null,
          postedAt: null, // milestone-dated, not timestamped
          summary: f.summary ? f.summary.slice(0, 600) : null,
        });
      }
    }
  }
  // Newest milestone first by id ordering of sourceItemId is unreliable; just cap.
  return out.slice(0, opts.maxItems);
}

async function chromeJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { "user-agent": "replen/spec-watch", accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const text = await res.text();
  // Strip the XSSI guard prefix ")]}'" (with or without trailing newline).
  const stripped = text.replace(/^\)\]\}'[\s]*/, "");
  return JSON.parse(stripped) as T;
}

function topByDate(items: SpecItem[], max: number): SpecItem[] {
  return items
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .slice(0, max);
}
