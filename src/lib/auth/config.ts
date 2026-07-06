// Prefer the base64-encoded form: completely sidesteps the systemd EnvironmentFile
// backslash-stripping gotcha and the .env shell-quoting gotcha. Fall back to the raw
// form (with \n unescape) for backwards compatibility.
function normalizePrivateKey(): string {
  const b64 = process.env.FIREBASE_PRIVATE_KEY_BASE64;
  if (b64) {
    try {
      return atob(b64.trim());
    } catch {
      // fall through to raw
    }
  }
  const raw = process.env.FIREBASE_PRIVATE_KEY || "";
  // Some pipelines deliver real newlines, others deliver literal `\n` sequences,
  // and broken pipelines strip the backslash entirely leaving stray `n` chars.
  // Handle the first two; the third (n-stripped) is unrecoverable - use base64.
  return raw.replace(/\\n/g, "\n");
}

const isProd = process.env.NODE_ENV === "production";

// Only the current secret is required; the previous one is optional (present
// only during a rotation). Filter out any falsy/empty entry so an unset
// COOKIE_SECRET_PREVIOUS can never become an empty HMAC verification key —
// which would silently accept cookies signed with the empty string.
const cookieSignatureKeys = [
  process.env.COOKIE_SECRET_CURRENT,
  process.env.COOKIE_SECRET_PREVIOUS,
].filter((k): k is string => typeof k === "string" && k.length > 0);

// NOTE: the boot-time COOKIE_SECRET assertion lives in src/db/client.ts, NOT
// here. This module is imported by the Edge middleware, and the Edge runtime
// forbids process.exit() — putting the hard-fail here breaks `next build`.
// The edge-safe part (filtering empty keys out of cookieSignatureKeys) stays.

export const authConfig = {
  // Same Firebase web API key as the client SDK uses; falling back to the
  // NEXT_PUBLIC_ one lets us keep a single source of truth in .env.
  apiKey: (process.env.FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY)!,
  cookieName: "__session",
  cookieSignatureKeys,
  cookieSerializeOptions: {
    path: "/",
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    maxAge: 12 * 60 * 60 * 24,
    // Host-only by default. Only set AUTH_COOKIE_DOMAIN (e.g. ".example.com")
    // when every subdomain under that parent is first-party and equally
    // trusted — a parent-domain cookie is sent to ALL subdomains, so an
    // XSS or untrusted content on any sibling becomes session theft.
    domain: isProd ? (process.env.AUTH_COOKIE_DOMAIN || undefined) : undefined,
  },
  serviceAccount: {
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
    clientEmail: (process.env.FIREBASE_CLIENT_EMAIL || "").trim(),
    privateKey: normalizePrivateKey(),
  },
  enableMultipleCookies: true,
  debug: !isProd,
};
