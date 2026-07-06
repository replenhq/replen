/**
 * Property-based multi-tenant isolation suite for Replen.
 * ------------------------------------------------------------------
 * Invariant (the product's load-bearing security property): a request bearing
 * Tenant A's credentials can NEVER read, modify, or delete a resource owned by
 * Tenant B — across user_match_state, matches, candidates, triage_events,
 * project_profiles, user_settings, and repo ownership — and Tenant A can never
 * decrypt Tenant B's secret cells (the v2 envelope binds ciphertext to tenant
 * via GCM AAD).
 *
 * fast-check generates populations of tens-to-hundreds of concurrent tenant
 * sessions per run, then throws cross-tenant requests at the authorization
 * seam in harness.ts. The encryption properties call the REAL crypto module.
 *
 * Run: see SETUP.md. Tune breadth with ISO_RUNS / ISO_MAX_TENANTS env vars.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  RESOURCE_TABLES,
  type ResourceTable,
  type Tenant,
  TenantStore,
  sealSecret,
  mintDek,
  attemptForeignDekDecrypt,
  forgeV2Header,
  readSecretGuarded,
} from "./harness";

// ── Breadth knobs ──────────────────────────────────────────────────────────
const RUNS = Math.max(1, Number(process.env.ISO_RUNS ?? 200));
const MIN_TENANTS = Math.max(2, Number(process.env.ISO_MIN_TENANTS ?? 40));
const MAX_TENANTS = Math.max(MIN_TENANTS, Number(process.env.ISO_MAX_TENANTS ?? 250));

// ── Arbitraries ────────────────────────────────────────────────────────────

const arbUserId = fc.integer({ min: 1, max: 5_000_000 });
// Non-empty on purpose: the real encryptForUserWithDek() (crypto.ts) passes an
// empty string through unchanged rather than sealing it, and writeUserSecret()
// stores null for empty input — production never seals an empty secret. A
// sealed cell is therefore always a v2 envelope, which is what we assert on.
const arbSecret = fc.string({ minLength: 1, maxLength: 200 });

/**
 * A population of distinct tenants. userIds are unique (a users.id is unique),
 * tokens are derived from the id so they're unique too, and each tenant gets a
 * real per-tenant DEK + a real sealed secret cell.
 */
const arbPopulation = fc
  .uniqueArray(fc.tuple(arbUserId, arbSecret, fc.string({ minLength: 4, maxLength: 8 })), {
    minLength: MIN_TENANTS,
    maxLength: MAX_TENANTS,
    selector: ([id]) => id,
  })
  .map<Tenant[]>((rows) =>
    rows.map(([userId, secretPlaintext, salt]) => ({
      userId,
      token: `tok_${userId}_${salt}`,
      dek: mintDek(),
      secretPlaintext,
    })),
  );

/** Build a live store from a population and return both. */
function boot(tenants: Tenant[]): { store: TenantStore; tenants: Tenant[] } {
  const store = new TenantStore();
  for (const t of tenants) store.seedTenant(t);
  return { store, tenants };
}

/** Pick a distinct (attacker, victim) index pair inside a population. */
function distinctPair(len: number, i: number, j: number): [number, number] | null {
  const a = i % len;
  let b = j % len;
  if (a === b) b = (b + 1) % len;
  if (a === b) return null; // len === 1 guard (excluded by MIN_TENANTS>=2)
  return [a, b];
}

// ── 1. Cross-tenant READ is denied, per table ──────────────────────────────

