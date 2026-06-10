// One-off catalogue enrichment: fetch README heads for catalogue repos that
// don't have one yet and re-embed them with the richer text. Idempotent and
// resumable — rows with a readme_head are skipped, so an interrupted run
// continues where it left off. Repos whose README fetch 404s get an empty
// marker so they aren't refetched forever.
//
// Usage:
//   tsx src/cli/reembed-catalogue.ts [--limit 200] [--all]   (--all re-embeds even rows with readme_head)

import { eq, isNull, or } from "drizzle-orm";
import { db, schema } from "../db/client";
import { embedBatch, candidateEmbeddingText, serialiseEmbedding } from "../lib/embeddings";
import { fetchReadmeHead } from "../catalogue/builder";

const NO_README_MARKER = ""; // distinguishes "fetched, none found" from "never fetched" (NULL)

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main() {
  const limit = arg("limit") ? parseInt(arg("limit")!, 10) : Infinity;
  const all = process.argv.includes("--all");
  const token = process.env.GITHUB_TOKEN;

  const rows = all
    ? await db.select().from(schema.catalogueRepos)
    : await db.select().from(schema.catalogueRepos).where(or(isNull(schema.catalogueRepos.readmeHead), eq(schema.catalogueRepos.readmeHead, NO_README_MARKER)));
  const todo = rows.filter((r) => all || r.readmeHead == null).slice(0, Number.isFinite(limit) ? limit : undefined);
  console.log(`[reembed] ${todo.length} catalogue repos to enrich (of ${rows.length} candidates)`);

  let fetched = 0;
  let embedded = 0;
  const BATCH = 32;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const heads: Array<string | null> = [];
    for (const r of batch) {
      const head = r.readmeHead && r.readmeHead !== NO_README_MARKER ? r.readmeHead : await fetchReadmeHead(r.fullName, token);
      heads.push(head);
      if (head) fetched++;
      await new Promise((res) => setTimeout(res, 150)); // polite to the API
    }
    const texts = batch.map((r, j) => {
      let topics: string[] = [];
      try { topics = r.topics ? JSON.parse(r.topics) : []; } catch { /* */ }
      return candidateEmbeddingText({
        title: r.fullName, description: r.description, topics,
        repoShape: r.repoShape, primaryLanguage: r.primaryLanguage, readmeHead: heads[j],
      });
    });
    const vecs = await embedBatch(texts);
    const now = new Date();
    for (let j = 0; j < batch.length; j++) {
      await db.update(schema.catalogueRepos).set({
        readmeHead: heads[j] ?? NO_README_MARKER,
        embedding: vecs[j]?.vector ? serialiseEmbedding(vecs[j]!.vector) : batch[j].embedding,
        updatedAt: now,
      }).where(eq(schema.catalogueRepos.id, batch[j].id));
      if (vecs[j]?.vector) embedded++;
    }
    console.log(`[reembed] ${Math.min(i + BATCH, todo.length)}/${todo.length} (readmes: ${fetched}, re-embedded: ${embedded})`);
  }
  console.log(`[reembed] done: ${fetched} READMEs fetched, ${embedded} re-embedded`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
