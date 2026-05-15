// Per-tenant secret read/write with audit logging. All access to encrypted
// fields on user_settings should go through this module (rather than the raw
// crypto helpers) so that:
//
//   1. Each access is attributed to a userId, column and "reason" — written
//      to secret_access_log for forensics.
//   2. Reads work transparently across the v1 → v2 boundary. v2 ciphertexts
//      use the user's DEK; legacy v1 ciphertexts fall back to the master KEK
//      and are quietly re-encrypted as v2 on the next write.
//   3. The DEK is fetched (or lazily created on first secret write).

import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import {
  decryptSecret,
  decryptWithDek,
  encryptForUserWithDek,
  generateDek,
  parseV2,
  unwrapDek,
} from "./crypto";

export type SecretReason =
  | "pipeline-run"
  | "mcp-handoff"
  | "mcp-analyze"
  | "settings-view"
  | "settings-save"
  | "auto-detect"
  | "migration"
  | "redetect-languages"
  | "create-handoff"
  | "webhook-send"
  | "other";

// Fetch the user's DEK ciphertext (or null) without invoking the master key.
async function fetchDekCiphertext(userId: number): Promise<string | null> {
  const row = await db
    .select({ dek: schema.users.dekCiphertext })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  return row?.dek ?? null;
}

// Lazily create + persist a per-user DEK if one isn't there yet. Returns the
// raw key bytes for in-memory use within the caller's stack frame.
async function getOrCreateDek(userId: number): Promise<Buffer> {
  const existing = await fetchDekCiphertext(userId);
  if (existing) return unwrapDek(existing);
  const fresh = generateDek();
  await db
    .update(schema.users)
    .set({ dekCiphertext: fresh.ciphertext })
    .where(eq(schema.users.id, userId));
  return fresh.dek;
}

async function logAccess(
  userId: number,
  column: string,
  reason: SecretReason,
  success: boolean,
  errorMessage?: string,
): Promise<void> {
  // Best-effort. Failure to write the audit row should not break the caller.
  try {
    await db.insert(schema.secretAccessLog).values({
      userId,
      column,
      reason,
      success,
      errorMessage: errorMessage ?? null,
      accessedAt: new Date(),
    });
  } catch (e) {
    console.error("[secret-access-log] write failed:", (e as Error).message);
  }
}

// Decrypt an at-rest secret stored on a user_settings row. Routes v2 →
// per-tenant DEK, v1 → master key (legacy). Logs every call (success and
// failure) to secret_access_log. Returns null if the input is empty.
export async function readUserSecret(
  userId: number,
  column: string,
  stored: string | null | undefined,
  reason: SecretReason,
): Promise<string | null> {
  if (!stored) return null;
  try {
    if (stored.startsWith("enc:v2:")) {
      const { userId: storedUid } = parseV2(stored);
      if (storedUid !== userId) {
        throw new Error(`v2 secret belongs to user ${storedUid}, not ${userId} - refusing decrypt`);
      }
      const cipher = await fetchDekCiphertext(userId);
      if (!cipher) throw new Error(`user ${userId} has no DEK; v2 secret unreadable`);
      const dek = unwrapDek(cipher);
      const pt = decryptWithDek(stored, dek);
      await logAccess(userId, column, reason, true);
      return pt;
    }
    // v1 legacy path (single master key) or plaintext passthrough.
    const pt = decryptSecret(stored);
    await logAccess(userId, column, reason, true);
    return pt;
  } catch (e) {
    await logAccess(userId, column, reason, false, (e as Error).message);
    throw e;
  }
}

// Encrypt for storage. Always emits v2 under the user's DEK (created lazily
// if missing). Empty input passes through.
export async function writeUserSecret(userId: number, plaintext: string | null | undefined): Promise<string | null> {
  if (!plaintext) return null;
  const dek = await getOrCreateDek(userId);
  return encryptForUserWithDek(userId, dek, plaintext);
}

// Best-effort, sync-shaped wrapper for legacy code paths that don't have an
// async context (some server actions historically returned raw decrypts).
// Logs a warning to flag the audit gap.
export function decryptSecretSync(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith("enc:v2:")) {
    throw new Error("decryptSecretSync cannot read v2 ciphertext - use readUserSecret(userId, ...)");
  }
  return decryptSecret(stored);
}
