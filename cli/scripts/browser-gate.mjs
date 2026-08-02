#!/usr/bin/env node
/**
 * FR-240 §3.4 — the REAL-BROWSER behavioural gates, driven over CDP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AS A FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * FR-239 shipped two bugs that 1,612 green tests could not see, and both fell
 * out in minutes under headless Chrome — a canvas that was still BECAUSE IT WAS
 * DEAD (the halt cancelled the library's hit-testing loop, so clicking a node
 * deselected instead of selecting), and a render loop that repainted identical
 * pixels forever while every stillness reading passed. That run was ad-hoc: a
 * scratch script, an operator recipe in `docs/dashboard.md`, and a memory note.
 * Nothing re-runnable survived, so the gate could not be independently re-run by
 * a reviewer — which is the property that makes a gate worth anything.
 *
 * This file is that run, checked in. `docs/dashboard.md` §"The FR-240 browser
 * gate" documents how to invoke it and what each gate does and does NOT prove.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO NEW DEPENDENCY (plan §3.4: "CDP, no new dependency")
 * ─────────────────────────────────────────────────────────────────────────────
 * Node 24 has global `fetch` and global `WebSocket`, so the Chrome DevTools
 * Protocol is drivable directly. There is no puppeteer, no playwright, no `ws`.
 * The one non-builtin thing this file touches is `typescript` — a devDependency
 * the build already uses — and only to TRANSPILE the shared brain fixture
 * (`cli/src/__tests__/dashboard-layers-fixture.ts`) so this harness seeds the
 * SAME rows the vitest suites assert on. A second hand-rolled fixture would
 * drift, and a browser gate reading different rows from the endpoint gate proves
 * nothing about the endpoint gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY GATE HAS A DEMONSTRATED FAILING COUNTERPART (FR-239 learnings 1092-1094)
 * ─────────────────────────────────────────────────────────────────────────────
 * A guard whose only observed output is "pass" is indistinguishable from a
 * broken one. So each gate below carries a `--mutate=<name>` that breaks it ON
 * PURPOSE, and in mutation mode this script INVERTS its own verdict: the run
 * SUCCEEDS only if the named gate actually reports FAIL. A mutation run in which
 * everything still passes is reported as `VACUOUS` and exits non-zero.
 *
 *   node cli/scripts/browser-gate.mjs                      # all gates must pass
 *   node cli/scripts/browser-gate.mjs --mutate=br1-fuse-projects
 *   node cli/scripts/browser-gate.mjs --list-mutations
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BRAIN IS ALWAYS A SANDBOX. NEVER THE OPERATOR'S.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every server this script starts runs with `IGRIS_BRAIN_DIR` pointed at a fresh
 * `mkdtemp` directory (`cli/src/lib/paths.ts#brainDir` is the seam) and `HOME`
 * pointed inside it. There is no code path here that opens
 * `~/.igris/memory/knowledge.db`. That is deliberate and load-bearing: the
 * dashboard tier is read-only, but a harness that pointed at the live brain
 * would still be one typo away from a `VACUUM INTO` over it.
 *
 * SIX WORLDS, because three of the gates are about DISAGREEMENT between them
 * (the count was stale at FOUR from FR-241 until FR-244 recounted it against
 * `main()`'s own list, which is the only place that cannot drift):
 *   seeded  — the shared fixture. Rows in every layer.
 *   vec     — the fixture PLUS a `learnings_vec` index, so hybrid recall runs.
 *   empty   — the fixture's schema with every row deleted. `empty` empty-state.
 *   missing — no `knowledge.db` at all. `degraded` empty-state.
 * A single-world gate cannot tell "the empty state renders" from "the empty
 * state always renders", which is exactly the vacuity learning 1092 describes.
 *
 * @module scripts/browser-gate
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..");
const CLI_ENTRY = join(CLI_ROOT, "dist", "index.js");
const FIXTURE_TS = join(CLI_ROOT, "src", "__tests__", "dashboard-layers-fixture.ts");

const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Mutations, each naming the gate it breaks and HOW.
 *
 * The `how` string is printed in the run header, so the recorded output of a
 * mutation run states the injected defect rather than leaving a reader to infer
 * it from a diff.
 */
const MUTATIONS = {
  "br1-fuse-projects": {
    gate: "G-BR-1d",
    how: "assert the two BR-001 detail titles are EQUAL — the exact BR-078 fusion signature",
  },
  "br2-skip-click": {
    gate: "G-BR-2a",
    how: "assert the FILTERED row count without ever clicking the filter chip",
  },
  "br3-empty-on-seeded": {
    gate: "G-BR-3a",
    how: "look for the degraded empty-state in the SEEDED world, where there is data",
  },
  "br4-same-palette": {
    gate: "G-BR-4d",
    how: "read the `blood` palette four times and assert the four readings differ",
  },
  "br4-measure-motion": {
    gate: "G-BR-4a",
    how: "take the first at-rest reading on the GRAPH — a surface known to move — so both `awaitQuiet` and the rAF window must report it",
  },
  "br5-absent-text": {
    gate: "G-BR-5a",
    how: "assert a sentence that is not in the fixture brief body",
  },
  "br6-no-emulation": {
    gate: "G-BR-6a",
    how: "assert reduced-motion WITHOUT setting the emulated media feature",
  },
  "br7-refetch-backout": {
    gate: "G-BR-7b",
    how: "REFRESH during the back-out, so the whole-brain payload is paid for twice — the exact defect the graphCache hoist exists to prevent",
  },
  // --- FR-241 -------------------------------------------------------------
  "br8-cancel-is-a-confirm": {
    gate: "G-BR-8c",
    how: "click CONFIRM where the gate clicks CANCEL — so a dialog that mutated on dismissal is what the 'no request, no row change' check now sees",
  },
  "br8-count-from-selection": {
    gate: "G-BR-8d",
    how: "assert the confirm dialog's hard-delete count equals the SELECTION SIZE rather than the tier-3 subset — the blanket-'irreversible' lie L-140 would have produced",
  },
  "br8-bulk-on-empty": {
    gate: "G-BR-8e",
    how: "run the bulk action with NOTHING selected and assert it succeeded — this brief's named vacuous gate (a bulk on zero items), driven on purpose",
  },
  "br8-write-affordance-when-down": {
    gate: "G-BR-8f",
    how: "assert the write buttons are PRESENT in the world whose write surface is unavailable — the 'disabled, not broken' claim, inverted",
  },
  // --- BR-082 -------------------------------------------------------------
  "br9-rescope-during-window": {
    gate: "G-BR-9c",
    how: "re-select the project INSIDE the two-beat window — the end state the FR-240 ladder defect produced (the chip re-checks itself and the counts fall back), so the LATE reading is the only thing that can catch it",
  },
  "br9-count-from-scoped": {
    gate: "G-BR-9b",
    how: "assert the CLEARED Overview's brief count equals the SCOPED endpoint total — a page that ignored the clear entirely would satisfy this",
  },
  // --- TD-326 -------------------------------------------------------------
  "br10-count-from-unscoped": {
    gate: "G-BR-10a",
    how: "assert the scoped page's BRAIN-LEVEL banner count equals the ALL-PROJECTS total — the number a 'just re-banner the unscoped total' implementation would print, and the one that makes the hidden population look bigger than it is",
  },
  "br10-rescope-during-window": {
    gate: "G-BR-10c",
    how: "re-select the project INSIDE the two-beat window — the end state the default-project ladder produces for a scope value it does not recognise, which is exactly what `(brain-level)` is",
  },
  "br10-bulk-spans-projects": {
    gate: "G-BR-10d",
    how: "assert the brain-level bulk ALSO emptied the project's queue — D5 inverted, and the shape a scope that silently widened to every project would produce",
  },
  "br7-backout-re-entrances": {
    gate: "G-BR-7d",
    how: "take the BACK-OUT arm's ink reading from the cold REFRESH transition — a real, measured re-entrance on the same canvas in the same run, which is exactly what a back-out that lost its position seed would look like",
  },
  // --- FR-244 -------------------------------------------------------------
  "br11-measure-at-blob-zoom": {
    gate: "G-BR-11a",
    how: "take the separability reading at the EXTREME zoom-out instead of at the measured operator zoom — a `k` at which the layout spans ~32px and the component count falls to ~45% of its FIT value, well under 11a's 60% floor. The mirror of br4-measure-motion. (It bites on the RATIO, not on total fusion: 11b's note records that the fixed size law still resolves 162 components down there, which is why this `how` no longer claims nothing can be separable.)",
  },
  "br11-control-at-extreme-zoom": {
    gate: "G-BR-11b",
    how: "take the negative control's reading at the extreme zoom-out instead of at FIT — the size law has PRESERVED the separation there, so the known linked-pair fusion the control exists to detect is no longer present to be detected",
  },
  "br11-fullheight-at-stacked-breakpoint": {
    gate: "G-BR-11c",
    how: "emulate a viewport below the 1100px stacked breakpoint — where the canvas legitimately does NOT own the column — and assert the full-column claim anyway",
  },
  "br11-banner-swallows-pointer": {
    gate: "G-BR-11d",
    how: "restore `pointer-events: auto` on the DENSITY banner overlay — the exact defect FR-244 shipped in review, where an opaque out-of-flow strip over the canvas ate every hover, click and wheel that landed on it",
  },
  // --- FR-245 -------------------------------------------------------------
  "br12-hand-listed-columns": {
    gate: "G-BR-12a",
    how: "render only the three lifecycle statuses Ready/In Progress/Done — a HAND-LISTED column set, this brief's named failure, driven on purpose. `Pending` (a real seeded status that is NOT in the documented vocabulary) and the sentence-status column vanish, so the union check goes red AND the column sum falls short of `/api/summary`'s total",
  },
  "br12-untruncated-header": {
    gate: "G-BR-12c",
    how: "put the RAW status in the column header instead of `columnLabel`'s truncation — the sentence status overflows its fixed-width column, which is why the truncation is a pure function rather than a CSS ellipsis nobody can measure",
  },
  "br12-view-in-component-state": {
    gate: "G-BR-12d",
    how: "drop the persisted view the instant it is chosen — i.e. hold it in `useState` only. The round trip through `#/graph` unmounts the page and the board is gone, which is D4's rejection of component state made observable rather than argued",
  },
  "br12-view-in-localstorage": {
    gate: "G-BR-12d-session",
    how: "persist the toggle in `localStorage` instead of `sessionStorage` — the OTHER way D4 can be got wrong, and the one `br12-view-in-component-state` cannot reach: that mutation reddens only 12d-nav, so without this one 12d-session's whole subject (a preference that outlives the session) had no demonstrated failing counterpart and was guarded only by a file-level string scan an alias would walk past. Injected as a document-start bridge that seeds `sessionStorage` from `localStorage`, which is what a localStorage-backed implementation looks like from outside: the NEW browsing context opens on BOARD",
  },
  "br12-handoff-is-a-plain-toggle": {
    gate: "G-BR-12g",
    how: "reach the list with the VIEW CHIP instead of the column's OPEN IN LIST control — i.e. a handoff that switches the arrangement and drops the status. The list then shows every brief in scope rather than that column's rows, which is D2's reachability claim (every brief is at most two clicks away) failing in the one place it is load-bearing: the columns that are capped",
  },
  "br12-board-drops-filters": {
    gate: "G-BR-12e",
    how: "build every per-column query from `{project, status}` alone, stripping the other filters on the way to the wire — so the column totals stay at their UNFILTERED values while the endpoint's own answer for the same (status, priority) pair moves",
  },
  "br12-drag-affordance": {
    gate: "G-BR-12f",
    how: "mark every board card `draggable` — the DOM half of the read-only claim, inverted. `status` is the canonical build-state source (TD-311), so a drag-to-change-status board is a write path into it wearing a convenience",
  },
  "br12-post-from-board": {
    gate: "G-BR-12f",
    how: "fire ONE POST from the board page — the counter half of the read-only claim, inverted. Without this mutation 'zero non-GET requests' is satisfied by a page with no write code, which is the vacuous gate this whole file exists to prevent",
  },
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--list-mutations")) {
  for (const [name, m] of Object.entries(MUTATIONS)) {
    process.stdout.write(`${name.padEnd(22)} ${m.gate.padEnd(9)} ${m.how}\n`);
  }
  process.exit(0);
}
const mutateArg = args.find((a) => a.startsWith("--mutate="));
const MUTATE = mutateArg === undefined ? null : mutateArg.slice("--mutate=".length);
if (MUTATE !== null && !(MUTATE in MUTATIONS)) {
  process.stderr.write(`unknown mutation: ${MUTATE}\n--list-mutations to see them\n`);
  process.exit(2);
}
const KEEP = args.includes("--keep");
/** True when the named mutation is active. Gates branch on this, nothing else. */
const mut = (name) => MUTATE === name;

/**
 * `--gates=11,4` — run ONLY the named gates. A DEVELOPMENT AID, and it is
 * fenced so it can never be mistaken for a full run.
 *
 * The gate ladder takes minutes and G-BR-11 runs last, so iterating on a new
 * gate meant paying for ten unrelated ones every time. What makes this safe
 * rather than a hole in the harness: a filtered run STAMPS ITS OWN VERDICT
 * LINE with `FILTERED` and the list of gates that did not run, so a filtered
 * transcript cannot be quoted as evidence of a green ladder. The evidence a
 * brief reports is always an unfiltered run.
 */
