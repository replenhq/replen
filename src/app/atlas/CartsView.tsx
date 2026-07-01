import { Icon } from "@/components/Icons";
import { CartsBoard } from "./CartsBoard";
import { CartsMap } from "./CartsMap";
import { CartsCards } from "./CartsCards";
import { CartsTimeline } from "./CartsTimeline";
import {
  CARTS, cartCount, runCart, fmtAgo, fmtStars,
  type CartEngine, type CartLayout, type CartResult, type CartColumn, type CartFilters,
} from "@/graph/carts";

// The "database" half of Atlas. Server-rendered: the rail, switcher, filter row,
// and the active layout are all <a>/<form>/<details> — no client JS. Rows and
// cards link out (to the repo) or into the graph dossier. Calm + monochrome;
// amber only on the match/degree bars (see globals.css .carts-root).

const RAIL_ICON: Record<string, string> = {
  "blind-spots": "gap", triage: "board", keystones: "cards",
  "brought-in": "table", stale: "table", "by-domain": "compass",
};
const CANDIDATE_CARTS = new Set(["triage", "brought-in", "stale"]);
const LAYOUTS: { id: CartLayout; label: string; icon: string }[] = [
  { id: "table", label: "Table", icon: "table" },
  { id: "board", label: "Board", icon: "board" },
  { id: "cards", label: "Cards", icon: "cards" },
  { id: "map", label: "Map", icon: "compass" },
  { id: "timeline", label: "Timeline", icon: "activity" },
];
const PROVENANCE = ["grounded", "extracted", "inferred"];

const isExternal = (h: string | null): boolean => !!h && /^https?:\/\//.test(h);

export function CartsView({
  engine, activeId, layout, filters, mapPos,
}: {
  engine: CartEngine; activeId: string; layout: CartLayout; filters: CartFilters;
  mapPos?: Record<string, { x: number; y: number }>;
}) {
  const result = runCart(engine, activeId, { layout, filters });
  const candidateCart = CANDIDATE_CARTS.has(activeId);
  // available filter options (from real data)
  const modalities = [...new Set((engine.byKind.get("capability") ?? []).flatMap((c) => c.modality))].sort();
  const projects = [...new Set((engine.byKind.get("project") ?? []).map((p) => p.label))].sort();

  // Link builder — merges the current view state with overrides, drops empties.
  const href = (o: Partial<{ cart: string; layout: string; q: string; prov: string; mod: string; proj: string }>): string => {
    const p = new URLSearchParams();
    p.set("view", "carts");
    p.set("cart", o.cart ?? activeId);
    const changed = o.cart && o.cart !== activeId; // a rail click resets filters
    const lay = o.layout ?? (changed ? "" : layout);
    if (lay) p.set("layout", lay);
    const q = o.q !== undefined ? o.q : (changed ? "" : filters.q);
    const prov = o.prov !== undefined ? o.prov : (changed ? "" : filters.provenance);
    const mod = o.mod !== undefined ? o.mod : (changed ? "" : filters.modality);
    const proj = o.proj !== undefined ? o.proj : (changed ? "" : filters.project);
    if (q) p.set("q", q);
    if (prov) p.set("prov", prov);
    if (mod) p.set("mod", mod);
    if (proj) p.set("proj", proj);
    return `/atlas?${p.toString()}`;
  };

  return (
    <div className="carts-root">
      {/* left rail */}
      <aside className="carts-rail">
        <div className="carts-rail-label">CARTS</div>
        {CARTS.map((c) => {
          const active = c.id === activeId;
          return (
            <a key={c.id} href={href({ cart: c.id })} className={`carts-rail-item${active ? " active" : ""}`}>
              <Icon name={RAIL_ICON[c.id] ?? "doc"} size={15} />
              <span className="carts-rail-name">{c.name}</span>
              <span className="carts-rail-count">{cartCount(engine, c.id)}</span>
            </a>
          );
        })}
        <div className="carts-rail-new">+&nbsp;&nbsp;New cart</div>
      </aside>

      {/* main */}
      <section className="carts-main">
        <header className="carts-head">
          <div className="carts-head-title">
            <h2>{result.name}</h2>
            <span className="carts-head-sub">{result.description}</span>
          </div>
          <div className="carts-switcher">
            {LAYOUTS.map((l) => {
              // every layout is live now; Board is the only cart-specific one.
              const live = l.id === "board" ? activeId === "triage" : true;
              const active = l.id === layout;
              if (active) return <span key={l.id} className="carts-tab active"><Icon name={l.icon} size={14} />{l.label}</span>;
              if (!live) return <span key={l.id} className="carts-tab ghost"><Icon name={l.icon} size={14} />{l.label}</span>;
              return <a key={l.id} href={href({ layout: l.id })} className="carts-tab"><Icon name={l.icon} size={14} />{l.label}</a>;
            })}
          </div>
        </header>

        <div className="carts-filters">
          <form className="carts-search" method="get" action="/atlas">
            <input type="hidden" name="view" value="carts" />
            <input type="hidden" name="cart" value={activeId} />
            <input type="hidden" name="layout" value={layout} />
            {filters.provenance ? <input type="hidden" name="prov" value={filters.provenance} /> : null}
            {filters.modality ? <input type="hidden" name="mod" value={filters.modality} /> : null}
            {filters.project ? <input type="hidden" name="proj" value={filters.project} /> : null}
            <Icon name="search" size={14} />
            <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder="Search this cart…" />
          </form>
          {candidateCart
            ? <FilterMenu label="Project" active={filters.project} options={projects} hrefFor={(v) => href({ proj: v })} />
            : <>
                <FilterMenu label="Provenance" active={filters.provenance} options={PROVENANCE} hrefFor={(v) => href({ prov: v })} />
                <FilterMenu label="Modality" active={filters.modality} options={modalities} hrefFor={(v) => href({ mod: v })} />
              </>}
          <span className="carts-results">{result.count} {result.layout === "board" ? "cards" : "results"}</span>
        </div>

        {result.layout === "board"
          ? <CartsBoard groups={result.groups ?? []} note="Drag a card into a verdict column to record or override it. Click a card for its full detail." />
          : result.layout === "map"
          ? <CartsMap points={result.points ?? []} positions={mapPos ?? {}} />
          : result.layout === "cards"
          ? <CartsCards groups={result.groups ?? []} />
          : result.layout === "timeline"
          ? <CartsTimeline items={result.timeline ?? []} />
          : <TableLayout result={result} />}
      </section>
    </div>
  );
}