describe.each(RESOURCE_TABLES)("cross-tenant READ denied — %s", (table: ResourceTable) => {
  it("Tenant A can never read Tenant B's row", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), fc.nat(), (tenants, i, j) => {
        const pair = distinctPair(tenants.length, i, j);
        if (!pair) return;
        const { store } = boot(tenants);
        const [ai, vi] = pair;
        const attacker = tenants[ai];
        const victim = tenants[vi];
        const target = store.findRow(victim.userId, table);
        expect(target).toBeDefined();
        const out = store.read(attacker.token, target!);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe("cross-tenant");
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 2. Cross-tenant MODIFY is denied AND leaves the row untouched ──────────

describe.each(RESOURCE_TABLES)("cross-tenant MODIFY denied — %s", (table: ResourceTable) => {
  it("Tenant A can never mutate Tenant B's row", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), fc.nat(), fc.string(), (tenants, i, j, patch) => {
        const pair = distinctPair(tenants.length, i, j);
        if (!pair) return;
        const { store } = boot(tenants);
        const [ai, vi] = pair;
        const attacker = tenants[ai];
        const victim = tenants[vi];
        const target = store.findRow(victim.userId, table)!;
        const before = target.value;
        const out = store.modify(attacker.token, target, patch);
        expect(out.ok).toBe(false);
        // The row is byte-for-byte unchanged.
        expect(store.snapshot(target.id)?.value).toBe(before);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 3. Cross-tenant DELETE is denied AND the row survives ──────────────────

describe.each(RESOURCE_TABLES)("cross-tenant DELETE denied — %s", (table: ResourceTable) => {
  it("Tenant A can never delete Tenant B's row", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), fc.nat(), (tenants, i, j) => {
        const pair = distinctPair(tenants.length, i, j);
        if (!pair) return;
        const { store } = boot(tenants);
        const [ai, vi] = pair;
        const attacker = tenants[ai];
        const victim = tenants[vi];
        const target = store.findRow(victim.userId, table)!;
        const out = store.remove(attacker.token, target);
        expect(out.ok).toBe(false);
        expect(store.snapshot(target.id)).toBeDefined();
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 4. Positive control: isolation must not over-block the OWNER ────────────

describe("same-tenant access is allowed (no false denial)", () => {
  it("every tenant can read + modify its own rows across all tables", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), (tenants, k) => {
        const { store } = boot(tenants);
        const me = tenants[k % tenants.length];
        for (const table of RESOURCE_TABLES) {
          const mine = store.findRow(me.userId, table)!;
          expect(store.read(me.token, mine).ok).toBe(true);
          const out = store.modify(me.token, mine, "self-write");
          expect(out.ok).toBe(true);
          expect(store.snapshot(mine.id)?.value).toBe("self-write");
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 5. Envelope encryption: cross-DEK decrypt fails (REAL crypto) ──────────

describe("envelope encryption — cross-tenant secret confidentiality", () => {
  it("Tenant A's DEK can never decrypt Tenant B's sealed cell", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), fc.nat(), (tenants, i, j) => {
        const pair = distinctPair(tenants.length, i, j);
        if (!pair) return;
        const [ai, vi] = pair;
        const attacker = tenants[ai];
        const victim = tenants[vi];
        const victimCell = sealSecret(victim.userId, victim.dek, victim.secretPlaintext);
        // Raw GCM: wrong key => authentication-tag failure => throw.
        expect(() => attemptForeignDekDecrypt(attacker.dek, victimCell)).toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  it("AAD binds ciphertext to tenant — forging the header userId fails even with the victim's own DEK", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), fc.nat(), (tenants, i, j) => {
        const pair = distinctPair(tenants.length, i, j);
        if (!pair) return;
        const [ai, vi] = pair;
        const attacker = tenants[ai];
        const victim = tenants[vi];
        const victimCell = sealSecret(victim.userId, victim.dek, victim.secretPlaintext);
        // Re-stamp the header to claim the attacker's userId. decryptWithDek
        // recomputes AAD from the header (now attacker's id); the sealed bytes
        // carry the victim's AAD => GCM tag mismatch even with victim.dek.
        const forged = forgeV2Header(victimCell, attacker.userId);
        expect(() => attemptForeignDekDecrypt(victim.dek, forged)).toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  it("the read guard refuses a v2 cell whose header userId != requester (REAL parseV2)", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), fc.nat(), (tenants, i, j) => {
        const pair = distinctPair(tenants.length, i, j);
        if (!pair) return;
        const [ai, vi] = pair;
        const attacker = tenants[ai];
        const victim = tenants[vi];
        const victimCell = sealSecret(victim.userId, victim.dek, victim.secretPlaintext);
        // Attacker asks to read the victim's cell under attacker identity+DEK.
        expect(() => readSecretGuarded(attacker.userId, attacker.dek, victimCell)).toThrow(
          /refusing decrypt/,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("round-trip sanity: a tenant CAN read its own sealed cell", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), (tenants, k) => {
        const me = tenants[k % tenants.length];
        const cell = sealSecret(me.userId, me.dek, me.secretPlaintext);
        expect(readSecretGuarded(me.userId, me.dek, cell)).toBe(me.secretPlaintext);
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 6. Account deletion isolation (models deleteUserAndAllData) ─────────────

describe("account deletion never reaps another tenant's data", () => {
  it("deleting Tenant A leaves every Tenant B row intact", () => {
    fc.assert(
      fc.property(arbPopulation, fc.nat(), (tenants, k) => {
        const { store } = boot(tenants);
        const victimCounts = new Map<number, number>();
        for (const t of tenants) victimCounts.set(t.userId, store.countOwnedBy(t.userId));
        const doomed = tenants[k % tenants.length];
        store.deleteTenant(doomed.userId);
        expect(store.countOwnedBy(doomed.userId)).toBe(0);
        for (const t of tenants) {
          if (t.userId === doomed.userId) continue;
          expect(store.countOwnedBy(t.userId)).toBe(victimCounts.get(t.userId));
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 7. Token authentication never resolves to a foreign identity ────────────

describe("token identity binding", () => {
  it("no tenant's token ever authenticates as another tenant's userId", () => {
    fc.assert(
      fc.property(arbPopulation, (tenants) => {
        const { store } = boot(tenants);
        for (const t of tenants) {
          const sess = store.authenticate(t.token);
          expect(sess).not.toBeNull();
          expect(sess!.userId).toBe(t.userId);
        }
        // An unminted token authenticates as nobody.
        expect(store.authenticate("tok_forged_00000")).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });
});

// ── 8. Concurrent interleaving: hundreds of sessions, arbitrary schedule ────

describe("concurrent cross-tenant requests under arbitrary interleaving", () => {
  it("no interleaving of N concurrent tenant sessions lets a cross-tenant op succeed", async () => {
    await fc.assert(
      fc.asyncProperty(arbPopulation, fc.scheduler(), async (tenants, s) => {
        const { store } = boot(tenants);
        const results: boolean[] = [];
        // Each tenant concurrently fires a cross-tenant read+modify+delete at
        // its right-neighbour victim. The scheduler picks the interleaving.
        tenants.forEach((attacker, idx) => {
          const victim = tenants[(idx + 1) % tenants.length];
          if (victim.userId === attacker.userId) return;
          for (const table of RESOURCE_TABLES) {
            const target = store.findRow(victim.userId, table)!;
            void s.schedule(Promise.resolve()).then(() => {
              results.push(store.read(attacker.token, target).ok);
              results.push(store.modify(attacker.token, target, "pwned").ok);
              results.push(store.remove(attacker.token, target).ok);
            });
          }
        });
        await s.waitAll();
        // Not one cross-tenant op succeeded, in any order.
        expect(results.some((ok) => ok === true)).toBe(false);
        // And every victim row still holds its original value.
        for (const t of tenants) {
          for (const table of RESOURCE_TABLES) {
            const row = store.findRow(t.userId, table);
            expect(row?.value).toBe(`owned-by-${t.userId}`);
          }
        }
      }),
      { numRuns: Math.min(RUNS, 60) },
    );
  });
});
