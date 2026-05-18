// Filter for "big-company / enterprise OSS that shouldn't dominate a personal
// discovery feed". We're looking for *new* tools we could plug into our own
// projects - not Anthropic's product launches, not Vercel's marketing repos,
// not the Linux kernel.
//
// Two layers:
//   1. Owner blocklist - exact GitHub org/user matches that we never want.
//   2. Star ceiling - anything above N stars is by definition not under-the-radar.

export const BIG_CO_OWNERS = new Set<string>([
  // AI / model vendors
  "anthropic", "openai", "google", "google-ai-edge", "google-deepmind", "deepmind",
  "meta-llama", "facebookresearch", "facebook", "huggingface",
  // Cloud / infra giants
  "microsoft", "azure", "aws", "amazon", "amazonwebservices", "googlecloudplatform",
  // Big OSS-as-SaaS companies
  "vercel", "supabase", "neondatabase", "planetscale", "cloudflare",
  "stripe", "shopify", "linear", "notion-os", "github",
  // Mega-projects (linux/k8s/etc.)
  "torvalds", "kubernetes", "kubernetes-sigs", "etcd-io",
  // BigCo-adjacent
  "nestjs", "nodejs", "denoland", "bunjs", "rust-lang",
  "vuejs", "facebook", "vercel-labs", "shadcn-ui",
]);

// Drop anything above this star count as "established, not under-the-radar".
// The whole point of the digest is *new* projects worth knowing about.
export const STAR_CEILING = parseInt(process.env.REPLEN_STAR_CEILING ?? "30000", 10);

export function isBigCoOwner(owner: string): boolean {
  return BIG_CO_OWNERS.has(owner.toLowerCase());
}

export function isTooEstablished(stars: number | null | undefined): boolean {
  if (typeof stars !== "number") return false;
  return stars >= STAR_CEILING;
}

export function shouldSkip(owner: string, stars: number | null | undefined): { skip: boolean; reason?: string } {
  if (isBigCoOwner(owner)) return { skip: true, reason: `big-co owner: ${owner}` };
  if (isTooEstablished(stars)) return { skip: true, reason: `too established: ${stars} stars` };
  return { skip: false };
}
