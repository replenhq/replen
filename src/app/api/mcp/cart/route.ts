import { NextResponse } from "next/server";
import { authenticate, corsHeaders } from "../_auth";
import { buildCartEngine, runCart, cartCount, loadSavedCarts, findSavedCart, CARTS, type CartFilters } from "@/graph/carts";

// replen_cart — pull an Atlas Cart's rows so a session agent can act on them.
// No `cart` param lists the available carts (built-in + the user's saved).
// Otherwise resolves a built-in id or a saved-cart name, applies filters, and
// returns the rows (table projection, uniform across carts). Read-only.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });

  const url = new URL(req.url);
  const cartParam = url.searchParams.get("cart")?.trim();
  const engine = await buildCartEngine(auth.userId);

  // query filters (only keys actually present)
  const qf: CartFilters = {};
  for (const [key, param] of [["provenance", "prov"], ["modality", "mod"], ["verdict", "verdict"], ["project", "project"], ["q", "q"]] as const) {
    const v = url.searchParams.get(param)?.trim();
    if (v) qf[key] = v;
  }

  if (!cartParam) {
    const saved = await loadSavedCarts(auth.userId);
    return NextResponse.json({
      carts: CARTS.map((c) => ({ id: c.id, name: c.name, description: c.description, layout: c.layout, count: cartCount(engine, c.id) })),
      saved: saved.map((s) => ({ name: s.name, baseCart: s.baseCart, layout: s.layout, filters: s.filters })),
      hint: "call replen_cart again with cart='<id or saved name>' to pull its rows",
    }, { headers: corsHeaders });
  }

  let baseCart = cartParam;
  let filters: CartFilters = qf;
  let name = cartParam;
  const builtin = CARTS.find((c) => c.id === cartParam);
  let description = builtin?.description ?? "";
  if (!builtin) {
    const saved = await findSavedCart(auth.userId, cartParam);
    if (!saved) return NextResponse.json({ error: `no cart '${cartParam}'. Call replen_cart with no cart to list them.` }, { status: 404, headers: corsHeaders });
    baseCart = saved.baseCart;
    filters = { ...saved.filters, ...qf }; // explicit query filters override the saved ones
    name = saved.name;
    description = CARTS.find((c) => c.id === baseCart)?.description ?? "";
  }

  const result = runCart(engine, baseCart, { layout: "table", filters });
  const rows = result.rows.map((r) => {
    const { __href, ...rest } = r as Record<string, unknown> & { __href?: string };
    return { ...rest, atlas: __href ?? null };
  });
  return NextResponse.json({
    cart: name, baseCart, description, count: result.count,
    columns: result.columns.map((c) => c.key),
    rows,
    summary: result.summary?.map((s) => s.text),
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
