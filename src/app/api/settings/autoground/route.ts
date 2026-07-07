import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { authenticate, corsHeaders } from "../../mcp/_auth";

// GET/POST /api/settings/autoground
//
// Token-authed master switch for SILENT AUTO-REGROUND — the in-session agent
// silently re-deriving a repo's grounded capabilities (in a background subagent)
// when they drift from live code or fall behind the grounding schema. Default
// ON. Flipped by `npx replen autoground on|off`.
//
// GET  → { enabled }
// POST { enabled: boolean }  → set it (returns { ok, enabled })
//
// When off, the inventory + onboard-state routes never emit needsReground and
// the injected instruction reverts to the consent offer for onboarding.

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  return NextResponse.json({ enabled: auth.settings.autogroundEnabled !== false }, { headers: corsHeaders });
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400, headers: corsHeaders });
  }

  await db
    .update(schema.userSettings)
    .set({ autogroundEnabled: body.enabled, updatedAt: new Date() })
    .where(eq(schema.userSettings.userId, auth.userId));

  return NextResponse.json({ ok: true, enabled: body.enabled }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
