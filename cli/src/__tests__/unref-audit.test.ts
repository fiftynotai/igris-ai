/**
 * unref-audit.test.ts — BR-117 AC-3: every `unref` in `cli/src` is a reviewed
 * decision with a stated reason.
 *
 * A standalone CLI exits as soon as only unref'd handles remain. BR-117: the
 * poll wait in `lib/sync/code.ts` was an unref'd timer, so `igris sync code`
 * emptied its event loop right after "launched" and exited 0 with the deploy
 * abandoned (no restart, no verify). vitest's worker keeps the loop alive, so
 * no in-process test can see that class; this static gate makes a NEW `unref`
 * fail until it is either dropped or added to `ALLOWED` with its reason. The
 * behavioural pin is the real-process tier in `sync-code-remote.test.ts`
 * (`describe("BR-117 …")`).
 *
 * Scanned: `cli/src/**\/*.ts` outside `__tests__`, for a CODE call `x.unref()`
 * (an identifier or closing bracket right before the dot — the backticked
 * mentions in `brain-write-bridge.ts` prose do not match) and `ref: false`
 * (the `node:timers/promises` form).
 *
 * Out of scope, recorded (BR-117 audit): `brain-mcp-server/src/engine/
 * components/sync/index.ts` `_batchTimer.unref()` — the auto-push batch flush,
 * armed only when `auto_push` is configured. It must never keep a CLI or MCP
 * process that booted the engine alive, and a batch dropped at exit is re-sent
 * by the next push because the push watermark advances only on the remote's
 * acknowledgement (BR-097).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = decodeURIComponent(new URL("../", import.meta.url).pathname);

const UNREF_CALL = /[\w)\]]\.unref\(\)/g;
const REF_FALSE = /\bref:\s*false\b/g;

/** Every allowed site, with WHY it is not a wait a standalone CLI depends on. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "lib/open-url.ts": {
    count: 1,
    reason:
      "child.unref() unrefs the handle of a best-effort browser opener; it is not a wait. `igris dashboard` " +
      "(the long-lived foreground verb) must not be held open by that child after SIGINT.",
  },
  "lib/remote-push.ts": {
    count: 1,
    reason:
      "maxTimer is a 10 s CAP racing an in-flight request, not a wait: the request's own socket " +
      "is ref'd and holds the process while it runs, and the `close` listener clears the cap. " +
      "The unref only stops the cap from holding a finished `igris install` open.",
  },
};

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "node_modules") walk(join(dir, e.name), out);
    } else if (e.name.endsWith(".ts")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

function count(text: string): number {
  return (text.match(UNREF_CALL)?.length ?? 0) + (text.match(REF_FALSE)?.length ?? 0);
}

describe("BR-117 AC-3 — unref audit over cli/src", () => {
  it("the matcher takes a code call and `ref: false`, and leaves backticked prose alone", () => {
    expect(count("const t = setTimeout(r, ms);\n  t.unref();")).toBe(1);
    expect(count("child.unref();")).toBe(1);
    expect(count("spawn(a).unref();")).toBe(1);
    expect(count("await setTimeout(ms, v, { ref: false });")).toBe(1);
    expect(count(" * arm is `sync`'s 10 s batch flush, which is `.unref()`'d")).toBe(0);
    expect(count(" * self-rescheduling `setTimeout` that is **not** `unref()`'d")).toBe(0);
    expect(count("// detached-and-unref'd so a long-lived server")).toBe(0);
  });

  it("every unref in cli/src is on the allowlist, with its reason", () => {
    const files = walk(SRC, []);
    expect(files.length).toBeGreaterThan(50); // the scan really walked the tree
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = count(readFileSync(f, "utf-8"));
      if (n > 0) found[relative(SRC, f)] = n;
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.count]));
    const unlisted = Object.keys(found).filter((f) => found[f] !== expected[f]);
    expect(
      found,
      unlisted
        .map(
          (f) =>
            `a new unref() in ${f} — a standalone CLI exits when only unref'd handles remain (BR-117). ` +
            "Drop it, or add it here with the reason it is not a wait the CLI depends on",
        )
        .join("\n") || "an allowlisted unref() is gone — remove its ALLOWED entry",
    ).toEqual(expected);
  });

  it("every allowlist entry states a reason", () => {
    for (const [f, { reason }] of Object.entries(ALLOWED)) {
      expect(reason.trim().length, `ALLOWED["${f}"] has no reason`).toBeGreaterThan(40);
    }
  });
});
