// Replen's Atlas ontology, as DATA. The single source of truth for the graph's
// node + edge types, modelled after consulting-intel/ontology/schema.py (a
// Palantir-pattern typed registry, itself an application of the acme pattern).
//
// Until now Replen's ontology was IMPLICIT, hardcoded as kind-string literals
// scattered through build.ts (and the readers). This module formalises it: one
// frozen registry that build.ts emits against and an optional dev-time
// validate() pass checks. It is ADDITIVE. Every existing kind string is
// preserved verbatim. Nothing is renamed, and graph output is byte-identical.
//
// PURE module: no I/O, no db import (same posture as schema.py). The only import
// is a TYPE-ONLY one for the shared Modality/Provenance enums, so the enums stay
// single-sourced without pulling any runtime (a value import would risk a cycle
// modality -> ... -> build -> ontology and break tree-shaking).
import type { Modality, Provenance } from "../projects/modality";

export const NAMESPACE = "replen";

/** Fully-qualified, globally-unique api name (the portability seam). The bare
 *  `kind` strings stored in graph_nodes.kind stay lowercase literals (a frozen
 *  DB + UI contract); the namespaced api name is registry-internal metadata for
 *  introspection + cross-registry interop, NOT what is written to the column. */
export const qn = (local: string): string => `${NAMESPACE}:${local}`;

export type Card = "1:1" | "N:1" | "N:N";
// "object" marks a payload edge that carries real data and is a candidate for
// promotion to a first-class object (the Mention idiom). It stays an edge today.
export type Backing = "fk" | "join" | "derived" | "object";

export type PropDef = { name: string; type: string; required?: boolean; doc?: string };
export type InterfaceDef = { local: string; api: string; props: PropDef[]; doc: string };

// ---------------------------------------------------------------------------
// Frozen kind contracts. The exact strings in graph_nodes.kind / graph_edges.kind.
// const-asserted so a typo at an emission site is a COMPILE error, and so the
// readers (AtlasGraph chips, dossier switches, overlay keys) have one place to
// learn the full set. Order is not significant.
// ---------------------------------------------------------------------------
export const NODE_KINDS = [
  "project", "product", "capability", "tool", "candidate",
  "suggestion", "goal", "domain", "lesson", "boundary", "concept",
] as const;
export const EDGE_KINDS = [
  "USES", "MEMBER_OF", "HAS_CAPABILITY", "GROUNDS", "VAULT_LINK",
  "ADJACENT_TO", "RELATES_TO", "EVALUATED", "FILLS", "INSIGHT_FOR",
  "FROM_CANDIDATE", "SUGGESTED", "GOAL_OF", "IN_DOMAIN", "RELATED_DOMAIN",
  "ENDORSED_BY_SIMILAR",
] as const;
export type NodeKind = typeof NODE_KINDS[number];
export type EdgeKind = typeof EDGE_KINDS[number];

export type NodeType = {
  local: string; api: string; kind: NodeKind;
  pk: string;        // deterministic nodeKey rule (logical identity is (kind, nodeKey), never graph_nodes.id)
  title: string;     // the data/label property used as the display key
  implements: string[];
  props: PropDef[];
  dataExcluded?: string[]; // fields the type conceptually HAS but that are deliberately off-node (vectors)
  doc: string;
};
export type LinkType = {
  local: string; api: string; kind: EdgeKind;
  src: NodeKind[]; dst: NodeKind[]; // sets, so kind-union edges (INSIGHT_FOR dst, FROM_CANDIDATE src) validate
  card: Card; backing: Backing;
  weighted: boolean; weightBand?: [number, number];
  data: PropDef[];
  doc: string;
};

