import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { authenticate, corsHeaders } from "../../mcp/_auth";

// GET/POST /api/settings/immersion
//
// Token-authed Immersion opt-in for the CLI (the /settings web form uses the
// session-based route; this is the headless equivalent). Account-level default;
// a per-repo override still wins where set.
//
// GET  → { tier }                       current account default
// POST { tier: "off" | "embeddings" }   set it (returns { ok, tier })
//
// "full-code" is intentionally NOT accepted: hosted Immersion v1 is vectors-only
// / no-retention. Allowing it would imply a retention surface that doesn't exist
// yet. Self-host doesn't use this endpoint (it defaults on via REPLEN_SELF_HOST).

const ALLOWED = new Set(["off", "embeddings"]);

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  return NextResponse.json({ tier: auth.settings.immersionTier ?? "off" }, { headers: corsHeaders });
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: { tier?: unknown };
  try {
    body = (await req.json()) as { tier?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  const tier = typeof body.tier === "string" ? body.tier.trim().toLowerCase() : "";
  if (!ALLOWED.has(tier)) {
    return NextResponse.json({ error: "tier must be 'off' or 'embeddings'" }, { status: 400, headers: corsHeaders });
  }

  await db
    .update(schema.userSettings)
    .set({ immersionTier: tier, updatedAt: new Date() })
    .where(eq(schema.userSettings.userId, auth.userId));

  return NextResponse.json({ ok: true, tier }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
