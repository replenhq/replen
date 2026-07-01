---
description: List replen MCP commands and pick one to run
---

Show the user every replen MCP tool available in this session. Call `replen_help` and render its grouped output verbatim as the menu; it returns the canonical, up-to-date list (Brainstem, Atlas, Onboarding, plus `replen_help`), so don't hardcode a tool list here. Then offer the common flows:

```
Common flows:
  • "triage today"             → /replen
  • "what's fresh?"            → replen_match, then triage the candidates in-session
  • "is X worth integrating"   → replen_match, then triage that candidate in-session
  • "what are my blind spots?" → replen_cart({ cart: 'blind-spots' })

What do you want to do?
```

If the user picks a number or names a tool, run it. If they ask a question that maps cleanly to one tool, just run that tool. Don't pad the menu with extra prose.
