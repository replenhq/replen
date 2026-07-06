import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { authenticate, corsHeaders } from "../../mcp/_auth";
import { allowAction, WRITE_LIMIT, WRITE_WINDOW_MS } from "@/lib/rate-limit";
import { resolveProject, effectiveTier, targetsFor, type ImmersionRequest } from "../_shared";
import { embedCodeItems, mergeCodeFacets, blobHasCodeFacets, type CodeItem } from "@/projects/immersion";
import { parseFacetCodeHash } from "@/lib/embeddings";

// POST /api/immersion/ingest
//
// Hosted Immersion (M2) step 2 — the transmit path. On hosted, the server is
// NOT the user's machine, so the client sends the grounded source files (from
// the manifest) here. The server embeds them with Replen's own key (no per-user
// bill), folds the vectors into facet_embeddings exactly as the self-host
// pipeline phase does, and DISCARDS the raw source — only the 1536-float
// vectors persist. Vectors-only, no retention: there is no code-at-rest surface.
//
// Hard guards:
//   - tier must be != "off" for this project (account default ± per-repo override)
//   - only paths the project's OWN capabilities cite are embedded; anything else
//     in the payload is ignored (a client can't smuggle in arbitrary files)
//   - modality is taken from the server-side capability spec, never the client
//     (so the cross-modal gate can't be spoofed)
//   - the secret deny-list + traversal filter re-run inside embedCodeItems
//   - payload size/count caps below
//
// Body: { githubFullName | slug, files: [{ rel, content }] }
// 200:  { ok, unchanged, filesEmbedded, chunksEmbedded }
//
// Auth: x-digest-token.

// Bound the payload: a grounded set is small. These cap abuse, not real use.
const MAX_FILES = 300;
const MAX_FILE_BYTES = 1_000_000;       // mirrors the walker/immersion per-file cap
const MAX_TOTAL_BYTES = 12_000_000;     // ~12MB across the whole request

type FileInput = { rel?: unknown; content?: unknown };

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  // Each call triggers server-paid OpenAI embedding batches — rate limit it.
  if (!allowAction(`immersion:${auth.userId}`, WRITE_LIMIT, WRITE_WINDOW_MS)) {
    return NextResponse.json({ error: "rate limit exceeded, slow down" }, { status: 429, headers: corsHeaders });
  }

  let body: ImmersionRequest & { files?: FileInput[] };
  try {
    body = (await req.json()) as ImmersionRequest & { files?: FileInput[] };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  if (!Array.isArray(body.files)) {
    return NextResponse.json({ error: "files array required" }, { status: 400, headers: corsHeaders });
  }
  if (body.files.length > MAX_FILES) {
    return NextResponse.json({ error: `max ${MAX_FILES} files per call` }, { status: 413, headers: corsHeaders });
  }

  const project = await resolveProject(auth.userId, body);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404, headers: corsHeaders });

  const tier = effectiveTier(auth.settings.immersionTier, project);
  if (tier === "off") {
    return NextResponse.json({ ok: true, skipped: "immersion-off", unchanged: false, filesEmbedded: 0, chunksEmbedded: 0 }, { headers: corsHeaders });
  }

  // Map incoming content by clean rel. Enforce per-file + total byte caps.
  const contentByRel = new Map<string, string>();
  let totalBytes = 0;
  for (const f of body.files) {
    const rel = typeof f.rel === "string" ? f.rel.trim().replace(/^[/\\]+/, "").split("\\").join("/") : "";
    const content = typeof f.content === "string" ? f.content : "";
    if (!rel || !content) continue;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) continue;          // oversized → skip this file
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413, headers: corsHeaders });
    }
    if (!contentByRel.has(rel)) contentByRel.set(rel, content);
  }

  // Build items ONLY for the grounded targets — server-authoritative (tag,
  // modality). A file the client sent that no capability cites is dropped here.
  const targets = targetsFor(project);
  const items: CodeItem[] = [];
  for (const t of targets) {
    const content = contentByRel.get(t.rel);
    if (content === undefined) continue; // client didn't send it (unchanged / absent)
    items.push({ tag: t.tag, modality: t.modality, rel: t.rel, content });
  }

  const priorHash = parseFacetCodeHash(project.facetEmbeddings);
  const result = await embedCodeItems(items, { priorHash });
  if (result.unchanged) {
    return NextResponse.json({ ok: true, unchanged: true, filesEmbedded: 0, chunksEmbedded: 0 }, { headers: corsHeaders });
  }
  // Nothing embedded AND none before → no write (avoid churning updated_at).
  if (result.facets.length === 0 && !blobHasCodeFacets(project.facetEmbeddings)) {
    return NextResponse.json({ ok: true, unchanged: false, filesEmbedded: 0, chunksEmbedded: 0 }, { headers: corsHeaders });
  }

  await db
    .update(schema.projectProfiles)
    .set({
      facetEmbeddings: mergeCodeFacets(project.facetEmbeddings, result.facets, result.hash),
      updatedAt: new Date(),
    })
    .where(eq(schema.projectProfiles.id, project.id));

  // result + items go out of scope here — the raw source is never written.
  return NextResponse.json(
    { ok: true, unchanged: false, filesEmbedded: result.filesRead, chunksEmbedded: result.chunksEmbedded },
    { headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
