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

type Row = { category: string; subCategory: string; vendor: string; tool: string; pricingUrl: string; notes: string | null };

// Words too generic to identify a tool in a user's deps/tags.
const GENERIC = new Set([
  "pricing", "hub", "page", "cloud", "platform", "api", "apis", "developer", "developers",
  "tools", "tool", "service", "services", "suite", "app", "apps", "data", "web", "labs",
  "inc", "the", "and", "for", "pro", "plus", "studio", "stack", "open", "source",
  "manager", "management", "security", "analytics", "storage", "hosting", "search",
  "email", "payments", "billing", "amazon", "google", "microsoft", "core", "edge",
]);

// Vendor-level aliases users actually have in tags/deps.
const ALIASES: Record<string, string[]> = {
  "amazon web services": ["aws"],
  "google cloud": ["gcp", "google-cloud"],
  "microsoft azure": ["azure"],
  "atlassian": ["jira", "bitbucket", "confluence"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

function detectTokens(vendor: string, tool: string): string[] {
  const out = new Set<string>();
  const nv = norm(vendor);
  const nt = norm(tool);
  if (nv) out.add(nv);
  if (nt) out.add(nt);
  for (const w of [...nv.split(" "), ...nt.split(" ")]) {
    if (w.length >= 3 && !GENERIC.has(w)) out.add(w);
  }
  for (const a of ALIASES[nv] ?? []) out.add(a);
  return [...out];
}

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