const gatesArg = args.find((a) => a.startsWith("--gates="));
const ONLY_GATES =
  gatesArg === undefined
    ? null
    : new Set(
        gatesArg
          .slice("--gates=".length)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
const gateEnabled = (id) => ONLY_GATES === null || ONLY_GATES.has(id.replace(/^G-BR-/, ""));

// ---------------------------------------------------------------------------
// Verdict ledger
// ---------------------------------------------------------------------------

const results = [];
let currentGate = "";

function gate(id, title) {
  currentGate = id;
  process.stdout.write(`\n${id}  ${title}\n`);
}

/**
 * Record one check.
 *
 * `detail` is ALWAYS printed, pass or fail. A gate that prints only "PASS"
 * hides the reading that produced it, and a reader cannot tell a real
 * measurement from a hard-coded `true` (learning 1094).
 */
function check(id, ok, detail) {
  results.push({ gate: currentGate, id, ok: ok === true });
  process.stdout.write(
    `  ${ok === true ? "PASS" : "FAIL"}  ${id.padEnd(9)} ${detail}\n`,
  );
}

/** A note that is not a verdict — a measurement, or a stated limit. */
function note(text) {
  process.stdout.write(`  ....            ${text}\n`);
}

/**
 * Record one check as NOT RUN, with a named reason.
 *
 * A skip is NOT a pass. It is kept in its own ledger, printed in the summary, and
 * a run with skips says so in the verdict line — so "green" can never be read as
 * "everything was exercised". There is deliberately no silent-skip path: the
 * only way a check is omitted is through this function, which demands a reason
 * (the F4 failure mode was a gate that quietly fetched 90 MB from the network
 * rather than either skipping loudly or refusing to reach it).
 */
const skipped = [];
/** Gates excluded by `--gates=`. Named in the verdict line, never silent. */
const notRun = [];
function skip(id, reason) {
  skipped.push({ gate: currentGate, id, reason });
  process.stdout.write(`  SKIP  ${id.padEnd(9)} NOT RUN — ${reason}\n`);
}

/** Run one gate; a throw becomes a recorded failure rather than a lost ledger. */
async function runGate(id, fn) {
  if (!gateEnabled(id)) {
    notRun.push(id);
    return;
  }
  try {
    await fn();
  } catch (err) {
    currentGate = id;
    check("threw", false, `${id} aborted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Sandbox construction
// ---------------------------------------------------------------------------

/**
 * Transpile the shared fixture once; return its ESM source text.
 *
 * `createRequire` rather than `import`, because `typescript` is CJS and this is
 * the only non-builtin module the harness touches. Memoised: `transpileModule`
 * runs four times otherwise, once per world.
 */
let cachedFixtureSource = null;
function fixtureSource() {
  if (cachedFixtureSource !== null) return cachedFixtureSource;
  const ts = createRequire(import.meta.url)("typescript");
  const src = readFileSync(FIXTURE_TS, "utf-8");
  cachedFixtureSource = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return cachedFixtureSource;
}

/**
 * Run a node snippet with the transpiled fixture in scope, from `cli/` so bare
 * specifiers (`better-sqlite3`) resolve against the repo's installed tree.
 *
 * `--input-type=module -e` rather than a written temp file: a temp file outside
 * the repo cannot resolve `better-sqlite3`, and a temp file INSIDE `cli/dist`
 * would land in `package.json` `files` and change the packed-size measurement
 * this brief is gated on.
 */
function runSeedScript(body, env) {
  const code = `${fixtureSource()}\n${body}\n`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Two catalog entries, chosen so ONE applies to the fixture project and one does not. */
function seedCatalog(brain) {
  const dir = join(brain, "core", "context-doc-types");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INDEX.md"), "# Catalog index — skipped by readCatalogDocs\n");
  const entry = (type, applies, summary) =>
    [
      "---",
      `type: ${type}`,
      `target: ${type}.md`,
      `applies_when: ${applies}`,
      "optional: false",
      `summary: ${summary}`,
      "---",
      "",
      "Body of the catalog entry.",
    ].join("\n");
  writeFileSync(
    join(dir, "coding_guidelines.md"),
    entry("coding_guidelines", "writing or reviewing code", "Code conventions and naming rules"),
  );
  writeFileSync(
    join(dir, "architecture_map.md"),
    entry("architecture_map", "working across module boundaries", "How the system fits together"),
  );
}

/** The one project context doc the ContextDocs layer reads in G-BR-5c. */
const DOC_BODY = [
  "# Demo guidelines",
  "",
  "The browser must be able to READ this sentence, not merely receive it.",
  "",
  "- one",
  "- two",
].join("\n");

/**
 * HERMETIC BY CONSTRUCTION — the harness must never reach the HuggingFace Hub.
 *
 * Any `/api/learnings/search` whose handle HAS `sqlite-vec` makes the reader ask
 * for a query embedding, and transformers.js v3 caches PACKAGE-LOCALLY — inside
 * `cli/dist/brain-mcp-server/node_modules/@huggingface/transformers/.cache/`,
 * which `scripts/copy-templates.sh` `rm -rf`s on every build. So on a freshly
 * built tree there is no cache, and an unguarded run FETCHES ~90 MB from the
 * network. That happened: the FR-240 sentinel run downloaded the model while
 * G-BR-3f asserted `mode === "hybrid"` with no precondition and no skip path,
 * which is a gate that passes because of a side effect it never declared.
 *
 * `dashboard-learnings-search.test.ts` had already solved this for vitest with
 * `env.allowRemoteModels = false` plus a read-back that the flag STUCK. This is
 * the same guard for a CHILD PROCESS: a `--import` preload sets the flag before
 * `dist/index.js` runs, and writes a RECEIPT so the gate can assert the arming
 * instead of assuming it (learning 1094 — a guard whose only observed outcome is
 * "pass" is indistinguishable from one that never ran).
 *
 * Local loading stays enabled, so a warm cache is still used when one is present.
 * The no-cache path is not a fiction: it is the production state of an offline
 * host or a fresh install, which must degrade to a REPORTED `bm25_only`.
 */
const TRANSFORMERS_ENTRY = join(
  CLI_ROOT,
  "dist",
  "brain-mcp-server",
  "node_modules",
  "@huggingface",
  "transformers",
  // `package.json` `exports.node.import.default` for v3.x — the exact file the
  // vendored `embeddings.js` resolves to, so the ESM registry hands both the
  // same module object. Here, unlike in vitest, a DIRECTORY import really does
  // throw ERR_UNSUPPORTED_DIR_IMPORT: this preload runs under plain Node ESM
  // with no bundler resolver in front of it.
  "dist",
  "transformers.node.mjs",
);

function writeHermeticPreload(brain) {
  const receipt = join(brain, "hermetic.json");
  const file = join(brain, "no-remote-models.mjs");
  writeFileSync(
    file,
    [
      'import { writeFileSync } from "node:fs";',
      `const receipt = ${JSON.stringify(receipt)};`,
      "let armed = false;",
      'let reason = "not attempted";',
      "try {",
      `  const mod = await import(${JSON.stringify(pathToFileURL(TRANSFORMERS_ENTRY).href)});`,
      "  if (mod.env === undefined) reason = 'transformers module exposes no `env`';",
      "  else {",
      "    mod.env.allowRemoteModels = false;",
      "    armed = mod.env.allowRemoteModels === false;",
      '    reason = armed ? null : "flag did not stick";',
      "  }",
      "} catch (err) {",
      "  reason = err && err.message ? err.message : String(err);",
      "}",
      "writeFileSync(receipt, JSON.stringify({ armed, reason }));",
      "",
    ].join("\n"),
  );
  return { file, receipt };
}

/** Read a world's hermetic receipt. `armed:false` with a reason when unwritten. */
function hermeticState(world) {
  if (!existsSync(world.hermetic.receipt)) {
    return { armed: false, reason: "the preload never wrote its receipt" };
  }
  try {
    return JSON.parse(readFileSync(world.hermetic.receipt, "utf-8"));
  } catch (err) {
    return { armed: false, reason: `unreadable receipt: ${err.message}` };
  }
}

/**
 * FR-241 — seed the TRIAGE world's brain with the ENGINE's own migrations.
 *
 * It cannot use `seedLayerBrain`. That fixture hand-rolls DDL (it must —
 * `cli/` and `brain-mcp-server/` have zero cross-imports), and booting the
 * write engine on top of it throws `duplicate column name: archetype` because
 * the engine's migrations re-apply an `ALTER TABLE` the DDL already inlined.
 * A triage world built that way would only ever show `TRIAGE DISABLED`, and
 * G-BR-8 would be green and meaningless.
 *
 * TWO PASSES, AND NOTHING OPENS A WRITER WHILE AN ENGINE IS LIVE. A read-write
 * connection opened and closed alongside a live engine unlinks the WAL, after
 * which every fresh reader — including the dashboard server — sees the
 * PRE-dispatch state. So: migrate, shut down, then seed.
 */
function seedTriageWorld(db) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import D from "better-sqlite3";
      const DB = process.env.GATE_DB;
      new D(DB).close();
      const { bootEngine } = await import(process.env.GATE_ENGINE);
      bootEngine({ dbPath: DB, components: { schedules: { enabled: false } } }).shutdown();
      const db = new D(DB);
      // Two registered projects, so the shared scope chips render and the page
      // opens on a DEFAULT project exactly as every other view does (D5).
      const insP = db.prepare(
        "INSERT INTO projects (slug, name, path, status, last_session_at) VALUES (?,?,?,'active',?)"
      );
      insP.run("demo", "Demo", "/tmp/demo", "2026-07-28 09:00:00");
      insP.run("other", "Other", "/tmp/other", "2026-07-27 09:00:00");
      // 6 pending suggestions on \`demo\`, 2 on \`other\` — an ASYMMETRIC scope
      // split, so a page that ignored the project chip shows a different count.
      const ins = db.prepare(
        "INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, created_at) VALUES (?,?,?,?,'{}',?, 'pending', ?)"
      );
      for (let i = 1; i <= 6; i++) {
        ins.run(i, i % 2 === 0 ? "janitor" : "gap", "demo", "demo suggestion " + i, i % 3 === 0 ? "high" : "medium", "2026-07-0" + i + "09:00:00");
      }
      ins.run(7, "missing_followup", "other", "other suggestion 7", "low", "2026-07-20 09:00:00");
      ins.run(8, "missing_followup", "other", "other suggestion 8", "low", "2026-07-21 09:00:00");
      // TD-326 — FOUR pending suggestions that belong to NO project. The count
      // is deliberately different from BOTH 6 (the demo scope) and 10 (every
      // row), so a page that showed either instead is visibly wrong rather
      // than coincidentally right. Two modules, so a source_module filter is
      // observable on this population too.
      const insNull = db.prepare(
        "INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, created_at) VALUES (?,?,NULL,?,'{}',?, 'pending', ?)"
      );
      insNull.run(9, "edge_inference", "brain-level edge 9", "medium", "2026-07-25 09:00:00");
      insNull.run(10, "edge_inference", "brain-level edge 10", "medium", "2026-07-26 09:00:00");
      insNull.run(11, "edge_inference", "brain-level edge 11", "low", "2026-07-27 09:00:00");
      insNull.run(12, "janitor", "brain-level orphan 12", "high", "2026-07-28 09:00:00");
      // Candidates: 3 first-time (reject = HARD delete, tier 3) and
      // 2 recurring (reject = SOFT delete, tier 2). The MIXED selection is the
      // only one that can catch a blanket-"irreversible" dialog.
      const insL = db.prepare(
        "INSERT INTO learnings (id, project, category, title, content, confidence, provenance, review_status, source_extractor, seen_again_count, tags, tech_stack, scope) VALUES (?,'demo','pattern',?,'body',0.8,'inferred','pending_review','perception',?,'','','local')"
      );
      insL.run(1, "first-time candidate 1", 0);
      insL.run(2, "first-time candidate 2", 0);
      insL.run(3, "first-time candidate 3", 0);
      insL.run(4, "recurring candidate 4", 5);
      insL.run(5, "recurring candidate 5", 2);
      db.close();
      `,
    ],
    {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        GATE_DB: db,
        GATE_ENGINE: pathToFileURL(
          join(CLI_ROOT, "dist", "brain-mcp-server", "dist", "engine", "index.js"),
        ).href,
      },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * FR-244 — how many extra `learning` rows the DENSE world carries.
 *
 * Chosen to land the whole-brain payload firmly in **Tier C** (`tier.ts`:
 * `n >= 500`), because Tier C is the only tier where `chrome` is `silhouette`
 * and the size floor is `--s-1` — and Tier C is the view the density complaint
 * came from. The `seeded` world is 11-13 nodes, i.e. Tier A with 24 px nodes:
 * the size law is the same there, but a separability claim measured at Tier A
 * would not be a claim about the surface anyone complained about.
 *
 * Not a round 500: a value just over the boundary would make the tier itself a
 * flake if the fixture ever gains or loses a row.
 */
const DENSE_EXTRA_LEARNINGS = 700;

function makeWorld(kind) {
  const brain = mkdtempSync(join(tmpdir(), `igris-fr240-gate-${kind}-`));
  mkdirSync(join(brain, "memory"), { recursive: true });
  mkdirSync(join(brain, "home"), { recursive: true });
  const db = join(brain, "memory", "knowledge.db");

  if (kind === "dense") {
    // The shared fixture plus N learnings, so the SAME builder, the SAME
    // endpoint and the SAME client render a Tier C payload. Half of them carry
    // an edge, so the picture G-BR-11 measures has real edge ink in it rather
    // than being an unnaturally clean field of isolated dots — the threshold
    // that separates node ink from edge ink is then measured against a real
    // mixture (see `READ_SEPARABILITY`).
    runSeedScript(
      `seedLayerBrain(process.env.GATE_DB);
       const db2 = new (await import('better-sqlite3')).default(process.env.GATE_DB);
       const N = Number(process.env.GATE_DENSE_N);
       const ins = db2.prepare(
         "INSERT INTO learnings (project, category, title, content, scope, confidence, review_status)" +
         " VALUES ('demo','pattern',?,?,'local',0.8,'approved')");
       const edge = db2.prepare(
         "INSERT INTO entity_edges (from_type,from_id,to_type,to_id,edge_type,confidence,provenance,metadata)" +
         " VALUES ('learning',?,'learning',?,'relates_to',1.0,'observed','{}')");
       db2.transaction(() => {
         const ids = [];
         for (let i = 0; i < N; i++) {
           ids.push(String(ins.run('dense learning ' + i, 'body ' + i).lastInsertRowid));
         }
         for (let i = 1; i < ids.length; i += 2) edge.run(ids[i - 1], ids[i]);
       })();
       db2.close();`,
      { GATE_DB: db, GATE_DENSE_N: String(DENSE_EXTRA_LEARNINGS) },
    );
    seedCatalog(brain);
    return { kind, brain, db, hermetic: writeHermeticPreload(brain) };
  }

  if (kind === "triage") {
    seedTriageWorld(db);
    seedCatalog(brain);
    const ctx = join(brain, "projects", "demo", "context");
    mkdirSync(ctx, { recursive: true });
    writeFileSync(join(ctx, "coding_guidelines.md"), DOC_BODY);
    return { kind, brain, db, hermetic: writeHermeticPreload(brain) };
  }

  if (kind !== "missing") {
    // The shared fixture, plus TWO gate-local additions:
    //
    //  1. an `errors` row + an edge to it. `error` is a real whole-graph node
    //     type (`whole-graph.ts:509`) that NO FR-240 layer shows, and G-BR-1e
    //     asserts the inspector says so explicitly instead of rendering a blank
    //     panel. The shared fixture has no such type, so the gate seeds one
    //     rather than asserting a state it cannot reach.
    //  2. for `empty`, every row is then DELETED — schema present, data absent.
    //     That is the only way `empty` and `degraded` can be told apart, and
    //     telling them apart is G-BR-3's whole job.
    let extra = `
      const db2 = new (await import('better-sqlite3')).default(process.env.GATE_DB);
      db2.exec(\`
        CREATE TABLE errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, message TEXT NOT NULL,
          occurrence_count INTEGER DEFAULT 1, scope TEXT DEFAULT 'local', resolved_at TEXT
        );
      \`);
      db2.prepare("INSERT INTO errors (project, message) VALUES ('demo','SQLITE_READONLY on a lens write')").run();
      db2.prepare(\`INSERT INTO entity_edges (from_type,from_id,to_type,to_id,edge_type,confidence,provenance,metadata)
                   VALUES ('brief','FR-240','error','1','caused_by',1.0,'observed','{}')\`).run();
    `;
    if (kind === "empty") {
      extra += `
        for (const t of ['brief_status','brief_files','learnings','goals','entity_edges','errors']) {
          db2.prepare('DELETE FROM ' + t).run();
        }
      `;
    }
    if (kind === "vec") {
      // A well-formed `learnings_vec`, so `hybridSearchLearnings` takes its
      // HYBRID arm. The vectors are deterministic and L2-normalised rather than
      // real embeddings — this gate asserts the retrieval MODE and the banner it
      // drives, never ranking quality. Copied in shape from
      // `dashboard-learnings-search.test.ts#seedVectorIndex`.
      extra += `
        const vec = await import(process.env.GATE_VEC_ENTRY);
        vec.load(db2);
        db2.exec('CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec USING vec0(embedding float[384])');
        const ids = db2.prepare('SELECT id FROM learnings').all().map(r => r.id);
        const ins = db2.prepare('INSERT OR REPLACE INTO learnings_vec(rowid, embedding) VALUES (?, ?)');
        for (const id of ids) {
          const v = new Float32Array(384);
          let norm = 0;
          for (let i = 0; i < 384; i++) { v[i] = Math.sin((id + 1) * (i + 1) * 0.017); norm += v[i] * v[i]; }
          norm = Math.sqrt(norm);
          for (let i = 0; i < 384; i++) v[i] /= norm;
          ins.run(BigInt(id), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        }
      `;
    }
    extra += "\n      db2.close();\n";
    runSeedScript(`seedLayerBrain(process.env.GATE_DB);\n${extra}`, {
      GATE_DB: db,
      GATE_VEC_ENTRY: join(
        CLI_ROOT,
        "dist",
        "brain-mcp-server",
        "node_modules",
        "sqlite-vec",
        "index.mjs",
      ),
    });
  }

  seedCatalog(brain);
  if (kind !== "missing") {
    const ctx = join(brain, "projects", "demo", "context");
    mkdirSync(ctx, { recursive: true });
    writeFileSync(join(ctx, "coding_guidelines.md"), DOC_BODY);
  }
  return { kind, brain, db, hermetic: writeHermeticPreload(brain) };
}

// ---------------------------------------------------------------------------
// Server + Chrome lifecycle
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} (${url})`);
    await sleep(120);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];

async function startServer(world) {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI_ENTRY, "dashboard", "--no-open", "--port", String(port)], {
    cwd: tmpdir(), // NOT a registered project dir — `default_project` must not be inherited from cwd
    env: {
      ...process.env,
      IGRIS_BRAIN_DIR: world.brain,
      HOME: join(world.brain, "home"),
      // See `writeHermeticPreload`. `--import` is awaited before the entry
      // module runs, so the flag is set before any pipeline is constructed.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(world.hermetic.file).href}`.trim(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = [];
  child.stdout.on("data", (c) => log.push(String(c)));
  child.stderr.on("data", (c) => log.push(String(c)));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${url}/api/health`, 20_000, `${world.kind} dashboard`);
  } catch (err) {
    process.stderr.write(log.join(""));
    throw err;
  }
  return { ...world, url, port, log };
}

async function startChrome() {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "igris-fr240-gate-chrome-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const version = await waitForHttp(`http://127.0.0.1:${port}/json/version`, 20_000, "chrome");
  return { port, profile, version: JSON.parse(version).Browser };
}

function teardown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// CDP client — id/resolver pump over the global WebSocket
// ---------------------------------------------------------------------------

/**
 * The independent instrument, installed with
 * `Page.addScriptToEvaluateOnNewDocument` so it runs BEFORE the bundle.
 *
 * `docs/dashboard.md` §"Use an independent instrument where you can" is explicit
 * that the app's own `__igrisGraphStillness.paints()` is the weaker reading —
 * a self-witnessing counter. These three witnesses are ours:
 *   raf        — every `requestAnimationFrame` CALLBACK that actually ran
 *   clearRect  — every canvas clear, i.e. real paint work
 *   mut        — DOM mutation records, which is the only motion a DOM view has
 *   graphFetch — every `/api/graph` REQUEST the page issued (G-BR-7)
 *
 * `graphFetch` is what makes the FR-240 scope-cache hoist observable in a real
 * browser: "backing out of a drill served the whole brain from the shared cache"
 * is exactly "the page issued no second `/api/graph`". Counting requests HERE
 * rather than in the server log is deliberate — it is the browser's own
 * behaviour that is under test, and a server-side count cannot tell the graph
 * page's read from the record detail's.
 */
const INSTRUMENT = `
(() => {
  const w = window;
  // \`triagePost\` is FR-241's witness: "CANCEL issued no request" is a claim
  // about a request that did NOT happen, and only an independent counter can
  // make it. Counting server-side would not do — the question is what the PAGE
  // did, and a server log cannot tell a triage POST from any other.
  // \`healthFetch\`/\`summaryFetch\` are BR-082's witnesses, and they witness
  // LIVENESS rather than stillness. "The cleared scope survived two live beats"
  // is only a claim if the beats actually happened — a backgrounded tab stops
  // polling entirely (\`useLive\` pauses on \`document.hidden\`), and a scope that
  // survived a PAUSED beat proves nothing at all. Counting the page's own
  // \`/api/health\` requests is what turns the waiting window from a sleep into a
  // measurement; \`/api/summary\` is the second half, because it is the request
  // the SCOPE-bearing effect issues, so a non-zero delta proves the effect that
  // would have re-applied the default ladder really did re-run.
  // TD-326 adds two more, and \`projectsFetch\` is the SHARPEST witness in the
  // set: it is the request the default-project LADDER itself issues, so a
  // non-zero delta means the effect that could have reset the scope really ran.
  // BR-082's G-BR-9 had to infer that from \`healthFetch\`; G-BR-10 counts it.
  // \`nonGet\` is FR-245's witness, and it is deliberately broader than
  // \`triagePost\`: G-BR-12f's claim is that the BOARD issues no write of ANY
  // kind, and a counter that only knew about \`/api/triage\` would be blind to
  // the next write endpoint someone reaches for. \`fetch\` is its POSITIVE
  // CONTROL — "zero non-GET" read beside "GET greater than zero" is a
  // measurement; read alone it is indistinguishable from a dead counter.
  w.__gate = {
    raf: 0, clearRect: 0, mut: 0, fetch: 0, graphFetch: 0, triagePost: 0,
    healthFetch: 0, summaryFetch: 0, projectsFetch: 0, suggestionsFetch: 0,
    briefsFetch: 0, nonGet: 0,
  };
  const raf = w.requestAnimationFrame.bind(w);
  w.requestAnimationFrame = (cb) => raf((t) => { w.__gate.raf++; return cb(t); });
  if (w.CanvasRenderingContext2D) {
    const cr = w.CanvasRenderingContext2D.prototype.clearRect;
    w.CanvasRenderingContext2D.prototype.clearRect = function (...a) {
      w.__gate.clearRect++;
      return cr.apply(this, a);
    };
  }
  const origFetch = w.fetch;
  w.fetch = function (...a) {
    const first = a[0];
    const url = String(typeof first === 'string' ? first : (first && first.url) || '');
    const init = a[1] || {};
    const method = String(init.method || (first && first.method) || 'GET').toUpperCase();
    w.__gate.fetch++;
    // \`/api/graph\` EXACTLY — not \`/api/graph/stats\`, which the overview polls.
    if (/(^|\\/)api\\/graph(\\?|$)/.test(url)) w.__gate.graphFetch++;
    if (/(^|\\/)api\\/health(\\?|$)/.test(url)) w.__gate.healthFetch++;
    // Matches BOTH \`api/summary\` and \`api/summary?project=x\` — the scoped and
    // the unscoped form are the same request to this counter ON PURPOSE: what
    // it measures is that the effect FIRED, not which scope it asked for.
    if (/(^|\\/)api\\/summary(\\?|$)/.test(url)) w.__gate.summaryFetch++;
    // TD-326: the ladder's own read, and the triage list's own read.
    if (/(^|\\/)api\\/projects(\\?|$)/.test(url)) w.__gate.projectsFetch++;
    if (/(^|\\/)api\\/suggestions(\\?|$)/.test(url)) w.__gate.suggestionsFetch++;
    if (method === 'POST' && /(^|\\/)api\\/triage(\\?|$)/.test(url)) w.__gate.triagePost++;
    // FR-245: one per column, so a board render is 1 + N.
    if (/(^|\\/)api\\/briefs(\\?|$)/.test(url)) w.__gate.briefsFetch++;
    if (method !== 'GET') w.__gate.nonGet++;
    return origFetch.apply(w, a);
  };
  const observe = () => {
    if (!document.documentElement) return;
    new w.MutationObserver((recs) => { w.__gate.mut += recs.length; })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  if (document.documentElement) observe();
  else document.addEventListener('readystatechange', observe, { once: true });
})();
`;

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (p !== undefined) {
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
    });
  }

  /** Evaluate an expression in the page and return its value by value. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails !== undefined) {
      throw new Error(
        `page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value;
  }

  /** Poll an expression until it is truthy. Returns the value. */
  async until(expression, { timeout = 30_000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = await this.eval(expression);
      if (v !== null && v !== undefined && v !== false && v !== 0 && v !== "") return v;
      if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
      await sleep(150);
    }
  }

  /**
   * Bring this tab to the front.
   *
   * NOT cosmetic, and NOT optional. Chrome throttles `requestAnimationFrame` to
   * ZERO in a background tab, so a rAF counter read on a backgrounded tab
   * reports `+0` for a page that is animating flat out — which would turn
   * G-BR-4a into exactly the vacuous gate this whole file exists to avoid. Four
   * tabs are open (one per world), so at most one is ever foreground; every
   * navigation and every measurement therefore claims focus first, G-BR-4a
   * prints the observed `visibilityState`, and G-BR-4b is the live proof that
   * rAF can still fire in the tab that was measured.
   */
  async focus() {
    await this.send("Page.bringToFront");
  }

  /** Navigate to a hash route and wait for the shell to have re-rendered. */
  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.until("return document.querySelector('#main') !== null ? 1 : 0", {
      label: `shell mount at ${url}`,
    });
    return this.settle();
  }

  /**
   * Reload the current document, keeping the hash.
   *
   * G-BR-7 needs this and nothing else does: the scope cache it measures is
   * MODULE-LEVEL state that deliberately outlives every component, so a gate
   * about "was this scope fetched?" has to start from a document where nothing
   * has been fetched yet. Earlier gates have already warmed both scopes.
   * `addScriptToEvaluateOnNewDocument` re-runs on a reload, so `window.__gate`
   * comes back zeroed — which is also what makes the counters below deltas from
   * a known start rather than from wherever gate 1 left them.
   */
  async reload() {
    await this.focus();
    await this.send("Page.reload", { ignoreCache: false });
    await this.until("return document.querySelector('#main') !== null ? 1 : 0", {
      label: "shell mount after reload",
    });
    await this.settle();
  }

  /** Set `location.hash` (a same-document navigation) and wait for the route. */
  async hash(h) {
    await this.focus();
    await this.eval(`location.hash = ${JSON.stringify(h)}; return 1;`);
    await this.settle();
  }

  /**
   * A beat, HOST-side.
   *
   * Deliberately not an in-page `requestAnimationFrame` await: rAF never fires
   * in a background tab, so an in-page frame wait DEADLOCKS the evaluate (60 s
   * CDP timeout) on three of the four tabs. Real synchronisation is `until()`
   * polling; this is only the slack React's effects need after it.
   */
  async settle(ms = 400) {
    await sleep(ms);
  }

  /**
   * A REAL mouse click at the centre of a selector's box.
   *
   * `settle:false` returns the instant the mouse events are dispatched. G-BR-7
   * needs that: it measures the FIRST ~1.4 s of the transition a click starts,
   * and the default 400 ms settle would swallow most of the window it is trying
   * to observe.
   */
  async click(selector, { settle = true } = {}) {
    const box = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (box === null) throw new Error(`click: no element for ${selector}`);
    await this.clickAt(box.x, box.y, { settle });
  }

  async clickAt(x, y, { settle = true } = {}) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    if (settle) await this.settle();
  }

  async moveTo(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  }

  /** Focus an input and type into it, so React sees real native input events. */
  async type(selector, text) {
    await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.focus();
      return 1;
    `);
    await this.send("Input.insertText", { text });
    await this.settle();
  }

  async instrument() {
    return this.eval("return { ...window.__gate };");
  }

  /**
   * Start recording a coarse "ink map" of the graph canvas on a timer.
   *
   * A 24x24 grid of summed premultiplied luminance, sampled every 70 ms. Coarse
   * ON PURPOSE: the question is HOW MUCH THE PICTURE MOVED, not what it looked
   * like, and a full-resolution comparison would be dominated by antialiasing.
   *
   * Returns immediately (the sampler is an interval) so the caller can start it
   * BEFORE the click whose transition it wants to measure. `stopInk()` returns
   * the samples.
   */
  async startInk() {
    return this.eval(`
      if (document.querySelector('.graph-canvas-host canvas') === null) return null;
      const G = 24;
      window.__gateInk = [];
      const sample = () => {
        // RE-QUERIED every sample, not captured once. A scope change DESTROYS
        // the force-graph instance and its canvas; a captured handle would keep
        // reading a detached element and report a frozen picture as stillness.
        const canvas = document.querySelector('.graph-canvas-host canvas');
        if (canvas === null) return;
        const ctx2 = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        if (w === 0 || h === 0) return;
        const px = ctx2.getImageData(0, 0, w, h).data;
        const cells = new Array(G * G).fill(0);
        const cw = w / G, ch = h / G;
        // The CELL PIXEL SIZE, recorded for \`inkSpread\` (FR-244). A cell is
        // square only when the canvas is, and the spread is a physical
        // distance — so the geometry of the dicing has to travel with the
        // samples rather than being assumed.
        window.__gateInkMeta = { w: w, h: h, G: G, cw: cw, ch: ch };
        for (let y = 0; y < h; y += 3) {
          const gy = Math.min(G - 1, (y / ch) | 0);
          for (let x = 0; x < w; x += 3) {
            const i = (y * w + x) * 4;
            cells[gy * G + Math.min(G - 1, (x / cw) | 0)] +=
              (px[i] + px[i + 1] + px[i + 2]) * (px[i + 3] / 255);
          }
        }
        window.__gateInk.push(cells);
      };
      // 30 ms, not 70. The cold entrance is over in a few hundred milliseconds,
      // so a slow sampler catches the clump at a different point on every run and
      // the reading wanders — measured 43.9% / 56.2% / 43.9% at 70 ms.
      window.__gateInkTimer = window.setInterval(sample, 30);
      sample();
      return 1;
    `);
  }

  async stopInk() {
    return this.eval(`
      window.clearInterval(window.__gateInkTimer);
      const out = window.__gateInk || [];
      window.__gateInk = [];
      return out;
    `);
  }

  /**
   * The geometry the last sampler ran with — `{ w, h, G, cw, ch }`.
   *
   * `inkSpread` needs `cw`/`ch` to express its moments in PIXELS. Read from the
   * page rather than recomputed host-side so it can never disagree with the
   * dicing the samples were actually taken under.
   */
  async inkMeta() {
    return this.eval("return window.__gateInkMeta || null;");
  }

  /** One ink frame, right now. Used for the SETTLED reference reading. */
  async sampleInk() {
    await this.startInk();
    return (await this.stopInk())[0] ?? null;
  }

  /**
   * Wait until the animation system has actually gone QUIET, and report whether
   * it did.
   *
   * REACHING rest is a PRECONDITION of "measure this surface at rest"; it is not
   * the assertion. Without it the first 4a reading inherited whatever the
   * PREVIOUS gate left running — G-BR-3 types into a search box and clicks a
   * filter, which wakes GSAP's ticker (`gsap.ticker`'s own rAF loop, identified
   * from a captured call stack during the FR-240 warden pass), and its tail
   * landed inside the window on roughly half of all runs as a constant
   * `rAF +9 · clearRect +0 · mut +0`. Two failures in five runs, always the
   * first view measured, never the other three.
   *
   * This CANNOT mask the defect 4a exists to catch. A real render loop never
   * goes quiet, so it times out and returns `false` — and the caller reports
   * that as a FAILURE with the observed rate, which is a louder signal than the
   * loop's own zero would have been.
   */
  async awaitQuiet({ window = 400, tries = 25 } = {}) {
    await this.focus();
    for (let i = 0; i < tries; i++) {
      const a = (await this.instrument()).raf;
      await sleep(window);
      const b = (await this.instrument()).raf;
      if (b - a === 0) return { quiet: true, waited: i * window, rate: 0 };
    }
    const a = (await this.instrument()).raf;
    await sleep(window);
    const b = (await this.instrument()).raf;
    return { quiet: false, waited: tries * window, rate: b - a };
  }

  /** Delta of the independent witnesses across a quiet window. */
  async witnessDelta(ms) {
    await this.focus();
    const a = await this.instrument();
    await sleep(ms);
    const b = await this.instrument();
    return { raf: b.raf - a.raf, clearRect: b.clearRect - a.clearRect, mut: b.mut - a.mut };
  }

  async reducedMotion(on) {
    await this.send("Emulation.setEmulatedMedia", {
      features: on ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
    });
  }

  /**
   * FR-244 — a REAL wheel event over the canvas.
   *
   * `Input.dispatchMouseEvent` with `type:"mouseWheel"`, not a synthetic
   * `WheelEvent` from page script, and not a call into the camera. Three
   * reasons, all load-bearing:
   *
   *  1. Zoom is d3-zoom's, and d3-zoom listens for a trusted `wheel`. A
   *     `dispatchEvent` from page script is `isTrusted:false` and d3-zoom's
   *     handler still runs, but nothing else on the real path does.
   *  2. It exercises the C1 wake path (learning 1097). `onZoom` fires from a
   *     d3 DOM handler, OUTSIDE `animate()`, and is routed through
   *     `pointerActivity()`. A canvas that is halted-and-dead does not repaint
   *     on a wheel — so a dead canvas fails G-BR-11 as well as G-BR-4c.
   *  3. Driving the camera directly (`fg.zoom(k)`) would measure a picture the
   *     operator can never produce, and would skip the wake path entirely.
   */
  async wheel(x, y, deltaY) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: "mouse",
    });
  }

  /**
   * Override the viewport, so a gate can assert a claim that is only made ABOVE
   * a breakpoint by testing it BELOW one (G-BR-11c's mutation).
   *
   * `deviceScaleFactor: 1` explicitly: the separability instrument reads the
   * canvas backing store, whose pixel dimensions are DPR-scaled, and a metrics
   * override that silently changed DPR would change every reading's units.
   */
  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async clearViewport() {
    await this.send("Emulation.clearDeviceMetricsOverride");
  }
}

/**
 * Open a tab with the instrument installed at document start.
 *
 * `extraScript` is a SECOND document-start script, and it exists for exactly one
 * class of mutation: a defect in how the page PERSISTS something, which cannot
 * be injected after load because the page has already read storage by then.
 * `br12-view-in-localstorage` is the case — see `gBr12`.
 */
async function openTab(cdpPort, url, extraScript = null) {
  const res = await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const tab = new Tab(ws);
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  if (extraScript !== null) {
    await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: extraScript });
  }
  await tab.goto(url);
  return tab;
}

// ---------------------------------------------------------------------------
// DOM readers — one place, so a selector change is one edit
// ---------------------------------------------------------------------------

const READ = {
  rowTitles: `return [...document.querySelectorAll('.record-row-title')].map(e => e.textContent.trim());`,
  rowEyes: `return [...document.querySelectorAll('.record-row-eye')].map(e => e.textContent.trim());`,
  detailTitle: `const e = document.querySelector('.record-detail-title'); return e === null ? null : e.textContent.trim();`,
  detailBody: `const e = document.querySelector('.record-detail-body'); return e === null ? null : e.textContent.trim();`,
  detailMeta: `
    const out = {};
    for (const kv of document.querySelectorAll('.record-detail-meta .shell-kv')) {
      const k = kv.querySelector('span'); const v = kv.querySelector('b');
      if (k !== null && v !== null) out[k.textContent.trim()] = v.textContent.trim();
    }
    return out;`,
  emptyKind: `const e = document.querySelector('[data-empty-kind]'); return e === null ? null : e.getAttribute('data-empty-kind');`,
  banners: `return [...document.querySelectorAll('.shell-banner')].map(e => e.textContent.trim());`,
  readouts: `return [...document.querySelectorAll('.record-readout')].map(e => e.textContent.trim());`,
  inspectorTitle: `const e = document.querySelector('.graph-inspector-title'); return e === null ? null : e.textContent.trim();`,
  inspectorEye: `const e = document.querySelector('.graph-inspector-eye'); return e === null ? null : e.textContent.trim();`,
  inspectorMore: `const e = document.querySelector('.graph-inspector-more'); return e === null ? null : e.textContent.trim();`,
  openRecordHref: `const a = [...document.querySelectorAll('.graph-inspector a')].find(x => x.textContent.trim() === 'OPEN RECORD'); return a === null || a === undefined ? null : a.getAttribute('href');`,
  /** `TIER A · 13 NODES · 3 EDGES` — the scope's identity, in one string. */
  graphReadout: `const e = document.querySelector('.graph-readout'); return e === null ? null : e.textContent.trim().replace(/\\s+/g, ' ');`,
  graphScope: `const s = document.querySelector('.graph-drill select'); return s === null ? null : s.value;`,
  hash: `return location.hash;`,
};

/**
 * FR-245 — the board's readers.
 *
 * `data-status` carries the FULL raw status and `data-total` the column's own
 * `/api/briefs` total, so this gate reads NUMBERS and IDENTITIES out of
 * attributes rather than parsing header prose — the same reason
 * `READ_OVERVIEW` reads `data-card` instead of picking `.shell-metric` by DOM
 * order.
 */
const READ_BOARD = {
  /** Every column's raw status, in rendered order. */
  statuses: `return [...document.querySelectorAll('.record-board-col')].map(e => e.getAttribute('data-status'));`,
  /** `[{status, total}]` — each column's OWN count, from its own response. */
  totals: `return [...document.querySelectorAll('.record-board-col')].map(e => ({
    status: e.getAttribute('data-status'),
    total: Number(e.getAttribute('data-total')),
    cards: e.querySelectorAll('.record-row').length,
  }));`,
  /** The strip's own arithmetic, for cross-checking the host-side sum. */
  readout: `const e = document.querySelector('[data-column-sum]');
    return e === null ? null : {
      sum: Number(e.getAttribute('data-column-sum')),
      scope: e.getAttribute('data-scope-total'),
      text: e.textContent.trim(),
    };`,
  /** Which arrangement is on screen. Exactly one of them, always. */
  which: `return {
    board: document.querySelector('.record-board') !== null,
    list: document.querySelector('.record-list') !== null &&
          document.querySelector('.record-board') === null,
    checked: (() => {
      const g = [...document.querySelectorAll('[role=radiogroup]')]
        .find(x => x.getAttribute('aria-label') === 'Layer view');
      if (g === undefined) return null;
      const b = [...g.querySelectorAll('button')].find(x => x.getAttribute('aria-checked') === 'true');
      return b === undefined ? null : b.textContent.trim();
    })(),
  };`,
  /** Any board card still reading. */
  reading: `return [...document.querySelectorAll('.record-board-count')].filter(e => e.textContent.includes('READING')).length;`,
};

/** One column header's geometry and text, by raw status. */
const readHeader = (status) => `
  const col = [...document.querySelectorAll('.record-board-col')]
    .find(e => e.getAttribute('data-status') === ${JSON.stringify(status)});
  if (col === undefined) return null;
  const label = col.querySelector('.record-board-label');
  return {
    text: label.textContent,
    title: label.getAttribute('title'),
    status: col.getAttribute('data-status'),
    // The layout claim, MEASURED: \`text-overflow: ellipsis\` does not shrink
    // content, so a header that overflows its box reports scrollWidth greater
    // than clientWidth. A header the pure truncation handled does not.
    scrollWidth: label.scrollWidth,
    clientWidth: label.clientWidth,
    colWidth: col.getBoundingClientRect().width,
  };
`;

/** Click a chip in a named radiogroup outside the filter strip (the view toggle). */
async function setLayerView(tab, label) {
  const box = await tab.eval(`
    const g = [...document.querySelectorAll('[role=radiogroup]')]
      .find(x => x.getAttribute('aria-label') === 'Layer view');
    if (g === undefined) return null;
    const b = [...g.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
    if (b === undefined) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (box === null) throw new Error(`no view chip "${label}"`);
  await tab.clickAt(box.x, box.y);
  await tab.settle(400);
}

/**
 * Wait until every column has answered.
 *
 * The board is 1 + N requests and each column paints as it lands, so a reading
 * taken too early sees `READING` where a total belongs — the same class of race
 * `untilListStable` exists for, with the columns as the moving part.
 */
async function untilBoardStable(tab, { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  let prev = null;
  for (;;) {
    const now = await tab.eval(`
      return document.querySelectorAll('.record-board-col').length + ':' +
             [...document.querySelectorAll('.record-board-col')].map(e => e.getAttribute('data-total')).join(',') + ':' +
             [...document.querySelectorAll('.record-board-count')].filter(e => e.textContent.includes('READING')).length;
    `);
    if (prev === now && now.endsWith(":0")) return now;
    prev = now;
    if (Date.now() > deadline) return now;
    await sleep(250);
  }
}

/** Selector for the nth `.record-row` anchor. */
const rowN = (n) => `.record-list > li:nth-child(${n}) .record-row`;

/**
 * An `until()` expression: "this selector is present".
 *
 * A helper rather than string-concatenating a `READ.*` reader, because every
 * `READ.*` value is a STATEMENT BLOCK ending in `return`. Appending `!== null`
 * to one produces `return e.textContent; !== null` — a SyntaxError that surfaces
 * as a page throw, not as a failed assertion.
 */
const has = (sel) =>
  `return document.querySelector(${JSON.stringify(sel)}) !== null ? 1 : 0;`;

/** An `until()` expression: "this selector's text is present and not `text`". */
const textOtherThan = (sel, text) => `
  const e = document.querySelector(${JSON.stringify(sel)});
  if (e === null) return 0;
  const t = e.textContent.trim();
  return t.length > 0 && t !== ${JSON.stringify(text)} ? 1 : 0;
`;

/**
 * Wait until the rendered row set has stopped changing.
 *
 * REQUIRED BEFORE MEASURING A CHIP'S COORDINATES. `useLayerList` deliberately
 * keeps the previous payload on screen during a refetch (a beat must not blank a
 * list the operator is reading), so a filter click is followed by a window in
 * which the OLD rows are still rendered. The filter vocabularies are derived
 * from those rows, so the strip re-flows when the new payload lands — and a
 * click dispatched at coordinates measured just before that re-flow lands on the
 * WRONG chip. Observed exactly once while writing this file: the run reported
 * `priority=P3-Low -> 0 rows` for a filter that has one, because the click had
 * actually hit a neighbouring chip.
 *
 * Two consecutive equal readings, not one — a single reading cannot distinguish
 * "settled" from "between renders".
 */
async function untilListStable(tab, { timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  let prev = null;
  for (;;) {
    const now = await tab.eval(`
      return document.querySelectorAll('.record-row').length + ':' +
             document.querySelectorAll('.record-filters .tweaks-chip').length + ':' +
             (document.querySelector('.shell-skel') === null ? 'idle' : 'loading');
    `);
    if (prev === now && now.endsWith("idle")) return now;
    prev = now;
    if (Date.now() > deadline) return now;
    await sleep(250);
  }
}

/** An `until()` expression: the filter's checked chip is exactly `value` (null = none). */
const chipStateIs = (label, value) => `
  const g = [...document.querySelectorAll('.record-filters [role=radiogroup]')]
    .find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (g === undefined) return ${value === null ? 1 : 0};
  const b = [...g.querySelectorAll('button')].find(x => x.getAttribute('aria-checked') === 'true');
  const cur = b === undefined ? null : b.textContent.trim();
  return cur === ${JSON.stringify(value)} ? 1 : 0;
`;

/**
 * Click the chip whose text is `value` inside the filter labelled `label`, then
 * CONFIRM the control took it and the list re-settled.
 *
 * `expect` is the chip state to wait for afterwards — `value` when setting, and
 * `null` when the click is a clear (re-clicking the active chip clears it).
 */
async function setFilterChip(tab, label, value, expect = value) {
  await untilListStable(tab);
  const box = await tab.eval(`
    const groups = [...document.querySelectorAll('.record-filters [role=radiogroup]')];
    const g = groups.find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (g === undefined) return null;
    const b = [...g.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(value)});
    if (b === undefined) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (box === null) throw new Error(`no chip "${value}" in filter "${label}"`);
  await tab.clickAt(box.x, box.y);
  await tab.until(chipStateIs(label, expect), {
    timeout: 10_000,
    label: `filter ${label} -> ${JSON.stringify(expect)}`,
  });
  await untilListStable(tab);
}

/**
 * The project slug the Layers page has scoped itself to, or `null`.
 *
 * Load-bearing for G-BR-2: `Layers.tsx` selects `default_project` on first load,
 * so the list is ALREADY scoped when it renders. Comparing the rendered row
 * count against an UNSCOPED `/api/briefs` would fail for a correct page, and
 * "make the numbers agree" is how a reviewer talks themselves into deleting the
 * scope from the comparison instead of naming it.
 */
async function activeProject(tab) {
  return tab.eval(`
    const g = [...document.querySelectorAll('[role=radiogroup]')]
      .find(x => x.getAttribute('aria-label') === 'Project scope');
    if (g === undefined) return null;
    const b = [...g.querySelectorAll('button')].find(x => x.getAttribute('aria-checked') === 'true');
    return b === undefined ? null : b.textContent.trim();
  `);
}

/** Click a project-scope chip (re-clicking the active one clears the scope). */
async function clickProjectChip(tab, slug) {
  const box = await tab.eval(`
    const g = [...document.querySelectorAll('[role=radiogroup]')]
      .find(x => x.getAttribute('aria-label') === 'Project scope');
    if (g === undefined) return null;
    const b = [...g.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(slug)});
    if (b === undefined) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (box === null) throw new Error(`no project chip "${slug}"`);
  await tab.clickAt(box.x, box.y);
  await tab.settle(600);
}

/** Type into the NAV's text mute (the `// QUICK` client-side filter). */
async function navMute(tab, text) {
  await tab.eval(`
    const el = document.querySelector('.shell-search-slot input');
    if (el === null) return null;
    el.focus();
    el.setSelectionRange(0, el.value.length);
    return 1;
  `);
  if (text.length === 0) {
    await tab.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await tab.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  } else {
    await tab.send("Input.insertText", { text });
  }
  await tab.settle(500);
}

/** Click a palette chip in the shell chrome. */
async function setPalette(tab, name) {
  const box = await tab.eval(`
    const g = [...document.querySelectorAll('[role=radiogroup]')]
      .find(x => x.getAttribute('aria-label') === 'Colour palette');
    if (g === undefined) return null;
    const b = [...g.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(name)});
    if (b === undefined) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (box === null) throw new Error(`no palette chip "${name}"`);
  await tab.clickAt(box.x, box.y);
}

async function apiJson(url) {
  const r = await fetch(url);
  return r.json();
}

/** Change the graph's `// DRILL` scope select — a real `change` event. */
async function graphDrill(tab, slug) {
  const ok = await tab.eval(`
    const sel = document.querySelector('.graph-drill select');
    if (sel === null) return null;
    sel.value = ${JSON.stringify(slug)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  `);
  if (ok === null) throw new Error("graphDrill: no `// DRILL` select on this page");
}

/**
 * Poll `fn` until `ok(value)` or the deadline, and return the LAST reading
 * either way. It never throws.
 *
 * `Tab#until` throws on timeout, which `runGate` records as a check called
 * `threw` — a verdict that names no gate, prints no reading, and does not match
 * the mutation predictor. For a gate whose whole subject is "what does this
 * page look like AFTER a while", the timed-out reading IS the evidence, so it
 * has to reach `check()` rather than an exception handler.
 */
async function pollFor(fn, ok, { timeout = 15_000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(every);
    last = await fn();
  }
  return last;
}

/**
 * ONE reading of the Overview: its stated scope, its checked chip, the three
 * card metrics, the BRIEFS footer label, and the tab's visibility.
 *
 * `data-scope` and `data-card` are attributes `pages/Overview.tsx` renders for
 * this gate to read; `.shell-metric` alone is ambiguous (BRIEFS, INSTANCES and
 * GRAPH SCALE all use it), and picking cards by DOM order is how a gate starts
 * silently asserting the wrong number after a re-layout.
 */
const READ_OVERVIEW = `
  const el = document.querySelector('[data-scope]');
  const num = (card) => {
    const e = document.querySelector('[data-card="' + card + '"] .shell-metric');
    return e === null ? null : Number(e.textContent.trim());
  };
  const g = [...document.querySelectorAll('[role=radiogroup]')]
    .find(x => x.getAttribute('aria-label') === 'Project scope');
  const b = g === undefined
    ? undefined
    : [...g.querySelectorAll('button')].find(x => x.getAttribute('aria-checked') === 'true');
  const foot = document.querySelector('[data-card="briefs"] .card-footer span');
  return {
    scope: el === null ? null : el.getAttribute('data-scope'),
    chip: b === undefined ? null : b.textContent.trim(),
    briefs: num('briefs'),
    instances: num('instances'),
    graph: num('graph'),
    footer: foot === null ? null : foot.textContent.trim(),
    visibility: document.visibilityState,
  };
`;

/**
 * Click a `<button>` by its exact label. `settle:false` for a timed window.
 *
 * `scroll: true` SCROLLS THE BUTTON INTO VIEW FIRST, and it is not cosmetic.
 * A `getBoundingClientRect()` on an element above the fold returns a NEGATIVE
 * `y`, and `Input.dispatchMouseEvent` at a negative coordinate lands nowhere —
 * the click silently does nothing and the gate times out waiting for the effect.
 * Observed exactly that on FR-241's G-BR-8: the triage bulk bar sat at
 * `y = -125.5` after the candidate list had grown, so `REJECT` was "clicked"
 * four times with no dialog. It is OPT-IN rather than the default so the FR-239
 * and FR-240 gates, whose timed windows are calibrated with no scroll in them,
 * are byte-for-byte unaffected.
 */
async function clickButton(tab, label, opts = {}) {
  const { scroll = false, ...clickOpts } = opts;
  const box = await tab.eval(`
    const b = [...document.querySelectorAll('button')]
      .find(x => x.textContent.trim() === ${JSON.stringify(label)});
    if (b === undefined) return null;
    ${scroll ? "b.scrollIntoView({ block: 'center' });" : ""}
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (box === null) throw new Error(`no button labelled "${label}"`);
  if (box.y < 0 || box.x < 0) {
    throw new Error(
      `button "${label}" is outside the viewport at (${box.x}, ${box.y}) — pass { scroll: true }`,
    );
  }
  await tab.clickAt(box.x, box.y, clickOpts);
}

/**
 * The RMS radius of one ink frame about its own centroid, **in canvas pixels**.
 *
 * This is the measurement that separates a RESTORED layout from a SECOND
 * ENTRANCE, and the choice is forced by how d3-force works. A node with no
 * coordinates is initialised on a phyllotaxis spiral of radius `10*sqrt(i)`, so
 * a COLD layout starts as a tight clump at the origin and expands to its settled
 * extent. A SEEDED layout starts AT that extent and stays there. So the spread
 * over time collapses toward zero in one case and never does in the other.
 *
 * Deliberately NOT a frame-to-frame image difference: the ink is a dozen small
 * blobs on a canvas of ~1058x423 (see below — NOT 1440x900; that is the
 * `--window-size` passed to Chrome, and headless chrome is counted inside it),
 * so any motion at all moves a blob across a cell
 * boundary and an L1 image distance saturates near 100% for both cases. Measured
 * during FR-240's warden pass — back-out 105.8% vs cold 146.0%, a 1.4x
 * separation with no headroom. The spread trajectory separates by ~an order of
 * magnitude because it measures the SHAPE of the layout rather than its pixels.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FR-244 — WHY THE MOMENTS ARE WEIGHTED BY CELL PIXEL SIZE
 * ─────────────────────────────────────────────────────────────────────────
 * This used to accumulate `dx = (i % G) - cx` and `dy = ((i/G)|0) - cy` in
 * grid-cell INDEX units, i.e. treating every cell as a unit square. Cells are
 * `canvasW/G x canvasH/G` pixels, so they are square only when the canvas is —
 * which made the metric **silently coupled to the canvas ASPECT RATIO**. The
 * same physical layout on a differently-shaped canvas produced a different RMS
 * radius, because vertical displacement was being counted in different units
 * from horizontal.
 *
 * That went unnoticed for three briefs because nothing had changed the canvas
 * box. FR-244 gave the canvas the vertical column, moving it from **1058x502
 * to 1058x423** — cells from 44.1x20.9px to 44.1x17.6px, so the vertical
 * weighting went from 2.11x horizontal to 2.50x. (502, not 504: 504 was an
 * arithmetic estimate of `62vh` at this window's usable height, and the gate
 * MEASURES 502. Both gates read the same box — G-BR-7 and G-BR-11 print
 * `1058x502` on the pre-FR-244 tree — so there was never a real disagreement,
 * only an estimate written down beside a measurement.) `7d` normalises each arm by its
 * OWN settled spread, which cancels a UNIFORM rescale (that is why it survived
 * every earlier size change) but CANNOT cancel an anisotropic one, because the
 * two arms differ in SHAPE at the moments compared: the cold arm opens as an
 * isotropic clump and settles into a wide field, while the seeded arm opens
 * wide already. `7d` went red for a canvas-shape change rather than for any
 * change in the behaviour it exists to police.
 *
 * Multiplying by `cw`/`ch` makes the result a PHYSICAL DISTANCE, so it is
 * invariant to how the canvas is diced and to the canvas's aspect. `G` may
 * change, the canvas may be reshaped, and the reading means the same thing.
 *
 * **If you change the canvas box again, this is the line that used to punish
 * you for it, and it no longer will.** Do not revert it to index units, and do
 * not "simplify" `cw`/`ch` away — only their RATIO actually matters (a uniform
 * scale cancels in `collapse`), but writing them as true pixels is what makes
 * the invariance obvious rather than accidental.
 *
 * Validated by `--mutate=br7-backout-re-entrances`, which was built and proven
 * to bite against the OLD, aspect-coupled metric BEFORE this change, and still
 * bites after it. A metric repair justified only by the failure it removes is
 * not a repair.
 */
function inkSpread(cells, cell = { cw: 1, ch: 1 }, G = 24) {
  const usable =
    typeof cell?.cw === "number" && cell.cw > 0 &&
    typeof cell?.ch === "number" && cell.ch > 0;
  /*
   * THE FALLBACK IS THE PRE-REPAIR BUG, so it announces itself.
   *
   * Without cell dimensions this reverts to INDEX units — exactly the
   * aspect-coupled behaviour the header describes, and the reading would still
   * look plausible while meaning something else. `__gateInkMeta` is written by
   * the sampler, so the only way to get here is a caller that read the samples
   * without running the sampler, or a page that was replaced between the two.
   * That must never be silent: a `7d` computed in the wrong units is precisely
   * the failure this brief spent a day diagnosing.
   */
  if (!usable) {
    process.stdout.write(
      `  ....            WARNING inkSpread: no cell geometry (__gateInkMeta missing or malformed) — ` +
        `falling back to grid-INDEX units, which are ASPECT-COUPLED. Any 7d reading from this run is ` +
        `not comparable to a recorded one. See inkSpread's header.\n`,
    );
  }
  const cw = usable ? cell.cw : 1;
  const ch = usable ? cell.ch : 1;
  let total = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v <= 0) continue;
    total += v;
    cx += v * (i % G);
    cy += v * ((i / G) | 0);
  }
  if (total <= 0) return null;
  cx /= total;
  cy /= total;
  let m2 = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v <= 0) continue;
    // IN PIXELS, not in cell indices — see the header. `cw`/`ch` are the cell's
    // real dimensions, so a tall-thin canvas and a short-wide one measure the
    // same layout the same way.
    const dx = ((i % G) - cx) * cw;
    const dy = (((i / G) | 0) - cy) * ch;
    m2 += v * (dx * dx + dy * dy);
  }
  return Math.sqrt(m2 / total);
}

