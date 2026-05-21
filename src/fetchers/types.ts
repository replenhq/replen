export type FetchedCandidate = {
  source: string;
  sourceItemId: string;
  title: string;
  url: string;
  githubUrl: string | null;
  author: string | null;
  score: number | null;
  postedAt: Date | null;
  raw: unknown;
  // Pipeline v2 / Sprint 1 — inventory-level metadata. Optional because
  // not every fetcher can populate it cheaply (HN/Reddit/Threads/TikTok
  // pre-resolve don't know the language of the linked repo). Stage 2
  // eligibility treats null as "unknown, defer to LLM tier."
  primaryLanguage?: string | null;
  topics?: string[] | null;
  repoShape?: import("./repo-shape").RepoShape | null;
};

export type FetcherContext = {
  // Comma-separated primary languages detected from the user's own GitHub repos
  // (e.g. "TypeScript,Python,Go"). Currently only consumed by gh-trending so it
  // can pull language-specific trending pages - most TikTok/Threads "find of the
  // day" creators just repackage gh-trending, so widening that lens is the
  // highest-leverage thing we can do for signal quality.
  detectedLanguages?: string | null;
  // Per-user fetcher hook. gh-search reads + writes project_profiles for this
  // user. Most fetchers ignore it.
  userId?: number;
};

export type Fetcher = {
  name: string;
  run(ctx?: FetcherContext): Promise<FetchedCandidate[]>;
};
