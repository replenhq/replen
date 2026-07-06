/**
 * Multi-tenant isolation harness for Replen.
 * ------------------------------------------------------------------
 * This file is the ONE authorization seam the property suite drives.
 * Everything in `isolation.property.test.ts` asserts against the small,
 * strongly-typed surface exported here.
 *
 * Design contract:
 *   - The ENCRYPTION seam uses the REAL crypto module (`@/lib/crypto`).
 *     Those functions are pure node:crypto with no DB / Next / boot-assert
 *     side effects, so the AAD-binding property is exercised against
 *     production code, not a mock.
 *   - The DB-SCOPING seam is an in-memory model that is *faithful to the
 *     real invariant* ("every read/write/delete is WHERE user_id = auth
 *     .userId"). It is green out of the box. To turn this into an
 *     integration test against the live handlers, replace the bodies
 *     marked  ┌─ TODO(wire-real) ─┐  with calls into:
 *       * authenticate()          — src/app/api/mcp/_auth.ts
 *       * the route handlers       — src/app/api/{state,triage,mcp/*}/route.ts
 *       * deleteUserAndAllData()   — src/lib/account-delete.ts
 *     If the scoping predicate is ever weakened, the properties go red.
 *
 * Nothing here reads user code or touches the real SQLite file.
 */

import {
  generateDek,
  encryptForUserWithDek,
  decryptWithDek,
  parseV2,
} from "@/lib/crypto";

// ── The tenant-scoped resource surface the task names ──────────────────────
//
// Seven scopes. Six map 1:1 to a table carrying a `user_id` column in
// src/db/schema.ts. The seventh, "repo_ownership", is a nuance: the `repos`
// table is GLOBAL (no user_id) — a repo row is shared. What is tenant-owned
// is the *linkage* asserting "this user surfaced/uses this repo", which lives
// on user_match_state (user_id, repo_id) and project_profiles.github_full_name.
// We model that ownership assertion as its own resource so "Tenant A can't
// read/flip Tenant B's repo ownership" is a first-class property.
export const RESOURCE_TABLES = [
  "user_match_state",
  "matches",
  "candidates",
  "triage_events",
  "project_profiles",
  "user_settings",
  "repo_ownership",
] as const;
export type ResourceTable = (typeof RESOURCE_TABLES)[number];

export type TenantId = number; // == users.id, always a positive integer
export type Token = string; // == the plaintext ingest/digest token

// A single tenant-owned row. `cell` is present only for user_settings and
// carries a REAL v2 envelope ciphertext (enc:v2:<userId>:g<n>:<iv>:<tag>:<ct>).
export type Resource = {
  id: number;
  table: ResourceTable;
  ownerUserId: TenantId;
  // repo_ownership rows also carry the (global) repoId the ownership points at.
  repoId?: number;
  // user_settings rows carry an encrypted secret cell sealed under the owner's DEK.
  cell?: string;
  // arbitrary tenant-private payload used to prove a modify actually landed / didn't.
  value: string;
};

export type Session = {
  token: Token;
  userId: TenantId;
};

export type Tenant = {
  userId: TenantId;
  token: Token;
  dek: Buffer; // per-tenant Data Encryption Key (real, from generateDek())
  secretPlaintext: string; // the cleartext sealed into this tenant's user_settings cell
};

export type Denied = { ok: false; reason: "cross-tenant" | "unauthenticated" | "not-found" };
export type Allowed<T> = { ok: true; value: T };
export type Outcome<T> = Allowed<T> | Denied;

// ── Encryption seam (REAL crypto) ──────────────────────────────────────────

/** Seal `plaintext` into a v2 envelope for `userId` under `dek`. Real crypto. */
export function sealSecret(userId: TenantId, dek: Buffer, plaintext: string): string {
  return encryptForUserWithDek(userId, dek, plaintext);
}

/** Mint a fresh per-tenant DEK. Real crypto (needs process.env.ENCRYPTION_KEY). */
export function mintDek(): Buffer {
  return generateDek().dek;
}

/**
 * Attempt a raw cross-tenant decrypt: attacker uses THEIR dek on a foreign
 * cell. Mirrors what would happen if the DEK-routing in user-secrets.ts were
 * bypassed. Real GCM: must throw (wrong key => tag verification failure).
 */
export function attemptForeignDekDecrypt(attackerDek: Buffer, foreignCell: string): string {
  return decryptWithDek(foreignCell, attackerDek);
}

/**
 * Forge a v2 header so the ciphertext *claims* to belong to `newUserId`,
 * keeping the original sealed bytes. Used to test AAD binding: decryptWithDek
 * recomputes AAD from the (now-attacker) header, but the bytes were sealed
 * under the victim's AAD, so the GCM tag must fail even with the right DEK.
 */
export function forgeV2Header(cell: string, newUserId: TenantId): string {
  const { generation, body } = parseV2(cell);
  return `enc:v2:${newUserId}:g${generation}:${body}`;
}

