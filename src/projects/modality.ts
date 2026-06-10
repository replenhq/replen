// Data modality — the kind of data/signal a capability operates on. This is the
// axis that the bare-label facet match loses: "anomaly detection" on drone
// TELEMETRY (timeseries) and "anomaly detection" on IMAGES embed to the same
// neighbourhood, so an image-defect library collides with a telemetry project.
// Tagging each capability + each catalogue repo with a modality lets the matcher
// gate cross-modal collisions deterministically (an image lib never matches a
// timeseries capability), the same way the language gate excludes a runtime you
// can't use.
//
// Closed set — keep it small and unambiguous. Anything that doesn't clearly map
// to one of these stays UNKNOWN (empty), and the gate treats unknown as "don't
// gate" so a warming catalogue never over-suppresses.

export type Modality =
  | "image"
  | "video"
  | "timeseries"
  | "tabular"
  | "text"
  | "audio"
  | "geospatial"
  | "graph"
  | "3d"
  | "code"
  | "network";

export const ALL_MODALITIES: ReadonlySet<Modality> = new Set<Modality>([
  "image", "video", "timeseries", "tabular", "text",
  "audio", "geospatial", "graph", "3d", "code", "network",
]);

// How we KNOW a capability is true of a project — borrowed from Graphify's
// EXTRACTED/INFERRED/AMBIGUOUS edge tags, adapted to Replen's sources. Drives
// trust (shown to the user) and ranking (grounded outranks inferred; ambiguous
// is gated harder). Confidence order: grounded > extracted > inferred > ambiguous.
//   grounded   — the in-session agent read the actual source (has a descriptor)
//   extracted  — deterministic dep→capability from the manifest
//   inferred   — the server LLM guessed it from the docs
//   ambiguous  — low-confidence inferred / a raw doc-section facet
export type Provenance = "grounded" | "extracted" | "inferred" | "ambiguous";
export const ALL_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["grounded", "extracted", "inferred", "ambiguous"]);
export function coerceProvenance(raw: unknown): Provenance | null {
  return typeof raw === "string" && ALL_PROVENANCE.has(raw as Provenance) ? (raw as Provenance) : null;
}

// A project capability, grounded. `tag` is the short GitHub-searchable term (for
// retrieval); `descriptor` is the rich, code-grounded phrase that actually gets
// embedded (for matching); `modality` is the data axis (for the gate);
// `provenance` is how we know it (confidence + trust).
export type CapabilitySpec = {
  tag: string;
  descriptor: string;
  modality: Modality[];
  provenance?: Provenance;
  // Evidence anchors: file paths that implement this capability (e.g.
  // ["src/cv/transformations.py"]). Paths only — never code. They make
  // cross-project leaps actionable ("acme solved this — see src/cv/…")
  // and ground the Atlas dossier in real locations.
  paths?: string[];
};

/** Validate arbitrary LLM/API input into a clean Modality[] (dedup, drop unknown values). */
export function coerceModalities(raw: unknown): Modality[] {
  if (!Array.isArray(raw)) return [];
  const out: Modality[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const m = v.trim().toLowerCase();
    if (ALL_MODALITIES.has(m as Modality) && !seen.has(m)) {
      seen.add(m);
      out.push(m as Modality);
    }
  }
  return out;
}

/** True when two modality sets share none — i.e. a hard cross-modal mismatch. */
export function modalitiesDisjoint(a: Modality[] | undefined, b: Modality[] | undefined): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false; // unknown on either side → don't gate
  const bs = new Set(b);
  return !a.some((m) => bs.has(m));
}

