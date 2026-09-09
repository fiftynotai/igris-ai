---
name: frontmatter
description: "Six tools with a non-empty required list, all in allowed-tools only (mixed mcp-prefixed and bare forms)."
allowed-tools:
  - mcp__igris-brain__igris_brief_get
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_brief_update
  - mcp__igris-brain__igris_memory_store
  - mcp__igris-brain__igris_error_lookup
  - igris_agent_event
---

# frontmatter

The body makes no brain call at all. If `allowed-tools` lines were counted as
call sites this file would score six residual sites; it must score zero.

The last entry is written BARE (no `mcp__igris-brain__` prefix) on purpose. The
prefixed form is already refused by the tool-mention lookbehind, so a fixture
using only that form would pass even with the frontmatter exclusion removed —
it would be testing the lookbehind, not the exclusion. The bare form is what
arms this test.