// ---------------------------------------------------------------------------
// Interfaces (capability contracts). The query / matching / export layers
// dispatch on these, not on an enumerated kind list. (consulting-intel idiom.)
// ---------------------------------------------------------------------------
const Embeddable: InterfaceDef = {
  local: "Embeddable", api: qn("Embeddable"),
  doc: "Carries a 1536-dim text-embedding-3-small vector; the cosine + modality-gate matcher targets this interface. CRITICAL: the vector is per-corpus, regenerable, content-hash-cached, and lives OFF-NODE (in build.ts's in-memory centroid maps, in project_profiles / candidates / catalogue tables), NEVER in graph_nodes.data and NEVER in the portable / cross-user export. dataExcluded on each NodeType records that.",
  props: [
    { name: "embedding", type: "vector(1536), OFF-NODE, regenerated per corpus, never exported" },
    { name: "embedText", type: "string, the surface string embedded" },
    { name: "embeddingContentHash", type: "sha256, drives the re-embed cache" },
    { name: "embeddingModel", type: "string, e.g. text-embedding-3-small" },
  ],
};
const Provenanced: InterfaceDef = {
  local: "Provenanced", api: qn("Provenanced"),
  doc: "Every inferred fact carries an evidence tier and a confirmation lifecycle (the Citable / Mention idiom). Encodes the rule 'file paths appear ONLY as evidence anchors, never as nodes': paths live in evidencePaths, full stop. Carried by the evidence/payload EDGES (HAS_CAPABILITY: provenance + paths; EVALUATED: a confirmed verdict), and conceptually by the capability + candidate node types as the subjects of those facts.",
  props: [
    { name: "provenance", type: "enum(grounded|extracted|inferred|ambiguous), closed, ordered grounded>extracted>inferred>ambiguous; 'ambiguous' is the do-not-emit gate" },
    { name: "evidencePaths", type: "string[], file-path anchors ONLY, the sole sanctioned place a code path appears (never a node, never a PK)" },
    { name: "confirmationState", type: "enum(proposed|confirmed|rejected), additive lifecycle from Mention.status" },
    { name: "confirmedBy", type: "string|null, null until a human/agent confirms" },
    { name: "confidence", type: "decimal|null" },
  ],
};
const Sensitive: InterfaceDef = {
  local: "Sensitive", api: qn("Sensitive"),
  doc: "The mandatory-control property, the analog of consulting-intel Confidential + EXTERNAL_SAFE: gates retrieval AND export. Drives (a) k-anonymity cross-user catalogue sharing (shareableToCatalogue true only if seed-term OR >=K distinct users hold it), (b) primary-vs-sensitive LLM slot routing, (c) cover-name display at high sensitivity, (d) 'source code never leaves the machine' via sourceScope. At N=1 the k-thresholds simply never fire (silent degrade).",
  props: [
    { name: "sensitivity", type: "enum(low|high), already on project_profiles" },
    { name: "coverName", type: "string|null, display alias when sensitivity=high" },
    { name: "shareableToCatalogue", type: "bool, k-anon gate: seed-term OR >=K distinct users" },
    { name: "sourceScope", type: "enum(identity-only|tags|embeddings|full-code), what may leave the machine; default tags, full-code only on explicit Immersion opt-in" },
  ],
};
const Decision: InterfaceDef = {
  local: "Decision", api: qn("Decision"),
  doc: "Marker interface that hard-encodes the cornerstone Atlas rule: every node is a DECISION unit, never a code unit. EVERY NodeType implements it; the registry forbids File/Symbol/Function node types outright (code only ever appears as Provenanced.evidencePaths). Turns 'the Atlas graph never models code units' from a convention into a checkable invariant, keeping Replen on its side of the Graphify boundary.",
  props: [
    { name: "decisionKind", type: "enum(project|product|capability|tool|candidate|suggestion|goal|domain|concept|lesson|boundary|verdict), the closed decision-unit set ('verdict' reserved for the EVALUATED->object promotion)" },
  ],
};

export const INTERFACES: Record<string, InterfaceDef> = { Embeddable, Provenanced, Sensitive, Decision };

