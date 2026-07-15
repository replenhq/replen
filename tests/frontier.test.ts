/**
 * Regression battery for the frontier prior (src/catalogue/frontier.ts) — the
 * age→ranking weight shared by the catalogue reader and the inventory route's
 * merged ranker. The load-bearing invariants:
 *   - it is a WEIGHT, never a gate (bounded, never negative, unknown age → 0);
 *   - it decays SMOOTHLY to zero at the window edge (no cliff);
 *   - it can never flip a relevance gap larger than the max boost (so a much
 *     stronger established match still wins — "silence beats a weak match").
 */

import { describe, expect, it } from "vitest";
import { frontierBoost, FRONTIER_MONTHS, FRONTIER_MAX_BOOST } from "@/catalogue/frontier";

const WINDOW_DAYS = FRONTIER_MONTHS * 30;

describe("frontierBoost — shipped defaults", () => {
  it("defaults to a 24-month window and a 0.12 max boost", () => {
    expect(FRONTIER_MONTHS).toBe(24);
    expect(FRONTIER_MAX_BOOST).toBeCloseTo(0.12, 10);
  });
});

describe("frontierBoost — weight, never a gate", () => {
  it("unknown age (null) gets no tilt — never gated", () => {
    expect(frontierBoost(null)).toBe(0);
  });
  it("negative age is treated as unknown (0), not a boost", () => {
    expect(frontierBoost(-5)).toBe(0);
  });
  it("a brand-new repo gets the full max boost", () => {
    expect(frontierBoost(0)).toBeCloseTo(FRONTIER_MAX_BOOST, 10);
  });
  it("is bounded in [0, FRONTIER_MAX_BOOST] across the whole range", () => {
    for (let d = 0; d <= WINDOW_DAYS + 400; d += 7) {
      const b = frontierBoost(d);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(FRONTIER_MAX_BOOST + 1e-12);
    }
  });
});

describe("frontierBoost — smooth decay, no cliff", () => {
  it("is 0 exactly at the window edge and beyond", () => {
    expect(frontierBoost(WINDOW_DAYS)).toBe(0);
    expect(frontierBoost(WINDOW_DAYS + 1)).toBe(0);
    expect(frontierBoost(WINDOW_DAYS * 5)).toBe(0);
  });
  it("halves at the window midpoint (12mo → half the max)", () => {
    expect(frontierBoost(WINDOW_DAYS / 2)).toBeCloseTo(FRONTIER_MAX_BOOST / 2, 10);
  });
  it("decreases monotonically with age", () => {
    let prev = Infinity;
    for (let d = 0; d < WINDOW_DAYS; d += 5) {
      const b = frontierBoost(d);
      expect(b).toBeLessThanOrEqual(prev + 1e-12);
      prev = b;
    }
  });
  it("has no discontinuity as it approaches the edge (approaches 0)", () => {
    expect(frontierBoost(WINDOW_DAYS - 1)).toBeGreaterThan(0);
    expect(frontierBoost(WINDOW_DAYS - 1)).toBeLessThan(FRONTIER_MAX_BOOST / 100);
  });
});

describe("frontierBoost — ranking property (tilt, don't dominate)", () => {
  const score = (cosine: number, ageDays: number | null) => cosine + frontierBoost(ageDays);

  it("a fresh, strong-enough match overtakes an established known one", () => {
    const establishedKnown = score(0.70, 5 * 365); // 5yr old → no boost
    const freshStrong = score(0.61, 30); // 1mo old
    expect(freshStrong).toBeGreaterThan(establishedKnown);
  });

  it("a fresh but WEAK match cannot leapfrog a much stronger established one", () => {
    const establishedStrong = score(0.75, 5 * 365);
    const freshWeak = score(0.50, 1); // barely-relevant newcomer
    expect(freshWeak).toBeLessThan(establishedStrong);
  });

  it("can never flip a relevance gap larger than the max boost", () => {
    // No age can make a repo with cosine (x - MAX - ε) outrank one at cosine x.
    const gap = FRONTIER_MAX_BOOST + 0.01;
    const older = score(0.80, 10 * 365);
    const newerButFarWorse = score(0.80 - gap, 0);
    expect(newerButFarWorse).toBeLessThan(older);
  });
});
