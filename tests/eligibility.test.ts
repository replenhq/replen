/**
 * Regression battery for the eligibility freshness floor
 * (src/analyzer/eligibility.ts). The floor is the YOUNG edge of the frontier
 * window: it drops a repo only when it is BOTH brand-new (< 5 days, the shipped
 * default) AND unproven (< 50 stars). Invariants:
 *   - the wait is short (5 days), so genuinely-new good repos aren't held back;
 *   - the star count is an escape hatch — a viral new repo (>=50★) passes at any
 *     age;
 *   - watch-lens ("feed") candidates are exempt — freshness is their SIGNAL;
 *   - the floor only catches the young: an old low-star repo still passes.
 * A couple of the neighbouring rules are checked too so a floor change can't
 * silently disable them.
 */

import { describe, expect, it } from "vitest";
import { checkEligibility, type EligibilityInput, type EligibilityContext } from "@/analyzer/eligibility";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    primaryLanguage: null,
    repoShape: "library",
    postedAt: daysAgo(60),
    score: 100,
    source: "gh-search",
    ...over,
  };
}
const noCtx: EligibilityContext = { detectedLanguages: null, knownDeps: null };

describe("freshness floor (young edge, default 5 days)", () => {
  it("drops a brand-new (<5d) AND unproven (<50★) repo", () => {
    const v = checkEligibility(input({ postedAt: daysAgo(3), score: 10 }), noCtx);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/too fresh/);
  });

  it("keeps a repo once it clears the 5-day floor, even with few stars", () => {
    // 8 days old, 10 stars — under the OLD 30-day floor this was dropped; now kept.
    expect(checkEligibility(input({ postedAt: daysAgo(8), score: 10 }), noCtx).eligible).toBe(true);
  });

  it("star escape hatch: a viral new repo (>=50★) passes at any age", () => {
    expect(checkEligibility(input({ postedAt: daysAgo(1), score: 11000 }), noCtx).eligible).toBe(true);
  });

  it("only catches the young — an old low-star repo still passes", () => {
    expect(checkEligibility(input({ postedAt: daysAgo(400), score: 5 }), noCtx).eligible).toBe(true);
  });

  it("prefers true created_at: an OLD repo pushed recently is not 'too fresh'", () => {
    // What gh-search stores: postedAt = pushed today, but the repo was born 3yr ago.
    // Using postedAt alone would wrongly drop it; created_at rescues it.
    const v = checkEligibility(input({ postedAt: daysAgo(0), createdAt: daysAgo(3 * 365), score: 10 }), noCtx);
    expect(v.eligible).toBe(true);
  });

  it("still drops a genuinely new repo by created_at (born 2d ago, few stars)", () => {
    const v = checkEligibility(input({ postedAt: daysAgo(0), createdAt: daysAgo(2), score: 10 }), noCtx);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/too fresh/);
  });

  it.each([
    "stack-watch:react",
    "spec-watch:tc39",
    "health-watch:leftpad",
    "security-watch:osv",
  ])("exempts watch-lens feed candidate %s (fresh + no stars)", (source) => {
    // shape "app" so the language-mismatch rule can't fire and mask the exemption
    const v = checkEligibility(input({ source, postedAt: daysAgo(1), score: 0, repoShape: "app" }), noCtx);
    expect(v.eligible).toBe(true);
  });
});

describe("neighbouring rules still fire (a floor change can't disable them)", () => {
  it("drops aggregators", () => {
    expect(checkEligibility(input({ repoShape: "aggregator" }), noCtx).eligible).toBe(false);
  });
  it("drops tutorials and templates", () => {
    expect(checkEligibility(input({ repoShape: "tutorial" }), noCtx).eligible).toBe(false);
    expect(checkEligibility(input({ repoShape: "template" }), noCtx).eligible).toBe(false);
  });
  it("drops a repo already in the user's manifests (known dep)", () => {
    const ctx: EligibilityContext = { detectedLanguages: null, knownDeps: new Set(["scrapling"]) };
    const v = checkEligibility(input({ owner: "d4vinci", name: "scrapling" }), ctx);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/manifests/);
  });
  it("forces cleanroom-rebuild on a cross-language library match", () => {
    const ctx: EligibilityContext = { detectedLanguages: "TypeScript,JavaScript", knownDeps: null };
    const v = checkEligibility(input({ primaryLanguage: "Rust", repoShape: "library" }), ctx);
    expect(v.eligible).toBe(true);
    if (v.eligible) expect(v.forceApproach).toBe("cleanroom-rebuild");
  });
});
