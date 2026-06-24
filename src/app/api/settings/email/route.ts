import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

// Saves the account email preferences from the /settings form (a plain POST,
// no client JS — same shape as the delete-account form). requireUser scopes the
// write to the signed-in user; we redirect back to /settings with a flash flag.

const FREQS = ["off", "weekly", "twiceweekly", "biweekly", "monthly"];

export async function POST(req: Request) {
  const user = await requireUser();
  const form = await req.formData();

  const freqRaw = String(form.get("briefFrequency") ?? "weekly");
  const briefFrequency = FREQS.includes(freqRaw) ? freqRaw : "weekly";

  // Checkboxes are present only when ticked → absent means off. Email always goes
  // to the account address; there is no separate destination field.
  const patch = {
    enabled: form.has("enabled"),
    digestEnabled: form.has("digestEnabled"),
    securityAlertsEnabled: form.has("securityAlertsEnabled"),
    weeklyBriefEnabled: briefFrequency !== "off",
    briefFrequency,
    updatedAt: new Date(),
  };

  const existing = await db
    .select({ userId: schema.userSettings.userId })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, user.id))
    .get();
  if (existing) {
    await db.update(schema.userSettings).set(patch).where(eq(schema.userSettings.userId, user.id));
  } else {
    await db.insert(schema.userSettings).values({ userId: user.id, ...patch });
  }

  return NextResponse.redirect(new URL("/settings?saved=1", req.url), 303);
}
