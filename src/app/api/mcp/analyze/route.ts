import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { readUserSecret } from "@/lib/user-secrets";
import { authenticate, corsHeaders } from "../_auth";

// POST /api/mcp/analyze
//   body: { owner, name }
//
// Returns raw signals so the *caller's* Claude can judge fit against their
// open codebase. Deliberately does NOT run our triage/reason pipeline - the
// whole point of MCP is that the analysis happens with the user's project
// in context, not against a stale snapshot of project_profiles.
//
// Pulls: GitHub repo metadata + README + the user's project profiles.
const README_MAX = 12_000;

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  let body: { owner?: string; name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: corsHeaders }); }
  const owner = (body.owner ?? "").trim();
  const name = (body.name ?? "").trim().replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) {
    return NextResponse.json({ error: "invalid owner/name" }, { status: 400, headers: corsHeaders });
  }

  const tokenStored = auth.settings.githubToken ?? auth.settings.githubWriteToken;
  const token = tokenStored ? await safeDec(auth.userId, "githubToken", tokenStored) : null;
  if (!token) return NextResponse.json({ error: "no GitHub PAT on file" }, { status: 400, headers: corsHeaders });

  const ghHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "replen-mcp",
  };

  // Repo metadata + README in parallel.
  const [metaRes, readmeRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${name}`, { headers: ghHeaders }),
    fetch(`https://api.github.com/repos/${owner}/${name}/readme`, { headers: ghHeaders }),
  ]);
  if (!metaRes.ok) {
    return NextResponse.json({ error: `github /repos → ${metaRes.status}` }, { status: metaRes.status === 404 ? 404 : 502, headers: corsHeaders });
  }
  const meta = await metaRes.json() as {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    language: string | null;
    license: { name: string } | null;
    default_branch: string;
    created_at: string;
    pushed_at: string;
    archived: boolean;
    open_issues_count: number;
  };
  let readme = "";
  if (readmeRes.ok) {
    const r = await readmeRes.json() as { content: string; encoding: string };
    if (r.encoding === "base64") readme = Buffer.from(r.content, "base64").toString("utf8");
    if (readme.length > README_MAX) readme = readme.slice(0, README_MAX) + "\n\n[…readme truncated]";
  }

  // Existing match (so the caller knows the writeup already exists).
  const existingMatches = await db
    .select({ m: schema.matches, p: schema.projectProfiles })
    .from(schema.matches)
    .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
    .leftJoin(schema.projectProfiles, and(
      eq(schema.matches.projectId, schema.projectProfiles.id),
      eq(schema.projectProfiles.userId, auth.userId),
    ))
    .where(and(
      eq(schema.matches.userId, auth.userId),
      eq(schema.repos.owner, owner),
      eq(schema.repos.name, name),
    ));

  // User's project profiles - Claude needs these to know what fits where.
  const projects = await db
    .select({
      slug: schema.projectProfiles.slug,
      name: schema.projectProfiles.name,
      techSummary: schema.projectProfiles.techSummary,
      sensitivity: schema.projectProfiles.sensitivity,
      githubFullName: schema.projectProfiles.githubFullName,
    })
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, auth.userId), eq(schema.projectProfiles.included, true)));

  const ageDays = Math.round((Date.now() - +new Date(meta.created_at)) / 86400_000);
  const daysSincePush = Math.round((Date.now() - +new Date(meta.pushed_at)) / 86400_000);

  return NextResponse.json({
    repo: {
      owner: meta.owner.login,
      name: meta.name,
      fullName: meta.full_name,
      url: meta.html_url,
      description: meta.description,
      stars: meta.stargazers_count,
      forks: meta.forks_count,
      primaryLanguage: meta.language,
      license: meta.license?.name ?? null,
      defaultBranch: meta.default_branch,
      ageDays,
      daysSincePush,
      archived: meta.archived,
      openIssues: meta.open_issues_count,
    },
    readme,
    detectedLanguages: auth.settings.detectedLanguages,
    yourProjects: projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      sensitivity: p.sensitivity,
      techSummary: p.techSummary,
      githubFullName: p.githubFullName,
    })),
    existingMatches: existingMatches.map(({ m, p }) => ({
      matchId: m.id,
      project: p?.slug ?? "_general",
      relevance: m.relevance,
      relevanceScore: m.relevanceScore,
      writeup: ((m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "").slice(0, 1500),
      starred: m.userStatus === "starred",
      bookmarked: m.userStatus === "bookmarked",
      handoffPrUrl: m.handoffPrUrl,
    })),
  }, { headers: corsHeaders });
}

export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: corsHeaders }); }

async function safeDec(userId: number, column: string, stored: string): Promise<string | null> {
  try { return await readUserSecret(userId, column, stored, "mcp-analyze"); } catch { return null; }
}
