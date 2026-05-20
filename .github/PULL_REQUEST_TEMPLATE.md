<!--
Thanks for the contribution! A few asks before you submit:

1. For non-trivial changes, please open an issue first (see CONTRIBUTING.md).
2. Keep PRs focused — one logical change per PR is much easier to review.
3. Do NOT add AI/Claude/Codex/Copilot attribution to the description, commit
   messages, or file content (see CONTRIBUTING.md).
-->

## What changed

<!-- One or two sentences. The diff shows the *what*; lead with the *why*. -->

## Why

<!-- What problem does this solve, or what would now be possible that wasn't before? -->

## Test plan

<!-- What did you do to convince yourself this works? Manual steps are fine for now; this repo doesn't have a formal test suite yet. -->

- [ ]
- [ ]

## Checklist

- [ ] `npm run lint` passes (currently `tsc --noEmit`).
- [ ] No secrets in the diff (PATs, LLM keys, encryption keys, `.env` content).
- [ ] No AI attribution in commits, PR body, or file content.
- [ ] If this changes user-facing behaviour, docs at <https://docs.replen.dev> have been updated or an issue tracking the doc update has been opened.
- [ ] If this changes the DB schema, a migration is included in `src/db/migrations/`.
