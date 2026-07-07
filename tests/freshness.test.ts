/**
 * Vitest battery for the grounding-freshness pure functions in
 * src/projects/summarize.ts:
 *   - summaryIsGrounded — is a stored summary in-session (grounded) vs doc-inferred?
 *   - needsRegeneration — the doc-summarizer cache-invalidation predicate; MUST
 *     never fire for a grounded row (the load-bearing decay-protection invariant).
 *   - needsReground — should the CLIENT silently re-run grounded derivation
 *     (schema-stale backfill or code-drift), with a throttle floor?
 *   - preserveGroundedFields — a doc-recompute must copy grounded-only fields
 *     (caps/tags/grounding/vaultConcepts + authored purpose/goals) forward.
 *
 * These are the highest-risk bits of the freshness automation: a bug here is
 * silent grounded-data loss or a re-ground thrash loop.
 */

import { describe, expect, it } from "vitest";
import {
  summaryIsGrounded,
  needsRegeneration,
  needsReground,
  preserveGroundedFields,
  GROUNDING_SCHEMA_VERSION,
  PROMPT_VERSION,
  type ProjectSummary,
} from "../src/projects/summarize";

// A complete, doc-shaped (NOT grounded) ProjectSummary to mutate in tests.
function makeSummary(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    purpose: "doc-derived purpose",
    keyCapabilities: [],
    capabilityTags: ["doc-tag"],
    capabilities: [{ tag: "doc-cap", descriptor: "", modality: [], provenance: "inferred" }],
    currentTech: {},
    outcomeGoals: [{ statement: "doc goal", source: "inferred", confidence: "low" }],
    crossRepoDependencies: [],
    languageSignals: { hardConstraints: [], detected: [] },
    generatedAt: "2020-01-01T00:00:00.000Z",
    sourceFiles: [],
    llmModel: "doc",
    promptVersion: PROMPT_VERSION,
    ...over,
  };
}

const GROUNDED_CAP = { tag: "order-book", descriptor: "hand-written heap", modality: ["timeseries"], provenance: "grounded" as const, paths: ["src/ob.ts"], mechanism: "price-time-priority", maturity: "hand-rolled" as const };

describe("summaryIsGrounded", () => {
  it("true when a grounding fingerprint is present", () => {
    expect(summaryIsGrounded(JSON.stringify({ grounding: { schemaVersion: "1" } }))).toBe(true);
    expect(summaryIsGrounded(JSON.stringify({ grounding: { sha: "abc1234" } }))).toBe(true);
    expect(summaryIsGrounded(JSON.stringify({ grounding: { at: "2026-01-01T00:00:00Z" } }))).toBe(true);
  });
  it("true for a legacy grounded row (grounded provenance, no fingerprint)", () => {
    expect(summaryIsGrounded(JSON.stringify({ capabilities: [GROUNDED_CAP] }))).toBe(true);
  });
  it("false for an empty grounding object with no grounded caps", () => {
    // grounding:{} must NOT count as grounded (it falls through to the provenance check).
    expect(summaryIsGrounded(JSON.stringify({ grounding: {}, capabilities: [{ tag: "x", descriptor: "", modality: [], provenance: "inferred" }] }))).toBe(false);
  });
  it("false for a doc-only summary, null, and malformed JSON", () => {
    expect(summaryIsGrounded(JSON.stringify({ capabilities: [{ tag: "x", descriptor: "", modality: [], provenance: "extracted" }] }))).toBe(false);
    expect(summaryIsGrounded(null)).toBe(false);
    expect(summaryIsGrounded("{not json")).toBe(false);
  });
});

describe("needsRegeneration — grounded rows are never doc-regenerated", () => {
  const grounded = JSON.stringify({ grounding: { schemaVersion: "1", at: new Date().toISOString() }, capabilities: [GROUNDED_CAP] });
  it("protects a grounded row even when hash/prompt/timestamp all say 'stale'", () => {
    const d = needsRegeneration({
      summaryJson: grounded,
      summaryHash: "OLD",
      currentProfileHash: "NEW",
      summaryGeneratedAt: new Date(0), // ancient → would be stale if ungrounded
      summaryPromptVersion: "0", // mismatched → would regen if ungrounded
    });
    expect(d.regen).toBe(false);
    expect(d.reason).toBe("grounded-protected");
  });
  it("regenerates an ungrounded row on profile-hash change", () => {
    const doc = JSON.stringify({ capabilities: [{ tag: "x", descriptor: "", modality: [], provenance: "inferred" }] });
    const d = needsRegeneration({ summaryJson: doc, summaryHash: "OLD", currentProfileHash: "NEW", summaryGeneratedAt: new Date(), summaryPromptVersion: PROMPT_VERSION });
    expect(d.regen).toBe(true);
    expect(d.reason).toBe("profile-hash-changed");
  });
  it("regenerates when there is no summary at all", () => {
    expect(needsRegeneration({ summaryJson: null, summaryHash: null, currentProfileHash: "H", summaryGeneratedAt: null, summaryPromptVersion: null }).regen).toBe(true);
  });
});

