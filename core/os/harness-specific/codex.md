---
harness: codex
delegation_model: native-static
summary: Codex uses native static agents; an available desktop browser panel can show the verified session-attention URL.
---

# Codex — harness-specific

Delegate through the native agent mechanism exposed by this Codex session.

After `/boot` returns an available session-attention URL, inspect the exposed
capabilities. When `mcp__codex_app__open_in_codex` is available, call it with
`target: {type: "browser", url: <verified-url>}` to show the map beside this chat.
If the tool is unavailable (for example a CLI-only harness), keep the clickable
link. Do not guess UI support, a thread ID, or a native chat identity.

Only pass `--harness-session-id` when the current chat identity is explicitly
provided by the harness. A project path, process ID or another chat's ID does
not establish identity. This adapter does not claim to observe hidden compaction.