/**
 * How far the layout COLLAPSED at any point during the transition, as a fraction
 * of the extent it eventually SETTLED at.
 *
 * `collapse ≈ 1` — the picture was never more compact than its settled form: the
 * nodes were already where they ended up. `collapse ≪ 1` — the picture was a
 * clump at some point and expanded out of it: a second entrance.
 *
 * TWO CHOICES THAT ARE LOAD-BEARING, both found by measuring rather than by
 * reasoning:
 *
 *  1. The DENOMINATOR is a reading taken AFTER `state() === 'still'`, not the
 *     last frame of the window. A 1.6 s window can end mid-settle, and dividing
 *     by a half-settled extent reported the back-out as 73% when it is 85-100%.
 *
 *  2. The LEADING frames that are BYTE-IDENTICAL to frame 0 are dropped. The
 *     recorder starts before the click on purpose (so no frame is lost to a CDP
 *     round trip), and the canvas is still at that point — so every pre-click
 *     frame is identical to the first. Those frames show the PREVIOUS SCOPE,
 *     whose node set is different and whose extent is therefore unrelated: on the
 *     back-out they were contributing the minimum, which measured the demo
 *     subgraph's size instead of the whole brain's entrance.
 */
function l1(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

function inkCollapse(samples, settledSpread, cell) {
  if (!Array.isArray(samples) || samples.length < 3) return null;
  if (typeof settledSpread !== "number" || settledSpread <= 0) return null;

  const first = samples[0];
  let start = 1;
  while (start < samples.length && l1(samples[start], first) === 0) start++;

  const moved = samples.slice(start);
  const spreads = moved.map((s) => inkSpread(s, cell)).filter((v) => v !== null && v > 0);
  if (spreads.length < 2) return null;
  // The MEAN of the first frames of the transition, not the single minimum. The
  // minimum is one sample and therefore a sampling-phase lottery; the mean of the
  // opening window is the same physical claim ("how compact was the layout when
  // it first appeared") with the phase noise averaged out.
  const opening = spreads.slice(0, Math.min(6, spreads.length));
  const early = opening.reduce((a, b) => a + b, 0) / opening.length;
  return {
    samples: samples.length,
    /** How many leading frames were the PREVIOUS, still canvas. */
    dropped: start,
    read: spreads.length,
    opening: opening.length,
    min: Number(Math.min(...spreads).toFixed(3)),
    early: Number(early.toFixed(3)),
    settled: Number(settledSpread.toFixed(3)),
    collapse: early / settledSpread,
  };
}

const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * G-BR-1 — the AC #3 cross-link round trip, on real data with real clicks.
 *
 * PROVES: a click on a list row reaches the right record; LOCATE IN GRAPH
 * selects the matching node; OPEN RECORD comes back to the same address; and
 * `BR-001` in two projects resolves to two DIFFERENT records.
 * DOES NOT PROVE: correctness for a node type with no detail view — 1e asserts
 * that state explicitly instead. Nor ranking, nor payload shape (G-EP-1/2).
 */
async function gBr1(tab) {
  gate("G-BR-1", "cross-link round trip (AC #3) — real clicks, real routing");

  await tab.hash("#/layers/briefs");
  await tab.until("return document.querySelectorAll('.record-row').length;", {
    label: "briefs rows",
  });
  const titles = await tab.eval(READ.rowTitles);
  const idx = titles.indexOf("Dashboard layer views") + 1;
  check(
    "1a-rows",
    idx > 0,
    `briefs list rendered ${titles.length} rows; "Dashboard layer views" at row ${idx}`,
  );

  await tab.click(rowN(idx));
  const dTitle = await tab.eval(READ.detailTitle);
  const dMeta = await tab.eval(READ.detailMeta);
  check(
    "1a",
    dTitle === "Dashboard layer views" &&
      dMeta.project === "demo" &&
      dMeta["brief id"] === "FR-240",
    `row click -> detail title=${JSON.stringify(dTitle)} project=${dMeta.project} id=${dMeta["brief id"]}`,
  );

  // --- 1b · LOCATE IN GRAPH ------------------------------------------------
  const locate = await tab.eval(`
    const a = [...document.querySelectorAll('.record-detail-actions a')]
      .find(x => x.textContent.trim() === 'LOCATE IN GRAPH');
    return a === undefined ? null : a.getAttribute('href');
  `);
  check(
    "1b-href",
    locate === "#/graph?focus=brief/demo/FR-240",
    `LOCATE IN GRAPH href = ${JSON.stringify(locate)}`,
  );
  const locBox = await tab.eval(`
    const a = [...document.querySelectorAll('.record-detail-actions a')]
      .find(x => x.textContent.trim() === 'LOCATE IN GRAPH');
    if (a === undefined) return null;
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await tab.clickAt(locBox.x, locBox.y);
  // The entrance has to settle before `graph.select` can move the camera, so
  // this waits on the INSPECTOR rather than on a fixed sleep.
  await tab.until(has(".graph-inspector-title"), {
    timeout: 45_000,
    label: "graph selects the focused node",
  });
  const insTitle = await tab.eval(READ.inspectorTitle);
  const insEye = await tab.eval(READ.inspectorEye);
  check(
    "1b",
    insTitle === "Dashboard layer views" && insEye.includes("BRIEF"),
    `graph inspector title=${JSON.stringify(insTitle)} eye=${JSON.stringify(insEye)}`,
  );

  // --- 1c · OPEN RECORD, the return trip -----------------------------------
  const orHref = await tab.eval(READ.openRecordHref);
  const orBox = await tab.eval(`
    const a = [...document.querySelectorAll('.graph-inspector a')].find(x => x.textContent.trim() === 'OPEN RECORD');
    if (a === undefined) return null;
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await tab.clickAt(orBox.x, orBox.y);
  await tab.until(has(".record-detail-title"), { label: "record detail after OPEN RECORD" });
  const backTitle = await tab.eval(READ.detailTitle);
  const backHash = await tab.eval(READ.hash);
  check(
    "1c",
    orHref === "#/layers/briefs/demo/FR-240" &&
      backHash === "#/layers/briefs/demo/FR-240" &&
      backTitle === "Dashboard layer views",
    `OPEN RECORD href=${JSON.stringify(orHref)} -> hash=${JSON.stringify(backHash)} title=${JSON.stringify(backTitle)}`,
  );

  // --- 1d · BR-078, the same id in two projects ----------------------------
  await tab.hash("#/layers/briefs/demo/BR-001");
  await tab.until(has(".record-detail-title"), { label: "demo BR-001" });
  const demoTitle = await tab.eval(READ.detailTitle);
  await tab.hash("#/layers/briefs/other/BR-001");
  await tab
    .until(textOtherThan(".record-detail-title", demoTitle), { label: "other BR-001" })
    // A tolerated timeout: if the two titles are IDENTICAL the wait can never
    // satisfy, and that is precisely the state 1d must then REPORT as a failure
    // rather than crash on.
    .catch(() => {});
  const otherTitle = await tab.eval(READ.detailTitle);
  // The MUTATION asserts EQUALITY — the exact signature of a router that
  // dropped the project segment and fused the two records.
  const ok1d = mut("br1-fuse-projects")
    ? demoTitle === otherTitle
    : demoTitle === "Demo-project bug" && otherTitle === "Other-project bug";
  check(
    "1d",
    ok1d,
    `BR-001 in demo=${JSON.stringify(demoTitle)} · in other=${JSON.stringify(otherTitle)}${
      mut("br1-fuse-projects") ? "  [MUTATED: asserting they are EQUAL]" : ""
    }`,
  );

  // --- 1e · a node type NO layer shows -------------------------------------
  await tab.hash("#/graph?focus=error/demo/1");
  await tab.until(has(".graph-inspector-title"), {
    timeout: 45_000,
    label: "graph selects the error node",
  });
  const moreText = await tab.eval(READ.inspectorMore);
  const errHref = await tab.eval(READ.openRecordHref);
  check(
    "1e",
    errHref === null && moreText !== null && moreText.includes("NO DETAIL VIEW FOR ERROR"),
    `error node: OPEN RECORD=${JSON.stringify(errHref)} · stated=${JSON.stringify(moreText)}`,
  );
  note(
    "1e is the STATED-ABSENCE case only. It does not prove session/concept/decision " +
      "render the same way — those types are not in this fixture; `layers/model.ts` " +
      "`recordHrefForNode` returns null for every type with no descriptor and its unit " +
      "test covers the mapping.",
  );

}

/**
 * G-BR-2 — the filter controls and the search box are WIRED to the endpoints.
 *
 * PROVES: clicking a chip changes the rendered row set, and the rendered count
 * agrees with the endpoint's own `count` for the same filter. The fixture's
 * partitions DISAGREE, so an assertion here cannot pass with a WHERE deleted.
 * DOES NOT PROVE: ranking, or that the SQL binds — G-EP-1 owns that.
 */
async function gBr2(tab, seeded) {
  gate("G-BR-2", "filters and search through the DOM");

  await tab.hash("#/layers/briefs");
  await tab.until("return document.querySelectorAll('.record-row').length;", { label: "briefs rows" });

  // The page scopes itself to `default_project` on first load, so the FIRST
  // comparison has to be against that same scope. Named rather than normalised
  // away — see `activeProject`'s header.
  const scope = await activeProject(tab);
  const scopedRows = (await tab.eval(READ.rowTitles)).length;
  const scopedApi = await apiJson(
    `${seeded.url}/api/briefs?project=${encodeURIComponent(scope ?? "")}`,
  );
  check(
    "2a-scope",
    scope !== null && scopedRows === scopedApi.count,
    `page scoped to project=${JSON.stringify(scope)} · DOM rows=${scopedRows} · endpoint count=${scopedApi.count}`,
  );

  // Clearing the scope (re-click the active chip) must make the count RISE to
  // the unscoped total. Assert-then-diff: 2a-scope alone would also pass if the
  // project chip were decorative.
  await clickProjectChip(tab, scope);
  const clearedScope = await activeProject(tab);
  const allRows = (await tab.eval(READ.rowTitles)).length;
  const allApi = await apiJson(`${seeded.url}/api/briefs`);
  check(
    "2a-clear",
    clearedScope === null && allRows === allApi.count && allRows > scopedRows,
    `scope cleared -> active=${JSON.stringify(clearedScope)} · DOM rows=${allRows} (was ${scopedRows}) · endpoint count=${allApi.count}`,
  );

  if (!mut("br2-skip-click")) await setFilterChip(tab, "status", "Pending");
  const filtered = await tab.eval(READ.rowTitles);
  const eyes = await tab.eval(READ.rowEyes);
  const filteredApi = await apiJson(`${seeded.url}/api/briefs?status=Pending`);
  const includesTd = eyes.some((e) => e.includes("TD-312"));
  const excludesFr = !eyes.some((e) => e.includes("FR-240"));
  check(
    "2a",
    filtered.length === filteredApi.count && includesTd && excludesFr,
    `status=Pending DOM rows=${filtered.length} · endpoint count=${filteredApi.count} · TD-312 present=${includesTd} · FR-240 excluded=${excludesFr}${
      mut("br2-skip-click") ? "  [MUTATED: chip never clicked]" : ""
    }`,
  );

  // The `priority` vocabulary comes from the LOADED ROWS (`Briefs.tsx` explains
  // why), so `P3-Low` only has a chip once the scope is cleared — which it is.
  await setFilterChip(tab, "status", "Pending", null); // re-click clears
  await setFilterChip(tab, "priority", "P3-Low");
  const p3 = await tab.eval(READ.rowEyes);
  const p3Api = await apiJson(`${seeded.url}/api/briefs?priority=P3-Low`);
  check(
    "2b",
    p3.length === p3Api.count && p3.length === 1 && p3[0].includes("BR-001"),
    `priority=P3-Low DOM rows=${p3.length} (${JSON.stringify(p3)}) · endpoint count=${p3Api.count}`,
  );
  await setFilterChip(tab, "priority", "P3-Low", null); // clear

  // The FILTERED empty state, reached through the NAV's client-side text mute —
  // the one narrowing control that is not a server filter. It must render
  // `filtered`, not the `empty` copy an empty brain shows (G-BR-3b).
  await navMute(tab, "zzz-no-such-brief");
  const mutedKind = await tab.eval(READ.emptyKind);
  const mutedRows = (await tab.eval(READ.rowTitles)).length;
  await navMute(tab, "");
  await tab.eval(
    "const el = document.querySelector('.shell-search-slot input'); if (el !== null) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } return 1;",
  );
  await tab.settle(500);
  const restoredRows = (await tab.eval(READ.rowTitles)).length;
  check(
    "2b-mute",
    mutedRows === 0 && mutedKind === "filtered" && restoredRows > 0,
    `nav text mute "zzz-no-such-brief" -> rows=${mutedRows} emptyKind=${JSON.stringify(mutedKind)}; cleared -> rows=${restoredRows}`,
  );

  // --- learnings hybrid search through the box ------------------------------
  await tab.hash("#/layers/learnings");
  await tab.until("return document.querySelectorAll('.record-row').length;", { label: "learnings rows" });
  await tab.type(".record-search input", "wrapper");
  await tab.click(".record-filter-run");
  // The first search on a cold host loads the embedding model; the endpoint
  // still answers, but it can take several seconds.
  await tab.until(
    `return [...document.querySelectorAll('.shell-banner, .record-readout')].some(e => /HYBRID|BM25|VECTOR|NONE/.test(e.textContent)) ? 1 : 0;`,
    { timeout: 60_000, label: "search returns and reports a retrieval mode" },
  );
  const searchRows = await tab.eval(READ.rowTitles);
  const searchApi = await apiJson(`${seeded.url}/api/learnings/search?q=wrapper`);
  const kilnAbsent = !searchRows.some((t) => t.includes("Ceramic kiln"));
  check(
    "2c",
    searchRows.length === searchApi.count && kilnAbsent,
    `search "wrapper" DOM rows=${searchRows.length} · endpoint count=${searchApi.count} · zero-overlap row excluded=${kilnAbsent} (mode=${searchApi.retrieval.mode})`,
  );
  note(
    `2c asserts the DOM agrees with the endpoint. It does NOT assert which arm produced ` +
      `the rows — retrieval.mode was ${searchApi.retrieval.mode} here; G-HS-1/G-HS-2 in ` +
      `dashboard-learnings-search.test.ts own the arm attribution.`,
  );

  // --- goals, a third layer through the same control -----------------------
  await tab.hash("#/layers/goals");
  await tab.until("return document.querySelectorAll('.record-row').length;", { label: "goals rows" });
  const goalsAll = (await tab.eval(READ.rowEyes)).length;
  await setFilterChip(tab, "status", "achieved");
  const goalsEyes = await tab.eval(READ.rowEyes);
  const achievedApi = await apiJson(`${seeded.url}/api/goals?status=achieved`);
  check(
    "2d",
    goalsEyes.length === achievedApi.count &&
      goalsEyes.some((e) => e.includes("GL-003")) &&
      !goalsEyes.some((e) => e.includes("GL-001")),
    `goals all=${goalsAll} · status=achieved DOM=${goalsEyes.length} endpoint=${achievedApi.count} · rows=${JSON.stringify(goalsEyes)}`,
  );
}

/**
 * G-BR-3 — the empty, degraded and retrieval-mode states are VISIBLE.
 *
 * PROVES: the four layer views render a DISTINGUISHED empty state per cause
 * (`degraded` on a missing brain, `empty` on an empty one, none at all when
 * there is data), and the learnings view banners its retrieval mode loudly when
 * hybrid recall did not run.
 * DOES NOT PROVE: the copy is right — that is operator review.
 */
async function gBr3(tabs, worlds) {
  gate("G-BR-3", "empty / degraded / retrieval-mode states are visible in pixels");

  const layers = ["briefs", "learnings", "goals"];

  // 3a — MISSING brain: every layer must say `degraded`.
  const missingTab = mut("br3-empty-on-seeded") ? tabs.seeded : tabs.missing;
  const missingKinds = {};
  for (const l of layers) {
    await missingTab.hash(`#/layers/${l}`);
    await missingTab.settle(700);
    missingKinds[l] = await missingTab.eval(READ.emptyKind);
  }
  check(
    "3a",
    layers.every((l) => missingKinds[l] === "degraded"),
    `missing brain -> ${JSON.stringify(missingKinds)}${
      mut("br3-empty-on-seeded") ? "  [MUTATED: read from the SEEDED world]" : ""
    }`,
  );

  // 3b — EMPTY brain: the SAME views, a DIFFERENT kind. This is the
  // assert-then-diff that makes 3a mean something.
  const emptyKinds = {};
  for (const l of layers) {
    await tabs.empty.hash(`#/layers/${l}`);
    await tabs.empty.settle(700);
    emptyKinds[l] = await tabs.empty.eval(READ.emptyKind);
  }
  check(
    "3b",
    layers.every((l) => emptyKinds[l] === "empty") &&
      layers.some((l) => emptyKinds[l] !== missingKinds[l]),
    `empty brain -> ${JSON.stringify(emptyKinds)} (differs from the missing-brain reading)`,
  );

  // 3c — SELF-NEGATIVE-CONTROL for the detector: with data, there is no
  // empty-state element at all. Without this, 3a/3b could both be reading a
  // constant.
  const seededKinds = {};
  for (const l of layers) {
    await tabs.seeded.hash(`#/layers/${l}`);
    await tabs.seeded.until("return document.querySelectorAll('.record-row').length;", {
      label: `${l} rows in the seeded world`,
    });
    seededKinds[l] = await tabs.seeded.eval(READ.emptyKind);
  }
  check(
    "3c",
    layers.every((l) => seededKinds[l] === null),
    `seeded brain -> ${JSON.stringify(seededKinds)} (no empty-state element anywhere)`,
  );

  // 3d — context docs, the layer with NO brain read (D8), and the FOURTH empty
  // kind. `no-project` exists because this layer cannot be read without a scope;
  // without it the view would show `empty`, which reads as "this project has no
  // docs" for a question that was never asked.
  await tabs.seeded.hash("#/layers/context-docs");
  await tabs.seeded.settle(900);
  const scopeNow = await activeProject(tabs.seeded);
  if (scopeNow !== null) await clickProjectChip(tabs.seeded, scopeNow);
  await tabs.seeded.settle(700);
  const noProjKind = await tabs.seeded.eval(READ.emptyKind);
  check(
    "3d-noproject",
    noProjKind === "no-project",
    `context docs with the scope CLEARED -> kind=${JSON.stringify(noProjKind)} (the fourth EmptyKind; all four are now observed)`,
  );

  await clickProjectChip(tabs.seeded, "demo");
  await tabs.seeded.until("return document.querySelectorAll('.record-row').length;", {
    timeout: 15_000,
    label: "context-doc inventory rows",
  });
  const ctxRows = await tabs.seeded.eval(READ.rowEyes);
  const ctxKind = await tabs.seeded.eval(READ.emptyKind);
  check(
    "3d",
    ctxRows.length > 0 && ctxKind === null,
    `context docs scoped to demo -> inventory rows=${ctxRows.length} kind=${JSON.stringify(ctxKind)}`,
  );

  // 3e — the retrieval banner is LOUD when hybrid recall did not run…
  await tabs.seeded.hash("#/layers/learnings");
  await tabs.seeded.until("return document.querySelectorAll('.record-row').length;", {
    label: "learnings rows",
  });
  await tabs.seeded.type(".record-search input", "wrapper");
  await tabs.seeded.click(".record-filter-run");
  await tabs.seeded.until(
    `return [...document.querySelectorAll('.shell-banner, .record-readout')].some(e => /HYBRID|BM25|VECTOR|NONE/.test(e.textContent)) ? 1 : 0;`,
    { timeout: 60_000, label: "retrieval readout" },
  );
  const seededBanners = await tabs.seeded.eval(READ.banners);
  const bm25Api = await apiJson(`${worlds.seeded.url}/api/learnings/search?q=wrapper`);
  const loud = seededBanners.find((b) => /^BM25 ONLY/.test(b)) ?? null;
  check(
    "3e",
    bm25Api.retrieval.mode === "bm25_only" && loud !== null,
    `no learnings_vec -> endpoint mode=${bm25Api.retrieval.mode} · DOM banner=${JSON.stringify(loud === null ? seededBanners : loud.slice(0, 110))}`,
  );

  // 3-hermetic — the network guard is ARMED, asserted rather than assumed.
  // Without this, everything below could be passing because the server quietly
  // downloaded a 90 MB model, which is a side effect no gate declared.
  const herm = hermeticState(worlds.vec);
  check(
    "3-hermetic",
    herm.armed === true,
    `vec server \`env.allowRemoteModels = false\` armed=${herm.armed} reason=${JSON.stringify(herm.reason)} — the HF Hub is unreachable from this run, so a warm LOCAL cache is the only way an embedding can be produced`,
  );

  // …and the vec world, where `vector_available` is TRUE. Which mode it reports
  // then depends on ONE remaining variable — whether a local MiniLM cache
  // exists — and the gate asserts the mode is CONSISTENT with that capability
  // rather than assuming one branch.
  await tabs.vec.hash("#/layers/learnings");
  await tabs.vec.until("return document.querySelectorAll('.record-row').length;", {
    label: "learnings rows (vec world)",
  });
  await tabs.vec.type(".record-search input", "wrapper");
  await tabs.vec.click(".record-filter-run");
  await tabs.vec.until(
    `return [...document.querySelectorAll('.shell-banner, .record-readout')].some(e => /HYBRID|BM25|VECTOR|NONE/.test(e.textContent)) ? 1 : 0;`,
    { timeout: 60_000, label: "retrieval readout (vec world)" },
  );
  const vecBanners = await tabs.vec.eval(READ.banners);
  const vecReadouts = await tabs.vec.eval(READ.readouts);
  const vecApi = await apiJson(`${worlds.vec.url}/api/learnings/search?q=wrapper`);
  const vecLoud = vecBanners.some((b) => /^BM25 ONLY/.test(b));
  const vecQuiet = vecReadouts.some((r) => /HYBRID/.test(r));
  const vecRet = vecApi.retrieval;
  const embeddable = vecRet.embedding_available === true;

  // 3f — the FIELD-SEPARATION contract, asserted in the browser's own world:
  // `vector_available` reports the CONNECTION (the extension loaded and the
  // index is queryable) and MUST be true here regardless of the model, while
  // `mode` reports what actually ran. Both directions can fail: `hybrid` with no
  // embedding, or `bm25_only` with one, are both reported as FAIL.
  check(
    "3f",
    vecRet.vector_available === true &&
      vecRet.mode === (embeddable ? "hybrid" : "bm25_only"),
    `learnings_vec present -> vector_available=${vecRet.vector_available} embedding_available=${embeddable} mode=${vecRet.mode} (must be ${embeddable ? "hybrid" : "bm25_only"}) reason=${JSON.stringify(vecRet.reason)}`,
  );

  if (embeddable) {
    // A local cache exists, so the HYBRID arm really ran: the banner must go
    // QUIET. This is 3e's assert-then-diff partner.
    check(
      "3f-hybrid",
      !vecLoud && vecQuiet,
      `hybrid ran -> loud banner=${vecLoud} · quiet readout=${vecQuiet} (${JSON.stringify(vecReadouts.filter((r) => /HYBRID/.test(r)))})`,
    );
    skip(
      "3f-loud",
      "the vec world reached HYBRID, so its embedding-missing degradation is not on this run's path (3e covers the no-index degradation)",
    );
  } else {
    // No local cache and no network. That is a REAL production state — an
    // offline host, or any freshly built tree, since `copy-templates.sh` wipes
    // the package-local model cache. It must be LOUD, and it is a DIFFERENT
    // cause from 3e's (no index at all) with `vector_available` still true.
    check(
      "3f-loud",
      vecLoud && !vecQuiet,
      `no local model cache -> the degradation is loud in the DOM too: banner=${JSON.stringify((vecBanners.find((b) => /^BM25 ONLY/.test(b)) ?? "").slice(0, 110))} · HYBRID readout=${vecQuiet}`,
    );
    skip(
      "3f-hybrid",
      "no local MiniLM cache under cli/dist (copy-templates.sh wipes it on every build) and the hermetic preload forbids the ~90 MB Hub fetch, so the HYBRID-quiet rendering was NOT exercised END-TO-END here. The COMPONENT is covered by record.test.tsx (\"hybrid renders a quiet readout, NOT a banner\"); what is unexercised is the page-level wiring of a hybrid value — see the note below",
    );
  }

  note(
    "3e/3f are an assert-then-diff PAIR over the retrieval MODE: `vector_available` " +
      "and `mode` are separate fields and the gate asserts their relationship, so a " +
      "pass cannot come from a banner that always renders. The `vec` world's vectors " +
      "are deterministic, not real embeddings — this proves the MODE plumbing, never " +
      "recall quality.",
  );
  note(
    "STATED LIMIT (learning 1095). This gate NEVER downloads a model: the server " +
      "runs with `allowRemoteModels = false`, asserted by 3-hermetic. On a tree " +
      "built in the normal way there is therefore no embedding backend, so exactly " +
      "one of 3f-hybrid / 3f-loud runs and the other is SKIPPED with its reason. " +
      "The unexercised arm on a cold tree is the PAGE-LEVEL WIRING of a quiet " +
      "hybrid readout. Siblings, stated precisely (learning 1095): " +
      "`record.test.tsx` (\"hybrid renders a quiet readout, NOT a banner\") DOES " +
      "cover the component's hybrid rendering via react-dom/server; " +
      "`dashboard-learnings-search.test.ts` proves the endpoint's field separation " +
      "offline; `memory-read.test.ts` proves the recall semantics. What none of " +
      "them covers is this page passing a hybrid `retrieval` value through to that " +
      "component — and note 3f-loud DOES exercise that same wiring for the " +
      "bm25_only value, so the residual gap is the hybrid value on that path only. To " +
      "exercise it deliberately, warm the package-local cache ONCE (this one DOES " +
      "hit the network, ~90 MB) and re-run:\n" +
      "                  node --input-type=module -e \"const m = await import('./cli/dist/brain-mcp-server/dist/utils/embeddings.js'); await m.generateEmbedding('warm');\"\n" +
      "                  node cli/scripts/browser-gate.mjs\n" +
      "                  — 3f-hybrid then runs and 3f-loud is the one that skips. The next " +
      "`npm run build` wipes the cache again (copy-templates.sh:98).",
  );
}

/**
 * G-BR-4 — no idling render loop, and the palettes really differ.
 *
 * PROVES (4a): across a 3-second quiet window on each of the four layer views,
 * ZERO `requestAnimationFrame` callbacks and ZERO canvas clears run, measured
 * by instruments installed BEFORE the bundle.
 * DOES NOT PROVE: that DOM mutations are zero. They are not, by design — the
 * layer lists follow the shell's 5-second `live.tick` beat. The mutation count
 * is MEASURED and printed rather than asserted, because asserting 0 there would
 * be asserting the refetch away.
 * (4c) re-runs the FR-239 stillness checkpoint verbatim, because FR-240 hoisted
 * `graphCache` out of `pages/Graph.tsx` and that cache is AC-load-bearing there.
 */
async function gBr4(tabs) {
  gate("G-BR-4", "no render loop · palettes differ · FR-239 stillness re-run");

  // 4a — the four layer views at rest.
  for (const l of ["briefs", "learnings", "context-docs", "goals"]) {
    // The mutation points the FIRST reading at the graph — a surface that is
    // known to move — without changing anything else. It exercises both halves:
    // `awaitQuiet` cannot reach rest, and the 3s window reads non-zero.
    const moving = mut("br4-measure-motion") && l === "briefs";
    await tabs.seeded.hash(moving ? "#/graph" : `#/layers/${l}`);
    if (moving) {
      await tabs.seeded.until("return document.querySelector('.graph-canvas-host canvas') !== null ? 1 : 0;", {
        timeout: 45_000,
        label: "graph canvas (MUTATED 4a target)",
      });
    } else
    // SYNCHRONISE ON THE VIEW BEING THERE, then sleep. Not the other way round.
    //
    // This used to be `settle(900)` alone, and it FLAKED — measured 2 failures
    // in 5 runs during the FR-240 warden pass, always `4a-briefs` (the FIRST
    // view visited, the one that pays the endpoint round trip) and always the
    // same `rAF +17 · clearRect +0 · mut +0`: a fixed ~280 ms row-entrance
    // animation that had not finished before the window opened. The check was
    // therefore measuring a view still ARRIVING while claiming to measure one AT
    // REST, and a guard that reds 40% of the time for the wrong reason teaches
    // people to re-run reds — which is worse than not having it.
    //
    // `.record-row` OR an empty-state, because `context-docs` starts scoped and
    // three of the four worlds can legitimately render no rows.
    await tabs.seeded.until(
      "return (document.querySelectorAll('.record-row').length > 0 || document.querySelector('[data-empty-kind]') !== null) ? 1 : 0;",
      { timeout: 20_000, label: `${l} view rendered` },
    );
    await tabs.seeded.settle(400);
    // Then wait for QUIET before opening the window. See `awaitQuiet`: a surface
    // that never reaches rest fails here, loudly, with its observed rate.
    const q = await tabs.seeded.awaitQuiet(moving ? { window: 400, tries: 4 } : {});
    const vis = await tabs.seeded.eval(
      "return document.visibilityState + '/' + (document.hasFocus() ? 'focused' : 'blurred');",
    );
    const d = await tabs.seeded.witnessDelta(3000);
    check(
      `4a-${l}`,
      q.quiet === true && d.raf === 0 && d.clearRect === 0 && vis.startsWith("visible"),
      q.quiet
        ? `${l} at rest for 3s [tab ${vis}, quiet after ${q.waited}ms]: rAF +${d.raf} · clearRect +${d.clearRect} · DOM mutations +${d.mut} (mutations are the live beat, not asserted)`
        : `${l} NEVER REACHED REST — still running ~${q.rate} rAF callbacks per 400 ms after ${q.waited}ms of waiting; the 3s window then read rAF +${d.raf} · clearRect +${d.clearRect}${
            moving ? "  [MUTATED: measured the GRAPH, a surface known to move]" : ""
          }`,
    );
  }

  // 4b — NEGATIVE CONTROL FOR THE INSTRUMENT. If the counters cannot move, 4a's
  // zeros are worthless. The graph entrance is a surface known to move.
  await tabs.seeded.hash("#/graph");
  const moving = await tabs.seeded.witnessDelta(2500);
  check(
    "4b",
    moving.raf > 0 && moving.clearRect > 0,
    `graph entrance (a surface known to move): rAF +${moving.raf} · clearRect +${moving.clearRect} — the instrument CAN report motion`,
  );

  // 4c — the FR-239 checkpoint, unchanged, after the graphCache hoist.
  await tabs.seeded.until("return window.__igrisGraphStillness !== undefined ? 1 : 0;", {
    timeout: 45_000,
    label: "graph diagnostic",
  });
  await tabs.seeded.until(
    "return window.__igrisGraphStillness.state() === 'still' ? 1 : 0;",
    { timeout: 60_000, label: "graph settles to still" },
  );
  const atRest = await tabs.seeded.eval(
    "return window.__igrisGraphStillness.probe(3000);",
  );
  const restWitness = await tabs.seeded.witnessDelta(3000);
  const appPaintsBefore = await tabs.seeded.eval("return window.__igrisGraphStillness.paints();");
  await sleep(3000);
  const appPaintsAfter = await tabs.seeded.eval("return window.__igrisGraphStillness.paints();");
  check(
    "4c-rest",
    atRest.identical === true &&
      restWitness.raf === 0 &&
      restWitness.clearRect === 0 &&
      appPaintsAfter - appPaintsBefore === 0,
    `AT REST: probe identical=${atRest.identical} samples=${atRest.samples} · independent rAF +${restWitness.raf} clearRect +${restWitness.clearRect} · app paints +${appPaintsAfter - appPaintsBefore}`,
  );

  // 4c-live — STILL is not DEAD. The wake-up path exercised here is a REAL
  // POINTER on the canvas host, which is the path the FR-239 defect broke; a
  // palette switch would have passed while the canvas was dead.
  const canvasBox = await tabs.seeded.eval(`
    const host = document.querySelector('.graph-canvas-host');
    if (host === null) return null;
    const r = host.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  `);
  const beforeMove = await tabs.seeded.instrument();
  await tabs.seeded.moveTo(canvasBox.x - 40, canvasBox.y - 20);
  await tabs.seeded.moveTo(canvasBox.x, canvasBox.y);
  await sleep(600);
  const afterMove = await tabs.seeded.instrument();
  check(
    "4c-live",
    afterMove.clearRect - beforeMove.clearRect > 0,
    `POINTER over the canvas: clearRect +${afterMove.clearRect - beforeMove.clearRect} · rAF +${afterMove.raf - beforeMove.raf} — the canvas is ALIVE, not merely still`,
  );

  // 4c-click — the exact FR-239 defect: a click on the centred node must
  // SELECT, never deselect. The focused node was centred by `graph.select`.
  await tabs.seeded.hash("#/graph?focus=brief/demo/FR-240");
  await tabs.seeded.until(has(".graph-inspector-title"), {
    timeout: 45_000,
    label: "focus selects",
  });
  await tabs.seeded.click(".graph-inspector-close");
  const afterClose = await tabs.seeded.eval(READ.inspectorTitle);
  const box2 = await tabs.seeded.eval(`
    const host = document.querySelector('.graph-canvas-host');
    const r = host.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  await tabs.seeded.moveTo(box2.x, box2.y);
  await sleep(400);
  await tabs.seeded.clickAt(box2.x, box2.y);
  await sleep(600);
  const afterClick = await tabs.seeded.eval(READ.inspectorTitle);
  check(
    "4c-click",
    afterClose === null && afterClick !== null,
    `deselect -> inspector=${JSON.stringify(afterClose)}; click the centred node -> inspector=${JSON.stringify(afterClick)} (a DEAD canvas reads null here — the FR-239 defect)`,
  );

  // 4d — palettes. FR-240 declares ZERO custom properties (it dereferences the
  // role tokens directly), which is what makes the FR-239 `:root` cascade bug
  // unreachable by construction — so there is nothing named `--record-*` to
  // read. The gate therefore reads the resolved COLOURS instead.
  await tabs.seeded.hash("#/layers/briefs");
  await tabs.seeded.until("return document.querySelectorAll('.record-row').length;", {
    label: "briefs rows",
  });
  const readColours = `
    const eye = document.querySelector('.record-row-eye');
    const title = document.querySelector('.record-row-title');
    const filters = document.querySelector('.record-filters');
    if (eye === null || title === null || filters === null) return null;
    const ce = getComputedStyle(eye), ct = getComputedStyle(title), cf = getComputedStyle(filters);
    return {
      palette: document.body.dataset.palette,
      accent: ce.color,
      fg: ct.color,
      line: cf.borderBottomColor,
      // A palette-INDEPENDENT reading, so a probe returning noise is detectable.
      invariant: ce.letterSpacing,
    };
  `;
  const palettes = ["blood", "cyber", "acid", "mono"];
  const readings = [];
  for (const p of palettes) {
    await setPalette(tabs.seeded, mut("br4-same-palette") ? "blood" : p);
    await tabs.seeded.settle(250);
    readings.push(await tabs.seeded.eval(readColours));
  }
  const tuples = readings.map((r) => `${r.accent}|${r.fg}|${r.line}`);
  const distinct = new Set(tuples).size;
  check(
    "4d",
    distinct === 4,
    `computed .record-* colours across ${palettes.join("/")}: ${distinct}/4 distinct${
      mut("br4-same-palette") ? "  [MUTATED: read `blood` four times]" : ""
    }\n                  ${readings.map((r) => `${r.palette}: accent=${r.accent} fg=${r.fg}`).join("\n                  ")}`,
  );
  const invariants = new Set(readings.map((r) => r.invariant));
  check(
    "4d-nc",
    invariants.size === 1,
    `palette-INDEPENDENT reading (.record-row-eye letter-spacing) stayed ${[...invariants].join(",")} across all four — the probe is not returning noise`,
  );
  const repeat = [];
  await setPalette(tabs.seeded, "cyber");
  await tabs.seeded.settle(250);
  repeat.push(await tabs.seeded.eval(readColours));
  await tabs.seeded.settle(250);
  repeat.push(await tabs.seeded.eval(readColours));
  check(
    "4d-nc2",
    repeat[0].accent === repeat[1].accent && repeat[0].fg === repeat[1].fg,
    `re-reading the SAME palette twice is identical (${repeat[0].accent}) — so 4d's four differences are caused by the palette`,
  );
  await setPalette(tabs.seeded, "blood");
}

/**
 * G-BR-5 — prove ACCESS, not bytes (learning 1096).
 *
 * PROVES: the operator can READ a specific brief's body, a specific learning's
 * content and a context doc's text in the live DOM, and that two different
 * records render two different bodies.
 * DOES NOT PROVE: markdown fidelity or XSS safety — `markdown/__tests__/` own
 * both, including the tag allowlist.
 */
async function gBr5(tab) {
  gate("G-BR-5", "prove ACCESS, not bytes — the body text is readable in the DOM");

  const BRIEF_SENTENCE = mut("br5-absent-text")
    ? "This sentence is not in the fixture at all."
    : "Mount four read-only browse views in the dashboard shell.";

  await tab.hash("#/layers/briefs/demo/FR-240");
  await tab.until(has(".record-detail-body"), { label: "brief body" });
  const briefBody = await tab.eval(READ.detailBody);
  const mdHeading = await tab.eval(
    `const e = document.querySelector('.record-detail-body .record-md-h'); return e === null ? null : e.tagName + ':' + e.textContent.trim();`,
  );
  check(
    "5a",
    briefBody !== null && briefBody.includes(BRIEF_SENTENCE),
    `brief body ${briefBody === null ? "MISSING" : `${briefBody.length} chars`}, contains the asserted sentence=${briefBody !== null && briefBody.includes(BRIEF_SENTENCE)}${
      mut("br5-absent-text") ? "  [MUTATED: asserting a sentence not in the fixture]" : ""
    }`,
  );
  // The claim is exactly "a heading ELEMENT rendered" — not which level. The
  // renderer offsets levels so a body `#` cannot outrank the page's own `h2`,
  // and pinning the level here would restate a mapping `Markdown.test.tsx` owns.
  check(
    "5a-md",
    mdHeading !== null && /^H[1-6]:/.test(mdHeading),
    `the markdown RAN (heading element = ${JSON.stringify(mdHeading)}), so the body is parsed React elements, not a text dump`,
  );

  // 5b — a DIFFERENT brief renders a DIFFERENT body. Assert-then-diff, so 5a
  // cannot be satisfied by a body slot showing a constant.
  await tab.hash("#/layers/briefs/demo/BR-001");
  await tab.until(has(".record-detail-title"), { label: "BR-001 detail" });
  await tab.settle(400);
  const otherBody = await tab.eval(READ.detailBody);
  const note1 = await tab.eval(
    `const e = document.querySelector('.record-note'); return e === null ? null : e.textContent.trim();`,
  );
  check(
    "5b",
    otherBody !== briefBody,
    `BR-001 (no brief_files row) body=${JSON.stringify((otherBody ?? note1 ?? "").slice(0, 80))} — differs from FR-240's`,
  );

  // 5c — a learning's content.
  await tab.hash("#/layers/learnings/demo/1");
  await tab.until(has(".record-detail-body"), { label: "learning body" });
  const learnBody = await tab.eval(READ.detailBody);
  check(
    "5c",
    learnBody !== null &&
      learnBody.includes("The MCP handler becomes a thin wrapper over the pure reader."),
    `learning 1 body = ${JSON.stringify((learnBody ?? "").slice(0, 90))}`,
  );

  // 5d — a context doc read from DISK (D8 — no brain involvement).
  await tab.hash("#/layers/context-docs");
  await tab.settle(900);
  const docRow = await tab.eval(`
    const rows = [...document.querySelectorAll('.record-row')];
    const r = rows.find(x => x.textContent.includes('coding_guidelines'));
    if (r === undefined) return null;
    r.scrollIntoView({ block: 'center' });
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  `);
  if (docRow === null) {
    check("5d", false, "no coding_guidelines row in the context-doc inventory");
  } else {
    await tab.clickAt(docRow.x, docRow.y);
    await tab.until(has(".record-detail-body"), { timeout: 15_000, label: "doc body" });
    const docBody = await tab.eval(READ.detailBody);
    check(
      "5d",
      docBody !== null &&
        docBody.includes("The browser must be able to READ this sentence, not merely receive it."),
      `context doc body = ${JSON.stringify((docBody ?? "").slice(0, 90))}`,
    );
  }
}

/**
 * G-BR-6 — `prefers-reduced-motion`, which only a browser can report.
 *
 * PROVES: under emulated `reduce` the media query matches in the page and the
 * global PRM block collapses animation to `0s`; and with emulation CLEARED the
 * same reads come back non-zero, so the check is not reading a constant.
 * DOES NOT PROVE: that every individual animation is gated in JS — `Cursor.tsx`
 * and `graph/instance.ts` have their own unit coverage (`motion.test.ts` T17).
 */
async function gBr6(tab) {
  gate("G-BR-6", "prefers-reduced-motion, measured in the page");

  const readMotion = `
    const h1 = document.querySelector('.shell-h1') ?? document.querySelector('h1');
    const row = document.querySelector('.record-row');
    if (h1 === null || row === null) return null;
    return {
      matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animation: getComputedStyle(h1).animationDuration,
      transition: getComputedStyle(row).transitionDuration,
    };
  `;

  await tab.reducedMotion(false);
  await tab.hash("#/layers/briefs");
  await tab.until("return document.querySelectorAll('.record-row').length;", { label: "briefs rows" });
  const normal = await tab.eval(readMotion);

  if (!mut("br6-no-emulation")) await tab.reducedMotion(true);
  await tab.settle(400);
  const reduced = await tab.eval(readMotion);

  check(
    "6a",
    reduced.matches === true && reduced.transition === "0.05s",
    `reduce emulated -> matchMedia=${reduced.matches} animation=${reduced.animation} transition=${reduced.transition}${
      mut("br6-no-emulation") ? "  [MUTATED: emulation never set]" : ""
    }`,
  );
  check(
    "6b",
    normal.matches === false && normal.transition !== reduced.transition,
    `NEGATIVE CONTROL — no emulation -> matchMedia=${normal.matches} transition=${normal.transition}, which DIFFERS from the reduced reading`,
  );
  await tab.reducedMotion(false);
}

/**
 * G-BR-7 — DRILL IN, BACK OUT. The hoisted scope cache, in a real browser.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * FR-240 phase 3 hoisted the scope cache out of `pages/Graph.tsx` into
 * `lib/graphCache.ts` so a record detail and the graph page share one
 * `/api/graph` read (D6). The behaviour that hoist must not break is FR-239's,
 * and it is AC-load-bearing THERE: *"Backing out restores the cached whole-brain
 * payload AND its settled positions, so it is a page transition rather than a
 * second entrance"* (`pages/Graph.tsx`'s D6 header). G-BR-4c re-runs the FR-239
 * stillness checkpoint, which is a DIFFERENT property — a settled canvas reads
 * still whether or not the positions survived the round trip.
 *
 * PROVES
 *   7a  A drill is a real scope change and a real read: the readout changes and
 *       EXACTLY ONE new `/api/graph` request leaves the page.
 *   7b  Backing out issues ZERO new `/api/graph` requests and restores the
 *       whole-brain readout — the payload came from the shared cache.
 *   7c  NEGATIVE CONTROL for 7b: REFRESH on the very same surface issues exactly
 *       one. So 7b's zero is a measured zero, not a counter that cannot move.
 *   7d  The back-out's first painted frame is already where it settles, while
 *       the REFRESH's is not — positions restored versus a second entrance,
 *       measured in pixels with 7c's refresh as the paired control.
 *
 * DOES NOT PROVE
 *   The cache's own mechanics — sharing, the `positions` reset, per-scope
 *   isolation, the `force` in-flight join. **Sibling:**
 *   `cli/dashboard/src/lib/__tests__/graphCache.test.ts`, which asserts all four
 *   against a stubbed `api.graph`.
 *   Nor that the RESTORED coordinates equal the pre-drill ones to the pixel.
 *   They cannot be read from the page (`__igrisGraphStillness` exposes
 *   `probe`/`state`/`paints` and nothing positional), and a settled-frame
 *   comparison would NOT discriminate: d3-force initialises unplaced nodes
 *   deterministically, so a cold re-layout of the same node array converges to
 *   the same picture. What separates the two cases is the JOURNEY, which is what
 *   7d measures.
 */
async function gBr7(tab) {
  gate("G-BR-7", "drill in / back out — the hoisted scope cache, in a real browser");

  const stillnessReady = "return window.__igrisGraphStillness !== undefined ? 1 : 0;";
  const isStill = "return window.__igrisGraphStillness.state() === 'still' ? 1 : 0;";
  const settleGraph = async (label) => {
    await tab.until(stillnessReady, { timeout: 45_000, label: `${label}: graph mounts` });
    await tab.until(isStill, { timeout: 60_000, label: `${label}: settles` });
  };
  const graphFetches = async () => (await tab.instrument()).graphFetch;
  /*
   * FR-244 — the canvas BOX, read at every stage of the transition.
   *
   * A MEASUREMENT, not a check, and it earns its place: `7d` compares ink
   * spread on a 24x24 grid laid over the canvas, so the grid's cells are only
   * square when the canvas is. If the canvas were to RESIZE part-way through a
   * transition, the opening frames and the settled reference would be measured
   * in different units and `7d` would be reading its own instrument rather than
   * the layout. FR-244 gave the canvas the vertical column, which changes its
   * box — so the box is now printed at each stage and a reader can see whether
   * it held still. It must be IDENTICAL across a drill and a back-out.
   */
  const canvasBox = async () =>
    tab.eval(`
      const c = document.querySelector('.graph-canvas-host canvas');
      return c === null ? null : c.width + 'x' + c.height;
    `);

  // A FRESH DOCUMENT. The cache is module-level and outlives components on
  // purpose, so earlier gates have already warmed both scopes; measuring "was
  // this fetched?" needs a page where nothing has been.
  await tab.hash("#/graph");
  await tab.reload();
  await settleGraph("whole brain");
  // NO reference frame is captured here on purpose. A settled-frame comparison
  // CANNOT discriminate a restored layout from a cold one — d3-force's cold
  // layout for a fixed node array is deterministic, so both converge to the same
  // picture. 7d reads opening-vs-settled ink SPREAD within each arm instead; see
  // the STATED LIMIT note below.
  const wholeReadout = await tab.eval(READ.graphReadout);
  const boxWhole = await canvasBox();
  const gWhole = await graphFetches();
  check(
    "7-pre",
    gWhole === 1 && wholeReadout !== null,
    `fresh document -> /api/graph requests=${gWhole} · readout=${JSON.stringify(wholeReadout)} (the counter starts from a known 1, so every delta below is measured)`,
  );

  // 7a — DRILL. A real scope change: `// SLOW`, one new read.
  await graphDrill(tab, "demo");
  await tab.until(textOtherThan(".graph-readout", wholeReadout), {
    timeout: 30_000,
    label: "the drilled readout",
  });
  await settleGraph("demo scope");
  const demoReadout = await tab.eval(READ.graphReadout);
  const boxDemo = await canvasBox();
  const gDemo = await graphFetches();
  check(
    "7a",
    gDemo - gWhole === 1 && demoReadout !== wholeReadout,
    `drill to demo -> +${gDemo - gWhole} /api/graph · readout ${JSON.stringify(wholeReadout)} -> ${JSON.stringify(demoReadout)}`,
  );

  // 7b — BACK OUT via the WHOLE BRAIN crumb. Served from the shared cache, so
  // ZERO new reads. The ink recorder runs across the transition for 7d.
  await tab.startInk();
  await tab.click(".graph-crumb", { settle: false });
  await sleep(1600);
  const backSamples = await tab.stopInk();
  if (mut("br7-refetch-backout")) {
    // The injected defect: pay for the payload again, which is exactly what the
    // hoist exists to avoid. 7b must notice.
    await clickButton(tab, "REFRESH");
  }
  await tab.until(textOtherThan(".graph-readout", demoReadout), {
    timeout: 30_000,
    label: "the backed-out readout",
  });
  await settleGraph("back out");
  const backSettledInk = await tab.sampleInk();
  // The dicing geometry the samples were taken under. Read once, AFTER the
  // first sampler run, and reused for every reading in this gate so both arms
  // are expressed in the same units (FR-244).
  const inkCell = await tab.inkMeta();
  const backSettledSpread = inkSpread(backSettledInk, inkCell);
  const backReadout = await tab.eval(READ.graphReadout);
  const boxBack = await canvasBox();
  const gBack = await graphFetches();
  check(
    "7b",
    gBack - gDemo === 0 && backReadout === wholeReadout,
    `back out -> +${gBack - gDemo} /api/graph (the shared cache answered) · readout back to ${JSON.stringify(backReadout)}${
      mut("br7-refetch-backout") ? "  [MUTATED: REFRESH clicked during the back-out]" : ""
    }`,
  );

  // 7c — the same surface, a REFRESH: the counter CAN move, and `force:true`
  // resets `positions`, so this is also 7d's cold-layout control.
  await tab.startInk();
  await clickButton(tab, "REFRESH", { settle: false });
  await sleep(1600);
  const refreshSamples = await tab.stopInk();
  await settleGraph("after refresh");
  const coldSettledSpread = inkSpread(await tab.sampleInk(), inkCell);
  const gRefresh = await graphFetches();
  check(
    "7c",
    gRefresh - gBack === 1,
    `NEGATIVE CONTROL — REFRESH on the SAME surface -> +${gRefresh - gBack} /api/graph, so 7b's zero is a measured zero`,
  );

  note(
    `canvas backing store across the transition: whole-brain ${boxWhole} · drilled ${boxDemo} · ` +
      `backed-out ${boxBack} · after refresh ${await canvasBox()}. 7d's grid is 24x24 over THIS box ` +
      `(cells ${inkCell === null ? "n/a" : `${inkCell.cw.toFixed(1)}x${inkCell.ch.toFixed(1)}px`}), and since FR-244 the spread is weighted by those cell ` +
      `dimensions, so the reading is a PIXEL distance and does not move with the canvas's aspect. A ` +
      `box that moved mid-transition would still change what the two arms are compared across. ` +
      `${boxWhole === boxDemo && boxDemo === boxBack ? "It held." : "IT MOVED — treat 7d's reading as suspect."}`,
  );

  /*
   * 7d's OWN MUTATION (FR-244). Until this existed, `7d` was the one check on
   * this surface with no demonstrated failing counterpart — `br7-refetch-backout`
   * breaks `7b`, the FETCH COUNT, and says nothing about the pixel reading.
   * That gap is why the FR-244 metric repair could not be validated at first:
   * there was no independent control to prove a rewritten metric kept its
   * sensitivity.
   *
   * THE INJECTED DEFECT: the back-out arm's ink is taken from the COLD REFRESH
   * transition. That is not a fabricated number — it is a real re-entrance,
   * measured on the same canvas, in the same run, through the same sampler, and
   * it is precisely the shape a back-out would have if it lost its position
   * seed and re-ran the entrance. Same idiom as `br4-measure-motion` (measure a
   * surface known to move) and `br11-measure-at-blob-zoom` (measure a zoom
   * known to merge).
   *
   * It costs no extra `/api/graph`, so `7a`/`7b`/`7c` stay green and `7d` is the
   * only thing that moves — which is what makes it a clean control.
   *
   * WHAT IT PROVES, precisely: that `7d`'s ABSOLUTE bound bites. The back arm
   * reads its real cold value (~62%) against the 0.75 floor. WHAT IT DOES NOT
   * PROVE: the separation bound in a non-trivial way — with both arms drawn
   * from one sample set the separation is identically 0, so that half fails
   * arithmetically rather than by measurement. The absolute half is the
   * load-bearing one here, and it is a genuine reading.
   */
  const reEntranced = mut("br7-backout-re-entrances");
  const backInk = reEntranced ? refreshSamples : backSamples;
  const backRef = reEntranced ? coldSettledSpread : backSettledSpread;

  // 7d — restored versus re-entranced, in pixels.
  const back = inkCollapse(backInk, backRef, inkCell);
  const cold = inkCollapse(refreshSamples, coldSettledSpread, inkCell);
  if (back === null || cold === null) {
    check(
      "7d",
      false,
      `ink spread unreadable (back=${JSON.stringify(back)} cold=${JSON.stringify(cold)}) — the canvas produced too few ink-bearing frames in the window`,
    );
  } else {
    check(
      "7d",
      back.collapse > 0.75 && back.collapse - cold.collapse > 0.15,
      `${reEntranced ? "[MUTATED: the back-out arm's ink was taken from the COLD REFRESH — a real re-entrance] " : ""}opening layout extent vs settled — BACK-OUT ${pct(back.collapse)} (opening mean ${back.early} over ${back.opening} frames, min ${back.min}, settled ${back.settled}), COLD REFRESH ${pct(cold.collapse)} (opening mean ${cold.early} over ${cold.opening}, min ${cold.min}, settled ${cold.settled}). The back-out opens NEAR its settled extent; the cold refresh opens as a clump at the origin and expands out of it.`,
    );
  }
  note(
    "7d is a PAIRED reading, not a tolerance: the same measurement over the same " +
      "surface with only the position seed differing. Both absolute numbers are " +
      "printed so a future regression shows up as a drift rather than only as a flip. " +
      "The settled extents repeat to three decimals because d3-force is deterministic " +
      "— that is the mechanical reason this metric is stable.",
  );
  note(
    "FR-244 RE-BASELINE, 2026-08-02, WITH THE ASPECT-CORRECTED METRIC — AND IT STILL DOES NOT " +
      "HOLD. READ THIS BEFORE TOUCHING THE THRESHOLDS. Five full runs after the FR-244 layout " +
      "reflow AND the `inkSpread` pixel-weighting repair: back-out 72.0-75.0% (72.0, 74.5 x2, " +
      "75.0 x2), cold 59.2-62.5%, separation 9.5-15.8pp. Worst case still violates both bounds — " +
      "72.0% against the 0.75 floor and 9.5pp against the 15pp separation. For comparison, the " +
      "FR-240 figures this replaces were back-out 84.3-85.3%, cold 61.2-61.9%, worst-case " +
      "separation 22.4pp, taken with the aspect-COUPLED metric on the pre-reflow canvas.",
  );
  note(
    "WHAT WAS FIXED AND WHAT IT BOUGHT. `inkSpread` accumulated its moments in grid-cell INDEX " +
      "units, treating every cell as a unit square, so it was silently coupled to the canvas " +
      "ASPECT — see the function header for the mechanism. That is repaired (moments weighted by " +
      "cell pixel size), and the repair was validated the only way a metric change can honestly " +
      "be validated: `--mutate=br7-backout-re-entrances` was built FIRST, proven RED against the " +
      "OLD metric at the OLD layout where 7d was green (83.7% -> 57.5%), and proven still RED " +
      "after the repair (58.2%). The repair moved the worst-case separation from 6.5pp to 9.5pp " +
      "and, at a matched canvas box, restored the reading to its historical band — but it did not " +
      "clear the thresholds.",
  );
  note(
    "THE RESIDUAL, MEASURED, because the next reader will want to know whether the metric or the " +
      "surface is at fault. (1) The SIZE LAW is innocent: with the layout reverted and " +
      "`nodeWorldSize` kept, 7d reads 84.1%/56.4% and 81.5%/57.9% on the old metric and 80.8%/57.8% " +
      "on the corrected one — green either way. The brief predicted the radius change would move " +
      "7d; the experiment says it does not. (2) THIS GATE DOES NOT RUN AT 1440x900, despite the " +
      "window size the harness passes Chrome: headless chrome is included in that figure, so the " +
      "CONTENT box is ~1058x813 and the canvas here is 1058x423. Under an explicit " +
      "`setViewport(1440, 900)` the canvas is 1058x510 — within 8px of the pre-FR-244 1058x502 — " +
      "and 7d read 81.3%/59.2% (22.1pp, PASS) and 77.6%/62.7% (14.9pp, FAIL) on two runs. So at " +
      "the viewport this file's header claims, the reflow barely moves the canvas at all. (3) What " +
      "those numbers also show is that 7d's separation now has a ~7pp run-to-run spread on this " +
      "world against a 15pp threshold, where FR-240 recorded 0.7-1.0pp. The metric has become " +
      "marginal here, and a threshold is not the thing to change about that.",
  );
  note(
    "WHAT WAS DELIBERATELY NOT DONE, TWICE OVER. The thresholds are UNTOUCHED at 0.75/0.15 — " +
      "widening them would destroy the only pixel-level gate on the FR-240 scope-cache behaviour. " +
      "And G-BR-7 was NOT moved to an emulated 1440x900 viewport, even though the reading above " +
      "says that would very likely clear it: changing the CONDITIONS a gate measures under, in the " +
      "same breath as discovering it is red, is the same move as widening the threshold wearing a " +
      "different hat. It is reported for an operator to decide, not taken. NOTE WHAT IS STILL " +
      "GREEN AND CARRIES THE ACTUAL BEHAVIOUR: 7b (the back-out issues ZERO new /api/graph) and 7c " +
      "(its measured control) both pass, and `--mutate=br7-refetch-backout` still fails 7b on " +
      "purpose. The scope cache works. What is in question is whether this pixel proxy still " +
      "discriminates on a canvas of this size.",
  );
  note(
    "OPERATOR DISPOSITION, 2026-08-02: 7d SHIPS RED, KNOWINGLY, AND TD-332 OWNS IT. This is not " +
      "an unnoticed regression and it is not an oversight — it was put to the operator with four " +
      "options (fix the viewport, ship red, downgrade 7d to advisory, revert the layout) and they " +
      "chose to ship red rather than let anything about the measurement move while it was failing. " +
      "One instrument repair had already been made in this same brief, and a second — on the " +
      "conditions rather than the metric — was judged one repair too many to trust in a single " +
      "pass. IF YOU ARE READING THIS BECAUSE 7d IS RED: that is the expected state; see TD-332 " +
      "before diagnosing. IF 7d IS GREEN AND YOU DID NOT FIX IT: that is the surprising state — " +
      "something changed the canvas box or the world, and TD-332's measurements are the baseline " +
      "to compare against. This gate is MANUAL-ONLY (verified 2026-08-02: no pre-commit hook and " +
      "no CI workflow invokes browser-gate.mjs), so a red 7d blocks no commit and no pipeline — " +
      "which is precisely why it needs a brief attached rather than a red line everyone learns to " +
      "scroll past.",
  );
  note(
    "A CONSEQUENCE OF SHIPPING 7d RED, found by sentinel 2026-08-02 and owned by TD-332: " +
      "`--mutate=br7-backout-re-entrances`'s HARNESS VERDICT is now structurally uninformative. " +
      "The harness inverts a mutation run by checking whether the predicted gate id appears in " +
      "`failed`; it does not diff against an unmutated baseline. Because 7d fails WITHOUT the " +
      "mutation, the run prints 'PASS (mutation caught)' for a reason that has nothing to do with " +
      "the injected defect — it would print that even if the mutation did nothing at all. This is " +
      "the vacuity class of learning 1094 raised one level: not a check that cannot fail, but a " +
      "CONTROL that cannot distinguish. The mutation itself is sound and was verified by its " +
      "NUMBERS, not its verdict — back-out 74.1% -> 59.2%, both arms collapsing to identical " +
      "readings (105.017 / 177.368). Judge it that way until TD-332 makes 7d green again, and if " +
      "you add a baseline-diff to the mutation harness, do it there rather than here.",
  );
  note(
    "STATED LIMIT (learning 1095). The back-out reads ~85%, NOT ~100%, and that is " +
      "the real behaviour rather than a tolerance: `instance.ts` seeds coordinates " +
      "but does not FIX them (no `fx`/`fy`), so the simulation restarts at alpha=1 " +
      "from the seeded configuration and relaxes further — the settled extent itself " +
      "moves (6.73 seeded vs 6.12 cold here). So what this gate proves is that a " +
      "back-out OPENS at its settled extent instead of expanding into it. It does " +
      "NOT prove the restored coordinates equal the pre-drill ones; nothing in the " +
      "page exposes coordinates, and a settled-frame comparison cannot discriminate " +
      "because d3-force's cold layout for a fixed node array is deterministic. " +
      "The cache MECHANICS are the sibling: " +
      "`cli/dashboard/src/lib/__tests__/graphCache.test.ts`.",
  );
}

/**
 * G-BR-8 — FR-241: THE TRIAGE SURFACE, CLICKED.
 *
 * PROVES, in a real browser against a real brain:
 *   8a  the Suggestions tab's rendered row count agrees with `/api/suggestions`
 *       for the scope the page selected, and selection checkboxes exist;
 *   8b  the Candidates tab marks the tier-3 rows on the ROW, before any dialog
 *       opens — an aggregate cannot tell you which row to untick;
 *   8c  CANCEL issues **no** request and changes **no** row (the independent
 *       `__gate.triagePost` counter is the witness, not the server log);
 *   8d  the dialog's hard-delete count is the TIER-3 SUBSET of a mixed
 *       selection, not the selection size — the blanket-"irreversible" lie;
 *   8e  a tier-3 bulk needs the count TYPED, and once confirmed the rows leave
 *       the list AND the endpoint's own count drops by the same number;
 *   8f  a world whose write surface is unavailable renders the queue but NO
 *       write control (*disabled, not broken*).
 *
 * DOES NOT PROVE: what the mutation does to `event_log` (that is
 * `dashboard-triage-parity.test.ts`, two processes, a real differ), nor the
 * gateway's input contract (`dashboard-triage-endpoint.test.ts` G-TR-6).
 *
 * NOTE ON THE WORLD: this gate runs on `triage`, whose brain is built by the
 * ENGINE's own migrations. The `seeded` world CANNOT be used — the write engine
 * throws `duplicate column name: archetype` on the hand-rolled FR-240 schema,
 * so every check here would observe `TRIAGE DISABLED` and pass for the wrong
 * reason. See `seedTriageWorld`.
 */
async function gBr8(tabs, worlds) {
  gate("G-BR-8", "cognition triage — select, confirm, cancel, and mutate");

  const tab = tabs.triage;
  const world = worlds.triage;

  // --- 8a: the Suggestions tab is wired to the endpoint ---------------------
  await tab.hash("#/triage");
  await tab.until(has(".triage-bulk"), { label: "the triage bulk bar mounts" });
  await untilListStable(tab);

  const scope = await activeProject(tab);
  const rows = await tab.eval(READ.rowTitles);
  const api = await apiJson(
    `${world.url}/api/suggestions?status=pending&project=${encodeURIComponent(scope ?? "")}`,
  );
  const boxes = await tab.eval(
    "return document.querySelectorAll('.record-select').length;",
  );
  check(
    "8a",
    scope !== null && rows.length === api.count && boxes === rows.length,
    `scoped to project=${JSON.stringify(scope)} · DOM rows=${rows.length} · endpoint count=${api.count} · checkboxes=${boxes}`,
  );
  note(
    `8a asserts the READ half agrees with the endpoint. The queue is project-scoped ` +
      `by DEFAULT (D5): the world seeds 6 pending on demo and 2 on other, so a page ` +
      `that ignored the scope chip would report 8 here.`,
  );

  // --- 8b: the tier is visible ON THE ROW ----------------------------------
  await clickButton(tab, "Candidates", { scroll: true });
  await tab.until(has(".record-select"), { label: "candidate rows" });
  await untilListStable(tab);
  const badges = await tab.eval(
    "return [...document.querySelectorAll('.record-row-badges')].map(e => e.textContent.trim());",
  );
  const permanent = badges.filter((b) => b.includes("reject = PERMANENT")).length;
  const recurring = badges.filter((b) => b.includes("recurring")).length;
  check(
    "8b",
    permanent === 3 && recurring === 2,
    `row badges: ${permanent} marked "reject = PERMANENT" (seeded 3 with seen_again_count=0), ` +
      `${recurring} marked recurring (seeded 2) · ${JSON.stringify(badges)}`,
  );

  /** Tick the checkbox on the row whose title contains `text`. */
  const selectRow = async (text) => {
    const box = await tab.eval(`
      const li = [...document.querySelectorAll('.record-list > li')]
        .find(x => (x.querySelector('.record-row-title')?.textContent ?? '').includes(${JSON.stringify(text)}));
      if (li === undefined) return null;
      const cb = li.querySelector('.record-select');
      if (cb === null) return null;
      cb.scrollIntoView({ block: 'center' });
      const r = cb.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (box === null) throw new Error(`no selectable row matching "${text}"`);
    await tab.clickAt(box.x, box.y);
  };

  // A MIXED selection: 2 first-time (tier 3) + 1 recurring (tier 2). Only a
  // mixed one can catch a dialog that reports the selection size.
  await selectRow("first-time candidate 1");
  await selectRow("first-time candidate 2");
  await selectRow("recurring candidate 4");
  const selected = await tab.eval(
    "const e = document.querySelector('.triage-bulk'); return e === null ? null : e.getAttribute('data-selected');",
  );
  check("8b-sel", selected === "3", `bulk bar reports data-selected=${selected} (expected 3)`);

  // --- 8c: CANCEL issues NO request ----------------------------------------
  const beforePosts = (await tab.instrument()).triagePost;
  const beforeApi = await apiJson(
    `${world.url}/api/learnings?review_status=pending_review&project=demo`,
  );
  await clickButton(tab, "REJECT", { scroll: true });
  try {
    await tab.until(has(".triage-confirm"), {
      label: "the confirm dialog opens",
      timeout: 8_000,
    });
  } catch (err) {
    // A "the dialog did not open" timeout has three very different causes — a
    // disabled button, an empty selection, and a control outside the viewport —
    // and the bare timeout distinguishes none of them. This DIAG line is what
    // identified the third (the bulk bar at `y = -125.5`); it is kept so the
    // next reader gets the reading instead of re-deriving it.
    note(
      "DIAG " +
        JSON.stringify(
          await tab.eval(`
      return {
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim() + (b.disabled ? '[disabled]' : '')),
        selected: document.querySelector('.triage-bulk')?.getAttribute('data-selected'),
        bulkRect: (() => { const e = document.querySelector('.triage-bulk'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
      };
    `),
        ),
    );
    throw err;
  }

  // The dialog, on screen, in pixels. A screenshot is the artifact a reviewer
  // can read without re-running anything.
  const shot = await tab.send("Page.captureScreenshot", { format: "png" });
  note(`8c captured the confirm dialog (${Math.round(shot.data.length / 1365)} KB png, discarded)`);

  if (mut("br8-cancel-is-a-confirm")) {
    // The injected defect is "the dialog MUTATED on dismissal". Reaching that
    // state needs the typed confirmation entered first — a `disabled` CONFIRM
    // does nothing when clicked, and a first draft of this mutation was
    // reported VACUOUS for exactly that reason: it "clicked" a dead button, no
    // POST was issued, and 8c passed. Which is itself a finding worth keeping:
    // the disabled attribute really is load-bearing.
    await tab.type(".triage-confirm .field input", "2");
    await tab.settle(300);
    await clickButton(tab, "DELETE 2 PERMANENTLY", { scroll: true });
  } else {
    await clickButton(tab, "CANCEL", { scroll: true });
  }
  await tab.settle(1200);
  const afterPosts = (await tab.instrument()).triagePost;
  const afterApi = await apiJson(
    `${world.url}/api/learnings?review_status=pending_review&project=demo`,
  );
  check(
    "8c",
    afterPosts === beforePosts && afterApi.total === beforeApi.total,
    `CANCEL -> triage POSTs ${beforePosts} -> ${afterPosts} (independent in-page counter) · ` +
      `pending candidates ${beforeApi.total} -> ${afterApi.total}${
        mut("br8-cancel-is-a-confirm") ? "  [MUTATED: clicked CONFIRM instead of CANCEL]" : ""
      }`,
  );

  // --- 8d: the count is the TIER-3 SUBSET, not the selection ---------------
  await clickButton(tab, "REJECT", { scroll: true });
  await tab.until(has(".triage-confirm"), { label: "the confirm dialog re-opens" });
  const dialog = await tab.eval(`
    const d = document.querySelector('.triage-confirm');
    if (d === null) return null;
    return {
      hardDelete: Number(d.getAttribute('data-hard-delete')),
      danger: (d.querySelector('.triage-danger')?.textContent ?? '').trim(),
      lines: [...d.querySelectorAll('.triage-confirm-line')].map(e => e.textContent.trim()),
      typedLabel: [...d.querySelectorAll('label')].map(e => e.textContent.trim()).join(' | '),
      confirmDisabled: [...d.querySelectorAll('button')]
        .filter(b => b.textContent.includes('PERMANENTLY'))
        .map(b => b.disabled),
    };
  `);
  const expectedHard = mut("br8-count-from-selection") ? 3 : 2;
  check(
    "8d",
    dialog !== null && dialog.hardDelete === expectedHard,
    `mixed selection of 3 (2 first-time + 1 recurring) -> dialog reports ` +
      `${dialog?.hardDelete} permanent deletions (expected ${expectedHard})${
        mut("br8-count-from-selection") ? "  [MUTATED: expecting the SELECTION SIZE]" : ""
      } · danger line: ${JSON.stringify(dialog?.danger)}`,
  );
  check(
    "8d-sentence",
    dialog !== null &&
      dialog.danger.includes("PERMANENTLY DELETED") &&
      dialog.danger.includes("cannot be undone") &&
      dialog.lines[dialog.lines.length - 1] === dialog.danger &&
      dialog.lines.length === 2,
    `the tier-3 sentence is its OWN line and is LAST: ${JSON.stringify(dialog?.lines)}`,
  );
  check(
    "8d-typed",
    dialog !== null &&
      dialog.typedLabel.includes("type 2 to confirm") &&
      dialog.confirmDisabled.every((d) => d === true),
    `a tier-3 BULK demands the count typed and leaves CONFIRM disabled: ` +
      `label=${JSON.stringify(dialog?.typedLabel)} confirmDisabled=${JSON.stringify(dialog?.confirmDisabled)}`,
  );

  // --- 8e: typing the count enables CONFIRM, and the mutation LANDS --------
  const bulkIds = mut("br8-bulk-on-empty") ? [] : [1, 2, 4];
  if (mut("br8-bulk-on-empty")) {
    // Deselect everything, which closes the dialog — the mutation drives the
    // vacuous shape (a bulk action on zero items) on purpose.
    await clickButton(tab, "CLEAR", { scroll: true });
    await tab.settle(500);
  }
  const preTotal = (
    await apiJson(`${world.url}/api/learnings?review_status=pending_review&project=demo`)
  ).total;

  if (!mut("br8-bulk-on-empty")) {
    await tab.type(".triage-confirm input[type=text], .triage-confirm .field input", "2");
    await tab.settle(300);
    await clickButton(tab, "DELETE 2 PERMANENTLY", { scroll: true });
    await tab.settle(1200);
    await untilListStable(tab);
  }

  const postTotal = (
    await apiJson(`${world.url}/api/learnings?review_status=pending_review&project=demo`)
  ).total;
  const posts = (await tab.instrument()).triagePost;
  check(
    "8e",
    // PRE-STATE, POST-STATE **and** DELTA — the three assertions that keep a
    // bulk gate from being the drain-test-on-an-empty-queue this brief names.
    preTotal === 5 && postTotal === 2 && preTotal - postTotal === bulkIds.length,
    `pending candidates ${preTotal} -> ${postTotal} (delta ${preTotal - postTotal}, ` +
      `expected ${bulkIds.length} for ids ${JSON.stringify(bulkIds)}) · triage POSTs so far ${posts}${
        mut("br8-bulk-on-empty") ? "  [MUTATED: bulk fired on an EMPTY selection]" : ""
      }`,
  );
  const remaining = await tab.eval(READ.rowTitles);
  check(
    "8e-rows",
    remaining.length === postTotal &&
      !remaining.some((t) => t.includes("first-time candidate 1")) &&
      !remaining.some((t) => t.includes("recurring candidate 4")),
    `the acted-on rows left the list · remaining=${JSON.stringify(remaining)}`,
  );

  // --- 8f: a down write surface renders NO write control -------------------
  const downTab = tabs.missing;
  await downTab.hash("#/triage");
  await downTab.until(has(".shell-banner"), { label: "the triage page mounts (missing world)" });
  const down = await downTab.eval(`
    const banners = [...document.querySelectorAll('.shell-banner')].map(e => e.textContent.trim());
    return {
      banners,
      bulkBar: document.querySelector('.triage-bulk') !== null,
      rejectButton: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'REJECT'),
    };
  `);
  const wantAffordance = mut("br8-write-affordance-when-down");
  check(
    "8f",
    down.banners.some((b) => b.includes("TRIAGE DISABLED")) &&
      down.bulkBar === wantAffordance &&
      down.rejectButton === wantAffordance,
    `write surface down -> TRIAGE DISABLED banner present, bulk bar=${down.bulkBar}, ` +
      `REJECT button=${down.rejectButton} (expected ${wantAffordance})${
        wantAffordance ? "  [MUTATED: expecting the affordances to be PRESENT]" : ""
      }`,
  );
  check(
    "8f-control",
    (await tab.eval("return document.querySelector('.triage-bulk') !== null;")) === true,
    `NEGATIVE CONTROL — the same page in the TRIAGE world still has its bulk bar, ` +
      `so 8f's absence is caused by the write surface and not by the page failing to mount`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * G-BR-9 — BR-082. The Overview's scope CLEARS, and the clear SURVIVES the beat.
 *
 * PROVES: the Overview opens scoped to `default_project`; re-clicking the
 * checked chip clears the scope to `everything`; all three card metrics widen
 * to the values the UNSCOPED endpoints report; and that widened state is still
 * on screen after the page has issued at least TWO further `/api/health` polls
 * and TWO further `/api/summary` reads.
 *
 * DOES NOT PROVE: that the shared hook's `undefined`-vs-`null` distinction is
 * the MECHANISM. This gate reads a page, not a state machine — it would pass
 * for any implementation that keeps the clear. The mechanism's siblings are
 * `cli/src/__tests__/dashboard-layers-source.test.ts` (there is exactly ONE
 * scope implementation and Overview consumes it) and the hook's own docblock.
 * Nor does it prove the numbers are RIGHT: it asserts DOM-vs-endpoint agreement,
 * and `dashboard-server.test.ts` owns what the endpoint should say.
 *
 * WHY TWO BEATS AND NOT A SETTLE. The FR-240 defect this brief is a sequel to
 * was undone by the 5-second `live.tick`: the clear held for a moment and the
 * ladder re-applied on the next poll (measured 3 rows -> 4 rows on the click,
 * then back to 3 at t+2 s). A single post-click assertion is therefore this
 * brief's named vacuous gate, and a `sleep(11_000)` is barely better — a
 * sleeping tab that has been BACKGROUNDED stops polling entirely (`useLive`
 * pauses on `document.hidden`), so "nothing changed" would be a reading of a
 * frozen page. The window is closed on OBSERVED REQUEST COUNTS from an
 * independent in-page counter, the tab's `visibilityState` is asserted, and a
 * window that never sees its two beats FAILS with the counts it did see.
 */
async function gBr9(tab, seeded) {
  gate("G-BR-9", "Overview: the scope clears, and the clear survives the live beat (BR-082)");

  await tab.hash("#/overview");
  const read = () => tab.eval(READ_OVERVIEW);

  // The endpoints, read out-of-band. Every DOM number below is compared with
  // the server's own answer for the SAME scope rather than with a literal.
  const scopedApi = await apiJson(`${seeded.url}/api/summary?project=demo`);
  const allApi = await apiJson(`${seeded.url}/api/summary`);
  const scopedGraph = await apiJson(`${seeded.url}/api/graph/stats?project=demo`);
  const allGraph = await apiJson(`${seeded.url}/api/graph/stats`);

  // --- 9a — it opens SCOPED, exactly as it always did ----------------------
  const scoped = await pollFor(read, (v) => v.briefs !== null && v.instances !== null);
  check(
    "9a",
    scoped.scope === "demo" &&
      scoped.chip === "demo" &&
      scoped.briefs === scopedApi.briefs.total &&
      scoped.instances === scopedApi.instances.active,
    `opens scoped: data-scope=${JSON.stringify(scoped.scope)} chip=${JSON.stringify(scoped.chip)} · ` +
      `briefs DOM=${scoped.briefs} endpoint=${scopedApi.briefs.total} · ` +
      `instances DOM=${scoped.instances} endpoint=${scopedApi.instances.active}`,
  );

  // --- 9b — the clear is possible AT ALL, and every card widens ------------
  // The bug BR-082 fixes is that this click had no effect to observe: the chip
  // strip was a radiogroup whose only action was `setSelected(slug)`.
  await clickProjectChip(tab, "demo");
  const wantBriefs = mut("br9-count-from-scoped")
    ? scopedApi.briefs.total
    : allApi.briefs.total;
  const cleared = await pollFor(
    read,
    (v) => v.scope === "everything" && v.briefs === wantBriefs,
  );
  check(
    "9b",
    cleared.scope === "everything" &&
      cleared.chip === null &&
      cleared.footer === "everything" &&
      cleared.briefs === wantBriefs &&
      cleared.briefs > scoped.briefs &&
      cleared.instances === allApi.instances.active &&
      cleared.instances > scoped.instances,
    `cleared -> data-scope=${JSON.stringify(cleared.scope)} checked chip=${JSON.stringify(cleared.chip)} footer=${JSON.stringify(cleared.footer)} · ` +
      `briefs ${scoped.briefs} -> ${cleared.briefs} (endpoint ${allApi.briefs.total}) · ` +
      `instances ${scoped.instances} -> ${cleared.instances} (endpoint ${allApi.instances.active})` +
      (mut("br9-count-from-scoped")
        ? `  [MUTATED: compared against the SCOPED total ${scopedApi.briefs.total}]`
        : ""),
  );

  // The graph card needed NO server change — `/api/graph/stats` already
  // answered unscoped. Its own check, so "the widening reached the card the
  // page never had to fix" is legible separately from the two that changed.
  check(
    "9b-graph",
    cleared.graph === allGraph.stats.node_count &&
      cleared.graph >= scopedGraph.stats.node_count,
    `graph nodes DOM=${cleared.graph} · unscoped endpoint=${allGraph.stats.node_count} · scoped endpoint=${scopedGraph.stats.node_count}`,
  );

  // --- 9c — THE GATE: the clear survives at least TWO live beats -----------
  const t0 = Date.now();
  const before = await tab.instrument();
  const beats = (g) => g.healthFetch - before.healthFetch;
  const reads = (g) => g.summaryFetch - before.summaryFetch;

  // First beat, then the injected defect, then the second beat. The halves are
  // identical in a clean run; the split exists so the mutation lands INSIDE the
  // window rather than before it, which is the only placement that tests
  // whether the LATE reading is the load-bearing one.
  await pollFor(() => tab.instrument(), (g) => beats(g) >= 1 && reads(g) >= 1, {
    timeout: 15_000,
  });
  if (mut("br9-rescope-during-window")) {
    await clickProjectChip(tab, "demo");
  }
  // TWO conditions, both required, because they say different things. Two
  // OBSERVED beats is the behavioural one — the effect that would re-apply the
  // ladder has now run twice. The 10 s floor is the literal one: two whole
  // `DEFAULT_POLL_MS` intervals of wall clock, so the window cannot be
  // satisfied by two polls that happen to land 1.3 s apart around its opening.
  const FLOOR_MS = 2 * 5_000;
  const witnessed = await pollFor(
    () => tab.instrument(),
    (g) => beats(g) >= 2 && reads(g) >= 2 && Date.now() - t0 >= FLOOR_MS,
    { timeout: 30_000 },
  );
  const after = await read();
  const elapsed = Date.now() - t0;

  // The PRECONDITION, asserted rather than assumed. If the tab were hidden or
  // the beat had stopped, "nothing changed" would be a reading of a frozen
  // page — so this fails with the counts it actually observed.
  check(
    "9c-live",
    after.visibility === "visible" &&
      beats(witnessed) >= 2 &&
      reads(witnessed) >= 2 &&
      elapsed >= FLOOR_MS,
    `window was LIVE: visibilityState=${after.visibility} · /api/health +${beats(witnessed)} · ` +
      `/api/summary +${reads(witnessed)} over ${elapsed} ms (>= ${FLOOR_MS} ms floor; tick is 5 s)`,
  );

  check(
    "9c",
    after.scope === "everything" &&
      after.chip === null &&
      after.briefs === allApi.briefs.total &&
      after.instances === allApi.instances.active,
    `after ${beats(witnessed)} beats / ${elapsed} ms the scope is STILL cleared: ` +
      `data-scope=${JSON.stringify(after.scope)} chip=${JSON.stringify(after.chip)} · ` +
      `briefs=${after.briefs} (endpoint ${allApi.briefs.total}) · instances=${after.instances}` +
      (mut("br9-rescope-during-window")
        ? "  [MUTATED: the project was re-selected inside the window]"
        : ""),
  );

  note(
    `9c proves the cleared scope is still cleared after at least two beats of the live tick. ` +
      `PRECISION on the witness, because an earlier draft of this note named the wrong one: the ` +
      `ladder lives in useProjectScope's [tick] effect, which fetches /api/projects — NOT the ` +
      `${reads(witnessed)} summary reads counted here, which belong to Overview's own ` +
      `[project, tick] effect. They are SIBLINGS on the same tick. What carries the inference is ` +
      `the separately-asserted healthFetch >= 2: health polling is what advances tick, and both ` +
      `effects declare tick, so two observed beats means the ladder effect ran twice. The summary ` +
      `count witnesses that the SCOPE-BEARING read re-ran with the cleared value. It does NOT ` +
      `prove WHICH state the hook holds — dashboard-layers-source.test.ts pins that there is only ` +
      `one implementation, and useProjectScope.ts's docblock records why the third state exists.`,
  );

  // Leave the page scoped again, so this gate ends where it started.
  await clickProjectChip(tab, "demo");
}

/**
 * G-BR-10 — TD-326. The project-less queue is STATED, REACHABLE and ACTIONABLE.
 *
 * PROVES, in a real browser against a real brain:
 *   10a  while scoped to a PROJECT, the page states the count of pending
 *        suggestions that belong to NO project — and states the brain-level
 *        count, not the all-projects total;
 *   10b  the `(brain-level)` chip is in the SAME scope strip, and selecting it
 *        lists exactly the project-less rows (a count that is neither the
 *        scoped one nor the unscoped one);
 *   10c  that selection SURVIVES the live beat — the default-project ladder
 *        re-runs on every `/api/projects` poll and must not overwrite a scope
 *        value it does not recognise;
 *   10d  a bulk DISMISS under that scope empties the project-less queue and
 *        leaves the project's queue untouched (FR-241 D5, under the new scope);
 *   10e  the Candidates tab under `brain-level` states the schema reason it is
 *        empty instead of issuing a request with a param that endpoint would
 *        drop.
 *
 * THE POPULATION IS ASSERTED NON-EMPTY FIRST (10a-live). This brief's named
 * vacuous gate is a check that passes because there happened to be zero
 * project-less rows: every count below would then be 0, the banner would
 * legitimately be absent, and 10d's "the queue emptied" would be a no-op.
 *
 * DOES NOT PROVE: what the endpoint SHOULD answer — that is
 * `dashboard-layers-endpoint.test.ts` G-EP-4 and the reader's own suite. Nor
 * that the chip is the only affordance; it asserts the DOM agrees with the
 * endpoint for the scope it selected.
 *
 * WORLD: `triage`, and it MUTATES — so it runs after G-BR-8, which reads
 * `/api/suggestions?project=demo` and would see a drained queue otherwise.
 */
async function gBr10(tab, world) {
  gate("G-BR-10", "TD-326: the project-less queue — stated, reachable, actionable");

  // A fresh document: G-BR-8 left this tab on the Candidates sub-tab, and the
  // sub-tab is component state that `location.hash` cannot address.
  await tab.reload();
  await tab.until(has(".triage-bulk"), { label: "the triage bulk bar mounts" });
  await untilListStable(tab);

  const scope = await activeProject(tab);
  const q = (extra) => `${world.url}/api/suggestions?status=pending&${extra}`;
  const scopedApi = await apiJson(q(`project=${encodeURIComponent(scope ?? "")}`));
  const brainApi = await apiJson(q("project_scope=brain-level"));
  const allApi = await apiJson(q(""));

  const READ_TRIAGE = `
    const g = [...document.querySelectorAll('[role=radiogroup]')]
      .find(x => x.getAttribute('aria-label') === 'Project scope');
    const buttons = g === undefined ? [] : [...g.querySelectorAll('button')];
    const banner = document.querySelector('.shell-banner[data-brain-level]');
    return {
      // Radiogroups labelled 'Project scope' SPECIFICALLY. The page has others
      // (FilterBar renders one per filter control), so an unqualified count
      // reads 5 on a correct page — measured.
      groups: [...document.querySelectorAll('[role=radiogroup]')]
        .filter(x => x.getAttribute('aria-label') === 'Project scope').length,
      chips: buttons.map(b => b.textContent.trim()),
      checked: (buttons.find(b => b.getAttribute('aria-checked') === 'true') || {textContent: ''}).textContent.trim() || null,
      bannerCount: banner === null ? null : Number(banner.getAttribute('data-brain-level')),
      bannerText: banner === null ? null : banner.textContent.trim().replace(/\\s+/g, ' '),
      rows: [...document.querySelectorAll('.record-row-title')].map(e => e.textContent.trim()),
      selected: (document.querySelector('.triage-bulk') || {getAttribute: () => null}).getAttribute('data-selected'),
      visibility: document.visibilityState,
    };
  `;
  const read = () => tab.eval(READ_TRIAGE);

  // --- 10a-live: the three populations are DISTINCT and none is empty -------
  // Without this the rest is unfalsifiable: if brain-level were 0 the banner
  // would correctly be absent and every later count would be trivially equal.
  check(
    "10a-live",
    brainApi.total > 0 &&
      scopedApi.total > 0 &&
      brainApi.total !== scopedApi.total &&
      brainApi.total !== allApi.total &&
      allApi.total === scopedApi.total + brainApi.total + 2,
    `endpoint populations: scoped(${scope})=${scopedApi.total} · brain-level=${brainApi.total} · ` +
      `everything=${allApi.total} (the +2 is the 'other' project, which is in NEITHER of the first two — ` +
      `'all projects' and 'brain-level' are different sets and this is the arithmetic that says so)`,
  );

  // --- 10a: the hidden count is stated WHILE SCOPED ------------------------
  const scoped = await read();
  const wantBanner = mut("br10-count-from-unscoped") ? allApi.total : brainApi.total;
  check(
    "10a",
    scoped.checked === scope &&
      scoped.bannerCount === wantBanner &&
      scoped.bannerCount !== scopedApi.total &&
      (scoped.bannerText ?? "").includes("belong to NO project"),
    `scoped to ${JSON.stringify(scoped.checked)} · banner data-brain-level=${scoped.bannerCount} ` +
      `(expected ${wantBanner}; brain-level endpoint=${brainApi.total}, all-projects endpoint=${allApi.total}) · ` +
      `rows on screen=${scoped.rows.length}` +
      (mut("br10-count-from-unscoped")
        ? `  [MUTATED: expecting the ALL-PROJECTS total ${allApi.total}]`
        : ""),
  );
  check(
    "10a-chip",
    scoped.groups === 1 && scoped.chips.includes("(brain-level)"),
    `ONE radiogroup labelled "Project scope" (${scoped.groups}; the page's other ` +
      `radiogroups are FilterBar's) whose chips are ${JSON.stringify(scoped.chips)} — the ` +
      `affordance is in the same strip as the projects, so "which scope is active" has one answer`,
  );

  // --- 10b: selecting it lists EXACTLY the project-less rows ---------------
  await clickProjectChip(tab, "(brain-level)");
  await untilListStable(tab);
  const brain = await read();
  check(
    "10b",
    brain.checked === "(brain-level)" &&
      brain.rows.length === brainApi.total &&
      brain.rows.length !== scopedApi.total &&
      brain.rows.length !== allApi.total &&
      brain.rows.every((t) => t.startsWith("brain-level ")),
    `checked=${JSON.stringify(brain.checked)} · DOM rows=${brain.rows.length} · ` +
      `brain-level endpoint=${brainApi.total} (scoped ${scopedApi.total}, everything ${allApi.total}) · ` +
      `titles=${JSON.stringify(brain.rows)}`,
  );
  check(
    "10b-banner",
    brain.bannerCount === brainApi.total &&
      (brain.bannerText ?? "").includes("cannot reach a row owned by any project"),
    `under the scope the banner restates the count and the D5 consequence: ` +
      `data-brain-level=${brain.bannerCount} · ${JSON.stringify(brain.bannerText)}`,
  );

  // --- 10c: THE GATE — the choice survives the ladder's own poll -----------
  // `(brain-level)` is not in `/api/projects`, so the ladder's membership test
  // rejects it unless the hook exempts it explicitly. That effect fires on
  // every `live.tick`, which is exactly how the FR-240 clear was undone.
  const t0 = Date.now();
  const before = await tab.instrument();
  const ladder = (g) => g.projectsFetch - before.projectsFetch;
  const lists = (g) => g.suggestionsFetch - before.suggestionsFetch;

  await pollFor(() => tab.instrument(), (g) => ladder(g) >= 1, { timeout: 15_000 });
  if (mut("br10-rescope-during-window")) {
    await clickProjectChip(tab, scope ?? "demo");
  }
  const FLOOR_MS = 2 * 5_000;
  const witnessed = await pollFor(
    () => tab.instrument(),
    (g) => ladder(g) >= 2 && lists(g) >= 2 && Date.now() - t0 >= FLOOR_MS,
    { timeout: 30_000 },
  );
  const after = await read();
  const elapsed = Date.now() - t0;

  check(
    "10c-live",
    after.visibility === "visible" &&
      ladder(witnessed) >= 2 &&
      lists(witnessed) >= 2 &&
      elapsed >= FLOOR_MS,
    `window was LIVE: visibilityState=${after.visibility} · /api/projects +${ladder(witnessed)} ` +
      `(the LADDER's own request, so this is a direct witness rather than an inference) · ` +
      `/api/suggestions +${lists(witnessed)} over ${elapsed} ms (>= ${FLOOR_MS} ms floor; tick is 5 s)`,
  );
  check(
    "10c",
    after.checked === "(brain-level)" && after.rows.length === brainApi.total,
    `after ${ladder(witnessed)} ladder runs / ${elapsed} ms the scope is STILL brain-level: ` +
      `checked=${JSON.stringify(after.checked)} · rows=${after.rows.length} (endpoint ${brainApi.total})` +
      (mut("br10-rescope-during-window")
        ? "  [MUTATED: the project was re-selected inside the window]"
        : ""),
  );

  // --- 10d: it is BULK-TRIAGEABLE, and only it ----------------------------
  await clickButton(tab, "SELECT PAGE", { scroll: true });
  await tab.settle(400);
  const selected = (await read()).selected;
  check(
    "10d-sel",
    selected === String(brainApi.total),
    `SELECT PAGE under brain-level selected ${selected} rows (the ${brainApi.total} listed, ` +
      `never the ${allApi.total} matching) — the FR-241 page bound, unchanged by the new scope`,
  );

  const postsBefore = (await tab.instrument()).triagePost;
  await clickButton(tab, "DISMISS", { scroll: true });
  await tab.until(has(".triage-confirm"), { label: "the dismiss dialog opens" });
  // `dismiss` REQUIRES a reason — the suppression-loop signal. Typing it is
  // part of the affordance, so the gate exercises it rather than routing round.
  await tab.type(".triage-confirm .field input", "edge inferences reviewed");
  await tab.settle(300);
  await clickButton(tab, `DISMISS ${brainApi.total}`, { scroll: true });
  await tab.settle(1500);
  await untilListStable(tab);

  const brainAfter = await apiJson(q("project_scope=brain-level"));
  const scopedAfter = await apiJson(q(`project=${encodeURIComponent(scope ?? "")}`));
  const wantScopedAfter = mut("br10-bulk-spans-projects") ? 0 : scopedApi.total;
  check(
    "10d",
    brainAfter.total === 0 &&
      brainApi.total - brainAfter.total === brainApi.total &&
      scopedAfter.total === wantScopedAfter &&
      (await tab.instrument()).triagePost === postsBefore + 1,
    `brain-level pending ${brainApi.total} -> ${brainAfter.total} (delta ${brainApi.total - brainAfter.total}) · ` +
      `the ${JSON.stringify(scope)} queue ${scopedApi.total} -> ${scopedAfter.total} (expected ${wantScopedAfter}) · ` +
      `one POST issued` +
      (mut("br10-bulk-spans-projects")
        ? "  [MUTATED: expecting the project's queue to have been emptied too]"
        : ""),
  );
  note(
    `10d is the D5 claim under the NEW scope: a bulk here reaches STRICTLY FEWER rows than clearing ` +
      `the scope would (${brainApi.total} of ${allApi.total}), and by construction none of them belongs to a ` +
      `project. The two-process audit-trail half is dashboard-triage-parity.test.ts; the server-side ` +
      `mutation half is dashboard-triage-endpoint.test.ts G-TR-7.`,
  );

  // --- 10e: the Candidates tab states WHY it is empty here ----------------
  await clickButton(tab, "Candidates", { scroll: true });
  await tab.settle(600);
  const cand = await tab.eval(`
    const s = document.querySelector('.state-page');
    return {
      meta: s === null ? null : (s.querySelector('.state-page-meta') || {textContent:''}).textContent.trim(),
      message: s === null ? null : (s.querySelector('.state-page-message') || {textContent:''}).textContent.trim(),
      rows: document.querySelectorAll('.record-row-title').length,
    };
  `);
  check(
    "10e",
    (cand.meta ?? "").includes("learnings.project is NOT NULL") && cand.rows === 0,
    `brain-level + Candidates -> a stated empty category rather than a request: ` +
      `meta=${JSON.stringify(cand.meta)} rows=${cand.rows}`,
  );
  note(
    `10e records a MEASUREMENT the brief asked for and a correction to it. The brief said perception ` +
      `candidates carry no NULL project as an observation with nothing enforcing it. They cannot: ` +
      `\`learnings.project\` is NOT NULL in db.ts:156 and PRAGMA table_info on the operator brain ` +
      `reports notnull:1, with 0 of 13 pending rows NULL or empty. So this is a schema guarantee, the ` +
      `same class as brief_status.project — not a reading of today's data.`,
  );
}

// ---------------------------------------------------------------------------
// FR-244 — the separability instrument
// ---------------------------------------------------------------------------

/**
 * G-BR-11's thresholds. Every one is set from the MEASURED sweep recorded in
 * the gate's closing `note()`, never picked to make a run pass.
 */

/**
 * 11a — the component count at the measured low zoom, as a fraction of the
 * count at FIT.
 *
 * Not 100%: nothing claims a zoom-out is free. Two nodes whose world distance
 * is genuinely below the size floor's reach merge at ANY constant size, and the
 * clamped divisor freezes the picture rather than improving it. What the floor
 * asserts is that the great majority of distinct things stay distinct — which
 * is exactly the property that failed before the fix.
 */
const SEPARABLE_BLOB_RATIO = 0.6;

/**
 * The zoom levels the sweep visits, as divisors of the MEASURED `k_fit`.
 *
 * Relative to `k_fit` rather than absolute because `k_fit` is a property of the
 * payload and the canvas box, and both move (the FR-244 layout reflow moves the
 * box on purpose). What is being measured is how the picture degrades as the
 * operator zooms OUT FROM THE VIEW THEY WERE GIVEN, which is a ratio.
 *
 * The dense end is fine-grained because the merge onset lives there: the first
 * exploratory run put the whole picture at ONE component by k_fit/3.8, so a
 * coarse sweep would have stepped straight over the transition it exists to
 * find.
 */
const SWEEP_DIVISORS = [1.5, 2, 3, 4, 8, 16];

/** Which sweep step 11a asserts at. `k_fit/2` is one comfortable zoom-out. */
const LOW_ZOOM_DIVISOR = 2;

/** 11a — no single component may own this much of the field's ink. */
const SEPARABLE_LARGEST_SHARE = 0.25;

/**
 * 11b — how far the MEASURED component deficit at FIT may sit from the seeded
 * edge count. The two agreed exactly (710 - 352 = 358 components) on every run
 * recorded, so the tolerance is headroom for a layout that nudges one pair
 * apart, not slack the assertion needs.
 */
const MERGE_DEFICIT_TOLERANCE = 0.1;

/** 11c — how much of the space below its own top edge the canvas must own. */
const COLUMN_FILL_FRACTION = 0.9;

/**
 * The `height: clamp(420px, 62vh, 900px)` ceiling `.graph-surface` carried
 * before FR-244. Named here so `11c-tall` reads as "the cap is GONE" rather
 * than as an arbitrary pixel comparison.
 */
const RETIRED_SURFACE_CLAMP_MAX_PX = 900;

/**
 * ONE separability reading of the graph canvas, at whatever zoom it is at.
 *
 * WHAT IT MEASURES, and why this metric rather than a prettier one.
 * The complaint FR-244 answers is *"zoomed out it is an unreadable blob"*, and
 * "blob" has an exact meaning in pixels: distinct nodes have stopped being
 * distinct CONNECTED REGIONS of ink. So the reading is a 4-connected component
 * count over a thresholded alpha-weighted luminance map of the canvas backing
 * store, plus the share of masked ink sitting in the single largest component.
 * Separated field -> many components, largest share ~1/N. Blob -> one
 * component, largest share ~1.
 *
 * THE THRESHOLD IS PASSED IN, NOT SELF-CALIBRATED PER READING, and that is
 * load-bearing. The sweep below is a PAIRED reading in the 7d spirit: the same
 * node set, the same colours, only the zoom differing. A per-frame
 * self-calibration (`0.5 * max` of THAT frame) would move the instrument
 * between the two readings being compared, so a picture that got dimmer would
 * be re-normalised back to looking the same. Calibrating ONCE at FIT and
 * reusing the absolute value keeps every reading in the sweep on one scale.
 * Pass `null` to calibrate, and the caller then reuses the returned `max`.
 *
 * WHY A THRESHOLD AT ALL — it is what separates NODE ink from EDGE ink. At
 * Tier C a resting node is an opaque fill at the `--dataviz-bone` role, while
 * a resting edge is `--dataviz-edge-dim`, which `tokens.css` defines as
 * `color-mix(... --dataviz-muted 38%, transparent)` — muted is already darker
 * than the foreground, and 38% alpha puts edge ink far below half of a node's.
 * Without the threshold every linked pair would count as ONE component and the
 * metric would measure the edge list rather than the picture.
 *
 * `masked` is returned and printed at every level ON PURPOSE. Nodes that
 * vanish entirely would also read as "few components", so the raw ink count is
 * what lets a reader tell "separable" from "gone".
 */
const readSeparability = (absoluteThreshold) => `
  const canvas = document.querySelector('.graph-canvas-host canvas');
  if (canvas === null) return null;
  const w = canvas.width | 0, h = canvas.height | 0;
  if (w === 0 || h === 0) return null;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const n = w * h;
  const ink = new Float32Array(n);
  let max = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = ((data[i] + data[i + 1] + data[i + 2]) / 3) * (data[i + 3] / 255);
    ink[p] = v;
    if (v > max) max = v;
  }
  const T = ${absoluteThreshold === null ? "max * 0.5" : String(absoluteThreshold)};
  const mask = new Uint8Array(n);
  let masked = 0;
  if (T > 0) {
    for (let p = 0; p < n; p++) if (ink[p] >= T) { mask[p] = 1; masked++; }
  }
  // Iterative flood fill over an explicit stack. A recursive one overflows the
  // JS stack the moment the picture really IS one canvas-sized blob, which is
  // precisely the case the negative control exists to produce.
  const stack = new Int32Array(n);
  const seen = new Uint8Array(n);
  let blobs = 0, largest = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let p0 = 0; p0 < n; p0++) {
    if (mask[p0] === 0 || seen[p0] === 1) continue;
    blobs++;
    let size = 0, top = 0;
    stack[top++] = p0;
    seen[p0] = 1;
    while (top > 0) {
      const q = stack[--top];
      size++;
      const x = q % w, y = (q / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[q - 1] === 1 && seen[q - 1] === 0) { seen[q - 1] = 1; stack[top++] = q - 1; }
      if (x < w - 1 && mask[q + 1] === 1 && seen[q + 1] === 0) { seen[q + 1] = 1; stack[top++] = q + 1; }
      if (y > 0 && mask[q - w] === 1 && seen[q - w] === 0) { seen[q - w] = 1; stack[top++] = q - w; }
      if (y < h - 1 && mask[q + w] === 1 && seen[q + w] === 0) { seen[q + w] = 1; stack[top++] = q + w; }
    }
    if (size > largest) largest = size;
  }
  return {
    w, h,
    max: Number(max.toFixed(2)),
    threshold: Number(T.toFixed(2)),
    masked,
    blobs,
    largest,
    largestShare: masked === 0 ? 0 : Number((largest / masked).toFixed(4)),
    /** The on-screen span of the inked field, in canvas pixels. */
    extentPx: maxX < 0 ? 0 : Math.max(maxX - minX, maxY - minY) + 1,
    zoom: Number(window.__igrisGraphStillness.zoom().toFixed(5)),
  };
`;

/**
 * Zoom OUT with real wheel events until `k` falls to `targetK`, and report what
 * was actually reached.
 *
 * It reports the ACHIEVED zoom rather than the requested one because the
 * library owns a scale extent we never set, so a request can be refused. Every
 * assertion downstream quotes the achieved figure — the brief's AC is "at a
 * MEASURED low zoom", and a gate that printed the target instead of the reading
 * would be asserting its own intention.
 */
async function wheelZoomTo(tab, host, targetK, { maxTicks = 400 } = {}) {
  const readK = "return window.__igrisGraphStillness.zoom();";
  let k = await tab.eval(readK);
  let ticks = 0;
  let stalled = 0;
  while (k > targetK && ticks < maxTicks) {
    // ADAPTIVE STEP, and it is not a nicety. d3-zoom scales by
    // `2 ** (-deltaY * 0.002)`, so a 120-unit tick multiplies `k` by ~0.85 —
    // coarse enough that a fixed step overshot the requested zoom by 2x on the
    // first exploratory run, and a gate that asserts "at k_fit/4" while
    // standing at k_fit/7 is reporting a level it did not measure. The step
    // shrinks as the target nears so the ACHIEVED `k` lands close to the
    // requested one; the achieved figure is still what every assertion quotes.
    const remaining = k / targetK;
    const delta = remaining > 2 ? 120 : remaining > 1.2 ? 40 : 12;
    await tab.wheel(host.x, host.y, delta);
    ticks += 1;
    const next = await tab.eval(readK);
    // The library's own scale extent is never set by us, so it is whatever the
    // default is (measured: a 0.01 minimum). If several more ticks cannot move
    // `k`, we have hit it, and grinding through the remaining budget would only
    // make the gate slow.
    if (next >= k * 0.9999) stalled += 1;
    else stalled = 0;
    k = next;
    if (stalled >= 4) break;
  }
  // The wheel wakes the render loop (C1). Let it re-pause so the frame the
  // instrument reads is the FINAL one for this zoom rather than a frame taken
  // mid-gesture.
  await tab.until("return window.__igrisGraphStillness.state() === 'still' ? 1 : 0;", {
    timeout: 30_000,
    label: `settles after zooming to k<=${targetK}`,
  });
  return { k: await tab.eval(readK), ticks, hitExtent: stalled >= 3 };
}

/**
 * G-BR-11 — FR-244. THE DENSITY DEFECT, MEASURED, AND THE COLUMN.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * FR-244's brief asks for the density fix to be JUSTIFIED BY A MEASUREMENT and
 * for the separability claim to be asserted at a MEASURED low zoom. The FR-240
 * header's complaint about FR-239 was that its ad-hoc run left nothing
 * re-runnable, so the measurement is checked in as a gate rather than taken in
 * a scratch script.
 *
 * WORLD: `dense`, its own world and its own tab. 700 extra `learning` rows put
 * the payload in Tier C, which is the only tier where `chrome` is `silhouette`
 * and the floor is `--s-1` — the surface the complaint came from. It runs after
 * G-BR-7 so it cannot disturb that gate's `/api/graph` counters, and it never
 * touches the `seeded` world whose row counts three earlier gates assert on.
 *
 * PROVES
 *   11a  At a MEASURED low zoom the picture is still made of distinct connected
 *        regions: the component count holds a stated fraction of its count at
 *        FIT, and no single component owns the field.
 *   11b  NEGATIVE CONTROL FOR THE INSTRUMENT. At an extreme zoom-out — outside
 *        any range this brief claims — the same metric reports MERGED. So 11a's
 *        pass is a measured pass rather than a counter that cannot move, which
 *        is what 4b is to 4a.
 *   11c  The canvas owns the vertical column at 1440x900: the page does not
 *        scroll, the host fills the space below it, and the query twin sits
 *        INSIDE the layout row rather than under it.
 *
 * DOES NOT PROVE
 *   That the picture is BEAUTIFUL, or that a reader can name a node at that
 *   zoom. Component count is a legibility FLOOR — "these are still separate
 *   things" — not a legibility ceiling. Nor does it prove anything about the
 *   node SHAPE vocabulary: FR-244's operator sign-off left `tracePath`
 *   untouched, so no shape claim is made here or anywhere in this file.
 *   **Sibling:** `shapes.test.ts` pins the vocabulary; `nodeWorldSize`'s unit
 *   tests in the same file pin the size law's arithmetic at every `k`, which is
 *   the half this gate cannot see.
 */
async function gBr11(tab) {
  gate("G-BR-11", "FR-244: density measured at a real zoom, and the vertical column");

  const stillnessReady = "return window.__igrisGraphStillness !== undefined ? 1 : 0;";
  const isStill = "return window.__igrisGraphStillness.state() === 'still' ? 1 : 0;";

  await tab.hash("#/graph");
  await tab.until(stillnessReady, { timeout: 45_000, label: "dense graph mounts" });
  await tab.until(isStill, { timeout: 90_000, label: "dense graph settles" });

  const readout = await tab.eval(READ.graphReadout);

  // CLEAR THE ENTRY-POINT SELECTION FIRST. `useGraph` auto-selects the
  // highest-degree node on settle (exemption 02), which paints an accent fill,
  // a selection ring and the 1-hop labels. All three are ink the size law does
  // not govern, and the ring in particular is a large thin circle that would
  // fuse otherwise-separate components. Measuring the RESTING field is the
  // whole point.
  await tab.click(".graph-inspector-close");
  await tab.until(isStill, { timeout: 30_000, label: "settles after the deselect" });
  await tab.settle(400);

  const host = await tab.eval(`
    const el = document.querySelector('.graph-canvas-host');
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  `);

  // FIT — every node on screen, which is the reference the sweep is paired
  // against. `graph.refit` -> `zoomToFit()`, driven through the real button.
  await clickButton(tab, "FIT");
  await tab.until(isStill, { timeout: 30_000, label: "settles after FIT" });
  await tab.settle(300);

  // Calibrate the instrument ONCE, at FIT, then hold it absolute for the sweep.
  const calib = await tab.eval(readSeparability(null));
  if (calib === null) {
    check("11-instrument", false, "no canvas to read — the dense graph never painted");
    return;
  }
  const T = calib.threshold;
  const atFit = await tab.eval(readSeparability(T));
  check(
    "11-instrument",
    atFit.blobs > 1 && atFit.masked > 0 && atFit.largestShare < 0.5,
    `CALIBRATION at FIT (${readout}) k=${atFit.zoom} canvas ${atFit.w}x${atFit.h}: ` +
      `peak ink ${calib.max}, threshold ${T} (half the peak — node ink is an opaque bone fill, ` +
      `resting edge ink is muted at 38% alpha and lands below it) · ` +
      `masked ${atFit.masked}px · blobs ${atFit.blobs} · largest blob ${atFit.largest}px ` +
      `(${pct(atFit.largestShare)} of the ink) · field spans ${atFit.extentPx}px`,
  );

  // THE SWEEP. Real wheel events, so this also drives the C1 wake path
  // (learning 1097) — a canvas that is halted-and-dead does not repaint on a
  // wheel and would read as a frozen picture at every level below.
  const sweep = [];
  for (const divisor of SWEEP_DIVISORS) {
    const target = atFit.zoom / divisor;
    const moved = await wheelZoomTo(tab, host, target);
    const s = await tab.eval(readSeparability(T));
    sweep.push({ divisor, target: Number(target.toFixed(5)), ...moved, sep: s });
    note(
      `sweep k_fit/${String(divisor).padEnd(2)} -> requested k=${target.toFixed(5)} reached k=${moved.k.toFixed(5)} ` +
        `in ${moved.ticks} wheel ticks${moved.hitExtent ? " [library scale extent reached]" : ""} · ` +
        `blobs ${s.blobs} (${((s.blobs / atFit.blobs) * 100).toFixed(1)}% of FIT's ${atFit.blobs}) · ` +
        `masked ${s.masked}px · largest ${pct(s.largestShare)} · field ${s.extentPx}px`,
    );
  }

  const low = sweep.find((s) => s.divisor === LOW_ZOOM_DIVISOR);
  const extreme = sweep[sweep.length - 1];

  // 11a — the assertion, at the MEASURED zoom. The mutation points it at the
  // extreme instead, which is a zoom known to merge: the mirror of
  // br4-measure-motion pointing 4a at a surface known to move.
  const measured = mut("br11-measure-at-blob-zoom") ? extreme : low;
  const ratio = measured.sep.blobs / atFit.blobs;
  check(
    "11a",
    ratio >= SEPARABLE_BLOB_RATIO && measured.sep.largestShare <= SEPARABLE_LARGEST_SHARE,
    `SEPARABLE AT A MEASURED LOW ZOOM: k=${measured.k.toFixed(5)} (FIT was k=${atFit.zoom}, ` +
      `so ${(atFit.zoom / measured.k).toFixed(1)}x further out, reached in ${measured.ticks} real wheel ticks) · ` +
      `blobs ${measured.sep.blobs} vs ${atFit.blobs} at FIT = ${pct(ratio)} (floor ${pct(SEPARABLE_BLOB_RATIO)}) · ` +
      `largest blob ${pct(measured.sep.largestShare)} of the ink (ceiling ${pct(SEPARABLE_LARGEST_SHARE)}) · ` +
      `masked ${measured.sep.masked}px, so the ink is still THERE rather than gone` +
      (mut("br11-measure-at-blob-zoom")
        ? "  [MUTATED: measured at the EXTREME zoom-out, a k at which the whole layout spans a few pixels]"
        : ""),
  );

  /*
   * 11b — THE INSTRUMENT'S NEGATIVE CONTROL, and it is not the one this gate
   * was first written with. That draft asserted the field reads as ONE blob at
   * an extreme zoom-out, on the reasoning that the layout's own on-screen
   * extent shrinks to a few pixels there whatever the size law does. The FIRST
   * POST-FIX RUN REFUTED IT: at k_fit/16 the fixed law still resolved 162
   * components in a 32px field. The control was wrong, and it was wrong in the
   * most dangerous direction — it would have gone red for the RIGHT behaviour.
   *
   * So the control is taken from a merge that is real, measured, and caused by
   * something the size law cannot reach: AT FIT, EVERY LINKED PAIR IS ALREADY
   * FUSED. The dense world seeds a known number of edges, each joining two
   * learnings, and d3-force's link force pulls those pairs closer than their
   * own size. The component deficit is therefore PREDICTED INDEPENDENTLY of
   * this instrument — it should equal the seeded edge count — and measured:
   * 710 nodes, 352 edges, 358 components. 710 - 352 = 358, exactly.
   *
   * That makes it a real negative control in the learning-1092 sense: it
   * travels the SAME path (the same canvas, the same render, the same reader),
   * and it proves the counter reports fusion WHEN FUSION OCCURS — against a
   * number this gate did not choose. A counter stuck at "everything is
   * separate" fails here.
   *
   * It also records FR-244's second measured finding: the absence of a collide
   * force IS a contributing cause of at-rest fusion. What it does NOT license
   * is adding one — see `shapes.ts`'s note on why separation at FIT is
   * scale-free and therefore out of a size law's reach.
   */
  const control = mut("br11-control-at-extreme-zoom")
    ? { k: extreme.k, sep: extreme.sep }
    : { k: atFit.zoom, sep: atFit };
  const counts = /(\d+)\s+NODES\s*·\s*(\d+)\s+EDGES/.exec(readout ?? "");
  const nodeCount = counts === null ? 0 : Number(counts[1]);
  const edgeCount = counts === null ? 0 : Number(counts[2]);
  const deficit = nodeCount - control.sep.blobs;
  check(
    "11b",
    counts !== null &&
      control.sep.blobs < nodeCount &&
      deficit >= edgeCount * (1 - MERGE_DEFICIT_TOLERANCE) &&
      deficit <= edgeCount * (1 + MERGE_DEFICIT_TOLERANCE),
    `NEGATIVE CONTROL — the metric REPORTS a merge when one is there. At k=${control.k.toFixed(5)}: ` +
      `${nodeCount} nodes render as ${control.sep.blobs} components, a deficit of ${deficit} ` +
      `against ${edgeCount} seeded edges (${pct(edgeCount === 0 ? 0 : deficit / edgeCount)} of them, ` +
      `tolerance +/-${pct(MERGE_DEFICIT_TOLERANCE)}) — every LINKED pair sits closer than its own size ` +
      `and fuses, which is a number this gate did not choose. So 11a's separability is a MEASURED pass` +
      (mut("br11-control-at-extreme-zoom")
        ? "  [MUTATED: the control's reading was taken at the extreme zoom-out, where the size law has PRESERVED the separation, so the known fusion is no longer there to detect]"
        : ""),
  );

  // 11c — the vertical column. Its own concern; measured after the zoom sweep
  // so the sweep never sees a mid-flight layout.
  await tab.hash("#/graph");
  await tab.until(stillnessReady, { timeout: 45_000, label: "graph remounts for the layout reading" });
  if (mut("br11-fullheight-at-stacked-breakpoint")) {
    // Below `base.css`'s 1100px breakpoint `.graph-layout` STACKS and the
    // canvas legitimately does not own the column. Asserting the full-column
    // claim there must fail.
    await tab.setViewport(1000, 900);
  } else {
    await tab.setViewport(1440, 900);
  }
  await tab.settle(900);
  const layout = await tab.eval(`
    // SCROLL TO THE TOP FIRST. \`getBoundingClientRect().top\` is relative to
    // the VIEWPORT, so on a page that scrolls — which is exactly the pre-fix
    // state this check exists to reject — the reading depends on where the
    // previous gate left the scroll position. Two exploratory runs disagreed by
    // 264px for that reason before this line existed.
    window.scrollTo(0, 0);
    const host = document.querySelector('.graph-canvas-host');
    const main = document.querySelector('#main') || document.body;
    if (host === null) return null;
    const r = host.getBoundingClientRect();
    const padBottom = Number.parseFloat(getComputedStyle(main).paddingBottom) || 0;
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      hostTop: Math.round(r.top),
      hostHeight: Math.round(r.height),
      /* Everything from the canvas's top edge to the bottom of the page box. */
      available: Math.round(window.innerHeight - r.top - padBottom),
      scrollHeight: document.documentElement.scrollHeight,
      /* DECISION 3a — the twin lives INSIDE the layout row, not under it. */
      twinInsideLayout: document.querySelector('.graph-layout .graph-twin') !== null,
      twinPresent: document.querySelector('.graph-twin') !== null,
    };
  `);
  const fillsColumn = layout.hostHeight / Math.max(1, layout.available);
  const scrolls = layout.scrollHeight > layout.innerHeight + 1;
  check(
    "11c",
    fillsColumn >= COLUMN_FILL_FRACTION &&
      !scrolls &&
      layout.twinInsideLayout === true &&
      layout.twinPresent === true,
    `FULL COLUMN at ${layout.innerWidth}x${layout.innerHeight}: canvas host ${layout.hostHeight}px of ` +
      `${layout.available}px available below its own top edge (${pct(fillsColumn)}, floor ${pct(COLUMN_FILL_FRACTION)}) · ` +
      `document scrollHeight ${layout.scrollHeight} vs innerHeight ${layout.innerHeight} -> ` +
      `${scrolls ? "THE PAGE SCROLLS" : "no page scroll"} · query twin present=${layout.twinPresent} ` +
      `inside the layout row=${layout.twinInsideLayout}` +
      (mut("br11-fullheight-at-stacked-breakpoint")
        ? "  [MUTATED: asserted at a 1000px viewport, below the 1100px stacked breakpoint]"
        : ""),
  );

  // 11c-tall — the retired clamp, proved retired. `.graph-surface` used to be
  // `height: clamp(420px, 62vh, 900px)`, so no viewport however tall could put
  // more than 900px of canvas on screen. This is the reading that says the cap
  // is gone rather than merely raised.
  if (!mut("br11-fullheight-at-stacked-breakpoint")) {
    await tab.setViewport(1440, 1600);
    await tab.settle(900);
    const tall = await tab.eval(`
      const host = document.querySelector('.graph-canvas-host');
      if (host === null) return null;
      const r = host.getBoundingClientRect();
      return { hostHeight: Math.round(r.height), innerHeight: window.innerHeight };
    `);
    check(
      "11c-tall",
      tall.hostHeight > RETIRED_SURFACE_CLAMP_MAX_PX,
      `at ${tall.innerHeight}px tall the canvas host is ${tall.hostHeight}px — above the RETIRED ` +
        `\`clamp(420px, 62vh, 900px)\` ceiling of ${RETIRED_SURFACE_CLAMP_MAX_PX}px, so the cap is gone rather than raised`,
    );
  } else {
    skip("11c-tall", "the stacked-breakpoint mutation owns the viewport for this run");
  }

  /*
   * 11d — THE DENSITY BANNER MUST NOT EAT THE CANVAS'S POINTER EVENTS.
   *
   * FR-244 moved the banner out of the page flow to kill a ResizeObserver
   * oscillation (see `pages/Graph.tsx`). That was right, and it shipped with a
   * regression review caught: an opaque, full-width, out-of-flow strip sitting
   * on `.graph-canvas-host` with no `pointer-events` rule INTERCEPTS every
   * hover, click and wheel that lands on it. Nodes under the strip become
   * unselectable while the banner is up — which is Tier C dense sets, exactly
   * the surface this brief exists to improve, and behaviourally
   * indistinguishable from FR-239's dead canvas.
   *
   * The absence of THIS assertion is what let it through, so it is the
   * assertion, not a comment.
   *
   * A SMALL VIEWPORT IS THE CHEAP WAY TO RAISE THE BANNER. `shouldAggregate`
   * trips when `count · floor² > area · 0.25`; the dense world's 710 nodes at
   * the 8px floor need under ~181,000 px² of canvas, which a ~400x700 viewport
   * gives. Raising the world's node count instead would have moved every figure
   * in the sweep above, which is a re-baseline the rest of this gate does not
   * need.
   *
   * NON-VACUITY IS ASSERTED IN THE CHECK ITSELF: the banner must be PRESENT
   * with a non-zero box and the probe point must fall INSIDE it. Without those,
   * a run where the banner simply never rendered would report a clean pass —
   * the failure mode that makes a guard indistinguishable from a broken one.
   */
  await tab.setViewport(400, 700);
  await tab.settle(1200);
  const banner = await tab.eval(`
    const el = document.querySelector('.graph-density');
    if (el === null) return { present: false };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { present: true, boxed: false, w: r.width, h: r.height };
    ${mut("br11-banner-swallows-pointer") ? "el.style.pointerEvents = 'auto';" : ""}
    // A point INSIDE the strip, inset from its edges so the reading is not a
    // border-rounding lottery.
    const x = r.left + Math.min(40, r.width / 2);
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const host = document.querySelector('.graph-canvas-host');
    return {
      present: true,
      boxed: true,
      w: Math.round(r.width), h: Math.round(r.height),
      insideBanner: x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
      hit: hit === null ? null : (hit.className && hit.className.baseVal !== undefined
        ? hit.className.baseVal : String(hit.className || hit.tagName)),
      hitIsBanner: hit !== null && hit.closest('.graph-density') !== null,
      hitReachesCanvas: hit !== null && host !== null && (hit === host || host.contains(hit)),
      computedPointerEvents: getComputedStyle(el).pointerEvents,
    };
  `);
  check(
    "11d",
    banner.present === true &&
      banner.boxed === true &&
      banner.insideBanner === true &&
      banner.hitIsBanner === false &&
      banner.hitReachesCanvas === true,
    banner.present !== true
      ? "the DENSITY banner never rendered at this viewport, so the pointer-transparency claim was NOT exercised — raise the density or lower the viewport"
      : `DENSITY banner is up (${banner.w}x${banner.h}px, pointer-events=${banner.computedPointerEvents}) and a point INSIDE it ` +
        `(inside=${banner.insideBanner}) resolves to ${JSON.stringify(banner.hit)} — banner=${banner.hitIsBanner}, ` +
        `reaches the canvas host=${banner.hitReachesCanvas}. A node under the strip is still hoverable and clickable` +
        (mut("br11-banner-swallows-pointer")
          ? "  [MUTATED: pointer-events restored to auto on the overlay — the defect as shipped]"
          : ""),
  );

  await tab.clearViewport();

  note(
    "11a/11b are a PAIRED reading in the 7d spirit, not a tolerance: the SAME node set, the SAME " +
      "colours and ONE calibrated ink threshold, with only the zoom differing. The threshold is " +
      "calibrated once at FIT and held absolute, because a per-frame self-calibration would " +
      "re-normalise a picture that got dimmer back into looking unchanged. `masked` is printed at " +
      "every level so 'separable' can be told apart from 'the nodes disappeared'.",
  );
  note(
    "STATED LIMIT (learning 1095). This gate measures COMPONENT COUNT — 'are these still distinct " +
      "things' — which is a legibility FLOOR, not a legibility ceiling: it cannot say whether a " +
      "reader could name a node at that zoom, and it makes no claim about the shape vocabulary " +
      "(FR-244's sign-off left `tracePath` untouched). The arithmetic of the size law at every `k`, " +
      "including the continuity at K_FLOOR and the agreement of the FOUR distinct geometry laws " +
      "(paint size, pointer-capture size, ring radius, label obstacle box) across the FIVE call " +
      "sites that use them, is the " +
      "sibling: `cli/dashboard/src/graph/__tests__/shapes.test.ts`. Do not weaken either on the " +
      "assumption the other has it covered.",
  );
}

// ---------------------------------------------------------------------------
// G-BR-12 — FR-245: the briefs board
// ---------------------------------------------------------------------------

/** A status no fixed-width header can hold, and one the vocabulary never had. */
const SENTENCE_STATUS =
  "Split (see FR-161, FR-162, FR-163, FR-164, FR-165, FR-166, FR-167)";

/**
 * Add ONE brief carrying a 66-character status to the seeded world.
 *
 * Not in `dashboard-layers-fixture.ts`, deliberately: that fixture is shared
 * with the vitest endpoint suites, which assert exact counts on it, and a
 * browser gate that widened it would move numbers three suites away from here.
 * It is seeded HERE and NOW — G-BR-12 runs after every other gate that reads
 * the `seeded` world — so no earlier count moves under it.
 *
 * A separate short-lived writer against a WAL brain the dashboard reads
 * per-request is safe; what is not safe is a second read-write connection
 * beside a LIVE brain engine, which is why `seedTriageWorld` has its own two
 * pass shape. Nothing here boots an engine.
 */
function seedSentenceStatusBrief(db) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import D from "better-sqlite3";
      const db = new D(process.env.GATE_DB);
      db.prepare(
        "INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?)"
      ).run(
        "demo", "FR-245", "feature", "Board view for the briefs layer",
        process.env.GATE_STATUS, "P2-Medium", "L", null, "2026-08-02 09:00:00"
      );
      db.close();
      `,
    ],
    {
      cwd: CLI_ROOT,
      env: { ...process.env, GATE_DB: db, GATE_STATUS: SENTENCE_STATUS },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * G-BR-12 — FR-245. THE BOARD: the column set, the sum, the filters, read-only.
 *
 * PROVES, in a real browser against a real brain: the column set is the union
 * of the statuses PRESENT in scope and the documented lifecycle vocabulary
 * (never a hand-listed set); the columns ACCOUNT FOR EVERY BRIEF (`Σ
 * column.total === /api/summary`'s `briefs.total`); a sentence-length status is
 * truncated in the header while the full value stays on the element and the
 * column does not overflow; the view toggle survives a route change and a
 * reload but NOT a new browsing context; every non-status filter reaches every
 * column's query; and a full board session — toggle, filter, hover, a real
 * mouse DRAG on a card — issues ZERO non-GET requests while the same reading
 * reports GET greater than zero.
 *
 * DOES NOT PROVE that the endpoint's answers are right (that is
 * `dashboard-layers-endpoint.test.ts`), nor which columns SHOULD exist for a
 * given brain — the union is computed here from `/api/summary` plus the
 * vocabulary literal below, independently of the client's own constant, so the
 * two would have to be wrong in the same way to agree.
 *
 * WORLD: `seeded`, on its OWN tab, and it runs after every other gate that
 * reads that world — it seeds one extra brief.
 */
async function gBr12(cdpPort, seeded) {
  gate("G-BR-12", "FR-245: the briefs board — union columns, the sum, the filters, read-only");

  seedSentenceStatusBrief(seeded.db);

  /*
   * The documented lifecycle, from
   * `docs/architecture/brief-state-source-of-truth.md:13` — NOT imported from
   * the client. The client mirrors that doc in `layers/board.ts`; if this gate
   * read the client's copy, a wrong vocabulary would agree with itself.
   */
  const VOCABULARY = ["Draft", "Ready", "In Progress", "Blocked", "Done", "Archived"];

  /*
   * `br12-view-in-localstorage`'s injection, and it has to be a DOCUMENT-START
   * script because the defect is in how the page persists: by the time a normal
   * `tab.eval` could run, the bundle has already read storage and chosen a
   * view. Seeding `sessionStorage` from `localStorage` before anything runs is
   * what a `localStorage`-backed implementation looks like from OUTSIDE — the
   * value crosses into a new browsing context, which is precisely the property
   * D4 rejected and 12d-session exists to detect.
   */
  const VIEW_KEY = "igris.dashboard.layers.view";
  const localStorageBridge = mut("br12-view-in-localstorage")
    ? `try {
         const v = localStorage.getItem(${JSON.stringify(VIEW_KEY)});
         if (v) sessionStorage.setItem(${JSON.stringify(VIEW_KEY)}, v);
       } catch (e) { /* storage disabled */ }`
    : null;

  const tab = await openTab(cdpPort, `${seeded.url}/#/layers/briefs`, localStorageBridge);
  await tab.until(has(".record-list"), { label: "briefs list" });
  await untilListStable(tab);

  const scope = await activeProject(tab);
  const q = scope === null ? "" : `?project=${encodeURIComponent(scope)}`;
  const summary = await apiJson(`${seeded.url}/api/summary${q}`);
  const present = Object.keys(summary.briefs.by_status);

  // --- 12a · the column set is data UNION vocabulary ------------------------
  await setLayerView(tab, "BOARD");
  await untilBoardStable(tab);

  if (mut("br12-view-in-localstorage")) {
    // The write half of the same mutation: a localStorage-backed hook would
    // have put the chosen view there. The bridge above then carries it into the
    // fresh tab exactly as that implementation would.
    await tab.eval(
      `localStorage.setItem(${JSON.stringify(VIEW_KEY)}, sessionStorage.getItem(${JSON.stringify(VIEW_KEY)}) || 'board'); return 1;`,
    );
  }

  if (mut("br12-hand-listed-columns")) {
    // The named failure, driven on purpose: a board that renders a hand-listed
    // lifecycle instead of the derived union. `Pending` is a REAL seeded status
    // that is not in the documented vocabulary, so this is not a contrived
    // deletion — it is what an allowlist would have done to real rows.
    await tab.eval(`
      const keep = ['Ready', 'In Progress', 'Done'];
      for (const col of document.querySelectorAll('.record-board-col')) {
        if (!keep.includes(col.getAttribute('data-status'))) col.remove();
      }
      return 1;
    `);
  }

  const domStatuses = await tab.eval(READ_BOARD.statuses);
  const expected = [...new Set([...present, ...VOCABULARY])].sort();
  const got = [...domStatuses].sort();
  const missing = expected.filter((s) => !got.includes(s));
  const extra = got.filter((s) => !expected.includes(s));
  check(
    "12a",
    missing.length === 0 && extra.length === 0,
    `columns=${got.length} · in scope=${JSON.stringify(present)} · vocabulary adds=${JSON.stringify(
      VOCABULARY.filter((v) => !present.includes(v)),
    )} · missing=${JSON.stringify(missing)} · unexpected=${JSON.stringify(extra)}${
      mut("br12-hand-listed-columns") ? "  [MUTATED: hand-listed lifecycle]" : ""
    }`,
  );

  // The three-spellings claim, on real data rather than in a table test: the
  // seeded world has no synonym pair, so this reports what IS distinct rather
  // than asserting a merge that could not happen here.
  note(
    `no column is a merge of two values: ${got.length} columns for ${got.length} distinct ` +
      `status strings. The FOLD case (Done/Completed/Complete as three columns) is pinned ` +
      `offline by B6 in dashboard/src/layers/__tests__/board.test.ts, because this fixture ` +
      `holds no synonym pair to observe.`,
  );

  // --- 12b · the columns account for EVERY brief ----------------------------
  const totals = await tab.eval(READ_BOARD.totals);
  const readout = await tab.eval(READ_BOARD.readout);
  const sum = totals.reduce((n, c) => n + c.total, 0);
  check(
    "12b",
    sum === summary.briefs.total,
    `Σ column.total=${sum} · /api/summary briefs.total=${summary.briefs.total} · page's own readout=${
      readout === null ? "absent" : `${readout.sum} (${JSON.stringify(readout.text)})`
    } · per column ${JSON.stringify(totals.map((c) => `${c.status}=${c.total}`))}`,
  );
  note(
    "12b is AC-2 made mechanical, and it is the check the whole gate is built around: a column " +
      "set can only pass it by being COMPLETE. The sum is taken host-side from each column's own " +
      "`data-total` (which is that column's own `/api/briefs` response), and compared with a " +
      "reading of `/api/summary` this script fetched itself — two independent numbers, not one " +
      "number read twice.",
  );

  // --- 12c · the sentence status ------------------------------------------
  if (mut("br12-untruncated-header")) {
    await tab.eval(`
      for (const col of document.querySelectorAll('.record-board-col')) {
        const label = col.querySelector('.record-board-label');
        label.textContent = col.getAttribute('data-status');
      }
      return 1;
    `);
  }
  const header = await tab.eval(readHeader(SENTENCE_STATUS));
  const fits = header !== null && header.scrollWidth <= header.clientWidth + 1;
  check(
    "12c",
    header !== null &&
      header.status === SENTENCE_STATUS &&
      header.title === SENTENCE_STATUS &&
      header.text.length < SENTENCE_STATUS.length &&
      header.text.endsWith("…") &&
      fits,
    header === null
      ? `no column for the ${SENTENCE_STATUS.length}-character status`
      : `header=${JSON.stringify(header.text)} (${header.text.length} chars of ${SENTENCE_STATUS.length}) · ` +
        `title and data-status carry the full value=${header.title === SENTENCE_STATUS && header.status === SENTENCE_STATUS} · ` +
        `label scrollWidth=${header.scrollWidth} clientWidth=${header.clientWidth} column=${Math.round(header.colWidth)}px${
          mut("br12-untruncated-header") ? "  [MUTATED: raw status in the header]" : ""
        }`,
  );

  // --- 12d · the toggle persists across navigation, not across sessions -----
  if (mut("br12-view-in-component-state")) {
    // "Held in `useState` only" IS "nothing was persisted". Clearing the key is
    // the same end state, injected without rebuilding the bundle.
    await tab.eval(`sessionStorage.removeItem('igris.dashboard.layers.view'); return 1;`);
  }

  await tab.reload();
  const afterReload = await tab.eval(READ_BOARD.which);
  await tab.hash("#/graph");
  await tab.settle(600);
  await tab.hash("#/layers/briefs");
  await tab.settle(600);
  const afterRoute = await tab.eval(READ_BOARD.which);
  check(
    "12d-nav",
    afterRoute.board === true && afterRoute.checked === "BOARD",
    `after #/graph and back: board=${afterRoute.board} checked=${JSON.stringify(afterRoute.checked)} ` +
      `(after a reload: board=${afterReload.board})${
        mut("br12-view-in-component-state") ? "  [MUTATED: view not persisted]" : ""
      }`,
  );
  note(
    "A RELOAD PRESERVES THE BOARD BY DESIGN, and the plan's prediction that it would not was " +
      "wrong: `sessionStorage` is scoped to the BROWSING CONTEXT, not to the document, so F5 keeps " +
      "it. The property that actually separates it from `localStorage` is the one 12d-session " +
      "reads — a NEW TAB is a new session and opens on the list.",
  );

  const fresh = await openTab(
    cdpPort,
    `${seeded.url}/#/layers/briefs`,
    localStorageBridge,
  );
  await fresh.until(has("#main"), { label: "fresh-tab shell" });
  await fresh.settle(800);
  const freshView = await fresh.eval(READ_BOARD.which);
  const freshStorage = await fresh.eval(`
    try {
      return {
        session: sessionStorage.getItem(${JSON.stringify(VIEW_KEY)}),
        local: localStorage.getItem(${JSON.stringify(VIEW_KEY)}),
      };
    } catch (e) { return { session: null, local: null }; }
  `);
  check(
    "12d-session",
    freshView.list === true && freshView.board === false && freshView.checked === "LIST",
    `a NEW browsing context opens on list=${freshView.list} board=${freshView.board} checked=${JSON.stringify(freshView.checked)} ` +
      `— the list is the default and the choice did not outlive the session · that context's storage: ` +
      `sessionStorage=${JSON.stringify(freshStorage.session)} localStorage=${JSON.stringify(freshStorage.local)}${
        mut("br12-view-in-localstorage") ? "  [MUTATED: the view was persisted in localStorage]" : ""
      }`,
  );
  note(
    "12d-session is the BEHAVIOURAL half of D4's `localStorage` rejection, and it needs its own " +
      "mutation to mean anything: `br12-view-in-component-state` reddens 12d-nav and leaves this " +
      "check green, so without `br12-view-in-localstorage` the only guard on 'the choice does not " +
      "outlive the session' would be a string scan for `localStorage` in the hook — which an alias " +
      "or a helper would walk straight past. The storage readout above is printed pass or fail, so " +
      "the reading behind the verdict is visible rather than inferred.",
  );

  // --- 12e · every non-status filter reaches every column -------------------
  await tab.focus();
  if (mut("br12-board-drops-filters")) {
    await tab.eval(`
      const orig = window.fetch;
      window.fetch = function (u, i) {
        const url = String(u);
        if (url.includes('api/briefs?')) {
          const [path, query] = url.split('?');
          const from = new URLSearchParams(query);
          const to = new URLSearchParams();
          if (from.get('project') !== null) to.set('project', from.get('project'));
          if (from.get('status') !== null) to.set('status', from.get('status'));
          to.set('limit', from.get('limit') || '12');
          to.set('offset', '0');
          return orig.call(window, path + '?' + to.toString(), i);
        }
        return orig.call(window, u, i);
      };
      return 1;
    `);
  }
  await setFilterChip(tab, "priority", "P1-High");
  await untilBoardStable(tab);
  const filtered = await tab.eval(READ_BOARD.totals);
  const disagreements = [];
  for (const col of filtered) {
    const url =
      `${seeded.url}/api/briefs?${scope === null ? "" : `project=${encodeURIComponent(scope)}&`}` +
      `status=${encodeURIComponent(col.status)}&priority=P1-High&limit=1`;
    const own = await apiJson(url);
    if (own.total !== col.total) {
      disagreements.push(`${col.status}: board=${col.total} endpoint=${own.total}`);
    }
  }
  check(
    "12e",
    disagreements.length === 0 && filtered.length > 0,
    `priority=P1-High in BOARD mode · ${filtered.length} columns · ` +
      `board totals ${JSON.stringify(filtered.map((c) => `${c.status}=${c.total}`))} · ` +
      `disagreements=${JSON.stringify(disagreements)}${
        mut("br12-board-drops-filters") ? "  [MUTATED: per-column query is {project,status} only]" : ""
      }`,
  );
  note(
    "12e also covers the AC-3 project-scope regression: the same builder carries `project` into " +
      "every column, and the endpoint readings above are taken at the SAME scope the page is on " +
      `(project=${JSON.stringify(scope)}).`,
  );
  await setFilterChip(tab, "priority", "P1-High", null);
  await untilBoardStable(tab);

  // --- 12g · OPEN IN LIST, driven end to end -------------------------------
  //
  // D2's reachability claim — "every status has a column, every column links to
  // the list filtered to it, so every brief is at most two clicks away" — is the
  // load-bearing half of how a uniform 12-card cap handles `Done`'s 493 rows.
  // Everything under it was previously asserted in pieces (a one-line pure
  // function with a table test, a `data-open-in-list` attribute in a render
  // test) and NOTHING clicked the control, so the chain that actually delivers
  // the promise — handoff -> view flip -> the list's INITIAL filter values ->
  // a filtered read — had no test at any level.
  const target = await tab.eval(`
    const cols = [...document.querySelectorAll('.record-board-col')]
      .filter(c => Number(c.getAttribute('data-total')) > 0);
    if (cols.length === 0) return null;
    const col = cols.sort((a, b) => Number(b.getAttribute('data-total')) - Number(a.getAttribute('data-total')))[0];
    return { status: col.getAttribute('data-status'), total: Number(col.getAttribute('data-total')) };
  `);
  if (target === null) throw new Error("12g: no non-empty column to hand off from");

  if (mut("br12-handoff-is-a-plain-toggle")) {
    // "The handoff is just a view switch": reach the list the other way, which
    // is what a board that dropped the status on the way there would produce.
    await setLayerView(tab, "LIST");
  } else {
    await tab.click(`.record-board-col[data-status="${target.status}"] .record-board-more`);
  }
  await tab.until(has(".record-list"), { timeout: 10_000, label: "list after the handoff" });
  await untilListStable(tab);

  const handedOff = await tab.eval(READ_BOARD.which);
  const listRows = (await tab.eval(READ.rowTitles)).length;
  const chip = await tab.eval(`
    const g = [...document.querySelectorAll('.record-filters [role=radiogroup]')]
      .find(x => x.getAttribute('aria-label') === 'status');
    if (g === undefined) return null;
    const b = [...g.querySelectorAll('button')].find(x => x.getAttribute('aria-checked') === 'true');
    return b === undefined ? null : b.textContent.trim();
  `);
  const listApi = await apiJson(
    `${seeded.url}/api/briefs?${scope === null ? "" : `project=${encodeURIComponent(scope)}&`}status=${encodeURIComponent(target.status)}`,
  );
  const unfiltered = await apiJson(
    `${seeded.url}/api/briefs?${scope === null ? "" : `project=${encodeURIComponent(scope)}`}`,
  );
  check(
    "12g",
    handedOff.list === true &&
      handedOff.checked === "LIST" &&
      chip === target.status &&
      listRows === target.total &&
      listRows === listApi.count,
    `OPEN IN LIST on the ${JSON.stringify(target.status)} column (total ${target.total}) -> ` +
      `view=${JSON.stringify(handedOff.checked)} list=${handedOff.list} · status chip=${JSON.stringify(chip)} · ` +
      `DOM rows=${listRows} · endpoint count for that status=${listApi.count} · ` +
      `UNFILTERED scope count=${unfiltered.count} (the number an unfiltered handoff would show)${
        mut("br12-handoff-is-a-plain-toggle") ? "  [MUTATED: reached the list by the view chip]" : ""
      }`,
  );
  note(
    "12g is the whole two-clicks claim in one reading, and it discriminates because the fixture's " +
      `filtered and unfiltered counts DISAGREE (${listApi.count} vs ${unfiltered.count}): a handoff that ` +
      "flipped the view and dropped the status would show the larger number. It also covers the one " +
      "chain no unit test can reach — the list is REMOUNTED by the flip, so the handoff arrives as " +
      "`useLayerList`'s `initial` values, which is state a `renderToStaticMarkup` render never runs.",
  );

  // Back to the board for 12f. The flip remounts the board, so its filter
  // values start empty again — which is why 12f's session begins clean.
  await setLayerView(tab, "BOARD");
  await untilBoardStable(tab);

  // --- 12f · READ-ONLY, with a positive control in the same reading ---------
  //
  // THE ORDER OF THIS BLOCK IS LOAD-BEARING, and it was got wrong first time:
  // both mutations came back VACUOUS because the injection sat OUTSIDE the
  // window the check reads. The POST fired before the `before` snapshot, so its
  // count was already in the baseline; and the injected `draggable` attribute
  // was wiped by the REFRESH that came after it, because a re-render unmounts
  // and remounts the rows. So: snapshot, THEN refresh (the positive control's
  // traffic), THEN inject, THEN drag, THEN read. Every mutation now lands
  // strictly inside the measured interval.
  const before = await tab.instrument();
  const orderBefore = await tab.eval(`
    const col = document.querySelector('.record-board-col');
    return col === null ? [] : [...col.querySelectorAll('.record-row-eye')].map(e => e.textContent.trim());
  `);

  // REFRESH, so the window this reads contains real requests. Without it "zero
  // non-GET" would be true of a window with no traffic at all, which is the
  // dead-counter reading learning 1094 is about.
  await tab.click(".record-board-meta .record-filter-run");
  await untilBoardStable(tab);

  if (mut("br12-drag-affordance")) {
    await tab.eval(`
      for (const card of document.querySelectorAll('.record-board .record-row')) {
        card.setAttribute('draggable', 'true');
      }
      return 1;
    `);
  }
  if (mut("br12-post-from-board")) {
    // A deliberately invalid action, so even the mutation run mutates nothing:
    // the server answers 400 with a stated reason. What matters to 12f is that
    // the REQUEST left the page while the counter was watching.
    await tab.eval(`
      fetch('api/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'not-a-real-action', ids: [1] }),
      }).catch(() => undefined);
      return 1;
    `);
    await tab.settle(600);
  }

  // Hover every card, then attempt a REAL drag of the first card of the first
  // column onto the last column: press, several moves, release.
  const drag = await tab.eval(`
    const cols = [...document.querySelectorAll('.record-board-col')];
    const from = cols.map(c => c.querySelector('.record-row')).find(Boolean);
    const to = cols[cols.length - 1];
    if (!from || !to) return null;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    return { x1: a.left + a.width / 2, y1: a.top + a.height / 2, x2: b.left + b.width / 2, y2: b.top + 40 };
  `);
  if (drag !== null) {
    await tab.moveTo(drag.x1, drag.y1);
    await tab.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: drag.x1,
      y: drag.y1,
      button: "left",
      clickCount: 1,
    });
    for (let i = 1; i <= 6; i++) {
      await tab.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: drag.x1 + ((drag.x2 - drag.x1) * i) / 6,
        y: drag.y1 + ((drag.y2 - drag.y1) * i) / 6,
        button: "left",
      });
    }
    await tab.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: drag.x2,
      y: drag.y2,
      button: "left",
      clickCount: 1,
    });
    await tab.settle(600);
  }

  const after = await tab.instrument();
  const affordances = await tab.eval(`
    return {
      draggable: document.querySelectorAll('.record-board [draggable]').length,
      handlers: [...document.querySelectorAll('.record-board *')].filter(e => e.ondragstart !== null || e.ondrop !== null).length,
      forms: document.querySelectorAll('.record-board form').length,
    };
  `);
  const orderAfter = await tab.eval(`
    const col = document.querySelector('.record-board-col');
    return col === null ? [] : [...col.querySelectorAll('.record-row-eye')].map(e => e.textContent.trim());
  `);
  const gets = after.fetch - before.fetch;
  const writes = after.nonGet - before.nonGet;
  check(
    "12f",
    writes === 0 &&
      gets > 0 &&
      affordances.draggable === 0 &&
      affordances.handlers === 0 &&
      affordances.forms === 0 &&
      JSON.stringify(orderAfter) === JSON.stringify(orderBefore),
    `across a full board session (toggle · filter · hover · a real mouse drag across columns · REFRESH): ` +
      `non-GET=${writes} · GET=${gets} [POSITIVE CONTROL — the witness was watching] · ` +
      `[draggable]=${affordances.draggable} · drag handlers=${affordances.handlers} · forms=${affordances.forms} · ` +
      `first column unchanged=${JSON.stringify(orderAfter) === JSON.stringify(orderBefore)}${
        mut("br12-drag-affordance") ? "  [MUTATED: cards marked draggable]" : ""
      }${mut("br12-post-from-board") ? "  [MUTATED: one POST fired from the board]" : ""}`,
  );
  note(
    "12f makes TWO independent claims and therefore has TWO mutations: `br12-drag-affordance` " +
      "breaks the DOM half and `br12-post-from-board` breaks the counter half. Without both, a " +
      "'no writes' assertion on a page with no write code passes by construction — which is the " +
      "vacuity this file exists to prevent, not a hypothetical. There is no drag-to-change-status " +
      "affordance and there is not going to be: `brief_status.status` is the canonical " +
      "build-state source (MAINTAINING row 94) and TD-311 forbids resolving a state contradiction " +
      "by editing brief data.",
  );
  note(
    `the board is 1 + N requests and does NOT follow the 5-second live beat (D5): ` +
      `briefsFetch=${after.briefsFetch} summaryFetch=${after.summaryFetch} over this whole gate, ` +
      `against a list view that would have issued one per beat. The staleness is carried by the ` +
      `AS OF stamp the strip renders.`,
  );
}

