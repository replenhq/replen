import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { readUserSecret } from "@/lib/user-secrets";
import { createHandoffPR } from "@/lib/github-pr";
import { handoffBranchName, handoffFilePath, renderHandoff, sanitizePrTitle } from "@/lib/handoff-template";
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

  const project = await db.select().from(schema.projectProfiles).where(and(eq(schema.projectProfiles.id, match.projectId), eq(schema.projectProfiles.userId, auth.userId))).get();
  if (!project?.githubFullName) return NextResponse.json({ error: "set project's github_full_name on /projects first" }, { status: 400, headers: corsHeaders });
  if (!/^[\w.-]+\/[\w.-]+$/.test(project.githubFullName)) return NextResponse.json({ error: "invalid github_full_name format" }, { status: 400, headers: corsHeaders });

  const repo = await db.select().from(schema.repos).where(eq(schema.repos.id, match.repoId)).get();
  if (!repo) return NextResponse.json({ error: "repo missing" }, { status: 500, headers: corsHeaders });

  const tokenStored = auth.settings.githubToken ?? auth.settings.githubWriteToken;
  const writeToken = tokenStored ? await safeDec(auth.userId, "githubToken", tokenStored) : null;
  if (!writeToken) return NextResponse.json({ error: "no GitHub PAT on file" }, { status: 400, headers: corsHeaders });

  const filePath = handoffFilePath(repo.owner, repo.name);
  const branch = handoffBranchName(repo.owner, repo.name);
  const fileContent = renderHandoff(
    match,
    { owner: repo.owner, name: repo.name, url: repo.url, stars: repo.stars, primaryLanguage: repo.primaryLanguage, license: repo.license },
    project.slug,
    filePath,
  );
  const prTitle = sanitizePrTitle(`Handoff: ${repo.owner}/${repo.name}`);
  const safeOwner = repo.owner.replace(/[`\n]/g, "");
  const safeName = repo.name.replace(/[`\n]/g, "");
  const safeSlug = project.slug.replace(/[`\n]/g, "");
  const safeFile = filePath.replace(/[`\n]/g, "");
  const safeRelevance = String(match.relevance).replace(/[`\n]/g, "");
  const prBody = `Automated handoff from replen (via MCP).

This PR adds \`${safeFile}\` describing why \`${safeOwner}/${safeName}\` surfaced as a potential fit for \`${safeSlug}\`, plus a prompt for Claude Code / Codex to re-evaluate it with knowledge of this codebase.

Source: ${repo.url}
Match relevance: ${safeRelevance}${match.relevanceScore != null ? ` (${match.relevanceScore})` : ""}`;

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
    // Don't echo the upstream GitHub API error verbatim to the client; log it
    // server-side and return a generic, non-leaky message.
    console.warn(`[/api/mcp/handoff] upstream failure user=${auth.userId}:`, (e as Error).message);
    return NextResponse.json({ error: "handoff PR creation failed upstream; check your GitHub token + repo access" }, { status: 502, headers: corsHeaders });
  }
  if (result.skipped === "file_exists") {
    return NextResponse.json({ error: `${filePath} already exists on default branch - skipped` }, { status: 409, headers: corsHeaders });
  }

  await db.update(schema.matches).set({ handoffPrUrl: result.prUrl, handoffCreatedAt: new Date() }).where(eq(schema.matches.id, matchId));
  return NextResponse.json({ ok: true, prUrl: result.prUrl, filePath, branch }, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }

async function safeDec(userId: number, column: string, stored: string): Promise<string | null> {
  try { return await readUserSecret(userId, column, stored, "mcp-handoff"); } catch { return null; }
}
