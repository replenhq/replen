import { db, schema } from "../db/client";
import { and, eq, desc, inArray } from "drizzle-orm";
import { resolveSafeWithPinnedDispatcher, validateWebhookUrl } from "../lib/url-guard";

// Real-time alert for high-relevance matches in a just-finished run. POSTs
// a JSON payload that Slack and Discord both accept (text + simple blocks /
// embeds). `generic` mode posts a plain `{ runId, matches: [...] }` JSON.
//
// We deliberately only ping for `relevance=high`; anything weaker is digest
// noise and would defeat the point of a real-time channel.
export async function sendHighRelevanceWebhook(
  runId: number,
  userId: number,
  webhookUrl: string,
  kind: string,
): Promise<void> {
  const matches = await db
    .select()
    .from(schema.matches)
    .where(and(
      eq(schema.matches.runId, runId),
      eq(schema.matches.userId, userId),
      eq(schema.matches.relevance, "high"),
    ))
    .orderBy(desc(schema.matches.relevanceScore))
    .limit(10);
  if (matches.length === 0) return;

  const repoIds = [...new Set(matches.map((m) => m.repoId))];
  const repos = new Map<number, typeof schema.repos.$inferSelect>();
  if (repoIds.length > 0) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repos.set(r.id, r);
  }
  const projectIds = [...new Set(matches.map((m) => m.projectId).filter((id): id is number => id !== null))];
  const projects = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length > 0) {
    const ps = await db.select().from(schema.projectProfiles).where(inArray(schema.projectProfiles.id, projectIds));
    for (const p of ps) projects.set(p.id, p);
  }

  const lines = matches.map((m) => {
    const r = repos.get(m.repoId);
    const p = m.projectId ? projects.get(m.projectId)?.slug ?? "_unknown" : "_general";
    return { slug: p, repo: r ? `${r.owner}/${r.name}` : "?", url: r?.url ?? "", score: m.relevanceScore ?? 0, summary: (m.summary ?? "").slice(0, 200) };
  });

  let body: object;
  if (kind === "slack") {
    body = {
      text: `🔥 ${matches.length} high-relevance OSS ${matches.length === 1 ? "match" : "matches"}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: `🔥 ${matches.length} high-relevance ${matches.length === 1 ? "match" : "matches"}` } },
        ...lines.map((l) => ({
          type: "section",
          text: { type: "mrkdwn", text: `*<${l.url}|${l.repo}>* → \`${l.slug}\` · score ${l.score}\n${l.summary}` },
        })),
      ],
    };
  } else if (kind === "discord") {
    body = {
      content: `🔥 **${matches.length} high-relevance OSS ${matches.length === 1 ? "match" : "matches"}**`,
      embeds: lines.slice(0, 10).map((l) => ({
        title: l.repo,
        url: l.url,
        description: l.summary,
        fields: [
          { name: "project", value: l.slug, inline: true },
          { name: "score", value: String(l.score), inline: true },
        ],
        color: 0x1f8a4c,
      })),
    };
  } else {
    body = { runId, matches: lines };
  }

  // Validate syntactically, then DNS-resolve and pin the result. A hostile
  // resolver that returns a public IP at validate-time and a private IP at
  // fetch-time cannot rebind us because the dispatcher's connect step is
  // already bound to the address we approved.
  const syntactic = validateWebhookUrl(webhookUrl);
  if (!syntactic.ok) {
    throw new Error(`webhook URL refused: ${syntactic.error}`);
  }
  const pinned = await resolveSafeWithPinnedDispatcher(syntactic.url);
  if (!pinned.ok) {
    throw new Error(`webhook URL refused: ${pinned.error}`);
  }

  // Body size + status both ignored on response: never reflect the response
  // body in our error path to prevent the webhook destination from being
  // used as an oracle.
  const res = await fetch(syntactic.url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    // Typed as `any` because the standard fetch RequestInit doesn't surface
    // undici's `dispatcher` extension. Node's runtime accepts it.
    dispatcher: pinned.dispatcher,
  } as any);
  if (!res.ok) {
    throw new Error(`webhook delivery failed: HTTP ${res.status}`);
  }
}
