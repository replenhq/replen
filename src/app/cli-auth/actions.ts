"use server";

import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth/current-user";
import { randomBytes } from "crypto";

export type AuthorizeResult =
  | { ok: true; callback: string }
  | { ok: false; error: string };

export async function authorizeCli(port: number, state: string): Promise<AuthorizeResult> {
  const u = await requireUser();

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, error: "Invalid port" };
  }
  if (!/^[a-f0-9]{32,128}$/i.test(state)) {
    return { ok: false, error: "Invalid state" };
  }

  const existing = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, u.id))
    .get();
  let token = existing?.ingestToken ?? null;
  if (!token) {
    token = "ing_" + randomBytes(24).toString("base64url");
    if (existing) {
      await db
        .update(schema.userSettings)
        .set({ ingestToken: token, updatedAt: new Date() })
        .where(eq(schema.userSettings.userId, u.id));
    } else {
      await db.insert(schema.userSettings).values({
        userId: u.id,
        ingestToken: token,
        updatedAt: new Date(),
      });
    }
  }

  const base = process.env.PUBLIC_BASE_URL || "https://app.replen.dev";
  const cb = new URL(`http://127.0.0.1:${port}/callback`);
  cb.searchParams.set("token", token);
  cb.searchParams.set("state", state);
  cb.searchParams.set("base", base);
  return { ok: true, callback: cb.toString() };
}
