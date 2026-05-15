// Renders the handoff.md content that gets committed to the user's project
// repo when they create a handoff PR for a starred match.

type Repo = {
  owner: string;
  name: string;
  url: string;
  stars: number | null;
  primaryLanguage: string | null;
  license: string | null;
};

type Match = {
  writeupMd: string | null;
  summary: string | null;
  whyUseful: string | null;
  suggestedUse: string | null;
  integrationApproach: string | null;
  risks: string | null;
  relevance: string;
  relevanceScore: number | null;
};

export function renderHandoff(
  match: Match,
  repo: Repo,
  projectSlug: string,
  filePath: string,
): string {
  // Strip the metadata footer from the writeup if present.
  const writeup = (match.writeupMd ?? "").split("\n\n— — —\n")[0].trim() || match.summary || "";

  return `# Integration brief: ${repo.owner}/${repo.name}

**Surfaced by**: OSS Digest on ${new Date().toISOString().slice(0, 10)}
**Source repo**: ${repo.url}
**Project**: ${projectSlug}
**Snapshot**: ${repo.stars ?? "?"}★ · ${repo.primaryLanguage ?? "?"} · ${repo.license ?? "no license"}
**Initial relevance**: ${match.relevance}${match.relevanceScore != null ? ` (${match.relevanceScore})` : ""}
**Suggested approach**: ${match.integrationApproach ?? "n/a"}

## Why this surfaced

${writeup}

## Suggested first action (from the writeup)

> ${match.suggestedUse ?? "(none provided)"}

## Risks flagged at discovery time

> ${match.risks ?? "(none flagged)"}

## Re-evaluate with codebase context

The writeup above was generated *without* access to this repo's source. Open
this folder in **Claude Code**, **Codex**, or another codebase-aware assistant
and prompt:

> Read \`${filePath}\`. Cross-check the proposed plug points against the
> actual code in this repo. For each plug point:
>   1. Cite the specific file/module you'd modify
>   2. Flag any plug points that don't apply given how this code is structured
>   3. Propose a concrete next step (PR scope, branch name, time estimate)
> Then add a "Verdict" section at the bottom of this file with your conclusion.

## Source repo at a glance

${repo.url}/blob/HEAD/README.md
${repo.url}/issues
${repo.url}/pulls
`;
}

export function handoffFilePath(repoOwner: string, repoName: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = `${repoOwner}-${repoName}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `.digest/handoffs/${slug}-${date}.md`;
}

export function handoffBranchName(repoOwner: string, repoName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = `${repoOwner}-${repoName}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `digest/handoff-${slug}-${date}`;
}
