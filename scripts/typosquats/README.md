# Typosquat placeholders

These are 0.0.0 placeholder packages for npm slot-claiming. Each one logs
a one-line redirect to the canonical package and exits non-zero.

Slots to claim (each gets one directory below):

- `replen-cli`     → canonical: `replen`
- `replen-mcp`     → canonical: `@replen/mcp`
- `@replen/cli`    → canonical: `replen`
- `@replenhq/mcp`  → canonical: `@replen/mcp` (defensive — we own `replenhq`
  on GitHub but not on npm)

## Publish + deprecate

For each slot, from the package directory:

```bash
npm publish --access public
npm deprecate <name>@0.0.0 "Renamed: install the canonical package — see homepage."
```

Re-run on every canonical version bump to keep the homepage URL fresh.

## Why placeholders instead of unpublished

npm allows anyone to register an unused name. A squatter publishing
`replen-cli` could ship arbitrary install scripts — and since the canonical
docs and README repeatedly reference the string "replen MCP" / `npx replen`
/ etc., this is the highest-conviction supply-chain attack vector.

Placeholders pre-register the slot to us, then `npm deprecate` makes it
clear no one should install it.
