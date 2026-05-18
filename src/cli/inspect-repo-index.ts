// One-shot: build a BM25 index for a local directory and run a sample query
// end-to-end, exercising walker → chunker → tokenizer → BM25 → SQLite → search.
//
// The point is to validate the indexer pipeline against real code (any local
// repo will do) before wiring it into Stage-4 verification. Operates on a
// synthetic "inspector" repos row keyed by a stable owner/name derived from
// the path, so re-running rebuilds in place rather than accumulating cruft.
//
// Usage:
//   tsx src/cli/inspect-repo-index.ts --path=/tmp/some-repo --query="how does auth work"
//   tsx src/cli/inspect-repo-index.ts --path=. --query="bm25 scoring" --topk=15
//   tsx src/cli/inspect-repo-index.ts --path=/tmp/some-repo --query=foo --rebuild
//   tsx src/cli/inspect-repo-index.ts --path=/tmp/some-repo --cleanup     (drop the index, don't query)

import { basename, resolve } from "node:path";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";
import {
  buildIndex,
  findFreshIndex,
  searchIndex,
  deleteIndex,
  indexStorageBytes,
  INDEX_VERSION,
} from "../lib/repo-index";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// Synthesise a stable owner/name pair from a local path so reruns reuse the
// same repos row. Owner is fixed; name is the directory basename with any
// non-safe chars stripped so we can store it without quoting.
function syntheticRepoIdent(absolutePath: string): { owner: string; name: string } {
  const base = basename(absolutePath) || "root";
  const name = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return { owner: "_inspector", name };
}

async function getOrCreateRepoId(absolutePath: string): Promise<number> {
  const { owner, name } = syntheticRepoIdent(absolutePath);
  const existing = await db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, owner), eq(schema.repos.name, name)))
    .get();
  if (existing) return existing.id;
  const now = new Date();
  const inserted = await db
    .insert(schema.repos)
    .values({
      owner,
      name,
      url: `local://${absolutePath}`,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning({ id: schema.repos.id })
    .get();
  if (!inserted) throw new Error("failed to insert synthetic repos row");
  return inserted.id;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function snippet(content: string, maxLines: number = 4): string {
  const lines = content.split(/\r?\n/);
  const head = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? `${head}\n…` : head;
}

async function main() {
  const path = arg("path");
  const query = arg("query");
  const topkStr = arg("topk");
  const rebuild = flag("rebuild");
  const cleanup = flag("cleanup");

  if (!path) {
    console.error(
      `Usage: tsx src/cli/inspect-repo-index.ts --path=<dir> [--query=<q>] [--topk=10] [--rebuild] [--cleanup]`,
    );
    process.exit(1);
  }
  const absolutePath = resolve(path);
  const topK = topkStr ? Math.max(1, parseInt(topkStr, 10)) : 10;

  const repoId = await getOrCreateRepoId(absolutePath);
  console.error(`[inspect-repo-index] repoId=${repoId} path=${absolutePath} version=${INDEX_VERSION}`);

  if (cleanup) {
    const fresh = await findFreshIndex(repoId);
    if (!fresh) {
      console.error(`[inspect-repo-index] no index to clean up`);
      return;
    }
    await deleteIndex(fresh.indexId);
    console.error(`[inspect-repo-index] deleted indexId=${fresh.indexId}`);
    return;
  }

  let indexId: number;
  const fresh = rebuild ? null : await findFreshIndex(repoId);
  if (fresh) {
    indexId = fresh.indexId;
    console.error(`[inspect-repo-index] reusing indexId=${indexId} builtAt=${fresh.builtAt.toISOString()}`);
  } else {
    const t0 = Date.now();
    const built = await buildIndex(repoId, absolutePath);
    const elapsedMs = Date.now() - t0;
    indexId = built.indexId;
    console.error(
      `[inspect-repo-index] built indexId=${indexId} chunks=${built.chunkCount} bytes=${fmtBytes(built.byteCount)} tokens=${built.totalTokens} in ${elapsedMs}ms`,
    );
  }

  const storage = await indexStorageBytes(repoId);
  console.error(`[inspect-repo-index] storage-for-repo=${fmtBytes(storage)}`);

  if (!query) {
    console.error(`[inspect-repo-index] (no --query given; build verified, exiting)`);
    return;
  }

  const t0 = Date.now();
  const hits = await searchIndex(indexId, query, topK);
  const elapsedMs = Date.now() - t0;
  console.error(`[inspect-repo-index] query="${query}" → ${hits.length} hits in ${elapsedMs}ms\n`);

  if (hits.length === 0) {
    console.log(`(no hits — try different query terms or check the indexed corpus)`);
    return;
  }

  for (const [i, h] of hits.entries()) {
    console.log(`#${i + 1}  score=${h.score.toFixed(3)}  ${h.filePath}:${h.startLine}-${h.endLine}  (${h.language ?? "?"})`);
    console.log(snippet(h.content));
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