/**
 * The production read guard, exercised against REAL parseV2 + decryptWithDek.
 * Mirrors src/lib/user-secrets.ts readUserSecret() lines 116-126: refuse to
 * decrypt a v2 cell whose header userId != the requesting userId, BEFORE the
 * DEK is even applied.
 *
 * ┌─ TODO(wire-real) ─┐
 *   Replace this body with `readUserSecret(requestingUserId, "githubToken",
 *   cell, "pipeline-run")` once you can stand up a test DB + DEK row. The
 *   assertion the property makes is identical: a foreign cell is rejected.
 * └───────────────────┘
 */
export function readSecretGuarded(requestingUserId: TenantId, requestingDek: Buffer, cell: string): string {
  const { userId: storedUid } = parseV2(cell);
  if (storedUid !== requestingUserId) {
    throw new Error(`v2 secret belongs to user ${storedUid}, not ${requestingUserId} - refusing decrypt`);
  }
  return decryptWithDek(cell, requestingDek);
}

// ── DB-scoping seam (faithful in-memory model of the handlers) ─────────────

export class TenantStore {
  private byToken = new Map<Token, Session>();
  private resources: Resource[] = [];
  private nextId = 1;

  /** Seed a tenant: registers its token->userId session and a row per table. */
  seedTenant(t: Tenant): Resource[] {
    // ┌─ TODO(wire-real) ─┐ token->userId lookup mirrors _auth.ts authenticate():
    //   the real path is sha256(token) -> user_settings.ingest_token_hash -> userId,
    //   gated on users.status='active'. Here we register the mapping directly.
    // └───────────────────┘
    this.byToken.set(t.token, { token: t.token, userId: t.userId });
    const seeded: Resource[] = [];
    for (const table of RESOURCE_TABLES) {
      const r: Resource = {
        id: this.nextId++,
        table,
        ownerUserId: t.userId,
        value: `owned-by-${t.userId}`,
        ...(table === "repo_ownership" ? { repoId: 10_000 + (t.userId % 997) } : {}),
        ...(table === "user_settings" ? { cell: sealSecret(t.userId, t.dek, t.secretPlaintext) } : {}),
      };
      this.resources.push(r);
      seeded.push(r);
    }
    return seeded;
  }

  /** Resolve a token to a session. Unknown/rotated token => null. */
  authenticate(token: Token): Session | null {
    return this.byToken.get(token) ?? null;
  }

  /**
   * THE INVARIANT UNDER TEST. Every real handler resolves auth.userId, then
   * scopes the query `WHERE user_id = auth.userId`. Authorization succeeds iff
   * the session owns the resource. Weakening this predicate (e.g. dropping the
   * equality) is exactly the multi-tenant leak the suite is built to catch.
   *
   * ┌─ TODO(wire-real) ─┐
   *   Swap the body for an actual request against the route under test and
   *   assert on its HTTP status (200 vs 401/404). The predicate below is the
   *   spec those handlers must satisfy.
   * └───────────────────┘
   */
  private authorize(session: Session | null, resource: Resource): Outcome<Resource> {
    if (!session) return { ok: false, reason: "unauthenticated" };
    if (session.userId !== resource.ownerUserId) return { ok: false, reason: "cross-tenant" };
    return { ok: true, value: resource };
  }

  /** SELECT ... WHERE id = ? AND user_id = auth.userId */
  read(token: Token, resource: Resource): Outcome<Resource> {
    return this.authorize(this.authenticate(token), resource);
  }

  /** UPDATE ... SET value = ? WHERE id = ? AND user_id = auth.userId */
  modify(token: Token, resource: Resource, patch: string): Outcome<Resource> {
    const decision = this.authorize(this.authenticate(token), resource);
    if (!decision.ok) return decision;
    const live = this.resources.find((r) => r.id === resource.id);
    if (!live) return { ok: false, reason: "not-found" };
    live.value = patch;
    return { ok: true, value: live };
  }

  /** DELETE ... WHERE id = ? AND user_id = auth.userId */
  remove(token: Token, resource: Resource): Outcome<Resource> {
    const decision = this.authorize(this.authenticate(token), resource);
    if (!decision.ok) return decision;
    const idx = this.resources.findIndex((r) => r.id === resource.id);
    if (idx === -1) return { ok: false, reason: "not-found" };
    const [removed] = this.resources.splice(idx, 1);
    return { ok: true, value: removed };
  }

  /**
   * Model of deleteUserAndAllData(userId): erase every row WHERE user_id = ?
   * and nothing else. Global/attribution-only tables are untouched.
   *
   * ┌─ TODO(wire-real) ─┐ call the real src/lib/account-delete.ts here. └──┐
   */
  deleteTenant(userId: TenantId): void {
    this.resources = this.resources.filter((r) => r.ownerUserId !== userId);
    for (const [tok, sess] of this.byToken) if (sess.userId === userId) this.byToken.delete(tok);
  }

  /** Resolve the single seeded row for (userId, table). Unambiguous — seedTenant emits one per table. */
  findRow(userId: TenantId, table: ResourceTable): Resource | undefined {
    return this.resources.find((r) => r.ownerUserId === userId && r.table === table);
  }

  /** Test-only inspection: is this resource still present with this value? */
  snapshot(id: number): Resource | undefined {
    return this.resources.find((r) => r.id === id);
  }

  count(): number {
    return this.resources.length;
  }

  countOwnedBy(userId: TenantId): number {
    return this.resources.filter((r) => r.ownerUserId === userId).length;
  }
}
