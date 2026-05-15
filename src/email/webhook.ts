import { db, schema } from "../db/client";
import { and, eq, desc } from "drizzle-orm";
import { resolveSafe, validateWebhookUrl } from "../lib/url-guard";

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
  for (const id of repoIds) {
    const r = await db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
    if (r) repos.set(id, r);
  }
  const projects = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  for (const m of matches) {
    if (m.projectId && !projects.has(m.projectId)) {
      const p = await db.select().from(schema.projectProfiles).where(eq(schema.projectProfiles.id, m.projectId)).get();
      if (p) projects.set(m.projectId, p);
    }
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

  // Re-validate the URL right before the fetch. Save-time validation could
  // have passed (public hostname, https) while DNS now resolves to a private
  // address (DNS rebinding / DNS hijack). Resolve and reject any private,
  // loopback, link-local or multicast address. The dns.lookup result is
  // passed through hostname-resolution only - the actual fetch reuses the
  // original URL so TLS hostname verification still works against a hostile
  // resolver only when paired with a hostile CA, which is out of scope.
  const syntactic = validateWebhookUrl(webhookUrl);
  if (!syntactic.ok) {
    throw new Error(`webhook URL refused: ${syntactic.error}`);
  }
  const safe = await resolveSafe(syntactic.url);
  if (!safe.ok) {
    throw new Error(`webhook URL refused: ${safe.error}`);
  }

  // Body size + status both ignored on response: never reflect the response
  // body in our error path to prevent the webhook destination from being
  // used as an oracle.
  const res = await fetch(syntactic.url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(`webhook delivery failed: HTTP ${res.status}`);
  }
}
