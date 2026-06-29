import { NextResponse } from "next/server";
import { db, schema } from "@/db/client";
import { sql } from "drizzle-orm";
import { getEmbeddingHealth } from "@/lib/embeddings";

// GET /api/status
//
// Public, no-auth, CORS-open status board for status.replen.dev (a static page
// hosted independently of this server, so it can report this server as DOWN
// when it is). Returns only coarse component health + public version info, no
// user data (deliberately not the user/match counts that /api/healthz also
// withholds). Fail-open: a check that errors degrades its own component, never
// the whole response.
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store, max-age=0",
};

type Status = "operational" | "degraded" | "down";
type Component = { name: string; status: Status; detail?: string };

const PIPELINE_STALE_MS = 26 * 60 * 60 * 1000; // a daily cron > 26h quiet = degraded
const VERSION_TIMEOUT_MS = 2500;

async function latestNpm(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return typeof j.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function GET() {
  const components: Component[] = [];

  // Web app + API: if this handler runs, the Next server is serving.
  components.push({ name: "Web app", status: "operational" });
  components.push({ name: "API server", status: "operational" });

  // Database: a trivial query (result discarded — no counts surfaced).
  try {
    await db.select({ c: sql<number>`1` }).from(schema.users).limit(1).get();
    components.push({ name: "Database", status: "operational" });
  } catch {
    components.push({ name: "Database", status: "down", detail: "unreachable" });
  }

  // Matching (embeddings): a quota/billing outage is degraded-but-up.
  const emb = getEmbeddingHealth();
  components.push(
    emb.ok
      ? { name: "Matching (embeddings)", status: "operational" }
      : { name: "Matching (embeddings)", status: "degraded", detail: emb.lastFailure?.quotaExhausted ? "embedding quota exhausted" : "embedding errors" },
  );

  // Pipeline: freshness of the most recent successful run (no user attribution).
  try {
    const row = await db
      .select({ last: sql<number | null>`max(${schema.digestRuns.finishedAt})` })
      .from(schema.digestRuns)
      .where(sql`${schema.digestRuns.finishedAt} is not null and ${schema.digestRuns.errorLog} is null`)
      .get();
    const lastMs = row?.last ? Number(row.last) * 1000 : null; // timestamp mode = unix seconds
    if (lastMs == null) {
      components.push({ name: "Ingestion pipeline", status: "degraded", detail: "no completed run yet" });
    } else {
      const age = Date.now() - lastMs;
      components.push({
        name: "Ingestion pipeline",
        status: age <= PIPELINE_STALE_MS ? "operational" : "degraded",
        detail: `last run ${ago(age)}`,
      });
    }
  } catch {
    components.push({ name: "Ingestion pipeline", status: "degraded", detail: "run history unavailable" });
  }

  // Published package + skill versions (public info from the npm registry).
  const [mcpV, cliV] = await Promise.all([latestNpm("@replen/mcp"), latestNpm("replen")]);
  components.push({ name: "MCP server (@replen/mcp)", status: mcpV ? "operational" : "degraded", detail: mcpV ? `latest v${mcpV}` : "registry unreachable" });
  components.push({ name: "CLI (replen)", status: cliV ? "operational" : "degraded", detail: cliV ? `latest v${cliV}` : "registry unreachable" });
  // Skills ship inside the CLI package; their availability tracks the CLI.
  components.push({ name: "Skills (/replen, /replen-onboard)", status: cliV ? "operational" : "degraded", detail: cliV ? `bundled with CLI v${cliV}` : undefined });

  const overall: Status = components.some((c) => c.status === "down")
    ? "down"
    : components.some((c) => c.status === "degraded")
      ? "degraded"
      : "operational";

  return NextResponse.json(
    { overall, generatedAt: new Date().toISOString(), components },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
