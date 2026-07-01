---
name: search
tier: essential
description: "Search the brain's learnings with hybrid BM25+vector recall - filter by project or global, show ranked results (ID/title/snippet/score), and pull a learning into context. Usage: /search <query> [--project <slug> | --global] [--pull <id>] [--limit <N>]"
disable-model-invocation: false
allowed-tools:
  - Read
  - mcp__igris-brain__igris_memory_hybrid_search
  - mcp__igris-brain__igris_memory_get
triggers:
  - "SEARCH"
  - "search the brain"
  - "search learnings"
  - "find a learning"
  - "recall about"
---

# SEARCH — Universal Brain Search

The interactive recall interface over the brain's learnings. Runs the existing
`igris_memory_hybrid_search` (RRF-fused BM25 + vector) read tool, presents ranked
results, and pulls a chosen learning's full content into the session with `--pull`.

This skill only calls the two MCP tools and formats their output — it does NOT
re-implement ranking, weighting, or the BM25-only fallback (the tool owns all of
that). It contains zero harness-specific branches.

## Arguments

`$ARGUMENTS` = **`<query> [--project <slug> | --global] [--pull <id>] [--limit <N>]`**

Parse as follows:

1. **Free-text tokens** (everything that is not a flag or a flag value) → the
   search `query`.
2. `--project <slug>` → scope the search to that project (`project: <slug>`).
3. `--global` → search everything; omit the `project` param entirely (broadest
   scope). Mutually exclusive with `--project` — if both are given, prefer
   `--global` and note it.
4. **Neither flag** → default to the **current project slug** (the most useful
   default). Always print the resolved scope, and hint that `--global` widens.
5. `--pull <id>` → skip the search entirely and go straight to the fetch path
   (§3). If a `query` is also present, `--pull` still wins.
6. `--limit <N>` → pass through to `hybrid_search.limit` (tool default 10).

## Degradation (applies to every brain call)

If the `igris-brain` MCP server is unavailable, do **not** block. Warn ONCE:
`Note: brain MCP unavailable — learnings can't be searched this run. Re-run /search when the brain is reachable.`
Then stop gracefully. Never error, never block, never emit a stack trace — same
convention as `/reuse`, `/scan`, and `/boot`.

## 1. Search

Call the hybrid search tool with the parsed query and scope:

```
igris_memory_hybrid_search({ query: "<query>", project: <slug or omitted>, limit: <N or omit> })
```

Accept the tool defaults — do NOT pass `bm25_weight` / `vector_weight` / `rrf_k`
unless the operator explicitly asked to tune them. The tool returns RRF-fused
ranked rows, excludes `pending_review` rows (conscious channel only), and falls
back to BM25-only internally when sqlite-vec / embedding is unavailable.

## 2. Present results

Render a compact table from the tool output plus a scope line:

```
Scope: project `igris-ai`   (or "Scope: global")

| ID  | Title                                   | Snippet                          | Score |
|-----|-----------------------------------------|----------------------------------|-------|
| 142 | Two-DB drift (fixed in FR-120)          | Pre-FR-120 MCP was http→VPS...   | 0.031 |
| 389 | Tree-aware vendor preserves nesting     | <doc pointer: coding_guidelines> | 0.028 |

Pull full content with /search --pull <id>.
```

- For rows the tool flagged as **promoted-to-doc** (FR-200 M2), surface the doc
  pointer the tool returned as-is — do NOT fabricate a snippet.
- **No results** → say so plainly and suggest widening with `--global` or a
  looser query. Never error.

## 3. Pull a learning (`--pull <id>`)

Fetch one learning's full content into the session so it becomes working context:

```
igris_memory_get({ id: <id> })
```

Print the full learning — title, category, scope, content, tags, source_brief,
confidence — so it lands in the session as working context. If the id does not
resolve, say so plainly and offer to re-run the search.

## 4. Summary hint

After a search, remind the operator of the two follow-up moves:
- `/search --pull <id>` to read a full learning.
- `/search <query> --global` to widen scope when a project-scoped search is thin.

---

## Constraints

1. **Read-only** — `/search` never stores, updates, or deletes a learning. It
   only reads via `igris_memory_hybrid_search` and `igris_memory_get`.
2. **Don't re-rank** — accept the tool's RRF ordering and defaults; never
   reimplement weighting or the BM25 fallback in the skill.
3. **Explicit scope** — always print the resolved `Scope:` line so the operator
   knows whether results are project-scoped or global.
4. **Graceful degradation** — brain absent → warn once, stop, never block.
5. **Harness-agnostic** — zero harness-specific branches; the body only calls
   the two MCP tools and formats their harness-agnostic output.
