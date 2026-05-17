---
description: List replen MCP commands and pick one to run
---

Show the user every replen MCP tool available in this session. Call `replen_help` to get the canonical list, then present it as a tidy menu in chat with this layout:

```
Replen commands · pick one:

  1. replen_today       what landed today
  2. replen_search      search past matches
  3. replen_starred     starred + handoff status
  4. replen_analyze     deep-dive one repo
  5. replen_handoff     open a handoff PR
  6. replen_feedback    good / bad / star / unstar / hide
  7. replen_run         trigger a fresh pipeline run
  8. replen_status      live progress of the current run

Common flows:
  • "triage today"          → /replen-triage
  • "what's fresh?"          → replen_run, then replen_status, then replen_today
  • "is X worth integrating" → replen_analyze({ owner, name })

What do you want to do?
```

If the user picks a number or names a tool, run it. If they ask a question that maps cleanly to one tool, just run that tool. Don't pad the menu with extra prose.
