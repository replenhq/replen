// Immersion (M1 — self-host) — path-scoped CODE-CONTENT facets.
//
// For each grounded capability that carries `paths`, read those local files,
// chunk + embed the ACTUAL CODE, and emit FacetEmbeddings so matching grounds
// on what the code does — not only the agent's descriptor. Self-host only: the
// server reads local disk (the caller MUST verify localPath is a real dir and
// that Immersion is enabled). Transient: raw source is discarded after
// embedding — only the 1536-float vectors persist in facet_embeddings, so there
// is no retention surface in M1.
//
// MECHANICAL ONLY (enforced by imports): this module imports the walker's
// extension allow-list, the chunker, and embeddings.embedBatch — and NOTHING
// from summarize/classify (no LLM). The only server cost is the embedding call,
// exactly like the descriptor-facet build.

import { readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CODE_EXTENSIONS } from "../lib/repo-index/walker";
import { chunkFile, detectLanguage } from "../lib/repo-index/chunker";
import { embedBatch, serialiseFacetEmbeddings, parseStoredFacetEmbeddings, type FacetEmbedding } from "../lib/embeddings";
import type { CapabilitySpec, Modality } from "./modality";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Mirror the walker's hard size cap (1MB ⇒ almost certainly a generated artefact).
const MAX_FILE_BYTES = 1_000_000;
// Re-apply the loader's secret deny-list at read time, EVEN IF the agent listed
// such a path as evidence — a credential file must never be read or embedded.
// Matched per path SEGMENT (not raw substring), so a top-level `secrets.ts` or a
// `secret_key.py` is caught, not only a `secrets/` directory.
const SECURITY_DENY = [
  ".env", ".pem", ".key", ".p12", ".pfx", ".asc", ".crt", ".pgpass", ".netrc",
  "credentials", "secrets", "secret", "id_rsa", "id_ed25519",
];
// Bound the work: total code-facets appended per project, and chunks per file.
const MAX_CODE_FACETS = Math.max(0, parseInt(process.env.REPLEN_IMMERSION_MAX_FACETS ?? "60", 10) || 60);
const MAX_CHUNKS_PER_FILE = Math.max(1, parseInt(process.env.REPLEN_IMMERSION_MAX_CHUNKS_PER_FILE ?? "6", 10) || 6);

// A code-content facet is recognisable by its `tag :: relpath` label + non-empty
// paths — used by the caller to strip stale code facets before re-merging, and
// to keep them out of any catalogue contribution.
export const CODE_FACET_SEP = " :: ";
export function isCodeFacet(f: FacetEmbedding): boolean {
  return typeof f.label === "string" && f.label.includes(CODE_FACET_SEP) && !!f.paths?.length;
}

/**
 * Merge a fresh set of code-content facets into an existing facet blob: keep the
 * descriptor facets (and their hash) untouched, swap the code layer in place,
 * and stamp the new codeHash. Shared by the self-host pipeline phase (M1) and
 * the hosted ingest endpoint (M2) so both produce byte-identical blobs.
 */
export function mergeCodeFacets(existingBlob: string | null, newCodeFacets: FacetEmbedding[], codeHash: string): string {
  let descriptorHash = "";
  if (existingBlob) {
    try { descriptorHash = (JSON.parse(existingBlob) as { hash?: string }).hash ?? ""; } catch { /* "" */ }
  }
  const existing = parseStoredFacetEmbeddings(existingBlob);
  const merged = existing.filter((f) => !isCodeFacet(f)).concat(newCodeFacets);
  return serialiseFacetEmbeddings({ hash: descriptorHash, facets: merged, codeHash });
}

/** True when a blob already carries code-content facets (used for no-op guards). */
export function blobHasCodeFacets(existingBlob: string | null): boolean {
  return parseStoredFacetEmbeddings(existingBlob).some(isCodeFacet);
}

/**
 * The parent capability tag of a code-facet label (`tag :: path#N` → `tag`).
 * A non-code label is returned unchanged. Used to attribute a code-facet match
 * back to its human-readable capability for reasons / diversity dedup, so a
 * file path never surfaces in a user-facing "fits your X capability" line.
 */
