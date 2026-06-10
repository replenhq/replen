// Shared facet construction — used by both the pipeline (run-once) and the
// in-session capability route (Phase 6). Splitting it out keeps the two paths
// from drifting: a project's facet set is capability probes + doc-section
// vectors, deduped by label, hashed over label+text+modality so a doc edit OR a
// grounded-descriptor edit regenerates.

import {
  embedBatch,
  selectFacetLabels,
  facetEmbeddingText,
  facetSetHash,
  type FacetEmbedding,
} from "../lib/embeddings";
import { extractDocSections } from "./doc-sections";
import { inferCapabilityModality, type CapabilitySpec, type Modality, type Provenance } from "./modality";

export type FacetInput = { label: string; text: string; modality: Modality[]; provenance: Provenance; paths?: string[] };

/**
 * Plan a project's facet inputs (cheap — no embedding). Returns the content
 * hash and the {label, text, modality} inputs. Caller embeds only when the hash
 * shows the stored facets are stale, preserving the cache.
 *
 * Prefers grounded `capabilities` (CapabilitySpec with descriptor + modality)
 * when present; otherwise falls back to bare `capabilityTags` / `keyCapabilities`
 * and infers a modality from the phrase so the gate still has signal on legacy
 * projects that haven't re-onboarded.
 */
export function facetInputsFor(input: {
  capabilities?: CapabilitySpec[] | null;
  capabilityTags?: string[] | null;
  keyCapabilities?: string[] | null;
  readmeMd?: string | null;
  claudeMd?: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
}): { hash: string; inputs: FacetInput[] } {
  // Build a spec map keyed by lowercased tag (grounded specs win; bare tags fill
  // in). The label set then runs through the same dedup/generic filter as before.
  const specByTag = new Map<string, CapabilitySpec>();
  for (const c of input.capabilities ?? []) {
    if (c && typeof c.tag === "string" && c.tag.trim()) {
      const k = c.tag.trim().toLowerCase();
      if (!specByTag.has(k)) specByTag.set(k, c);
    }
  }
  const bareSource = (input.capabilityTags?.length ? input.capabilityTags : input.keyCapabilities) ?? [];
  const allTags = [...(input.capabilities ?? []).map((c) => c?.tag), ...bareSource];
  const capLabels = selectFacetLabels(allTags);
  const sections = extractDocSections(input.readmeMd ?? null, input.claudeMd ?? null, input.projectName ?? null, input.projectSlug ?? null);

  const inputs: FacetInput[] = [];
  const seen = new Set<string>();
  for (const l of capLabels) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const spec = specByTag.get(k);
    const descriptor = spec?.descriptor && spec.descriptor.trim() !== l ? spec.descriptor : null;
    const modality = spec?.modality?.length ? spec.modality : inferCapabilityModality(l, descriptor);
    // Provenance comes from the spec when set; otherwise a grounded descriptor
    // implies grounded, and a bare tag with no spec is inferred.
    const provenance: Provenance = spec?.provenance ?? (descriptor ? "grounded" : "inferred");
    inputs.push({ label: l, text: facetEmbeddingText(l, descriptor), modality, provenance, paths: spec?.paths?.length ? spec.paths : undefined });
  }
  for (const s of sections) {
    const k = s.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // Doc-section facets are freeform prose — leave modality unknown so they
    // never gate, and tag them ambiguous (raw doc text, lowest confidence).
    inputs.push({ label: s.label, text: s.text, modality: [], provenance: "ambiguous" });
  }
  const hash = facetSetHash(inputs.map((f) => `${f.label}::${f.text}::${f.modality.join(",")}::${f.provenance}`));
  return { hash, inputs };
}

/** Embed facet inputs into {label, vec, modality, provenance} pairs. Drops inputs that fail to embed. */
export async function embedFacets(inputs: FacetInput[]): Promise<FacetEmbedding[]> {
  if (inputs.length === 0) return [];
  const vecs = await embedBatch(inputs.map((f) => f.text));
  const facets: FacetEmbedding[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const r = vecs[i];
    if (r) facets.push({ label: inputs[i].label, vec: r.vector, modality: inputs[i].modality, provenance: inputs[i].provenance, paths: inputs[i].paths });
  }
  return facets;
}
