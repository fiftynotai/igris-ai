# Brain MCP Server

This file is intentionally a pointer, not the source of truth.

The brain's codebase context — the tool-registration contract (component
`tools()` factories composed by `bootEngine()`), the strict-input contract
(`additionalProperties: false` gateway enforcement), the dual-transport gateway
choke point, forbidden patterns, and test invariants — lives in the Igris
context system so every harness sees it, not just Claude Code.

See the **Brain Engine — Tool Registration & Strict-Input Contract** section of
the project `architecture_map` context doc, loaded harness-agnostically via
`/boot` (migrated by TD-263). Do not re-grow the contract here — a nested
`CLAUDE.md` is read only by Claude Code, so content added here is invisible to
Codex / Gemini / OpenCode / Antigravity agents working in this directory.
