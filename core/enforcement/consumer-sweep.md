---
obligation: "Consumer sweep — re-point every consumer when a mapped contract changes"
mechanism: gate
status: shipped
lives_in: "scripts/check_contract_consumers.sh"
summary: "FR-186 pre-commit checker parses MAINTAINING.md, WARNs on rename/delete of a mapped token, and hard-fails on a stale-map citation (a consumer path that no longer exists)."
---

# Consumer sweep (FR-186)

The FR-186 contract checker is the mechanical layer of the consumer-sweep rule:
it parses `MAINTAINING.md`, scans the staged diff for deletions/renames of mapped
tokens, and surfaces each contract's consumer list. WARN-only on a legitimate
refactor; a stale-map citation (a consumer whose file does not exist) is a
hard-fail. Backed at planning by the architect's `## Consumer Sweep` section and
at review by warden.