// Deterministic GitHub-topic → modality. Front-runs the LLM classifier on the
// CANDIDATE side: most catalogue repos declare their modality in their topics
// (anomalib: "anomaly-segmentation", "anomaly-localization" → image). Only the
// ambiguous remainder needs the LLM. Keyed by exact lowercased topic.
const TOPIC_MODALITY: Record<string, Modality[]> = {
  // image
  "computer-vision": ["image"], "image-processing": ["image"], "image-classification": ["image"],
  "object-detection": ["image"], "image-segmentation": ["image"], "semantic-segmentation": ["image"],
  "instance-segmentation": ["image"], "anomaly-segmentation": ["image"], "anomaly-localization": ["image"],
  "face-detection": ["image"], "face-recognition": ["image"], "pose-estimation": ["image"],
  "keypoint-detection": ["image"], "ocr": ["image"], "opencv": ["image"], "image": ["image"],
  "medical-imaging": ["image"], "diffusion-models": ["image"], "image-generation": ["image"],
  // video
  "video": ["video"], "video-processing": ["video"], "action-recognition": ["video"],
  "video-analysis": ["video"], "object-tracking": ["video"], "video-understanding": ["video"],
  // timeseries
  "time-series": ["timeseries"], "timeseries": ["timeseries"], "forecasting": ["timeseries"],
  "telemetry": ["timeseries"], "sensor": ["timeseries"], "sensor-fusion": ["timeseries"],
  "iot": ["timeseries"], "signal-processing": ["timeseries"], "metrics": ["timeseries"],
  // tabular
  "tabular": ["tabular"], "tabular-data": ["tabular"], "dataframe": ["tabular"], "dataframes": ["tabular"],
  "recommendation": ["tabular"], "recommender-system": ["tabular"], "recommendation-system": ["tabular"],
  "collaborative-filtering": ["tabular"], "feature-engineering": ["tabular"], "etl": ["tabular"],
  // text
  "nlp": ["text"], "natural-language-processing": ["text"], "text-classification": ["text"],
  "sentiment-analysis": ["text"], "named-entity-recognition": ["text"], "ner": ["text"],
  "information-retrieval": ["text"], "semantic-search": ["text"], "embeddings": ["text"],
  "rag": ["text"], "language-model": ["text"], "llm": ["text"], "text-generation": ["text"],
  // audio
  "audio": ["audio"], "speech": ["audio"], "speech-recognition": ["audio"], "asr": ["audio"],
  "tts": ["audio"], "text-to-speech": ["audio"], "music": ["audio"], "sound": ["audio"],
  // geospatial
  "geospatial": ["geospatial"], "gis": ["geospatial"], "maps": ["geospatial"], "mapping": ["geospatial"],
  "geocoding": ["geospatial"], "cartography": ["geospatial"], "openstreetmap": ["geospatial"],
  "leaflet": ["geospatial"], "mapbox": ["geospatial"], "remote-sensing": ["image", "geospatial"],
  "satellite-imagery": ["image", "geospatial"], "raster": ["geospatial"],
  // graph
  "graph": ["graph"], "knowledge-graph": ["graph"], "graph-database": ["graph"],
  "graph-neural-networks": ["graph"], "network-analysis": ["graph"], "neo4j": ["graph"],
  // 3d
  "3d": ["3d"], "point-cloud": ["3d"], "lidar": ["3d"], "mesh": ["3d"], "slam": ["3d"],
  "photogrammetry": ["3d"], "3d-reconstruction": ["3d"],
  // code
  "static-analysis": ["code"], "ast": ["code"], "code-analysis": ["code"], "parser": ["code"],
  "compiler": ["code"], "linter": ["code"],
  // network
  "networking": ["network"], "packet-analysis": ["network"], "pcap": ["network"],
  "network-security": ["network"], "traffic-analysis": ["network"],
};

/** Deterministic modality from a repo's GitHub topics. Union across matched topics. */
export function modalityFromTopics(topics: string[]): Modality[] {
  const out = new Set<Modality>();
  for (const t of topics) {
    const ms = TOPIC_MODALITY[t.trim().toLowerCase()];
    if (ms) for (const m of ms) out.add(m);
  }
  return [...out];
}

// Capability-phrase → modality, for the PROJECT side fallback (and the dep
// table). ONLY maps phrases whose modality is unambiguous — deliberately omits
// "anomaly detection" (image vs timeseries), "recommendation" stays tabular but
// generic ML method families (deep learning, bayesian inference) are left
// UNKNOWN so the gate never fires on a method that spans modalities. Ambiguous
// capabilities rely on the agent-supplied modality + the grounded descriptor.
const CAPABILITY_MODALITY: Record<string, Modality[]> = {
  "computer vision": ["image"], "object detection": ["image"], "image processing": ["image"],
  "image segmentation": ["image"], "image augmentation": ["image"], "ocr": ["image"],
  "satellite imagery": ["image", "geospatial"], "raster processing": ["geospatial"],
  "geospatial": ["geospatial"], "geospatial visualization": ["geospatial"], "geospatial analysis": ["geospatial"],
  "geospatial indexing": ["geospatial"], "geospatial projection": ["geospatial"], "interactive mapping": ["geospatial"],
  "3d mapping": ["geospatial", "3d"], "3d rendering": ["3d"],
  "video processing": ["video"], "video editing": ["video"],
  "audio processing": ["audio"], "audio analysis": ["audio"],
  "nlp": ["text"], "transformers": ["text"], "text embeddings": ["text"],
  "dataframes": ["tabular"], "data analysis": ["tabular"], "numerical computing": ["tabular"],
  "analytical sql": ["tabular"], "columnar data": ["tabular"],
  "kalman filtering": ["timeseries"], "sensor fusion": ["timeseries"], "technical analysis": ["timeseries"],
  "backtesting": ["timeseries"], "market data": ["timeseries"],
};

/**
 * Best-effort modality for a capability when the agent didn't supply one — from
 * the phrase map, then a light keyword scan of the descriptor. Returns [] when
 * genuinely ambiguous, so the gate stays open rather than guessing.
 */
export function inferCapabilityModality(tag: string, descriptor?: string | null): Modality[] {
  const direct = CAPABILITY_MODALITY[tag.trim().toLowerCase()];
  if (direct) return direct;
  const text = `${tag} ${descriptor ?? ""}`.toLowerCase();
  const out = new Set<Modality>();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  if (has("image", "satellite imagery", "pixel", "photo", "visual ")) out.add("image");
  if (has("video", "frame-by-frame")) out.add("video");
  if (has("time series", "time-series", "telemetry", "sensor stream", "sensor reading")) out.add("timeseries");
  if (has("dataframe", "tabular", "csv", "spreadsheet")) out.add("tabular");
  if (has("nlp", "natural language", "text corpus", "documents", "tokeniz")) out.add("text");
  if (has("audio", "speech", "waveform", "spectrogram")) out.add("audio");
  if (has("geospatial", "map ", "gis", "coordinates", "lat/long", "raster")) out.add("geospatial");
  if (has("knowledge graph", "graph database", "node and edge")) out.add("graph");
  if (has("point cloud", "lidar", "mesh", "3d ")) out.add("3d");
  if (has("packet", "network traffic", "pcap")) out.add("network");
  return [...out];
}
