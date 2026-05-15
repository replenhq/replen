const GH_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?=[\s)\].,'"!?#/]|$)/gi;

export type RepoRef = { owner: string; name: string; url: string };

export function extractGithubRepos(text: string | null | undefined): RepoRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: RepoRef[] = [];
  for (const m of text.matchAll(GH_RE)) {
    let owner = m[1];
    let name = m[2].replace(/\.git$/i, "");
    if (isReservedOwner(owner) || isReservedName(name)) continue;
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, name, url: `https://github.com/${owner}/${name}` });
  }
  return out;
}

function isReservedOwner(o: string) {
  return ["orgs", "topics", "marketplace", "settings", "notifications", "sponsors", "features"].includes(o.toLowerCase());
}
function isReservedName(n: string) {
  return n.length === 0 || n === "search" || n.startsWith("?");
}
