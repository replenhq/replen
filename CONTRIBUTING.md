# Contributing to Replen

Thanks for the interest. Replen is a small project run by a single maintainer; PRs are welcome but please read this before you start, especially for non-trivial changes.

## Before you open a PR

- For **small fixes** (typos, dead imports, obvious bugs): just open the PR.
- For **anything larger** (new feature, refactor, new dependency, schema change): open an issue first describing the problem and your proposed approach. This avoids the worst-case where you spend a week on something we'd want to do differently.
- For **security issues**: do not open a public issue or PR. See [SECURITY.md](./SECURITY.md).

## What's in scope

- Bug fixes in any path (`src/`, `cli/`, `mcp/`, scripts).
- Pipeline improvements (fetchers, scoring, prompts) that have a clear motivating example. "I added a new source and it surfaces good repos for projects like X" beats "added a source".
- Self-host ergonomics (deploy scripts, env-var handling, error messages on bad config).
- Documentation. The docs site lives at [replenhq/docs-site](https://github.com/replenhq/docs-site) — most doc PRs go there.

## What's not in scope (without an issue first)

- New LLM provider integrations beyond what's already supported (the primary slot is OpenAI-compatible and that covers most providers — a wire-format toggle on the sensitive slot covers the rest).
- Hosting / billing / multi-tenant infrastructure changes.
- "Replace component X with library Y" PRs where the motivation is taste rather than a concrete benefit.
- Telemetry, analytics, or tracking of any kind.

## Setting up locally

```bash
git clone https://github.com/replenhq/replen.git
cd replen
npm install
cp .env.example .env       # then fill in the values
npm run db:migrate
npm run dev                # http://localhost:3030
```

The full self-host walkthrough is at <https://docs.replen.dev/self-host>.

## Code style

- TypeScript strict; `npm run lint` (currently `tsc --noEmit`) must pass.
- Function declarations over `const foo = async () => ...` (this is the dominant style in the codebase).
- Default exports are reserved for Next.js page/layout entry points. Everything else is a named export.
- No comments that just restate what the code says. A comment that explains *why* — a constraint, an invariant, a workaround for a specific bug — is valuable. Everything else is noise.
- Error messages start lowercase ("invalid matchId", "match not found"), except when they open with an env-var name (`ENCRYPTION_KEY must be 32 bytes`).

## Commit + PR conventions

- Branch off `main`. Keep branches short-lived.
- One logical change per commit. Squash trivial fix-ups before opening the PR.
- Commit messages should explain the *why*, not the *what* — the diff already shows the what.
- PR description should cover: what changed, why, what you tested, and any caveats the reviewer should know.
- **Do not** add AI/Claude/Codex/Copilot attribution to commit messages, PR descriptions, code comments, or any file content. The repo stays clean of AI attribution regardless of how the code was authored.

## Tests

The repo doesn't have a formal test suite yet. For now:

- TypeScript strict + `tsc --noEmit` catches a lot at the type level.
- Pipeline logic is exercised by re-running against a seeded demo user (`scripts/seed-demo.ts`) plus the maintainer's own projects every morning.
- Tests are welcome — Vitest is the planned target — but please discuss the shape (unit vs integration, fixture strategy) in an issue first so we don't end up with three competing patterns.

## What happens after you open the PR

- Reasonable response time is a few days. If you haven't heard anything after a week, ping me in the PR.
- The maintainer reviews and either merges, requests changes, or explains why we'd want to do it differently.
- For non-trivial changes I may rebase / squash to keep the commit graph readable. I'll never change the substance of your work without telling you.

## Questions

If something here is unclear or you're not sure whether your idea fits — open an issue and ask. Better than guessing.
