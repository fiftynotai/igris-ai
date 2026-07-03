---
name: Brief Test Count Audit
description: Always verify per-test claims in forger's status messages by reading test files directly — overall test counts may be correct while breakdowns can be misreported.
type: feedback
---

When a brief reports something like "+6 tests (5 sync + 1 perception)", verify each claim independently. The total may be correct but the breakdown can be misreported.

**Why:** During FR-109 round-2 review, brief claimed "+1 perception integration regression for source_extractor" asserting "rule row has source_extractor='rule:learned_marker', LLM row has source_extractor='llm', source_extractor UNCHANGED across approval". On reading runner.test.ts and handlers.test.ts directly, no such test was found. The 5 sync tests existed as claimed; the +1 perception test did not. Existing tests cover source_extractor only indirectly via `result.by_source` (in-memory candidate field, not the persisted column).

**How to apply:** When reviewing a fix that lists specific test additions:
1. Open each named test file
2. Search for the asserted behavior (e.g., grep for `source_extractor` assertions reading from DB rows)
3. If the test isn't there, flag it as a finding — but consider severity: if existing coverage is sufficient via other paths, treat as minor follow-up TD; if the gap leaves the regression risk uncovered, treat as major.
