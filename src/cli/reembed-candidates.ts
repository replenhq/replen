// One-off backfill: re-embed a user's fetcher candidates with the enriched
// surface signal (README head + deterministic topic→modality) introduced in the
// candidate-side parity work. The in-pipeline embed pass only touches NEW
// (null-embedding) candidates and caps at 500/run oldest-first; this re-embeds
// ALL null-embedding candidates for a user, RECENT-FIRST (so the matchable ones
// land soonest), with no cap. Idempotent: re-run safely.
//
// Usage (host):  ssh prod-server 'cd /opt/replen && set -a && . ./.env && set +a && \
//   npx tsx src/cli/reembed-candidates.ts --user 1'

import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import { candidateEmbeddingText, embedBatch, serialiseEmbedding } from "../lib/embeddings";
import { fetchReadmeHead } from "../catalogue/builder";
import { modalityFromTopics } from "../projects/modality";

function argNum(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) { const n = parseInt(process.argv[i + 1], 10); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}
const parseArr = (s: string | null): string[] => { try { const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
const descOf = (raw: string | null): string | null => { try { const j = raw ? JSON.parse(raw) : null; const d = j?.description ?? j?.text ?? null; return typeof d === "string" ? d : null; } catch { return null; } };
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

async function main() {
  const userId = argNum("user");
  if (userId == null) { console.error("--user N required"); process.exit(1); }
  const token = process.env.GITHUB_TOKEN || undefined;
  let total = 0, withReadme = 0, withMod = 0, round = 0;
  for (;;) {
    const pending = await db.select()
      .from(schema.candidates)
      .where(and(eq(schema.candidates.userId, userId), isNull(schema.candidates.embedding)))
      .orderBy(desc(schema.candidates.fetchedAt))
      .limit(100);
    if (pending.length === 0) break;
    round++;
    const enriched = await mapLimit(pending, 8, async (c) => {
      const topics = parseArr(c.topics);
      const modality = modalityFromTopics(topics);
      const fullName = c.githubUrl?.toLowerCase().match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1] ?? null;
      const readmeHead = c.readmeHead ?? (fullName ? await fetchReadmeHead(fullName, token) : null);
      const text = candidateEmbeddingText({ title: c.title, description: descOf(c.rawJson), topics, repoShape: c.repoShape, primaryLanguage: c.primaryLanguage, readmeHead });
      return { modality, readmeHead, text };
    });
    const vecs = await embedBatch(enriched.map((e) => e.text));
    let wrote = 0;
    for (let i = 0; i < pending.length; i++) {
      const r = vecs[i];
      if (!r) continue;
      await db.update(schema.candidates).set({
        embedding: serialiseEmbedding(r.vector), embeddingContentHash: r.contentHash, embeddingGeneratedAt: r.generatedAt,
        readmeHead: enriched[i].readmeHead ?? pending[i].readmeHead, modality: JSON.stringify(enriched[i].modality),
      }).where(eq(schema.candidates.id, pending[i].id));
      wrote++;
      total++;
      if (enriched[i].readmeHead) withReadme++;
      if (enriched[i].modality.length) withMod++;
    }
    console.log(`  round ${round}: embedded ${wrote}/${pending.length} (running total ${total})`);
    if (wrote === 0) { console.error("  embedding failed (OPENAI_API_KEY?) — stopping"); break; }
  }
  console.log(`\nDone. Re-embedded ${total} candidate(s) for user ${userId} — ${withReadme} with a README head, ${withMod} with a topic-derived modality.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
