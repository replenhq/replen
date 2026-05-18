// Symmetric encryption for at-rest secrets in user_settings (GitHub PAT, LLM
// API keys). Two formats coexist:
//
//   enc:v1:<iv>:<tag>:<ct>           - encrypted with the master ENCRYPTION_KEY
//                                       directly. Used for the user's DEK
//                                       ciphertext (stored on users.dek_ciphertext)
//                                       and for legacy user_settings rows
//                                       written before the v2 envelope existed.
//   enc:v2:<userId>:<iv>:<tag>:<ct>  - encrypted with the user's per-tenant
//                                       Data Encryption Key (DEK). The DEK
//                                       is itself stored as v1 on the user row.
//
// Why two layers: the master key (ENCRYPTION_KEY / KEK) is in env / KMS; the
// per-user DEK lives in the DB. Deleting a user destroys their DEK, which
// in turn destroys all access to their secrets — GDPR-grade erase. A single
// runtime bug that leaks a decrypted PAT can only touch that one user's keys.
//
// Boot behaviour: assertEncryptionKeyForBoot() throws in production if the
// master key is missing. There is no silent-plaintext fallback.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX_V1 = "enc:v1:";
const PREFIX_V2 = "enc:v2:";
const ALGO = "aes-256-gcm";

function getMasterKey(): Buffer {
  // Re-read on every call. Not cached: the key may be rotated via env reload
  // and a stale buffer cached in module memory is a small surface area worth
  // avoiding. Cost is ~10us per crypto op, negligible at our scale.
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY env var not set. Generate one: " +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error("ENCRYPTION_KEY must be base64-encoded");
  }
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`);
  }
  return buf;
}

// Optional previous master key for the rotation window. When operator wants
// to rotate ENCRYPTION_KEY they set ENCRYPTION_KEY_PREV to the OLD value,
// flip ENCRYPTION_KEY to the new value, deploy, then run the rotate CLI
// (`tsx src/cli/rotate-master-key.ts`) to rewrap every users.dek_ciphertext
// under the new key. Once verified they unset ENCRYPTION_KEY_PREV. During
// the window, decrypt tries current first, then prev.
export function getPrevMasterKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY_PREV;
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY_PREV must decode to 32 bytes, got ${buf.length}`);
  }
  return buf;
}

// decryptWith but try the current master key first, fall back to PREV if a
// rotation is in flight. Surface the *original* error on total failure so
// the caller's error log reads cleanly.
function decryptWithMasterKeys(body: string): string {
  const cur = getMasterKey();
  try {
    return decryptWith(cur, body);
  } catch (eCur) {
    const prev = getPrevMasterKey();
    if (!prev) throw eCur;
    try {
      return decryptWith(prev, body);
    } catch {
      throw eCur;
    }
  }
}

// Call once at module-load time. In production, refuses to boot without a
// valid ENCRYPTION_KEY. In development we let it through so `npm run dev`
// works on a fresh checkout - first real DB write will then fail loud.
export function assertEncryptionKeyForBoot(): void {
  if (process.env.NODE_ENV !== "production") return;
  try {
    getMasterKey();
  } catch (e) {
    console.error(`[crypto] FATAL: ${(e as Error).message}`);
    console.error(`[crypto] Refusing to boot in production without ENCRYPTION_KEY.`);
    process.exit(1);
  }
}

export function isEncrypted(s: string | null | undefined): boolean {
  return typeof s === "string" && (s.startsWith(PREFIX_V1) || s.startsWith(PREFIX_V2));
}

// v1 raw envelope (used for the DEK ciphertext and legacy rows)

function encryptWith(key: Buffer, plaintext: string, prefix: string, header = "", aad?: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}${header}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decryptWith(key: Buffer, body: string, aad?: Buffer): string {
  const parts = body.split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted secret");
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

// Encrypt with the MASTER key. Reserved for the DEK ciphertext stored on
// users.dek_ciphertext; do NOT use directly for user_settings.* secrets -
// those should go through encryptForUser() so they pick up the v2 envelope.
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  return encryptWith(getMasterKey(), plaintext, PREFIX_V1);
}

// Decrypts either v1 or v2 *without* userId context. v2 callers should prefer
// decryptForUser() which logs to secret_access_log. Used by encrypt-secrets.ts
// migration CLI which has no user context.
//
// During key rotation (ENCRYPTION_KEY_PREV is set) tries the current master
// first, then the previous one, so a half-rotated DB stays readable until
// the rotate-master-key CLI catches up.
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith(PREFIX_V1)) {
    return decryptWithMasterKeys(stored.slice(PREFIX_V1.length));
  }
  if (stored.startsWith(PREFIX_V2)) {
    throw new Error("v2 ciphertext requires decryptForUser(userId, reason)");
  }
  return stored; // legacy unencrypted - returned as-is
}

// per-tenant DEK helpers

