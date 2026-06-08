// Shared facet construction — used by both the pipeline (run-once) and the
// in-session capability route (Phase 6). Splitting it out keeps the two paths
// from drifting: a project's facet set is capability probes + doc-section
// vectors, deduped by label, hashed over label+text so a doc edit regenerates.

import {
  embedBatch,
  selectFacetLabels,
  facetEmbeddingText,
  facetSetHash,
  type FacetEmbedding,
} from "../lib/embeddings";
import { extractDocSections } from "./doc-sections";

export type FacetInput = { label: string; text: string };

/**
 * Plan a project's facet inputs (cheap — no embedding). Returns the content
 * hash and the {label, text} inputs. Caller embeds only when the hash shows the
 * stored facets are stale, preserving the cache.
 */
export function facetInputsFor(input: {
  capabilityTags?: string[] | null;
  keyCapabilities?: string[] | null;
  readmeMd?: string | null;
  claudeMd?: string | null;
}): { hash: string; inputs: FacetInput[] } {
  const facetSource = (input.capabilityTags?.length ? input.capabilityTags : input.keyCapabilities) ?? [];
  const capLabels = selectFacetLabels(facetSource);
  const sections = extractDocSections(input.readmeMd ?? null, input.claudeMd ?? null);

  const inputs: FacetInput[] = [];
  const seen = new Set<string>();
  for (const l of capLabels) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    inputs.push({ label: l, text: facetEmbeddingText(l) });
  }
  for (const s of sections) {
    const k = s.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    inputs.push({ label: s.label, text: s.text });
  }
  const hash = facetSetHash(inputs.map((f) => `${f.label}::${f.text}`));
  return { hash, inputs };
}

/** Embed facet inputs into {label, vec} pairs. Drops inputs that fail to embed. */
export async function embedFacets(inputs: FacetInput[]): Promise<FacetEmbedding[]> {
  if (inputs.length === 0) return [];
  const vecs = await embedBatch(inputs.map((f) => f.text));
  const facets: FacetEmbedding[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const r = vecs[i];
    if (r) facets.push({ label: inputs[i].label, vec: r.vector });
  }
  return facets;
}
