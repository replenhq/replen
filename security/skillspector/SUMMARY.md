# Replen skills — NVIDIA SkillSpector security scan

**Scanner:** [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector) v2.2.3 —
16 threat categories / 64 patterns (prompt injection, data exfiltration, privilege
escalation, supply-chain, excessive agency, system-prompt leakage, tool misuse,
trigger abuse, dangerous code, MCP least-privilege, …) + live OSV.dev dependency
lookups. Static analysis.
**Scanned:** 2026-06-22. Per-skill reports alongside this file.

## Result — all skills SAFE

| Skill | Score | Severity | Recommendation | Executable scripts | Dep vulns |
|---|---|---|---|---|---|
| `replen` | 20/100 | LOW | **SAFE** | None | None |
| `replen-triage` | 0/100 | LOW | **SAFE** | None | None |
| `replen-project-init` | 0/100 | LOW | **SAFE** | None | None |
| `replen-onboard` | 0/100 | LOW | **SAFE** | None | None |

No high or critical findings. No executable scripts in any skill. No vulnerable
dependencies.

## The two LOW/MEDIUM flags on `replen` — both reviewed, both benign

1. **"Session persistence" (RA2, SKILL.md:11)** — false positive. The heuristic
   matched the phrase *"running the matching loop locally"*. There is no persistence
   mechanism — no cron, no startup script, no state file. It's descriptive prose.

2. **"External transmission" (E1, SKILL.md:227)** — expected by design. The flagged
   `curl POST /api/state` is the documented call to the user's **own** Replen server,
   token-authenticated, sending only **repo name + status + projectId**. It never
   transmits source code, secrets, or PII — consistent with Replen's core constraint
   that *source code never leaves the user's machine*.

## Why this matters

Replen's whole model runs the expensive reasoning **in the user's own agent session**
— the skills are the in-session playbooks. An independent third-party scanner that
knows nothing of Replen's design rating every skill **SAFE** (with the only flags
being a keyword false-positive and the documented, no-code status API) is strong
external evidence the skills are clean.

## Reproduce

```bash
git clone https://github.com/NVIDIA/SkillSpector.git && cd SkillSpector
uv venv .venv && source .venv/bin/activate && uv sync
uv run skillspector scan <path-to-skill>
```