describe("needsReground", () => {
  const oldAt = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // 48h ago → past 24h throttle
  const recentAt = new Date(Date.now() - 1000 * 60 * 30).toISOString(); // 30m ago → inside throttle

  it("never fires for an un-grounded row", () => {
    const doc = JSON.stringify({ capabilities: [{ tag: "x", descriptor: "", modality: [], provenance: "inferred" }] });
    expect(needsReground({ summaryJson: doc }).reground).toBe(false);
    expect(needsReground({ summaryJson: doc }).reason).toBe("not-grounded");
  });

  it("schema-stale + not throttled for a legacy grounded row (no fingerprint)", () => {
    const legacy = JSON.stringify({ capabilities: [GROUNDED_CAP] });
    const d = needsReground({ summaryJson: legacy });
    expect(d.reground).toBe(true);
    expect(d.reason).toBe("schema-stale");
  });

  it("current (no reground) when schema matches and HEAD has not drifted", () => {
    const g = JSON.stringify({ grounding: { sha: "abcdef1234567890", schemaVersion: GROUNDING_SCHEMA_VERSION, at: oldAt }, capabilities: [GROUNDED_CAP] });
    const d = needsReground({ summaryJson: g, localHead: "abcdef1234567890" });
    expect(d.reground).toBe(false);
    expect(d.reason).toBe("current");
  });

  it("code-drift when the live HEAD differs from the grounded SHA (past throttle)", () => {
    const g = JSON.stringify({ grounding: { sha: "abcdef1234567890", schemaVersion: GROUNDING_SCHEMA_VERSION, at: oldAt }, capabilities: [GROUNDED_CAP] });
    const d = needsReground({ summaryJson: g, localHead: "ffffffffffffffff" });
    expect(d.reground).toBe(true);
    expect(d.reason).toBe("code-drift");
  });

  it("throttled: a recently-grounded row does not re-ground even with drift", () => {
    const g = JSON.stringify({ grounding: { sha: "abcdef1234567890", schemaVersion: GROUNDING_SCHEMA_VERSION, at: recentAt }, capabilities: [GROUNDED_CAP] });
    const d = needsReground({ summaryJson: g, localHead: "ffffffffffffffff" });
    expect(d.reground).toBe(false);
    expect(d.reason).toBe("throttled");
  });

  it("throttleHours=0 disables the floor so drift fires immediately", () => {
    const g = JSON.stringify({ grounding: { sha: "abcdef1234567890", schemaVersion: GROUNDING_SCHEMA_VERSION, at: recentAt }, capabilities: [GROUNDED_CAP] });
    const d = needsReground({ summaryJson: g, localHead: "ffffffffffffffff", throttleHours: 0 });
    expect(d.reground).toBe(true);
    expect(d.reason).toBe("code-drift");
  });
});

describe("preserveGroundedFields", () => {
  const prevJson = JSON.stringify({
    capabilities: [GROUNDED_CAP],
    capabilityTags: ["order-book", "matching-engine"],
    grounding: { sha: "abc1234", schemaVersion: GROUNDING_SCHEMA_VERSION, at: "2026-01-01T00:00:00.000Z" },
    vaultConcepts: [{ title: "price-time priority" }],
    purpose: "grounded product thesis",
    outcomeGoals: [{ statement: "sub-microsecond matching", source: "user", confidence: "high" }],
  });

  it("copies grounded-only fields (caps/tags/grounding/vaultConcepts) onto the doc summary", () => {
    const target = makeSummary();
    preserveGroundedFields(target, prevJson);
    expect(target.capabilities[0].tag).toBe("order-book");
    expect(target.capabilities[0].mechanism).toBe("price-time-priority");
    expect(target.capabilityTags).toEqual(["order-book", "matching-engine"]);
    expect(target.grounding?.sha).toBe("abc1234");
    expect(target.vaultConcepts?.[0].title).toBe("price-time priority");
  });

  it("preserves grounded-authored purpose + user outcomeGoals", () => {
    const target = makeSummary();
    preserveGroundedFields(target, prevJson);
    expect(target.purpose).toBe("grounded product thesis");
    expect(target.outcomeGoals[0].source).toBe("user");
    expect(target.outcomeGoals[0].statement).toBe("sub-microsecond matching");
  });

  it("keeps the DOC purpose when the grounded row never set one", () => {
    const target = makeSummary({ purpose: "kept doc purpose" });
    const noPurpose = JSON.stringify({ capabilities: [GROUNDED_CAP], capabilityTags: [], grounding: { schemaVersion: GROUNDING_SCHEMA_VERSION }, purpose: "  " });
    preserveGroundedFields(target, noPurpose);
    expect(target.purpose).toBe("kept doc purpose");
  });

  it("keeps DOC outcomeGoals when the grounded row has no user-sourced goals", () => {
    const target = makeSummary({ outcomeGoals: [{ statement: "doc goal", source: "inferred", confidence: "low" }] });
    const inferredGoals = JSON.stringify({ capabilities: [GROUNDED_CAP], capabilityTags: [], grounding: { schemaVersion: GROUNDING_SCHEMA_VERSION }, outcomeGoals: [{ statement: "g", source: "inferred", confidence: "low" }] });
    preserveGroundedFields(target, inferredGoals);
    expect(target.outcomeGoals[0].statement).toBe("doc goal");
  });

  it("is a no-op on null / malformed prev", () => {
    const target = makeSummary();
    const before = JSON.stringify(target);
    preserveGroundedFields(target, null);
    preserveGroundedFields(target, "{broken");
    expect(JSON.stringify(target)).toBe(before);
  });
});