// Helpers to keep the node/link literals terse + self-namespacing.
const node = (
  kind: NodeKind, pk: string, title: string, implement: string[], props: PropDef[], doc: string, dataExcluded?: string[],
): NodeType => ({ local: cap(kind), api: qn(cap(kind)), kind, pk, title, implements: implement, props, doc, ...(dataExcluded ? { dataExcluded } : {}) });
const link = (
  kind: EdgeKind, src: NodeKind[], dst: NodeKind[], card: Card, backing: Backing,
  weighted: boolean, data: PropDef[], doc: string, weightBand?: [number, number],
): LinkType => ({ local: lc(kind), api: qn(lc(kind)), kind, src, dst, card, backing, weighted, data, doc, ...(weightBand ? { weightBand } : {}) });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lc = (s: string) => s.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Node types. pk = the deterministic nodeKey rule build.ts already computes.
// ---------------------------------------------------------------------------
export const NODE_TYPES: Record<NodeKind, NodeType> = {
  project: node("project", "p.slug (user-scoped via uniq_profile_user_slug)", "label",
    ["Decision", "Embeddable", "Sensitive"],
    [
      { name: "slug", type: "string", required: true, doc: "p.slug, same as nodeKey" },
      { name: "name", type: "string|null", doc: "p.name" },
      { name: "githubFullName", type: "string|null", doc: "'owner/name'" },
    ],
    "The repo/project decision unit (build.ts:123). label = p.name ?? p.slug. The project centroid + facetEmbeddings exist but are OFF-NODE (they weight RELATES_TO, never written to node.data).",
    ["embedding", "facetEmbeddings", "domainAnchor"]),

  product: node("product", "p.productKey ?? deriveProductKey(githubFullName) ('owner/stem'); emitted only when >=2 of the user's repos share it", "label",
    ["Decision"],
    [
      { name: "key", type: "string", required: true, doc: "productKey, same as nodeKey" },
      { name: "repoCount", type: "number", required: true, doc: "members.length" },
    ],
    "Multi-repo product grouping (build.ts:185). AtlasGraph sizes product radius by MEMBER_OF count."),

  capability: node("capability", "norm(label) AFTER the near-duplicate merge (capCanon). This canonical key is what FILLS, node_notes, and capability_curations target; changing how it is chosen orphans notes/curations", "label",
    ["Decision", "Embeddable", "Provenanced", "Sensitive"],
    [
      { name: "label", type: "string", required: true, doc: "canonicalLabel" },
      { name: "modality", type: "Modality[]", doc: "OPTIONAL union; [] means do-NOT-gate" },
      { name: "aliases", type: "string[]", doc: "OPTIONAL merged-away phrasings" },
      { name: "theme", type: "number", doc: "Louvain community id" },
      { name: "themeName", type: "string", doc: "two highest-degree members, ' / ' joined" },
      { name: "degree", type: "number", doc: "#projects + #adjacency edges; waypoint signal" },
      { name: "waypoint", type: "boolean", doc: "true if top-degree; drives blind-spot scouting" },
    ],
    "The central decision unit (build.ts:314). The facet-centroid vector is OFF-NODE (drives ADJACENT_TO weights + Louvain). The grounded/extracted/inferred tag rides the HAS_CAPABILITY edge, not the node.",
    ["embedding"]),

  tool: node("tool", "dep.toLowerCase() (the detect-token; inventory/today atlasLink + overlay depend on it)", "label",
    ["Decision", "Sensitive"],
    [
      { name: "name", type: "string", required: true, doc: "dep, original case" },
      { name: "plan", type: "string", doc: "OPTIONAL toolPrefs.plan" },
      { name: "migrateOff", type: "boolean", doc: "OPTIONAL, only when toolPrefs.migrateOff" },
    ],
    "An external product/runtime the project USES (build.ts:143): 'use' vs capability's 'do'. Pricing/CVE/EOL awareness anchors here. A future library|model|service role discriminator belongs here, not parallel kinds."),

  candidate: node("candidate", "`${owner}/${name}`.toLowerCase() (candKey)", "label",
    ["Decision", "Embeddable", "Provenanced", "Sensitive"],
    [
      { name: "fullName", type: "string", required: true, doc: "'owner/name' original case" },
      { name: "stars", type: "number|null", doc: "repos.stars" },
      { name: "url", type: "string", required: true, doc: "repos.url" },
    ],
    "A triaged OSS repo (build.ts:509). EVALUATED from project (payload on edge), FILLS a capability via matchedFacet, FROM_CANDIDATE a lesson/boundary. Repo embedding lives in catalogue/candidates, OFF-NODE.",
    ["embedding"]),

  suggestion: node("suggestion", "fullName.toLowerCase() (same scheme as candidate, distinct kind); graduates to candidate once triaged", "label",
    ["Decision", "Embeddable", "Sensitive"],
    [
      { name: "fullName", type: "string", required: true, doc: "'owner/name' original case" },
      { name: "stars", type: "number|null", doc: "repos.stars" },
      { name: "url", type: "string", required: true, doc: "repos.url" },
      { name: "projected", type: "string", required: true, doc: "deterministic action: clean-room build|use as-is|port|cherry-pick" },
      { name: "starred", type: "boolean", doc: "true when status === 'starred'" },
    ],
    "A repo surfaced for a project with NO verdict yet (build.ts:595). SUGGESTED from project.",
    ["embedding"]),

  goal: node("goal", "`goal-${capabilityGoals.id}` (stable row id suffix)", "label",
    ["Decision"],
    [
      { name: "goalId", type: "number", required: true, doc: "capabilityGoals.id" },
      { name: "label", type: "string", required: true, doc: "g.label" },
      { name: "descriptor", type: "string|null", doc: "g.descriptor" },
      { name: "projectSlug", type: "string|null", doc: "scoping project, null = portfolio-wide" },
      { name: "createdAt", type: "string", required: true, doc: "ISO timestamp" },
    ],
    "An active capability goal, what the user WANTS to build (build.ts:614). GOAL_OF from project when scoped; portfolio-wide goals stand alone with no edge."),

  domain: node("domain", "tag (trimmed+lowercased); emitted when >=2 of this user's projects share it OR >=K non-test users carry it (k-anon), cap 80", "label",
    ["Decision", "Sensitive"],
    [
      { name: "tag", type: "string", required: true, doc: "the domain tag, same as nodeKey" },
      { name: "projectCount", type: "number", required: true, doc: "count of THIS user's projects carrying it" },
      { name: "crossUserUsers", type: "number", doc: "OPTIONAL k-anon distinct-user count; present only when >=K; EXCLUDED from the rebuild hash" },
      { name: "theme", type: "string", doc: "OPTIONAL Louvain domain-community id" },
      { name: "themeName", type: "string|null", doc: "OPTIONAL two top members ' / ' joined" },
    ],
    "A sector/domain tag from the dense per-project tag cloud (build.ts:672). IN_DOMAIN from each project; RELATED_DOMAIN clusters synonyms. The cross-user count is the k-anon aggregate signal that must stay silent at N=1."),

  lesson: node("lesson", "`insight-${triageInsights.id}` (stable row id); shares the namespace with boundary, distinguished only by kind", "label",
    ["Decision", "Provenanced"],
    [
      { name: "id", type: "number", required: true, doc: "triageInsights.id" },
      { name: "kind", type: "string", required: true, doc: "literal 'lesson'" },
      { name: "text", type: "string", required: true, doc: "full insight text" },
      { name: "createdAt", type: "string", required: true, doc: "ISO timestamp" },
    ],
    "A transferable idea/premise captured during generative-skip triage (build.ts:531). INSIGHT_FOR a project; FROM_CANDIDATE the repo that prompted it. label = ins.text.slice(0,80)."),

  boundary: node("boundary", "`insight-${triageInsights.id}` (SAME call site as lesson, taken when kind==='boundary')", "label",
    ["Decision", "Provenanced"],
    [
      { name: "id", type: "number", required: true, doc: "triageInsights.id" },
      { name: "kind", type: "string", required: true, doc: "literal 'boundary'" },
      { name: "text", type: "string", required: true, doc: "full insight text" },
      { name: "createdAt", type: "string", required: true, doc: "ISO timestamp" },
    ],
    "A sharpened 'we are explicitly NOT this' boundary insight from triage (build.ts:531). Same edges + data shape as lesson."),

  concept: node("concept", "norm(vault-concept title); emitted only if it grounds >=1 capability that was itself emitted", "label",
    ["Decision", "Provenanced"],
    [
      { name: "title", type: "string", required: true, doc: "original concept title" },
      { name: "projects", type: "string[]", required: true, doc: "slugs of projects whose vault carried it" },
    ],
    "A vault decision-unit from the user's Graphify/Obsidian/ADR export (build.ts:362), an INGESTED grounding source (never our own artifact; Tiles are ours). Emits GROUNDS->capability and VAULT_LINK->concept."),
};

