// "Does this user use this tool?" — token derivation shared by the pricing
// watch and the announcement sources. A tool/vendor name becomes a small set
// of normalized tokens that get matched (exact, lowercased) against a user's
// manifest deps and project tags. Generic words are excluded so "AWS Pricing
// Hub" never matches everyone via "pricing" or "hub".

// Words too generic to identify a tool in a user's deps/tags.
export const GENERIC_TOKENS = new Set([
  "pricing", "hub", "page", "cloud", "platform", "api", "apis", "developer", "developers",
  "tools", "tool", "service", "services", "suite", "app", "apps", "data", "web", "labs",
  "inc", "the", "and", "for", "pro", "plus", "studio", "stack", "open", "source",
  "manager", "management", "security", "analytics", "storage", "hosting", "search",
  "email", "payments", "billing", "amazon", "google", "microsoft", "core", "edge",
  "releases", "release", "cli", "sdk", "docs", "server", "client", "node", "python",
  "javascript", "atlas", "typescript", "orm", "framework", "engine", "database",
]);

// Vendor-level aliases users actually have in tags/deps.
export const VENDOR_ALIASES: Record<string, string[]> = {
  "amazon web services": ["aws"],
  "google cloud": ["gcp", "google-cloud"],
  "microsoft azure": ["azure"],
  "atlassian": ["jira", "bitbucket", "confluence"],
  "kubernetes": ["k8s"],
};

export const normToken = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// Tokens for a (vendor, product) pair, optionally enriched with the GitHub
// owner/repo from a source URL (repo names are often the manifest name:
// supabase-js → supabase, next.js → next).
export function detectTokens(vendor: string, product: string, sourceUrl?: string | null): string[] {
  const out = new Set<string>();
  const parts = [normToken(vendor), normToken(product)];
  const gh = sourceUrl?.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (gh) {
    parts.push(normToken(gh[1]), normToken(gh[2].replace(/\.git$/, "")));
  }
  for (const p of parts) {
    if (!p) continue;
    out.add(p);
    for (const w of p.split(" ")) {
      if (w.length >= 3 && !GENERIC_TOKENS.has(w)) out.add(w);
    }
  }
  for (const a of VENDOR_ALIASES[normToken(vendor)] ?? []) out.add(a);
  return [...out].filter((t) => !GENERIC_TOKENS.has(t));
}

// The user-side counterpart: a token set from manifest deps + project tags.
// Scoped deps catch SDK-installed tools (@supabase/supabase-js → supabase);
// tags catch platform-level ones a manifest can't see (aws, vercel, datadog).
export function userToolTokens(deps: Iterable<string>, tags: Iterable<string>): Set<string> {
  const tokens = new Set<string>();
  for (const t of tags) {
    const tl = String(t).toLowerCase();
    if (tl) tokens.add(tl);
  }
  for (const d of deps) {
    const dl = String(d).toLowerCase();
    if (!dl) continue;
    tokens.add(dl);
    const scoped = dl.match(/^@([^/]+)\//);
    if (scoped) tokens.add(scoped[1]);
    for (const part of dl.split(/[^a-z0-9]+/)) if (part.length >= 3) tokens.add(part);
  }
  return tokens;
}

// Stricter counterpart to userToolTokens: EXACT declared identities only — full
// dep names, scoped-package owners (@supabase/x → supabase), and tags — with NO
// hyphen/word-part splitting. Used to gate aggregator SECURITY headlines so a
// generic word-part ("csrf" split out of "csrf-request-validator") can't match a
// "CSRF in Dropzone" headline; only a dependency or tag the user ACTUALLY
// declares surfaces an advisory. Version-confirmed dep matches are unaffected.
export function declaredToolTokens(deps: Iterable<string>, tags: Iterable<string>): Set<string> {
  const tokens = new Set<string>();
  for (const t of tags) {
    const tl = String(t).toLowerCase();
    if (tl) tokens.add(tl);
  }
  for (const d of deps) {
    const dl = String(d).toLowerCase();
    if (!dl) continue;
    tokens.add(dl);
    const scoped = dl.match(/^@([^/]+)\//);
    if (scoped) tokens.add(scoped[1]);
  }
  return tokens;
}
