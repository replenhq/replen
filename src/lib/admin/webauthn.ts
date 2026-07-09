import "server-only";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getRpConfig, setChallengeCookie, readAndClearChallenge } from "./2fa";

// WebAuthn passkey ceremonies for the admin 2FA gate. Ported from the
// British-Housing admin (@simplewebauthn v13); storage is replen's SQLite
// admin_passkeys table, scoped by userId so an admin can only register/assert
// their own credentials.

async function userPasskeys(userId: number) {
  return db.select().from(schema.adminPasskeys).where(eq(schema.adminPasskeys.userId, userId));
}

function parseTransports(json: string | null): AuthenticatorTransportFuture[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? (a as AuthenticatorTransportFuture[]) : [];
  } catch {
    return [];
  }
}

export async function listPasskeys(userId: number) {
  const rows = await userPasskeys(userId);
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
}

export async function deletePasskey(userId: number, id: number): Promise<void> {
  await db.delete(schema.adminPasskeys).where(and(eq(schema.adminPasskeys.id, id), eq(schema.adminPasskeys.userId, userId)));
}

export async function registrationOptions(userId: number, userName: string) {
  const { rpID, rpName } = await getRpConfig();
  const existing = await userPasskeys(userId);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName,
    userID: Uint8Array.from(Buffer.from(`replen-admin-${userId}`, "utf8")),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: parseTransports(p.transports) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await setChallengeCookie(options.challenge, "register");
  return options;
}

export async function verifyRegistration(userId: number, response: RegistrationResponseJSON, label: string | null): Promise<boolean> {
  const challenge = await readAndClearChallenge("register");
  if (!challenge) return false;
  const { rpID, origin } = await getRpConfig();
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) return false;
  const { credential } = verification.registrationInfo;
  await db.insert(schema.adminPasskeys).values({
    userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports ?? []),
    label: label?.trim() || "passkey",
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });
  return true;
}

export async function authenticationOptions(userId: number) {
  const { rpID } = await getRpConfig();
  const stored = await userPasskeys(userId);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: stored.map((p) => ({ id: p.credentialId, transports: parseTransports(p.transports) })),
  });
  await setChallengeCookie(options.challenge, "authenticate");
  return { options, hasPasskeys: stored.length > 0 };
}

export async function verifyAuthentication(userId: number, response: AuthenticationResponseJSON): Promise<boolean> {
  const challenge = await readAndClearChallenge("authenticate");
  if (!challenge) return false;
  const stored = await db
    .select()
    .from(schema.adminPasskeys)
    .where(and(eq(schema.adminPasskeys.userId, userId), eq(schema.adminPasskeys.credentialId, response.id)))
    .get();
  if (!stored) return false;
  const { rpID, origin } = await getRpConfig();
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
      counter: stored.counter,
      transports: parseTransports(stored.transports),
    },
  });
  if (!verification.verified) return false;
  await db
    .update(schema.adminPasskeys)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(schema.adminPasskeys.id, stored.id));
  return true;
}
