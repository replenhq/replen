# Starter seeds

Small, curated seed data for self-hosted installs — enough to make the watch
lenses useful on day one:

- `starter-announcement-sources.json` — the cross-vendor security aggregators
  (NVD, OSV, GitHub Advisories, CISA KEV, …) plus changelog/security/release
  sources for ~20 widely-used vendors. Import with:
  `tsx src/cli/import-announcement-sources.ts seeds/starter-announcement-sources.json`
- `starter-pricing.json` — pricing pages for ~30 well-known dev tools. Import:
  `tsx src/cli/import-pricing-tracker.ts seeds/starter-pricing.json`

Both importers are idempotent (upsert by stable key), and both accept any file
in the same shape — point them at your own curated lists to extend coverage.
The hosted service runs a continuously-maintained catalogue (~1,250 sources,
dead links pruned, new tools added) on top of the same engine.
