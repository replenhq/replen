// Curated capability vocabulary for the shared catalogue.
//
// PRIVACY: the shared catalogue must never leak one user's project vocabulary.
// Two rules enforce that (see refreshCatalogueStep):
//   1. These curated, generic capabilities seed the catalogue with no user data
//      at all — they're the baseline coverage, safe by construction.
//   2. A capability derived from a USER's project only enters the shared
//      catalogue (and becomes a GitHub search) once it's also in this list OR
//      at least REPLEN_CATALOGUE_MIN_USERS distinct users independently have it
//      (k-anonymity). A unique/proprietary term used by one project never
//      crosses that threshold, so it's never shared and never searched.
//
// Everything here is a common, generic dev capability — the kind of thing
// thousands of public repos describe themselves with. Add freely; keep them
// generic (no domains, no product names).

export const SEED_CAPABILITIES: string[] = [
  // Web / frontend
  "server side rendering", "static site generation", "form validation",
  "state management", "data visualization", "rich text editor", "design system",
  "authentication", "authorization", "rate limiting", "websockets",
  "realtime streaming", "file uploads", "pdf generation", "image optimization",
  "web components", "progressive web app", "accessibility", "internationalization",
  "animation", "charting", "drag and drop", "virtual scrolling", "code editor",
  "markdown rendering", "syntax highlighting", "data tables", "date picker",
  // Backend / data
  "rest api", "graphql api", "grpc", "background jobs", "task queue",
  "message queue", "event streaming", "stream processing", "caching",
  "full text search", "vector search", "semantic search", "object relational mapping",
  "database migrations", "data pipelines", "workflow orchestration", "etl",
  "analytical sql", "time series", "geospatial", "graph database",
  "change data capture", "dataframes", "columnar data", "serialization",
  "schema validation", "dependency injection", "job scheduling", "webhooks",
  "email sending", "push notifications", "distributed locking", "service discovery",
  // AI / ML
  "machine learning", "deep learning", "computer vision", "object detection",
  "image segmentation", "pose estimation", "face recognition", "image generation",
  "diffusion models", "natural language processing", "named entity recognition",
  "sentiment analysis", "text embeddings", "speech recognition", "speech synthesis",
  "recommendation systems", "anomaly detection", "time series forecasting",
  "bayesian inference", "reinforcement learning", "gradient boosting",
  "model serving", "model evaluation", "experiment tracking", "feature engineering",
  "hyperparameter tuning", "vector database", "knowledge graph",
  "retrieval augmented generation", "llm orchestration", "prompt engineering",
  "kalman filtering", "sensor fusion", "optimization", "numerical computing",
  "linear algebra", "monte carlo simulation", "signal processing",
  // Media / signal
  "video processing", "video streaming", "audio processing", "audio analysis",
  "image processing", "ocr", "3d rendering", "physics simulation",
  "procedural generation", "pathfinding", "satellite imagery", "interactive mapping",
  "geocoding", "routing engine", "point cloud", "photogrammetry",
  // Crypto / fintech
  "crypto exchange", "market data", "technical analysis", "backtesting",
  "order management", "blockchain", "smart contracts", "decentralized finance",
  "zero knowledge proofs", "payments", "double entry accounting",
  // Hardware / embedded / robotics
  "embedded systems", "microcontrollers", "internet of things", "robotics",
  "motor control", "firmware", "real time operating system", "can bus",
  // Security
  "cryptography", "password hashing", "oauth", "json web tokens",
  "multi factor authentication", "static analysis", "fuzzing", "sandboxing",
  "dependency scanning", "secrets scanning",
  // Infra / ops / devops
  "browser automation", "web scraping", "containerization", "infrastructure as code",
  "ci cd", "gitops", "observability", "distributed tracing", "metrics collection",
  "log aggregation", "feature flags", "secrets management", "load testing",
  "service mesh", "api gateway", "configuration management", "chaos engineering",
  // Cross-platform apps
  "cross platform mobile", "desktop applications", "offline sync", "deep linking",
];

const SEED_SET = new Set(SEED_CAPABILITIES.map((c) => c.toLowerCase()));

export function isSeedCapability(label: string): boolean {
  return SEED_SET.has(label.trim().toLowerCase());
}