// ---------------------------------------------------------------------------
// Link types. src/dst are SETS (NodeKind[]) so kind-union edges validate.
// ---------------------------------------------------------------------------
export const LINK_TYPES: Record<EdgeKind, LinkType> = {
  USES: link("USES", ["project"], ["tool"], "N:N", "join", false,
    [{ name: "version", type: "string", doc: "only when depVersions[dep] known" }],
    "build.ts:147. Direction project->tool is load-bearing (overlay renders per-project version)."),

  MEMBER_OF: link("MEMBER_OF", ["project"], ["product"], "N:1", "fk", false, [],
    "build.ts:186. project (many) -> product (one), only where the product groups >=2 repos."),

  HAS_CAPABILITY: link("HAS_CAPABILITY", ["project"], ["capability"], "N:N", "object", false,
    [
      { name: "provenance", type: "Provenance", required: true, doc: "grounded>extracted>inferred>ambiguous, strongest kept on dedupe" },
      { name: "modality", type: "Modality[]", required: true },
      { name: "paths", type: "string[]", doc: "omitted when empty; the ONLY sanctioned code-path location" },
    ],
    "build.ts:307. EVIDENCE edge (Provenanced). Constant weight 1 (not a similarity). A capability with no inbound FILLS but >=1 inbound HAS_CAPABILITY is the blind-spot definition in 4 readers."),

  GROUNDS: link("GROUNDS", ["concept"], ["capability"], "N:N", "join", false, [],
    "build.ts:367. Vault concept -> the capability it grounds (resolved via capCanon to an emitted node)."),

  VAULT_LINK: link("VAULT_LINK", ["concept"], ["concept"], "N:N", "join", false,
    [{ name: "rel", type: "string", doc: "only when declared, e.g. same-as (which Leaps skips)" }],
    "build.ts:378. The user's own wikilinks; one edge per unordered pair. Self-referential."),

  ADJACENT_TO: link("ADJACENT_TO", ["capability"], ["capability"], "N:N", "derived", true, [],
    "build.ts:391. Cosine of normalized capability centroids, top 6 neighbours/cap, one edge per unordered pair. Feeds Louvain themes/waypoints; Leaps treats >0.88 as synonym. Self-referential.",
    [0.50, 0.88]),

  RELATES_TO: link("RELATES_TO", ["project"], ["project"], "N:N", "derived", true,
    [{ name: "sharedCaps", type: "string[]", doc: "up to 12 human labels after the generic-probe filter" }],
    "build.ts:449. Centroid cosine when finite, else null (fires on >=2 shared non-generic caps). One edge per unordered pair. Self-referential.",
    [0.55, 1.0]),

  EVALUATED: link("EVALUATED", ["project"], ["candidate"], "N:N", "object", true,
    [
      { name: "verdict", type: "enum(adopt|port|cherry-pick|clean-room|upgrade|skip)", doc: "the triage verdict" },
      { name: "reasonCode", type: "string" }, { name: "score", type: "number|null" },
      { name: "effort", type: "string" }, { name: "oneLine", type: "string" }, { name: "at", type: "string" },
    ],
    "build.ts:470. PAYLOAD edge, the prime candidate for promotion to an object-backed replen:Verdict (pk sha256(projectSlug+candidateKey+at)). Populated by the user's triage session; DO NOT move verdict generation server-side."),

  FILLS: link("FILLS", ["candidate"], ["capability"], "N:N", "fk", false, [],
    "build.ts:517. candidate -> the capability it filled (triage matchedFacet, norm()-ed), only if that capability node exists. dst=capability is the coverage/blind-spot anchor in 4 readers."),

  INSIGHT_FOR: link("INSIGHT_FOR", ["project"], ["lesson", "boundary"], "N:1", "fk", false, [],
    "build.ts:528. project -> the lesson/boundary insight (FK appliesToProjectId). dst is the {lesson,boundary} set."),

  FROM_CANDIDATE: link("FROM_CANDIDATE", ["lesson", "boundary"], ["candidate"], "N:1", "fk", false, [],
    "build.ts:536. lesson/boundary insight -> the candidate that prompted it (FK viaCandidateRepoId). src is the {lesson,boundary} set."),

  SUGGESTED: link("SUGGESTED", ["project"], ["suggestion"], "N:N", "fk", false,
    [{ name: "status", type: "enum(surfaced|starred)" }, { name: "projected", type: "string", doc: "action level, mirrors node.projected" }],
    "build.ts:548. Surfaced-but-untriaged repos (<=30d, capped 6/project & 40 total)."),

  GOAL_OF: link("GOAL_OF", ["project"], ["goal"], "N:1", "fk", false, [],
    "build.ts:606. Active capability_goals. Edge only when g.projectSlug matches an active project; portfolio-wide goals are standalone."),

  IN_DOMAIN: link("IN_DOMAIN", ["project"], ["domain"], "N:N", "join", false, [],
    "build.ts:623. project -> domain tag. The cross-user count is decorative node data excluded from the rebuild hash."),

  RELATED_DOMAIN: link("RELATED_DOMAIN", ["domain"], ["domain"], "N:N", "derived", true,
    [{ name: "sharedProjects", type: "number" }],
    "build.ts:676. Domain<->domain co-occurrence (>=2 shared projects, top-6 neighbours). Feeds a second Louvain pass. Self-referential.",
    [1, 9999]),

  ENDORSED_BY_SIMILAR: link("ENDORSED_BY_SIMILAR", ["candidate"], ["candidate"], "N:N", "derived", true, [],
    "DECLARED-BUT-DORMANT cross-user edge (header build.ts:26, schema kind comment, migration 0054). No live producer in src/ today. Registered for completeness so validateEdge tolerates it if a producer lands; src/dst candidate<->candidate is the best-guess 'similar users also adopted' signal. Must degrade to SILENT at N=1.",
    [0, 1]),
};

