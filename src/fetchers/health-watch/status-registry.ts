// Pattern C / C13 — vendor status pages. Maps the managed services a project
// depends on to their public status page. v1 covers vendors confirmed on the
// standard Statuspage API (GET <host>/api/v2/incidents/unresolved.json); custom
// status systems (OpenAI, Stripe, Anthropic) are a documented follow-on.

export type StatusVendor = {
  id: string;
  name: string;
  // Manifest package names (lowercased) that imply the project uses this
  // managed service.
  depSignals: string[];
  // Statuspage host (no scheme). Must speak the standard /api/v2 endpoints.
  statusHost: string;
};

export const STATUS_VENDORS: StatusVendor[] = [
  { id: "vercel", name: "Vercel", depSignals: ["next", "@vercel/analytics", "@vercel/kv", "@vercel/blob"], statusHost: "www.vercel-status.com" },
  { id: "supabase", name: "Supabase", depSignals: ["@supabase/supabase-js", "@supabase/ssr"], statusHost: "status.supabase.com" },
  { id: "redis", name: "Redis Cloud", depSignals: ["ioredis", "redis"], statusHost: "status.redis.io" },
  { id: "mongodb", name: "MongoDB Cloud", depSignals: ["mongodb", "mongoose"], statusHost: "status.mongodb.com" },
  { id: "cloudflare", name: "Cloudflare", depSignals: ["wrangler", "@cloudflare/workers-types", "@cloudflare/next-on-pages"], statusHost: "www.cloudflarestatus.com" },
  { id: "github", name: "GitHub", depSignals: ["@octokit/rest", "@octokit/core", "octokit", "@octokit/graphql"], statusHost: "www.githubstatus.com" },
  { id: "netlify", name: "Netlify", depSignals: ["netlify", "@netlify/functions", "@netlify/blobs"], statusHost: "www.netlifystatus.com" },
];

const byDep = new Map<string, StatusVendor>();
for (const v of STATUS_VENDORS) for (const d of v.depSignals) byDep.set(d.toLowerCase(), v);

export function statusVendorsForDeps(deps: Set<string>): StatusVendor[] {
  const seen = new Map<string, StatusVendor>();
  for (const d of deps) {
    const v = byDep.get(d);
    if (v) seen.set(v.id, v);
  }
  return [...seen.values()];
}