function FilterMenu({ label, active, options, hrefFor }: {
  label: string; active?: string; options: string[]; hrefFor: (v: string) => string;
}) {
  return (
    <details className="carts-filter">
      <summary>{active ? `${label}: ${active}` : label}<span className="carts-caret">⌄</span></summary>
      <div className="carts-filter-menu">
        <a href={hrefFor("")} className={!active ? "active" : ""}>Any</a>
        {options.map((o) => <a key={o} href={hrefFor(o)} className={active === o ? "active" : ""}>{o}</a>)}
      </div>
    </details>
  );
}

// ---- Table -----------------------------------------------------------------
function TableLayout({ result }: { result: CartResult }) {
  if (!result.rows.length) return <EmptyCart name={result.name} />;
  return (
    <div className="carts-table-wrap">
      <table className="carts-table">
        <thead>
          <tr>{result.columns.map((c) => <th key={c.key} className={c.align === "right" ? "r" : ""}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => {
            const h = row.__href as string | null;
            return (
              <tr key={i}>
                {result.columns.map((c) => <td key={c.key} className={c.align === "right" ? "r" : ""}>{cell(c, row, result.barMax, h)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {result.summary && (
        <div className="carts-summary">
          {result.summary.map((s, i) => <span key={i} className={s.accent ? "accent" : ""}>{s.text}</span>)}
        </div>
      )}
    </div>
  );
}

function cell(c: CartColumn, row: Record<string, unknown>, barMax: number, href: string | null) {
  const v = row[c.key];
  switch (c.type) {
    case "title":
      return href
        ? <a className="carts-cell-title" href={href} {...(isExternal(href) ? { target: "_blank", rel: "noopener" } : {})}>{String(v ?? "")}</a>
        : <span className="carts-cell-title">{String(v ?? "")}</span>;
    case "provenance":
      return <span className={`carts-prov${v === "grounded" ? " grounded" : ""}`}>{String(v ?? "")}</span>;
    case "modality":
      return <span className="carts-dim">{Array.isArray(v) ? (v as string[]).join(", ") : ""}</span>;
    case "num":
      return <span className="carts-num">{v == null ? "" : c.key === "stars" ? fmtStars(Number(v)) : String(v)}</span>;
    case "date":
      return <span className="carts-faint">{fmtAgo((v as string | number | null) ?? null)}</span>;
    case "bar": {
      const n = typeof v === "number" ? v : 0;
      const pct = Math.max(0, Math.min(100, barMax > 0 ? (n / barMax) * 100 : 0));
      return (
        <span className="carts-bar-cell">
          <span className="carts-bar-track"><span className="carts-bar-fill" style={{ width: `${pct}%` }} /></span>
          <span className="carts-bar-num">{n}</span>
        </span>
      );
    }
    default:
      return <span className="carts-dim">{v == null ? "" : String(v)}</span>;
  }
}


function EmptyCart({ name }: { name: string }) {
  return (
    <div className="carts-empty">
      <p>Nothing in <strong>{name}</strong> yet.</p>
      <p className="carts-faint">Run a pipeline and a triage session to populate it.</p>
    </div>
  );
}
