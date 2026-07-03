---
name: Mock at the I/O boundary, not the domain boundary
description: For CLI/handler integration tests, mock fetch/getDb (I/O), not the handler under test — otherwise wiring bugs slip through
type: feedback
---

When writing tests for a CLI or wrapper that orchestrates a domain handler, mock the I/O boundary (network: `globalThis.fetch`; storage: `getDb` returning a real in-memory `better-sqlite3` connection), NOT the handler itself.

**Why:** BR-064 ("no such table: goals") shipped because `brain_push_cli.test.ts` mocked the entire `handleBrainPush` symbol via `vi.mock('../../src/tools/sync.js', ...)`. That stubbed the function under test, so the CLI's wiring to the real DB connection was never exercised. The bug surface (CLI bypassed `bootEngine`, leaving the connection without per-component migrations) lived in the wiring between CLI args and handler I/O — exactly where the mock erased coverage.

**How to apply:** When writing CLI/script integration tests in `brain-mcp-server/scripts/__tests__/`:

- DO mock `db.js` to return a real `:memory:` `better-sqlite3` connection seeded with the schema the test needs.
- DO mock `globalThis.fetch` to capture push payloads / simulate network responses.
- DO mock heavy boot infra like `bootEngine` only as a thin shim that returns `{ shutdown: () => {} }` — but still let the real handler iterate the real DB.
- DO NOT `vi.mock()` the module that exports the handler under test.

The canonical reference pattern is `scripts/__tests__/perception_extract_cli.test.ts` (lines 41-44 + 80-onward): mocks `getDb` to point at a hand-built in-memory DB, runs the real domain logic against it. `brain_push_cli.test.ts` was rewritten to follow the same pattern as part of the BR-064 fix.

If you find yourself writing `vi.mock('../../src/tools/foo.js', () => ({ handleFoo: vi.fn() }))` in a CLI test for a script that calls `handleFoo`, stop — the test will not catch wiring bugs in the CLI itself.
