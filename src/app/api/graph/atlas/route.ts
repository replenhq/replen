import { NextResponse } from "next/server";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { renderAtlas } from "@/graph/atlas";

// Atlas §4 — returns the user's knowledge graph rendered as a markdown vault
// (path → content). The `replen atlas` CLI writes these to ~/.replen/atlas/.

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  const files = await renderAtlas(auth.userId);
  return NextResponse.json({ count: files.length, files }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
