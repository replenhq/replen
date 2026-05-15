// Symmetric encryption for at-rest secrets in user_settings (GitHub PAT, LLM
// API keys). AES-256-GCM with a key from ENCRYPTION_KEY (base64-encoded 32 bytes).
//
// On-disk format:  enc:v1:<iv_b64>:<auth_tag_b64>:<ciphertext_b64>
//
// Decryption is backward-compatible: anything without the "enc:v1:" prefix is
// treated as plaintext (so old rows keep working until the migration script
// runs). After backfill, all secrets should match the enc:v1: prefix.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
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
  cachedKey = buf;
  return buf;
}

export function isEncrypted(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

// Returns the original plaintext. If the input doesn't have the enc:v1: prefix,
// it's returned unchanged (legacy row that hasn't been migrated yet — the
// CLI in src/cli/encrypt-secrets.ts rewrites these).
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const body = stored.slice(PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted secret");
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

// Encrypt only when ENCRYPTION_KEY is configured. Lets early adopters delay
// rolling out a key — but in production you should set the key and migrate.
export function maybeEncrypt(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  if (!process.env.ENCRYPTION_KEY) {
    console.warn("[crypto] ENCRYPTION_KEY not set — storing secret as plaintext");
    return plaintext;
  }
  return encryptSecret(plaintext);
}
