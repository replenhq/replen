// Phase 2 — capability extraction. A project's TECHNICAL capabilities (what it
// does at the tech level: "computer vision", "geospatial mapping", "Bayesian
// inference") drive two things now:
//   1. Facet embeddings — one vector per capability, so a library that fills a
//      capability surfaces even when it's far from the project's blended
//      centroid (src/scheduler/run-once.ts).
//   2. Targeted GitHub search — each capability becomes a search term so the
//      candidate pool actually CONTAINS capability-libraries (search-vectors).
//
// Capabilities come from two sources, merged:
//   - the LLM summary (`capabilityTags`, derived from docs + file tree + config)
//   - this deterministic dep→capability table, which catches tech the docs
//     never spell out as a "capability" (a repo that imports `cv2` does
//     computer vision whether or not its README says so).
//
// The table maps a manifest dep token (lowercased, as it appears in
// package.json / pyproject.toml / Cargo.toml / go.mod) to one or more SHORT,
// GitHub-searchable capability phrases. Keep phrases ≤4 words and in the
// vocabulary real repos use in their description/topics.

// dep token (lowercased) -> capability phrases
const DEP_CAPABILITIES: Record<string, string[]> = {
  // ── Computer vision / imagery ──
  "opencv-python": ["computer vision"],
  "opencv-contrib-python": ["computer vision"],
  "opencv": ["computer vision"],
  "cv2": ["computer vision"],
  "scikit-image": ["image processing"],
  "pillow": ["image processing"],
  "kornia": ["computer vision", "image augmentation"],
  "ultralytics": ["object detection"],
  "yolov5": ["object detection"],
  "yolov8": ["object detection"],
  "supervision": ["object detection"],
  "mmcv": ["computer vision"],
  "detectron2": ["object detection"],
  "tesseract": ["OCR"],
  "pytesseract": ["OCR"],
  "easyocr": ["OCR"],

  // ── Geospatial / satellite ──
  "rasterio": ["geospatial", "satellite imagery"],
  "gdal": ["geospatial", "raster processing"],
  "geopandas": ["geospatial"],
  "shapely": ["geospatial"],
  "fiona": ["geospatial"],
  "pyproj": ["geospatial projection"],
  "rioxarray": ["satellite imagery"],
  "sentinelsat": ["satellite imagery"],
  "earthengine-api": ["satellite imagery"],
  "leaflet": ["interactive mapping"],
  "mapbox-gl": ["interactive mapping"],
  "maplibre-gl": ["interactive mapping"],
  "deck.gl": ["geospatial visualization"],
  "ol": ["interactive mapping"], // openlayers
  "openlayers": ["interactive mapping"],
  "cesium": ["3d mapping"],
  "turf": ["geospatial analysis"],
  "@turf/turf": ["geospatial analysis"],
  "h3": ["geospatial indexing"],

  // ── Probabilistic / Bayesian / ML ──
  "pymc": ["Bayesian inference"],
  "numpyro": ["Bayesian inference"],
  "pyro-ppl": ["probabilistic programming"],
  "pystan": ["Bayesian inference"],
  "emcee": ["MCMC sampling"],
  "scikit-learn": ["machine learning"],
  "sklearn": ["machine learning"],
  "xgboost": ["gradient boosting"],
  "lightgbm": ["gradient boosting"],
  "torch": ["deep learning"],
  "pytorch": ["deep learning"],
  "tensorflow": ["deep learning"],
  "keras": ["deep learning"],
  "jax": ["deep learning"],
  "transformers": ["transformers", "NLP"],
  "sentence-transformers": ["text embeddings"],
  "spacy": ["NLP"],
  "nltk": ["NLP"],
  "onnxruntime": ["model inference"],
  "filterpy": ["Kalman filtering", "sensor fusion"],
  "pykalman": ["Kalman filtering"],

  // ── Data ──
  "pandas": ["data analysis"],
  "polars": ["dataframes"],
  "numpy": ["numerical computing"],
  "scipy": ["scientific computing"],
  "duckdb": ["analytical sql"],
  "pyarrow": ["columnar data"],
  "dask": ["parallel computing"],

  // ── Crypto / trading ──
  "ccxt": ["crypto exchange", "market data"],
  "python-binance": ["crypto exchange"],
  "pybit": ["crypto exchange"],
  "web3": ["blockchain", "ethereum"],
  "ethers": ["ethereum", "smart contracts"],
  "viem": ["ethereum", "smart contracts"],
  "@solana/web3.js": ["solana"],
  "backtrader": ["backtesting", "trading strategy"],
  "vectorbt": ["backtesting", "trading strategy"],
  "zipline": ["backtesting"],
  "ta-lib": ["technical analysis"],
  "pandas-ta": ["technical analysis"],
  "ta": ["technical analysis"],

  // ── Realtime / streaming / messaging ──
  "websockets": ["realtime streaming"],
  "ws": ["websockets"],
  "socket.io": ["realtime streaming"],
  "aiokafka": ["event streaming"],
  "kafka-python": ["event streaming"],
  "confluent-kafka": ["event streaming"],
  "pika": ["message queue"],
  "celery": ["task queue"],
  "bullmq": ["job queue"],

  // ── Media ──
  "ffmpeg": ["video processing"],
  "fluent-ffmpeg": ["video processing"],
  "moviepy": ["video editing"],
  "pydub": ["audio processing"],
  "librosa": ["audio analysis"],

  // ── Web / scraping ──
  "playwright": ["browser automation"],
  "puppeteer": ["browser automation"],
  "selenium": ["browser automation"],
  "scrapy": ["web scraping"],
  "beautifulsoup4": ["web scraping"],
  "three": ["3d rendering"],
  "@react-three/fiber": ["3d rendering"],
  "d3": ["data visualization"],
  "recharts": ["data visualization"],
};

