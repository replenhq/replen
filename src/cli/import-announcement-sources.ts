// Import/refresh the announcement source catalogue from the seed pack JSON
// (developer_announcement_tracker_full_db_pack/announcement_sources_seed.json).
//
// Two jobs:
//   1. Upsert every source into announcement_sources (by source_id), deriving
//      detect tokens from vendor/product/source_url for user-stack matching.
//   2. Merge pricing_page sources into pricing_tools (by pricing_url), so the
//      pricing watch's catalogue grows; new tools get baselined by the normal
//      scrape cron (lastScrapedAt null → due on the next run).
//
// Idempotent — safe to re-run after a seed refresh.
//
// Usage:
//   tsx src/cli/import-announcement-sources.ts [path/to/announcement_sources_seed.json] [--no-pricing-merge]

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { detectTokens } from "../lib/detect-tokens";

type SeedRow = {
  source_id: string;
  vendor: string;
  product: string;
  category?: string;
  subcategory?: string;
  source_url: string;
  source_type: string;
  event_types?: string; // pipe-separated in the seed
  priority?: string;
  recommended_poll_frequency?: string;
  parser_strategy?: string;
  ecosystems?: string;
  keywords_to_watch?: string;
  active?: boolean | string;
  url_confidence?: string;
  seed_status?: string;
  will_break_app?: boolean | string;
  security_issue?: boolean | string;
  bill_increase?: boolean | string;
  upgrade_needed?: boolean | string;
  notes?: string;
};

const asBool = (v: boolean | string | undefined): boolean =>
  v === true || v === "TRUE" || v === "true" || v === "1";

async function main() {
  const path = process.argv.find((a) => a.endsWith(".json")) ??
    "data/developer_announcement_tracker_full_db_pack/announcement_sources_seed.json";
  const mergePricing = !process.argv.includes("--no-pricing-merge");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { sources?: SeedRow[] } | SeedRow[];
  const rows = Array.isArray(parsed) ? parsed : parsed.sources ?? [];
  const now = new Date();

  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    if (!r.source_id || !r.source_url || !r.vendor || !r.product) continue;
    const values = {
      vendor: r.vendor,
      product: r.product,
      category: r.category ?? null,
      subCategory: r.subcategory ?? null,
      sourceUrl: r.source_url,
      sourceType: r.source_type,
      eventTypes: JSON.stringify((r.event_types ?? "").split("|").map((s) => s.trim()).filter(Boolean)),
      priority: r.priority ?? "P2",
      pollFrequency: r.recommended_poll_frequency ?? null,
      parserStrategy: r.parser_strategy ?? null,
      ecosystems: r.ecosystems ?? null,
      keywords: r.keywords_to_watch ?? null,
      detectTokens: JSON.stringify(detectTokens(r.vendor, r.product, r.source_url)),
      active: asBool(r.active ?? true),
      urlConfidence: r.url_confidence ?? null,
      seedStatus: r.seed_status ?? "seeded",
      willBreakApp: asBool(r.will_break_app),
      securityIssue: asBool(r.security_issue),
      billIncrease: asBool(r.bill_increase),
      upgradeNeeded: asBool(r.upgrade_needed),
      notes: r.notes || null,
      updatedAt: now,
    };
    const existing = await db.select({ id: schema.announcementSources.id }).from(schema.announcementSources)
      .where(eq(schema.announcementSources.sourceId, r.source_id)).get();
    if (existing) {
      await db.update(schema.announcementSources).set(values).where(eq(schema.announcementSources.id, existing.id));
      updated++;
    } else {
      await db.insert(schema.announcementSources).values({ ...values, sourceId: r.source_id, createdAt: now });
      inserted++;
    }
  }
  console.log(`[announce-import] sources: ${inserted} inserted, ${updated} updated (${rows.length} rows in ${path})`);

  if (mergePricing) {
    let pInserted = 0;
    let pSkipped = 0;
    for (const r of rows) {
      if (r.source_type !== "pricing_page" || !r.source_url) continue;
      const existing = await db.select({ id: schema.pricingTools.id }).from(schema.pricingTools)
        .where(eq(schema.pricingTools.pricingUrl, r.source_url)).get();
      if (existing) { pSkipped++; continue; } // curated tracker row wins — don't overwrite
      await db.insert(schema.pricingTools).values({
        category: r.category ?? null,
        subCategory: r.subcategory ?? null,
        vendor: r.vendor,
        tool: r.product,
        pricingUrl: r.source_url,
        notes: r.notes || "from announcement source seed",
        detectTokens: JSON.stringify(detectTokens(r.vendor, r.product, r.source_url)),
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      pInserted++;
    }
    console.log(`[announce-import] pricing merge: ${pInserted} new pricing tools, ${pSkipped} already tracked`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
