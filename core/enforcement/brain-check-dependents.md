---
obligation: "Check-dependents — inspect graph neighbors before a refactor"
mechanism: honor-system
status: honor-system
lives_in: "core/os/memory.md (decision triggers)"
summary: "Brain obligation #6. No gate enforces it; the model checks the knowledge-graph dependents of what it is about to change before refactoring."
---

# Brain obligation #6 — Check-dependents

Before a refactor, check the graph neighbors (dependents) of what you are about to
change so a downstream consumer is not silently broken. Honor-system reach — the
same call-site-sweep discipline the consumer-sweep gate enforces mechanically for
mapped contracts.