export function parentCapabilityLabel(label: string): string {
  const i = label.indexOf(CODE_FACET_SEP);
  return i >= 0 ? label.slice(0, i).trim() || label : label;
}

function isDenied(rel: string): boolean {
  const segs = rel.toLowerCase().split(/[/\\]/);
  // Any path segment (a directory name OR the filename) containing a denied
  // token blocks the read — covers `secrets/x.py`, `secrets.ts`, `app.env`.
  return segs.some((s) => SECURITY_DENY.some((d) => s.includes(d)));
}

// Resolve a capability path under the repo root, refusing anything that escapes
// it. resolve() collapses `..` and absolute paths but does NOT follow symlinks,
// so we ALSO realpath the target and re-check containment — otherwise an in-repo
// symlink pointing at /etc/passwd would pass the lexical check and be read.
function safeResolve(root: string, p: string): string | null {
  const cleaned = p.trim().replace(/^[/\\]+/, "");
  if (!cleaned) return null;
  const abs = resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + "/")) return null;
  try {
    // realpath CHECK only (resolves symlinks); return the lexical `abs` so the
    // caller's relative(root, abs) stays correct (root itself may be under a
    // symlinked prefix, e.g. macOS /var -> /private/var). Reading abs follows
    // the same links to the same file.
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + "/")) return null; // symlink escapes the tree
    return abs;
  } catch {
    return null; // missing / broken / unreadable — skip silently
  }
}

export type CodeFacetResult = {
  facets: FacetEmbedding[];
  hash: string;        // stable over (relpath, file-content-hash) — gates re-embed
  unchanged: boolean;  // true when priorHash matched (no embedding performed)
  filesRead: number;
  chunksEmbedded: number;
};

// A grounded source file ready to embed: which capability it implements (tag +
// modality, both server-authoritative), its repo-relative path, and the source
// itself. Produced from disk (M1, self-host) or from the wire (M2, hosted).
export type CodeItem = { tag: string; modality: Modality[]; rel: string; content: string };

// A grounded-file TARGET — the (capability, path) pairs the project's own
// capabilities cite, with the secret deny-list + code-extension + dedup filters
// applied, but WITHOUT the content. The hosted manifest endpoint returns these
// so the client knows exactly which files to read + send; the ingest endpoint
// uses the same set to validate + tag incoming content (a client can't smuggle
// in a path the capabilities don't reference, or spoof a file's modality).
export type CodeTarget = { tag: string; modality: Modality[]; rel: string };

// Normalise a capability path to a clean repo-relative path, or null if it's
// empty, escapes the root (`..`), denied, or not a code file. No disk access —
// safe to run server-side on client-claimed paths.
function normaliseRel(p: string): string | null {
  const cleaned = p.trim().replace(/^[/\\]+/, "").split("\\").join("/");
  if (!cleaned) return null;
  if (cleaned === ".." || cleaned.startsWith("../") || cleaned.includes("/../") || cleaned.endsWith("/..")) return null;
  if (isDenied(cleaned)) return null;
  if (!DEFAULT_CODE_EXTENSIONS.has(extname(cleaned).toLowerCase())) return null;
  return cleaned;
}

/**
 * The grounded-file targets for a set of capabilities — deduped by (tag, rel),
 * deny-list / extension / traversal filtered. Pure (no I/O); the server uses it
 * to drive the manifest + to validate ingest payloads.
 */
