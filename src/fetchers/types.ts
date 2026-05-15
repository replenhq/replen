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
};

export type FetcherContext = {
  // Comma-separated primary languages detected from the user's own GitHub repos
  // (e.g. "TypeScript,Python,Go"). Currently only consumed by gh-trending so it
  // can pull language-specific trending pages — most TikTok/Threads "find of the
  // day" creators just repackage gh-trending, so widening that lens is the
  // highest-leverage thing we can do for signal quality.
  detectedLanguages?: string | null;
};

export type Fetcher = {
  name: string;
  run(ctx?: FetcherContext): Promise<FetchedCandidate[]>;
};
