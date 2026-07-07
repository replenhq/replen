// Shared facet construction — used by both the pipeline (run-once) and the
// in-session capability route (Phase 6). Splitting it out keeps the two paths
// from drifting: a project's facet set is capability probes + doc-section
// vectors, deduped by label, hashed over label+text+modality so a doc edit OR a
// grounded-descriptor edit regenerates.

import {
  embedBatch,
  selectFacetLabels,
  facetEmbeddingText,
  projectDomainContext,
  facetSetHash,
  type FacetEmbedding,
} from "../lib/embeddings";
import { inferCapabilityModality, type CapabilitySpec, type Modality, type Provenance } from "./modality";

export type FacetInput = { label: string; text: string; modality: Modality[]; provenance: Provenance; paths?: string[] };

// Mechanism-fit matching (flagged, off by default). When on, each facet's embed
// text carries the capability's `mechanism` (HOW it's implemented), so a
// candidate that does the same KIND of work aligns even when the domain differs.
// Off ⇒ the embed text is byte-identical to before ⇒ every stored vector and the
// entire keep-set are unchanged; flipping it on re-embeds facets per-project (the
// mechanism clause changes the facet text, which is in the regeneration hash).
// Validate offline before enabling by default — same discipline as the domain
// qualifier and the ontology levers. Set REPLEN_FACET_MECHANISM=1 to enable.
const FACET_MECHANISM = process.env.REPLEN_FACET_MECHANISM === "1";

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
  // Domain signal for the per-facet qualifier (see projectDomainContext). Derived
  // from the summary `purpose` (the sector — reliable even when tags are stack) +
  // non-stack `domainTags`, NOT raw tags. `purpose`/`keyCapabilities` come straight
  // from summaryJson.
  purpose?: string | null;
  domainTags?: string[] | null;
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

  // Facets are CAPABILITY probes only. Doc-section heading facets (formerly
  // appended here via extractDocSections) are dropped as of FACET_SCHEME "5":
  // they were a noise source (README headings such as "Makefile Targets" or
  // "Q5 — 9D004.e" became match probes), and the dense grounded domain cloud —
  // now embedded into the project centroid (see projectEmbeddingText) — covers
  // the recall they were added for, without the junk.
  const domainContext = projectDomainContext({ purpose: input.purpose, keyCapabilities: input.keyCapabilities, tags: input.domainTags });
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
    // Mechanism only enters the embed text when the flag is on (default off keeps
    // vectors identical). Maturity is NOT embedded — it's read from the summary at
    // rank time (source of truth), so it never needs a facet re-embed to take effect.
    const mechanism = FACET_MECHANISM && spec?.mechanism?.trim() ? spec.mechanism : null;
    inputs.push({ label: l, text: facetEmbeddingText(l, descriptor, domainContext, mechanism), modality, provenance, paths: spec?.paths?.length ? spec.paths : undefined });
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
