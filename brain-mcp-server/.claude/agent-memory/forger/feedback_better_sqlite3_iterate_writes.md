---
name: better-sqlite3 iterate vs writes
description: better-sqlite3 prepare().iterate() blocks the connection — use .all() if the loop body writes
type: feedback
---

When a script reads with `db.prepare(SELECT).iterate()` and the loop body
writes back to the same DB (e.g. via `handleEdgeCreate` -> INSERT), the
iterator holds the connection open and any write throws
`TypeError: This database connection is busy executing a query`.

**Why:** better-sqlite3 is synchronous and single-connection; iterators
keep the prepared statement live until exhausted. INSERTs inside the loop
share the same connection, hence the conflict.

**How to apply:** for one-shot CLI scripts where the read set is bounded
(thousands of rows, not millions), prefer `stmt.all(...)` and iterate the
materialized array. The memory cost is negligible compared to the
correctness win. `.iterate()` is only safe when the loop body is
read-only or operates on a separate connection. Surfaced during TD-057
backfill_brief_edges implementation.