export function groundedFileTargets(specs: CapabilitySpec[]): CodeTarget[] {
  const out: CodeTarget[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.paths?.length) continue;
    for (const p of spec.paths) {
      const rel = normaliseRel(p);
      if (!rel) continue;
      const key = `${spec.tag.toLowerCase()}|${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tag: spec.tag, modality: spec.modality ?? [], rel });
    }
  }
  return out;
}

/**
 * Embed a set of grounded source files into code-content facets — the shared
 * core of M1 (disk) and M2 (wire). Computes a stable source-set hash; when it
 * matches `priorHash`, returns early WITHOUT embedding. Modality is inherited
 * from each item's parent capability (never a generic ["code"]); provenance is
 * always "grounded". Caps total facets per project + chunks per file.
 *
 * Mechanical only: the single cost is the embedding call. Raw `content` is held
 * just long enough to chunk + embed, then dropped — nothing here persists it.
 */
export async function embedCodeItems(
  items: CodeItem[],
  opts: { priorHash?: string | null } = {},
): Promise<CodeFacetResult> {
  // Drop blanks; dedup by (tag, rel); compute per-file content hashes.
  const seen = new Set<string>();
  const clean = items
    .filter((it) => it.content.trim() && normaliseRel(it.rel))
    .map((it) => ({ ...it, rel: normaliseRel(it.rel)!, contentHash: sha256(it.content) }))
    .filter((it) => { const k = `${it.tag.toLowerCase()}|${it.rel}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const hash = clean.length
    ? sha256(JSON.stringify(clean.map((it) => [it.rel, it.contentHash]).sort()))
    : "";
  if (clean.length === 0) return { facets: [], hash, unchanged: false, filesRead: 0, chunksEmbedded: 0 };
  if (opts.priorHash && opts.priorHash === hash) {
    return { facets: [], hash, unchanged: true, filesRead: clean.length, chunksEmbedded: 0 };
  }

  // Chunk + assemble embedding inputs, capping total facets per project.
  type Pending = { label: string; modality: Modality[]; paths: string[]; text: string };
  const pending: Pending[] = [];
  for (const it of clean) {
    if (pending.length >= MAX_CODE_FACETS) break;
    const lang = detectLanguage(extname(it.rel).toLowerCase());
    const chunks = chunkFile(it.rel, it.content, lang).slice(0, MAX_CHUNKS_PER_FILE);
    for (let i = 0; i < chunks.length; i++) {
      if (pending.length >= MAX_CODE_FACETS) break;
      const suffix = chunks.length > 1 ? `#${i + 1}` : "";
      pending.push({
        label: `${it.tag}${CODE_FACET_SEP}${it.rel}${suffix}`,
        modality: it.modality,
        paths: [it.rel],
        text: `Capability: ${it.tag} — implementation in ${it.rel}\n\n${chunks[i].content}`,
      });
    }
  }

  // Embed the chunk content (mechanical; the only cost). Nulls (no API key, or
  // a per-item failure) are dropped.
  const vecs = await embedBatch(pending.map((p) => p.text));
  const facets: FacetEmbedding[] = [];
  let chunksEmbedded = 0;
  for (let i = 0; i < pending.length; i++) {
    const v = vecs[i];
    if (!v) continue;
    chunksEmbedded++;
    facets.push({ label: pending[i].label, vec: v.vector, modality: pending[i].modality, provenance: "grounded", paths: pending[i].paths });
  }
  return { facets, hash, unchanged: false, filesRead: clean.length, chunksEmbedded };
}

/**
 * Build path-scoped code-content facets for a project's local checkout (M1,
 * self-host). Reads the grounded source files from disk, then delegates to
 * embedCodeItems. Pass `priorHash` to skip embedding when nothing changed.
 *
 * Self-host only — the caller verifies localPath is a real, readable directory.
 */
export async function embedCodeFacets(
  specs: CapabilitySpec[],
  localPath: string,
  opts: { priorHash?: string | null } = {},
): Promise<CodeFacetResult> {
  const root = resolve(localPath);
  const items: CodeItem[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.paths?.length) continue;
    for (const p of spec.paths) {
      const abs = safeResolve(root, p);
      if (!abs) continue;
      const rel = relative(root, abs).split("\\").join("/");
      if (!rel || isDenied(rel)) continue;
      if (!DEFAULT_CODE_EXTENSIONS.has(extname(abs).toLowerCase())) continue;
      const key = `${spec.tag.toLowerCase()}|${rel}`;
      if (seen.has(key)) continue;
      let content: string;
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        content = readFileSync(abs, "utf8");
      } catch {
        continue; // missing / unreadable — skip silently
      }
      if (!content.trim()) continue;
      seen.add(key);
      items.push({ tag: spec.tag, modality: spec.modality ?? [], rel, content });
    }
  }
  return embedCodeItems(items, opts);
}