async function main() {
  if (!existsSync(CLI_ENTRY)) {
    process.stderr.write(`missing ${CLI_ENTRY} — run \`cd cli && npm run build\` first\n`);
    process.exit(2);
  }
  if (!existsSync(CHROME)) {
    process.stderr.write(`Chrome not found at ${CHROME}\nSet CHROME_BIN to override.\n`);
    process.exit(2);
  }

  const worldDirs = [];
  const worlds = {};
  const tabs = {};
  try {
    // FR-241 adds a FIFTH world. `triage` is the only one whose brain is built
    // by the engine's own migrations, which is the only schema the write door
    // can boot against — see `seedTriageWorld`.
    // FR-244 adds a SIXTH. `dense` is the only world whose payload reaches
    // Tier C, which is the only tier where the density defect exists.
    for (const kind of ["seeded", "vec", "empty", "missing", "triage", "dense"]) {
      const w = makeWorld(kind);
      worldDirs.push(w.brain);
      worlds[kind] = await startServer(w);
    }
    const chrome = await startChrome();

    process.stdout.write("FR-240 · G-BR — real-browser behavioural gates (CDP, no new dependency)\n");
    process.stdout.write(`node        ${process.version}\n`);
    process.stdout.write(`chrome      ${chrome.version}\n`);
    for (const kind of Object.keys(worlds)) {
      process.stdout.write(`${`${kind} brain`.padEnd(12)}${worlds[kind].brain}  ->  ${worlds[kind].url}\n`);
    }
    process.stdout.write(
      `hermetic    allowRemoteModels=false in every server: ${Object.keys(worlds)
        .map((k) => `${k}=${hermeticState(worlds[k]).armed ? "armed" : `NOT ARMED (${hermeticState(worlds[k]).reason})`}`)
        .join(" · ")}\n`,
    );
    process.stdout.write(
      `mutation    ${MUTATE === null ? "none — every gate must PASS" : `${MUTATE} (${MUTATIONS[MUTATE].gate}): ${MUTATIONS[MUTATE].how}`}\n`,
    );

    for (const kind of Object.keys(worlds)) {
      tabs[kind] = await openTab(chrome.port, `${worlds[kind].url}/#/overview`);
    }

    // Each gate runs inside a barrier. A THROW is recorded as a failed check and
    // the run continues: an injected defect frequently makes a LATER step
    // unreachable (a chip that was never set cannot be cleared), and losing the
    // rest of the ledger to that would hide which checks the mutation reached.
    await runGate("G-BR-1", () => gBr1(tabs.seeded));
    await runGate("G-BR-2", () => gBr2(tabs.seeded, worlds.seeded));
    await runGate("G-BR-3", () => gBr3(tabs, worlds));
    await runGate("G-BR-4", () => gBr4(tabs));
    await runGate("G-BR-5", () => gBr5(tabs.seeded));
    await runGate("G-BR-6", () => gBr6(tabs.seeded));
    // FR-241. Its own world and its own tab, so it cannot disturb G-BR-7's
    // document below — and it MUTATES, so it must never touch `seeded`, whose
    // row counts three earlier gates assert on.
    await runGate("G-BR-8", () => gBr8(tabs, worlds));
    // LAST of the FR-240 gates, because it RELOADS the seeded tab: the scope
    // cache it measures is module-level, so it needs a document nothing has
    // fetched in yet.
    await runGate("G-BR-7", () => gBr7(tabs.seeded));
    // BR-082, AFTER G-BR-7 for two reasons: it browses the Overview, which
    // polls `/api/graph/stats` and would put a warm document under G-BR-7's
    // module-level cache measurement; and it is the only gate that spends >10 s
    // of wall clock waiting for real beats, so it costs nothing to run at the
    // end. It needs the FOREGROUND tab (a background tab stops polling), which
    // it takes via `tab.hash()` and asserts in 9c-live.
    await runGate("G-BR-9", () => gBr9(tabs.seeded, worlds.seeded));
    // TD-326, LAST. It runs on the `triage` world and MUTATES its suggestion
    // queue, so it must follow G-BR-8, which reads that queue's scoped count.
    // It also spends >10 s waiting for real ladder polls, so like G-BR-9 it
    // costs nothing at the end.
    await runGate("G-BR-10", () => gBr10(tabs.triage, worlds.triage));
    // FR-245. It opens its OWN tabs on the `seeded` world and it SEEDS one
    // extra brief there, so it must follow every gate that reads that world's
    // counts (1, 2, 3, 4, 5, 6, 7, 9) — and it must precede G-BR-11, whose
    // viewport override would change the column geometry 12c measures.
    await runGate("G-BR-12", () => gBr12(chrome.port, worlds.seeded));
    // FR-244, LAST. Its own world and its own tab, so its zoom sweep and its
    // viewport overrides cannot disturb any earlier gate — G-BR-7 in particular
    // measures `/api/graph` request counts on the `seeded` document, and G-BR-4
    // measures that document at rest.
    await runGate("G-BR-11", () => gBr11(tabs.dense));
  } finally {
    teardown();
    if (!KEEP) for (const d of worldDirs) rmSync(d, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.stdout.write(
    skipped.length === 0 ? ", 0 skipped\n" : `, ${skipped.length} SKIPPED\n`,
  );
  // A skip is not a pass, so it is named in the summary and in the verdict line.
  // "Green with skips" must never be readable as "everything was exercised".
  for (const s of skipped) {
    process.stdout.write(`SKIPPED ${s.gate} ${s.id} — ${s.reason}\n`);
  }

  // A `--gates=` run is stamped so its transcript can never be quoted as a full
  // ladder. This is printed BEFORE the verdict and repeated inside it.
  const filtered =
    notRun.length === 0
      ? ""
      : ` [FILTERED — ${notRun.length} gate(s) did NOT run: ${notRun.join(", ")}; this is NOT a full-gate run]`;
  if (filtered !== "") process.stdout.write(`${filtered.trim()}\n`);

  if (MUTATE === null) {
    if (failed.length > 0) {
      for (const f of failed) process.stdout.write(`FAILED  ${f.gate} ${f.id}\n`);
      process.stdout.write(`VERDICT: FAIL${filtered}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      (skipped.length === 0
        ? "VERDICT: PASS — every gate green, every negative control green, nothing skipped"
        : `VERDICT: PASS WITH ${skipped.length} SKIPPED — every gate that RAN is green, every negative control green. The skipped checks above were NOT exercised.`) +
        `${filtered}\n`,
    );
    return;
  }

  // Mutation mode INVERTS the verdict. A mutation run where nothing fails means
  // the gate could not have caught the defect, which is the vacuity FR-239's
  // learning 1094 is about — and it is reported as a failure of the GATE.
  const expected = MUTATIONS[MUTATE].gate;
  // Prefix match, not equality: a gate's checks are sub-ids (`4a-briefs` under
  // `G-BR-4a`), and an equality test reported every one of those as "caught by a
  // different check than predicted" — a false note on a correct run.
  const want = expected.replace(/^G-BR-/, "");
  const hit = failed.some((f) => f.id === want || f.id.startsWith(`${want}-`));
  process.stdout.write(
    `\nexpected the mutation to break ${expected}; failures observed: ${failed.map((f) => `${f.gate}/${f.id}`).join(", ") || "NONE"}\n`,
  );
  if (failed.length === 0) {
    process.stdout.write(
      `VERDICT: VACUOUS — the injected defect did NOT fail any check. The gate proves nothing.${filtered}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `VERDICT: PASS (mutation caught${hit ? "" : " — note: by a different check than predicted, listed above"})${filtered}\n`,
  );
}

process.on("SIGINT", () => {
  teardown();
  process.exit(130);
});

await main();
