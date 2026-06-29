// Immersion tier resolution. The tier controls how deeply Replen grounds on a
// project's actual code. Stored as a per-account default (user_settings
// .immersion_tier) with an optional per-repo override (project_profiles
// .immersion_tier).
//
// SELF-HOST is special: the server is the user's own machine, so reading local
// disk crosses no trust boundary. A single-tenant install therefore defaults ON
// via the REPLEN_SELF_HOST env flag — no settings UI, no per-row write, no
// crippleware. The account-level column stays at its 'off' default there and is
// simply ignored (a self-host operator turns it off by unsetting the env flag,
// or per-repo via an override).

export type ImmersionTier = "off" | "embeddings" | "full-code";

const VALID: ReadonlySet<string> = new Set(["off", "embeddings", "full-code"]);

/** True when this is a single-tenant self-host install (server == user's machine). */
export function isSelfHost(): boolean {
  const v = (process.env.REPLEN_SELF_HOST ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function coerce(t: string | null | undefined): ImmersionTier | null {
  return t && VALID.has(t) ? (t as ImmersionTier) : null;
}

/**
 * Resolve the effective tier for a repo. Precedence:
 *   1. per-repo override (when explicitly set) — the most specific signal
 *   2. self-host → 'embeddings' (default-on; the account column is just the DB
 *      default there and carries no deliberate choice)
 *   3. hosted → the account-level opt-in, else 'off'
 * (Per-repo-vs-account precedence on hosted is flagged as an open question; the
 * per-repo override winning is the proposed default.)
 */
export function resolveImmersionTier(opts: { accountTier?: string | null; repoTier?: string | null }): ImmersionTier {
  const repo = coerce(opts.repoTier);
  if (repo) return repo;
  if (isSelfHost()) return "embeddings";
  return coerce(opts.accountTier) ?? "off";
}