// Returns a freshly generated 32-byte DEK and its v1 ciphertext (encrypted
// under the master KEK). Caller persists the ciphertext on users.dek_ciphertext.
export function generateDek(): { dek: Buffer; ciphertext: string } {
  const dek = randomBytes(32);
  const ciphertext = encryptWith(getMasterKey(), dek.toString("base64"), PREFIX_V1);
  return { dek, ciphertext };
}

// Unwraps the DEK ciphertext using the master KEK. Throws if not v1.
// During a master-key rotation window (ENCRYPTION_KEY_PREV set) tries the
// current key first, then falls back to the prev key so a half-rotated DB
// keeps decrypting until the rotate-master-key CLI catches every row.
export function unwrapDek(stored: string): Buffer {
  if (!stored.startsWith(PREFIX_V1)) throw new Error("DEK must be v1-wrapped");
  const dekB64 = decryptWithMasterKeys(stored.slice(PREFIX_V1.length));
  const dek = Buffer.from(dekB64, "base64");
  if (dek.length !== 32) throw new Error("Unwrapped DEK must be 32 bytes");
  return dek;
}

// Rewrap a DEK ciphertext under the CURRENT master key. Used by the
// rotate-master-key CLI to migrate rows from KEY_PREV → KEY_CURRENT.
// Returns the new ciphertext (caller persists). Pure function — no DB I/O.
export function rewrapDekUnderCurrentKey(stored: string): string {
  const dek = unwrapDek(stored);
  return encryptWith(getMasterKey(), dek.toString("base64"), PREFIX_V1);
}

// Current DEK generation stamp. Bumped on real DEK rotation (not yet
// implemented). New ciphertexts emit `g1`; legacy ciphertexts without a
// generation tag parse as `g0` and resolve to the current DEK.
export const DEK_GENERATION_CURRENT = 1;

// v2 envelope - encrypts under the user's DEK and stamps the userId in the
// header so we can route decryption to the right key at read time. A
// generation tag (`g1`, `g2`, …) is also stamped so future DEK rotation can
// route historical ciphertexts to the right historical key without rewriting
// every row at rotation time. The header (`userId:gN`) is bound into GCM
// as AAD (audit L3) so swapping headers between rows in the DB forces a
// tag-verification failure instead of a silent wrong-key decrypt.
export function encryptForUserWithDek(userId: number, dek: Buffer, plaintext: string): string {
  if (!plaintext) return plaintext;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("encryptForUserWithDek: bad userId");
  const header = `${userId}:g${DEK_GENERATION_CURRENT}:`;
  return encryptWith(dek, plaintext, PREFIX_V2, header, Buffer.from(`${userId}:g${DEK_GENERATION_CURRENT}`));
}

// Parses a v2 ciphertext header and returns the userId + generation + body.
// Backwards-compatible: a header without `:g<n>:` resolves to generation 0
// (the original v2 format before generation tagging was added).
export function parseV2(stored: string): { userId: number; generation: number; body: string } {
  if (!stored.startsWith(PREFIX_V2)) throw new Error("not a v2 ciphertext");
  const tail = stored.slice(PREFIX_V2.length);
  const sep = tail.indexOf(":");
  if (sep < 1) throw new Error("malformed v2 header");
  const userId = parseInt(tail.slice(0, sep), 10);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("malformed v2 userId");
  let rest = tail.slice(sep + 1);
  let generation = 0;
  const genMatch = /^g(\d+):/.exec(rest);
  if (genMatch) {
    generation = parseInt(genMatch[1], 10);
    if (!Number.isInteger(generation) || generation < 0) throw new Error("malformed v2 generation");
    rest = rest.slice(genMatch[0].length);
  }
  return { userId, generation, body: rest };
}

// Decrypts a v2 ciphertext given the user's DEK. Future rotation will pass a
// generation-specific DEK; for now there's only one DEK per user so the
// generation is informational.
//
// Try the AAD-bound decrypt first (audit L3 — new ciphertexts bind userId+gen
// into GCM AAD so header tampering is detected). Fall back to no-AAD for
// legacy rows written before the L3 fix. Both paths use the SAME ciphertext
// bytes — the difference is whether the AEAD verifies against AAD or not.
// Legacy rows naturally migrate to the new shape on the next write.
export function decryptWithDek(stored: string, dek: Buffer): string {
  const { userId, generation, body } = parseV2(stored);
  const aad = Buffer.from(`${userId}:g${generation}`);
  try {
    return decryptWith(dek, body, aad);
  } catch (eAad) {
    try {
      return decryptWith(dek, body);
    } catch {
      throw eAad;
    }
  }
}

// One-way hash for ingest tokens. The token itself has ~192 bits of entropy
// (24 random bytes, base64url), so an unsalted SHA-256 is fine - rainbow
// tables and brute-force are not feasible at that key length. We use it
// instead of equality on plaintext so a DB leak doesn't yield reusable tokens.
export function hashIngestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
