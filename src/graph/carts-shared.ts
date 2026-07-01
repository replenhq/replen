// Pure, DB-free surface for Atlas Carts — types + small constants + formatters.
// Split out so the CLIENT board (CartsBoard.tsx) can import it without dragging
// src/db/client.ts into the browser bundle. carts.ts (which touches the DB)
// re-exports everything here, so server callers keep importing "@/graph/carts".

export type CartLayout = "table" | "board" | "cards" | "map" | "timeline";

export type CartColumnType =
  | "title"        // primary cell; the UI links it (href on the row)
  | "text"
  | "num"
  | "bar"          // amber degree/score bar, scaled to result.barMax
  | "modality"     // plain comma-joined list
  | "provenance"   // brightness hierarchy, no pill
  | "date";

export type CartColumn = { key: string; label: string; type: CartColumnType; align?: "right" };

export type CartCardMeta = { icon: "star" | "hex" | "doc" | "split" | "folder"; text: string };
export type CartCard = {
  key: string;
  title: string;        // repo full name
  node: string;         // dossier ref "kind:nodeKey" — opens the slide-over
  repo: string;         // owner/name for setCartVerdict
  projectSlug: string | null; // the project this card belongs to (drag target resolution)
  column: string;       // its current verdict / status column
  meta: CartCardMeta[];
  match: number | null; // 0..100, the amber "Match" bar; null hides it
  sub: string | null;   // a projected-action line when there's no score
};
export type CartCardDetail = CartCard; // alias for the drawer
export type CartGroup = { key: string; label: string; total: number; cards: CartCard[] };

// A node placed on the semantic (PCA) map. Position is joined in the UI from
// computeSemanticMap by the `node` ref ("kind:nodeKey").
export type CartMapPoint = {
  node: string;              // "kind:nodeKey" — join key + dossier ref
  label: string;
  kind: string;
  theme: string | null;
  provenance: string | null;
  modality: string | null;
  verdict: string | null;
};

// A node on the Timeline layout, placed by its timestamp (epoch seconds).
export type CartTimelineItem = {
  node: string;              // dossier ref
  title: string;
  at: number | null;         // epoch seconds; null = undated
  tag: string | null;        // verdict / theme
  sub: string | null;
};

export type CartResult = {
  id: string;
  name: string;
  description: string;
  icon: string;
  layout: CartLayout;
  count: number;
  columns: CartColumn[];
  rows: Record<string, string | number | boolean | string[] | null>[];
  barMax: number;
  groups?: CartGroup[];
  points?: CartMapPoint[];
  timeline?: CartTimelineItem[];
  summary?: { text: string; accent?: boolean }[];
};

export type CartFilters = {
  provenance?: string;
  modality?: string;
  verdict?: string;
  project?: string;
  q?: string;
};

export type CartMeta = { id: string; name: string; description: string; icon: string; layout: CartLayout };

// A user-saved view: a built-in cart + a layout + saved filters, persisted in
// atlas_carts. Presentation config only.
export type SavedCart = { id: number; name: string; baseCart: string; layout: CartLayout | null; filters: CartFilters };

// Columns a card can be dragged INTO (real verdicts). suggested/evaluating are
// statuses, not verdicts, so they are not drop targets.
export const VERDICT_COLUMNS = ["adopt", "port", "cherry-pick", "clean-room", "upgrade", "skip"];

export const CARTS: CartMeta[] = [
  { id: "blind-spots", name: "Blind spots", icon: "gap", layout: "table",
    description: "capabilities you have with no tool, library or candidate filling them" },
  { id: "triage", name: "Triage board", icon: "board", layout: "board",
    description: "candidates and suggestions, grouped by verdict" },
  { id: "keystones", name: "Keystones", icon: "cards", layout: "table",
    description: "the capabilities that recur across the most repos" },
  { id: "brought-in", name: "Brought in", icon: "table", layout: "table",
    description: "candidates you adopted, ported, or cherry-picked" },
  { id: "stale", name: "Stale deferrals", icon: "table", layout: "table",
    description: "verdicts to port or cherry-pick that you haven't acted on, oldest first" },
  { id: "by-domain", name: "By domain", icon: "map", layout: "table",
    description: "capabilities grouped by the domain they belong to" },
];

export function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtAgo(epochOrIso: string | number | null): string {
  if (epochOrIso == null) return "";
  let then: number;
  if (typeof epochOrIso === "number") then = epochOrIso * 1000;
  else { const t = Date.parse(epochOrIso); if (Number.isNaN(t)) return String(epochOrIso); then = t; }
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
