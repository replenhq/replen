// Pipeline v2 / Sprint 4 Layer A — "user already knows about it" dedup.
//
// If a candidate is already in the user's package.json / pyproject.toml /
// Cargo.toml / go.mod, the user definitionally knows about it. Suggesting
// it back to them is noise. This module builds a single set of all
// dep-identifying tokens (lowercased) across the user's active+included
// projects, which the eligibility filter can probe per-candidate in O(1).
//
// Matching strategy: a candidate is "known" if EITHER the candidate's
// github repo name OR its owner appears in the dep-token set. Covers:
//   - npm  fluent-ffmpeg → github fluent-ffmpeg/node-fluent-ffmpeg (owner match)
//   - npm  react         → github facebook/react (repo-name match)
//   - pypi requests      → github psf/requests (repo-name match)
//   - npm  @reduxjs/toolkit → github reduxjs/redux-toolkit (scope strip → owner match)
//
// False positives (a candidate happens to share a name with one of your
// deps but is actually a different project) are rare and low-cost. False
// negatives (your dep doesn't match the candidate's repo or owner)
// degrade gracefully: candidate flows through to the LLM tier as before.

import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import { parseManifests } from "../projects/manifest-parser";
import { GitHubApiError, fetchFile } from "../github/repo-content";
import ecosystemMainstream from "../datasets/ecosystem-mainstream.json";

/** Map user-language → ecosystem-mainstream key. Detected languages
 *  come canonical-cased from the GitHub /user/repos API ("TypeScript",
 *  "Python") and may also include shell scripts etc. that we don't
 *  cover. Mapping lowercased + collapsing JS/TS into one family.
 */
function ecosystemKeyFor(lang: string): string | null {
  const l = lang.toLowerCase().trim();
  if (l === "typescript" || l === "javascript" || l === "tsx" || l === "jsx") return "ts-js";
  if (l === "python") return "python";
  if (l === "rust") return "rust";
  if (l === "go") return "go";
  if (l === "java" || l === "kotlin") return "java-kotlin";
  if (l === "swift") return "swift";
  return null;
}

/** Add the curated ecosystem-mainstream tokens for each of the user's
 *  detected languages. Layer B of the under-the-radar dedup — fires
 *  even when the user hasn't installed the lib via their package.json
 *  (e.g. they're using axios via a wrapper, or just generally know
 *  react exists because they're a TS dev). Cheap, static, runs in O(1).
 */
function seedMainstream(known: Set<string>, detectedLanguagesCsv: string | null): void {
  if (!detectedLanguagesCsv) return;
  const langs = detectedLanguagesCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const seeded = new Set<string>();
  for (const lang of langs) {
    const key = ecosystemKeyFor(lang);
    if (!key || seeded.has(key)) continue;
    seeded.add(key);
    const raw = (ecosystemMainstream as unknown as Record<string, unknown>)[key];
    const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    for (const name of list) known.add(name.toLowerCase());
  }
}

/** Build the lowercased token set of "things this user has in any
 *  project manifest" + Layer B ecosystem-mainstream seeds for each
 *  of the user's detected languages. Pulls manifests via GitHub's
 *  Contents API on each call — cheap (~5 API calls per project, 404s
 *  return fast). Returns an empty set on token failure or when no
 *  projects have a resolvable github_full_name.
 */
export async function getKnownDeps(userId: number, ghToken: string | null | undefined): Promise<Set<string>> {
  const known = new Set<string>();
  // Layer B always fires (uses static curated lists, no GitHub call).
  // Pull the user's detected languages so we seed the right ecosystem.
  const settings = await db
    .select({ detectedLanguages: schema.userSettings.detectedLanguages })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .get();
  seedMainstream(known, settings?.detectedLanguages ?? null);
  if (!ghToken) return known;

  const projects = await db
    .select({
      id: schema.projectProfiles.id,
      slug: schema.projectProfiles.slug,
      githubFullName: schema.projectProfiles.githubFullName,
    })
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, userId),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
    ));

  for (const p of projects) {
    if (!p.githubFullName || !/^[\w.-]+\/[\w.-]+$/.test(p.githubFullName)) continue;
    const [owner, name] = p.githubFullName.split("/");
    let manifest;
    try {
      manifest = await parseManifests(async (filename) => {
        try { return await fetchFile(owner, name, filename, ghToken); }
        catch (e) {
          // Rate-limit / forbidden — bail this project but keep the
          // partial set we've collected from prior projects.
          if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) throw e;
          return null;
        }
      });
    } catch (e) {
      if (e instanceof GitHubApiError) {
        console.warn(`[known-deps] GitHub API ${e.status} fetching manifests for ${p.slug}; bailing dep enumeration`);
        return known;
      }
      console.warn(`[known-deps] ${p.slug} manifest fetch failed:`, e);
      continue;
    }
    if (!manifest.hasManifest) continue;
    for (const d of manifest.deps) {
      addDepTokens(known, d.name);
    }
  }

  console.log(`[known-deps] user=${userId} ${known.size} dep tokens across ${projects.length} projects`);
  return known;
}

/** Decompose a manifest dep name into the tokens we'll probe against
 *  candidate (owner, name). Adds lowercase variants.
 *
 *  Examples:
 *    "react"            → adds "react"
 *    "@reduxjs/toolkit" → adds "reduxjs", "toolkit", "redux-toolkit"
 *    "fluent-ffmpeg"    → adds "fluent-ffmpeg"
 */
function addDepTokens(set: Set<string>, depName: string): void {
  const lower = depName.toLowerCase();
  set.add(lower);
  // Scoped npm names: @org/pkg → add the org and the unscoped name
  const scoped = /^@([\w-]+)\/(.+)$/.exec(lower);
  if (scoped) {
    set.add(scoped[1]);
    set.add(scoped[2]);
    // Common GitHub repo-name shape: org-pkg or pkg-org (e.g.
    // @reduxjs/toolkit → reduxjs/redux-toolkit). Heuristic: also
    // index the joined form.
    set.add(`${scoped[1]}-${scoped[2]}`);
    set.add(`${scoped[2]}-${scoped[1]}`);
  }
}

/** Probe whether a candidate is "user-known." True if either the
 *  candidate's owner or repo name (lowercased) is in the known-deps
 *  set. Pure function — caller manages the set lifecycle.
 */
export function isUserKnown(
  candidate: { owner?: string | null; name?: string | null },
  known: Set<string>,
): boolean {
  if (known.size === 0) return false;
  const owner = candidate.owner?.toLowerCase();
  const name = candidate.name?.toLowerCase();
  if (owner && known.has(owner)) return true;
  if (name && known.has(name)) return true;
  return false;
}