export const MAX_HOPS = 3; // the declared traversal bound Leaps + Recall already respect

// ---------------------------------------------------------------------------
// Lookups + guards.
// ---------------------------------------------------------------------------
export const nodeType = (k: string): NodeType | undefined => (NODE_TYPES as Record<string, NodeType>)[k];
export const linkType = (k: string): LinkType | undefined => (LINK_TYPES as Record<string, LinkType>)[k];
export const isNodeKind = (k: string): k is NodeKind => (NODE_KINDS as readonly string[]).includes(k);
export const isEdgeKind = (k: string): k is EdgeKind => (EDGE_KINDS as readonly string[]).includes(k);

/** Warn-only structural check of one node. Returns human warnings, never throws. */
export function validateNode(n: { kind: string; nodeKey: string; data: Record<string, unknown> }): string[] {
  const w: string[] = [];
  const t = nodeType(n.kind);
  if (!t) { w.push(`node: unknown kind "${n.kind}" (key=${n.nodeKey})`); return w; }
  if (!n.nodeKey) w.push(`node: empty nodeKey for kind "${n.kind}"`);
  for (const p of t.props) {
    if (p.required && !(p.name in (n.data ?? {}))) w.push(`node ${n.kind}(${n.nodeKey}): missing required data.${p.name}`);
  }
  // Soft off-node guard: a vector field in node.data violates the Embeddable contract.
  for (const ex of t.dataExcluded ?? []) {
    if (n.data && ex in n.data) w.push(`node ${n.kind}(${n.nodeKey}): off-node field "${ex}" must NOT be written to node.data`);
  }
  return w;
}

