---
obligation: "Harness parity — committed per-harness artifacts must match the canonical sources"
mechanism: gate
status: shipped
lives_in: "scripts/validate_harness_drift.sh"
summary: "Pre-commit harness-drift validator fails when a staged harness artifact (skills/agents/identity/MCP projection) diverges from its canonical source."
---

# Harness drift (FR-135 / TD-021)

When a commit touches harness-related surfaces, the pre-commit harness-drift
validator confirms the committed per-harness artifacts (generated identity files,
projected configs) still match their single canonical sources — the L-519
Igris-owned-topology guarantee. The compile-time companion verifier lives at
`core/scripts/cli-adapters/check_harness_drift.sh`.
