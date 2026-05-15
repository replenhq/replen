import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "@/lib/crypto";
import { createHandoffPR } from "@/lib/github-pr";
import { handoffBranchName, handoffFilePath, renderHandoff } from "@/lib/handoff-template";
import { authenticate, corsHeaders } from "../_auth";

// POST /api/mcp/handoff  body: { matchId }
// Mirrors the `createHandoff` server action but uses token auth so the MCP
// server can drive it from Claude Code without a browser session.
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: { matchId?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders }); }
  const matchId = Number(body.matchId);
  if (!Number.isInteger(matchId) || matchId <= 0) {
    return NextResponse.json({ error: "matchId required" }, { status: 400, headers: corsHeaders });
  }

  const match = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.id, matchId), eq(schema.matches.userId, auth.userId)))
    .get();
  if (!match) return NextResponse.json({ error: "match not found" }, { status: 404, headers: corsHeaders });
  if (match.handoffPrUrl) return NextResponse.json({ ok: true, prUrl: match.handoffPrUrl, reason: "already exists" }, { headers: corsHeaders });
  if (!match.projectId) return NextResponse.json({ error: "_general match has no project to commit to" }, { status: 400, headers: corsHeaders });

  const project = await db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, match.projectId)).get();
  if (!project?.githubFullName) return NextResponse.json({ error: "set project's github_full_name on /projects first" }, { status: 400, headers: corsHeaders });
  if (!/^[\w.-]+\/[\w.-]+$/.test(project.githubFullName)) return NextResponse.json({ error: "invalid github_full_name format" }, { status: 400, headers: corsHeaders });

  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, match.repoId)).get();
  if (!repo) return NextResponse.json({ error: "repo missing" }, { status: 500, headers: corsHeaders });

  const tokenStored = auth.settings.githubToken ?? auth.settings.githubWriteToken;
  const writeToken = tokenStored ? safeDec(tokenStored) : null;
  if (!writeToken) return NextResponse.json({ error: "no GitHub PAT on file" }, { status: 400, headers: corsHeaders });

  const filePath = handoffFilePath(repo.owner, repo.name);
  const branch = handoffBranchName(repo.owner, repo.name);
  const fileContent = renderHandoff(
    match,
    { owner: repo.owner, name: repo.name, url: repo.url, stars: repo.stars, primaryLanguage: repo.primaryLanguage, license: repo.license },
    project.slug,
    filePath,
  );
  const prTitle = `Handoff: ${repo.owner}/${repo.name}`;
  const prBody = `Automated handoff from replen (via MCP).

This PR adds \`${filePath}\` describing why \`${repo.owner}/${repo.name}\` surfaced as a potential fit for \`${project.slug}\`, plus a prompt for Claude Code / Codex to re-evaluate it with knowledge of this codebase.

Source: ${repo.url}
Match relevance: ${match.relevance}${match.relevanceScore != null ? ` (${match.relevanceScore})` : ""}`;

  let result;
  try {
    result = await createHandoffPR({
      token: writeToken,
      ownerRepo: project.githubFullName,
      filePath,
      fileContent,
      branch,
      prTitle,
      prBody,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502, headers: corsHeaders });
  }
  if (result.skipped === "file_exists") {
    return NextResponse.json({ error: `${filePath} already exists on default branch — skipped` }, { status: 409, headers: corsHeaders });
  }

  await db.update(schema.matches).set({ handoffPrUrl: result.prUrl, handoffCreatedAt: new Date() }).where(eq(schema.matches.id, matchId));
  return NextResponse.json({ ok: true, prUrl: result.prUrl, filePath, branch }, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }

function safeDec(stored: string): string | null {
  try { return decryptSecret(stored); } catch { return null; }
}