/**
 * Deterministic capability phrases for a project's dependency set. Catches
 * tech the docs don't name as a capability. Returns deduped, order-preserving.
 */
export function capabilitiesFromDeps(deps: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of deps) {
    const caps = DEP_CAPABILITIES[raw.trim().toLowerCase()];
    if (!caps) continue;
    for (const c of caps) {
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/**
 * Merge LLM-derived + dep-derived capability tags into one clean, deduped,
 * capped list suitable for BOTH facet embedding and GitHub search. Drops
 * blanks, over-long phrases (>5 words never appear in GitHub topics), and
 * exact-duplicate (case-insensitive) tags; preserves first-seen casing.
 */
// Generic tags that are useless as both facet probes and search terms — they'd
// match almost any repo. The prompt forbids these in capabilityTags; this is
// the server-side backstop for when the LLM emits one anyway.
const GENERIC_TAGS = new Set([
  "data", "api", "apis", "web", "webapp", "app", "ui", "ux", "frontend",
  "backend", "fullstack", "database", "cli", "tooling", "testing", "logging",
  "auth", "devops", "infrastructure", "deployment", "monitoring", "analytics",
  "dashboard", "dashboards", "automation", "integration", "platform",
  // Bare language/runtime names: useless as a capability probe or search term
  // (they'd match the whole ecosystem). The prompt forbids them; this is the
  // backstop for when the LLM emits one anyway.
  "python", "javascript", "typescript", "java", "golang", "rust", "ruby",
  "php", "swift", "kotlin", "scala", "node", "nodejs", "asyncio",
]);

export function mergeCapabilityTags(
  llmTags: Array<string | null | undefined>,
  depTags: string[],
  cap = 12,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...llmTags, ...depTags]) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/\s+/g, " ");
    if (tag.length < 3 || tag.length > 40) continue;
    if (tag.split(" ").length > 5) continue;
    const key = tag.toLowerCase();
    if (GENERIC_TAGS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= cap) break;
  }
  return out;
}