/** Warn-only structural check of one edge, including the load-bearing DIRECTION
 *  invariant (src/dst kinds must be in the declared sets). Never throws. */
export function validateEdge(e: { kind: string; srcKind?: string; dstKind?: string; weight: number | null }): string[] {
  const w: string[] = [];
  const t = linkType(e.kind);
  if (!t) { w.push(`edge: unknown kind "${e.kind}"`); return w; }
  if (e.srcKind && !t.src.includes(e.srcKind as NodeKind)) w.push(`edge ${e.kind}: src kind "${e.srcKind}" not in {${t.src.join(",")}}`);
  if (e.dstKind && !t.dst.includes(e.dstKind as NodeKind)) w.push(`edge ${e.kind}: dst kind "${e.dstKind}" not in {${t.dst.join(",")}}`);
  if (t.weighted && t.weightBand && e.weight != null) {
    const [lo, hi] = t.weightBand;
    if (e.weight < lo || e.weight > hi) w.push(`edge ${e.kind}: weight ${e.weight} outside band [${lo},${hi}]`);
  }
  return w;
}

/** A self-describing dump of the whole ontology (kinds, pks, interfaces, links). */
export function summary(): string {
  const lines: string[] = [
    `${NAMESPACE} ontology  (namespace api: ${qn("…")})`,
    `  interfaces: ${Object.keys(INTERFACES).length}  nodes: ${NODE_KINDS.length}  links: ${EDGE_KINDS.length}  maxHops: ${MAX_HOPS}`,
    "", "  Node types:",
  ];
  for (const k of NODE_KINDS) {
    const t = NODE_TYPES[k];
    const impl = t.implements.length ? `  implements(${t.implements.join(",")})` : "";
    lines.push(`    ${t.api.padEnd(22)} kind=${k.padEnd(11)} pk=${t.pk.slice(0, 60)}${impl}`);
  }
  lines.push("  Link types:");
  for (const k of EDGE_KINDS) {
    const l = LINK_TYPES[k];
    lines.push(`    ${l.src.join("|").padEnd(18)} --${k}--> ${l.dst.join("|").padEnd(14)} [${l.card}, ${l.backing}${l.weighted ? ", weighted" : ""}]`);
  }
  return lines.join("\n");
}

// Re-exported for build.ts emission sites that prefer a named constant over a
// bare literal (optional; the narrowed draft types already enforce the union).
export const K = Object.fromEntries(NODE_KINDS.map((k) => [k, k])) as { [P in NodeKind]: P };
export const E = Object.fromEntries(EDGE_KINDS.map((k) => [k, k])) as { [P in EdgeKind]: P };

// Surface the shared enums' presence so a value reference stays a type ref only.
export type { Modality, Provenance };
