// Import/refresh the pricing-watch tool list from the curated tracker JSON
// (converted from the developer_tool_pricing_tracker.xlsx — vendor, tool,
// pricing URL per row; no prices, the first scrape is the baseline).
//
// Idempotent: upserts by pricing_url, so re-running after a tracker refresh
// updates names/notes and adds new tools without disturbing scrape history.
//
// Usage:
//   tsx src/cli/import-pricing-tracker.ts [data/pricing-tracker.json]

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { detectTokens } from "../lib/detect-tokens";

type Row = { category: string; subCategory: string; vendor: string; tool: string; pricingUrl: string; notes: string | null };

async function main() {
  const path = process.argv[2] ?? "data/pricing-tracker.json";
  const rows = JSON.parse(readFileSync(path, "utf8")) as Row[];
  const now = new Date();
  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    if (!r.pricingUrl || !r.vendor || !r.tool) continue;
    const tokens = JSON.stringify(detectTokens(r.vendor, r.tool));
    const existing = await db.select({ id: schema.pricingTools.id }).from(schema.pricingTools)
      .where(eq(schema.pricingTools.pricingUrl, r.pricingUrl)).get();
    if (existing) {
      await db.update(schema.pricingTools).set({
        category: r.category, subCategory: r.subCategory, vendor: r.vendor, tool: r.tool,
        notes: r.notes ?? null, detectTokens: tokens, updatedAt: now,
      }).where(eq(schema.pricingTools.id, existing.id));
      updated++;
    } else {
      await db.insert(schema.pricingTools).values({
        category: r.category, subCategory: r.subCategory, vendor: r.vendor, tool: r.tool,
        pricingUrl: r.pricingUrl, notes: r.notes ?? null, detectTokens: tokens,
        active: true, createdAt: now, updatedAt: now,
      });
      inserted++;
    }
  }
  console.log(`[pricing-import] ${inserted} inserted, ${updated} updated (${rows.length} rows in ${path})`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
