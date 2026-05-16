---
name: replen-project-init
description: Produce a CLAUDE.md for the current repo that's optimised for replen's relevance scorer. Reads the source + existing docs to draft an accurate, project-specific CLAUDE.md following the template at https://docs.replen.dev/project-docs.html. Run with `/replen-project-init` or by saying "draft a CLAUDE.md for replen".
---

# Replen Project Init

Bootstrap a `CLAUDE.md` for the user's repo, formatted so that replen's relevance scorer can use it well. The user runs this once per project, ideally when they first sign up for replen and don't have CLAUDE.md files yet.

**The fact that you're running locally with full source access is the point.** Replen's hosted scorer can't read source code; you can. So the quality of the CLAUDE.md you produce is the difference between getting useful daily matches and getting noise.

## Protocol

### 1. Read the repo

Walk the project structure to build a real understanding before drafting:

- Top-level file tree (don't recurse into `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `__pycache__`).
- Existing `README.md`, `CLAUDE.md` (if it already exists — read it; respect existing intent), `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` (whichever is present).
- Major directory READMEs if they exist (`src/README.md`, `docs/README.md`).
- 3-5 of the largest source files in the entry-point area (e.g. `src/index.*`, `app/page.*`, `main.*`) to understand the actual code shape, not just declared deps.
- Recent git log: `git log --oneline -20` to spot active areas.

Do not read secrets, env files, lock files (other than to spot dep versions), or test fixtures.

### 2. Map the project to the seven template sections

Fill each section concretely. Generic = useless to replen's scorer. Use the user's domain vocabulary, not abstractions.

| Section | Source signal |
|---|---|
| **What this project is** | One sentence. Synthesise from README + entry-point code. If the README is generic, derive from what the code actually does. |
| **Stack** | Languages + framework versions from manifest. Runtime from any deploy config (Dockerfile, fly.toml, vercel.json, etc.). Be specific: "Next.js 16 (App Router, server components)" not just "Next.js". |
| **Niche / problem domain** | 2-3 sentences. Read the README + any docs/ to figure out the domain (CV, dev-tools, fintech, infra, etc.). Use domain vocabulary the user's industry uses (replen matches against trending repos in their niche). |
| **Active areas** | Look at the last 30-50 commits. Cluster by file/dir. The top 2-3 areas are "active." Write 1 line each in present tense. |
| **Constraints & non-goals** | Read configs and the existing CLAUDE.md (if any). Look for "no X" patterns. Examples: air-gapped from public internet → no outbound HTTP; managed-RDS Postgres → no extensions; Node-only fleet → no JVM deps. If none are obvious from configs, ask the user. |
| **Anti-patterns** | Patterns of OSS the project would skip. Derive from the constraints. E.g. heavy framework + air-gapped network → "no kitchen-sink frameworks with network init in dep tree". |
| **Integration preferences** | Look at how recent libraries were adopted. Are new deps feature-flagged? Pinned exactly or with ranges? Tested before merge? Express the team's actual habit. |

### 3. Draft the file

Write to `CLAUDE.md` at the repo root using exactly the section headings from the template at https://docs.replen.dev/project-docs.html. Keep total length 200-500 words. Bullet points over paragraphs.

Do NOT:
- Make up constraints you can't verify from the code or git history (better to leave a section short than wrong).
- Copy boilerplate from the template's placeholders.
- Include any secret or token, even masked.

### 4. Show the user

Print the drafted file in chat and ask:
> "Drafted `CLAUDE.md`. Anything you'd change before I write it to the repo? In particular check the **Constraints** section — that's where I'm most likely to be wrong."

Iterate on edits. When the user signs off, write the file to `CLAUDE.md` (don't overwrite an existing one without confirming).

### 5. Suggest the next step

```
Done. Two next steps:
1. Commit + push: `git add CLAUDE.md && git commit -m "Add CLAUDE.md for replen"`
2. Trigger a fresh replen pipeline run from /runs so it picks up the new docs immediately.
```

## When NOT to run this skill

- The repo already has a thorough `CLAUDE.md` (>200 words, covers most template sections). Suggest the user run `/replen-triage` instead and skip this.
- The user wants help with a specific bug or feature — direct them away; this skill is documentation-only.
- The repo has no source code (empty or docs-only) — explain that replen needs at least some code shape to extract niche information.

## Source of truth

The template + rationale lives at https://docs.replen.dev/project-docs.html. If the user asks "why this format?" point them there.
