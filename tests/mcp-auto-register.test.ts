/**
 * Guards the correctness-critical piece of the MCP-startup repo auto-register
 * (mcp/src/auto-register.ts): deriveSlug MUST always return a slug the bulk
 * endpoint accepts. The server rejects the whole batch on a bad slug
 * (SLUG_RE), and auto-register swallows the resulting 400 silently — so an
 * invalid slug means a repo silently never registers. This locks the slug
 * shape to the server's contract.
 */

import { describe, it, expect } from "vitest";
import { deriveSlug } from "../mcp/src/auto-register.js";

// Mirror of the server's slug validator (src/app/api/projects/bulk/route.ts).
// If the server loosens/tightens this, update here in lockstep.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

describe("deriveSlug", () => {
  const cases: Array<[string, string]> = [
    ["nsokin/replen", "replen"],
    ["owner/My-Repo", "my-repo"],
    ["owner/repo.js", "repo-js"],           // dots aren't slug-legal
    ["owner/  weird  ", "weird"],           // spaces → dashes, then trimmed to legal
    ["owner/123-start", "123-start"],       // leading digit is legal
    ["owner/-leading-dash", "leading-dash"],// leading non-alnum stripped
    ["owner/UPPER_case-1", "upper_case-1"], // underscores kept, lowercased
  ];

  it.each(cases)("%s → %s (and is SLUG_RE-valid)", (gfn, expected) => {
    const slug = deriveSlug(gfn);
    expect(slug).toBe(expected);
    expect(SLUG_RE.test(slug)).toBe(true);
  });

  it("never emits an empty/invalid slug even for pathological names", () => {
    const pathological = [
      "owner/...",        // all dots
      "owner/---",        // all dashes
      "owner/😀",         // emoji only
      "owner/  ",         // whitespace only
      "owner/",           // empty name
    ];
    for (const gfn of pathological) {
      const slug = deriveSlug(gfn);
      expect(slug.length).toBeGreaterThan(0);
      expect(SLUG_RE.test(slug)).toBe(true);
    }
  });

  it("caps the slug at 80 chars (SLUG_RE upper bound)", () => {
    const long = "owner/" + "a".repeat(200);
    const slug = deriveSlug(long);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(SLUG_RE.test(slug)).toBe(true);
  });
});
