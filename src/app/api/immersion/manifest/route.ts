import { NextResponse } from "next/server";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { resolveProject, effectiveTier, targetsFor, type ImmersionRequest } from "../_shared";
import { parseFacetCodeHash } from "@/lib/embeddings";

// POST /api/immersion/manifest
//
// Hosted Immersion (M2) step 1. The client (CLI or in-session skill) asks "is
// Immersion on for this repo, and which files should I send?". The server holds
// the grounded capabilities; the client holds the source. This endpoint returns
// the effective tier + the exact repo-relative paths the project's OWN
// capabilities cite (deny-list + code-extension filtered server-side) so the
// client never has to guess, and can't widen the set.
//
// No code is read or transmitted here — paths only. When the tier is "off" the
// path list is empty and the client sends nothing.
//
// Body: { "githubFullName": "owner/name" }  (or { "slug": "..." })
// 200:  { tier, paths: string[], storedCodeHash: string | null }
//
// Auth: x-digest-token, same as the other MCP endpoints.

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: ImmersionRequest;
  try {
    body = (await req.json()) as ImmersionRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const project = await resolveProject(auth.userId, body);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404, headers: corsHeaders });

  const tier = effectiveTier(auth.settings.immersionTier, project);
  if (tier === "off") {
    return NextResponse.json({ tier, paths: [], storedCodeHash: null }, { headers: corsHeaders });
  }

  // Deduped, ordered list of paths to read. (A path cited by two capabilities
  // appears once here; ingest re-derives the per-capability tagging.)
  const paths = Array.from(new Set(targetsFor(project).map((t) => t.rel)));
  const storedCodeHash = parseFacetCodeHash(project.facetEmbeddings);
  return NextResponse.json({ tier, paths, storedCodeHash }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
