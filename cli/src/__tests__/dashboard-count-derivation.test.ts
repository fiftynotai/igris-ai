/**
 * TD-420 — **the derivation gate.** A count written into prose about the
 * dashboard endpoint set or the engine component set fails CI on the commit
 * that writes it.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS A TEST RATHER THAN A SENTENCE.
 * L-1314 (TD-402, measured 2026-08-18) says it in terms: *a count is true at
 * one instant, against one instrument, over one corpus. It rots silently,
 * reads as measured forever, and a reviewer can refute it in one grep. A
 * derivation does not rot — and when it is wrong it is wrong visibly, because
 * you can run it.* The same lesson also carries warden's structural finding,
 * which is why the rule alone was never going to be enough: **prose is not a
 * control.** At TD-420's filing the rule already existed verbatim in FOUR (count:record TD-420)
 * places in this tree — `MAINTAINING.md`'s own TD-402 row, the runtime
 * `coding_guidelines.md`, `core/skills/harvest/SKILL.md` and the brain's
 * `briefs` component — and one of those sits three rows above a row that broke
 * it three times. Every one of those statements was in place while the defect
 * shipped, so restating the rule again buys nothing: this file is the version
 * that RUNS, and that is the whole of its claim to be worth adding.
 *
 * WHAT IT PROVES, in two parts with different verbs.
 *
 *   PART 1 — ASSERT-MATCHES, derivation against derivation. The four
 *   independent enumerations of the local HTTP surface (`routes.ts`'s exported
 *   handlers, `server.ts`'s exact-match arms, `SMOKE_PROBE_PATHS`, and
 *   `dashboard.bats`'s exact-set string) are compared AS SETS, never as
 *   totals. This part has no number of its own, so it has nothing to go stale.
 *   It also pins each place where a count was replaced by an ENUMERATION,
 *   because "see the source" is only an improvement if the thing the reader is
 *   sent to still partitions its set.
 *
 *   PART 2 — ASSERT-ABSENT, over prose. No unmarked count describing these two
 *   sets survives anywhere in the contract corpus.
 *
 * THE CORPUS IS DERIVED, NOT HAND-LISTED. It is every backticked repo path in
 * `MAINTAINING.md` row 110's own Consumers cell, plus `MAINTAINING.md` and
 * `docs/dashboard.md`. A consumer added to that row is guarded automatically;
 * a consumer removed from it leaves the corpus automatically. Nobody has to
 * remember to update a second list — which is L-1126's failure mode (*a
 * hand-listed mirror over a derived value cannot report what nobody remembered
 * to update*), and hand-listing here would have re-created the very defect
 * being removed.
 *
 * THE PREDICATE ANCHORS ON THE SET-NOUN, NEVER ON THE NUMERAL. That is what
 * makes the exclusions structural rather than a list of names:
 * `MAINTAINING.md`'s own "lines under", its "gates", `base.css`'s "columns"
 * and `Triage.tsx`'s "projects" are all invisible because those nouns are not
 * in the vocabulary — and some of those files are INSIDE the corpus, so the
 * vocabulary is the only thing protecting them. Adding a filename to an
 * exclusion list instead would be the L-1126 defect again.
 *
 * STATED LIMITS. Read these as the honest edge of the instrument.
 *
 *   L1. THE MAGNITUDE ARM HAS A FLOOR, AND THE FLOOR IS MEASURED — SO
 *       RE-MEASURE IT RATHER THAN READING A FIGURE HERE. Arm M only looks at
 *       values from MAGNITUDE_FLOOR up. Drop `MAGNITUDE_FLOOR` to 1 and re-run
 *       this file to see the population the floor excludes; TD-420 did exactly
 *       that on the pre-fix tree and the difference was ~5x, essentially ALL of
 *       it correct structural prose about small closed sets ("the write
 *       endpoint is one endpoint", "the layer views", "the search endpoints").
 *       The floor is not tuned to a number that worked: the largest declared
 *       PROPER SUBSET this contract's prose names is the FR-240 layer set, so
 *       the floor sits strictly above every declared subset — the same way
 *       row 114's tier threshold was derived. The residual is real and it is
 *       the reason arms P and F exist: a stale count BELOW the floor that
 *       describes a proper subset is invisible to arm M, and two of TD-420's
 *       own defects lived exactly there.
 *
 *       THE SUB-FLOOR RESIDUE IS REAL AND IT IS OWNED: sentences stating the
 *       size of the FR-240 layer subset survive in files this corpus scans.
 *       They are correct — `fc738b8` added exactly those paths and FR-240 is a
 *       CLOSED historical set, so the figure cannot rot — but the rule as
 *       stated in row 110 does not reach them, and row 110 now says so rather
 *       than implying it does. TD-422 owns the decision about whether they get
 *       markers, a lower floor, or nothing. Measured on the post-fix tree, in
 *       BOTH directions, before deciding not to move the floor:
 *         floor 12 / 11 / 10 -> 2 findings, BOTH false (a latency reading of
 *              `12 ms` beside a `GET` column, and this file's own floor
 *              arm-check fixture). Buys nothing real.
 *         floor 9 -> +12, which IS the FR-240 layer population. Most are the
 *              closed-set provenance claims above. The REST were MECHANISM
 *              claims that the source refuted, and TD-420 converted every one
 *              it found to a DERIVATION instead (see part 1's read-preamble and
 *              parseFilters pins) — which is the move this file prefers to a
 *              floor change, because it gates the claim rather than banning the
 *              sentence. Note "every one it found": an earlier draft of this
 *              paragraph said there were three, and there was a FOURTH, in the
 *              contract row itself, unreachable for two independent reasons
 *              (sub-floor AND the whole-line marker bug MARKER_REACH replaced).
 *              Do not read a tally here; re-run the floor sweep.
 *         floor 7 -> +3 more, ALL false: `AC #7`, `G-RC-7` and a gate id. Below
 *              9 the ladder starts colliding with IDENTIFIERS, not counts.
 *   L2. A MARKER CANNOT BE ENFORCED, AND IT IS NOT A CENSUS.
 *       `count:record <BRIEF-ID>` exempts the figure beside it, and nothing
 *       stops someone stamping it on a live claim.
 *
 *       What it buys is ENUMERABILITY OF THE MARKED SET — `grep -rn
 *       'count:record'` lists every sentence someone chose to mark, which is a
 *       derivation that did not exist when FR-266 swept for these and missed
 *       them. **It is NOT the complete list of count-bearing sentences in the
 *       corpus, and an earlier draft of this paragraph said it was.** Unmarked
 *       ones survive wherever the arms cannot reach — below the magnitude
 *       floor, and in the notations L5 names. Likewise "a new unmarked count
 *       fails CI" is true only for a count the arms MATCH; write one below the
 *       floor, or as an ordinal, and nothing happens.
 *
 *       The marker covers two kinds of line and no third: a RECORD of a past
 *       measurement (`brain-write-bridge.ts`'s FR-241 boot probe), and a
 *       QUOTATION of a defect used as a fixture — which is what every marked
 *       line in THIS file is, since row 110 cites it and it therefore scans
 *       itself. Neither is a claim about the current set.
 *   L3. THE CORPUS IS ROW 110's CONSUMERS. A count about these sets written
 *       into a file that row 110 does not cite is not scanned, and there is a
 *       live residue outside it. DO NOT TAKE A TALLY OF IT FROM THIS COMMENT —
 *       that is the defect this file exists to stop, and TD-420's first draft
 *       of this very paragraph committed it. ENUMERATE the residue by swapping
 *       `corpusFiles()` for the whole tracked tree and re-running:
 *
 *           git ls-files | while read -r f; do echo "$f"; done   # the reach
 *
 *       …or run the AC-5 sweep in the header above over `.` instead of the
 *       corpus. What the residue CONTAINS, described rather than counted, with
 *       an owner named for each part:
 *         - engine-component figures under `docs/architecture/**`, in
 *           `README.md`, and in the runtime context docs (BOTH
 *           `coding_guidelines.md` and `architecture_map.md`) -> **TD-421**,
 *           whose own site table is the authority here rather than this
 *           comment. Note `architecture_map.md`'s figure is CORRECT and in
 *           scope anyway, which is the thesis.
 *         - engine-component figures in `brain-mcp-server/**` (`engine/index.ts`
 *           and the hand-mirrored `COMPONENT_FACTORIES` arrays under
 *           `engine/__tests__/`) and the same class in `docs/archive/**` ->
 *           owned by NO brief, recorded as a known gap rather than implied.
 *         - figures of BOTH kinds in the two CHANGELOGs
 *           -> dated by construction; the part of the residue that is
 *           acceptable as it stands.
 *   L5. ORDINALS ARE INVISIBLE, BY CONSTRUCTION AND ON PURPOSE — BUT THEY ARE
 *       STILL COUNTS. `numberAtom`'s trailing `(?![\w-])` means `seventeenth`
 *       can never match, so "FR-248 added the seventeenth GET" is silent to
 *       every arm. That is deliberate: an ordinal in this tree is nearly always
 *       a DATED statement of what a past brief did, which is exactly the shape
 *       L2's marker exists for. It is a limit all the same, because an ordinal
 *       asserts a cardinal at an instant — "the seventeenth GET" says there
 *       were seventeen (count:record TD-420 — an illustration, and arm R caught
 *       this very sentence when it was written unmarked). The ordinals live in
 *       `MAINTAINING.md` row 110 and are
 *       marked there under the same rule as any other dated figure, so they are
 *       in the `count:record` enumeration even though no arm would have caught
 *       them.
 *   L4. `GET` IS MATCHED CASE-SENSITIVELY, the other nouns are not. Folding
 *       case on the HTTP method would reach the English verb "get", which is a
 *       different WORD, not a different notation — measured: it produced hits
 *       on "2026-08-03 to get" and "until you get". The NUMBER half folds case
 *       unconditionally, which is required: row 114's stale copy was
 *       capitalised and was invisible to four consecutive lower-case sweeps.
 *
 * RE-RUNNABLE SWEEP (AC-5). The whole-tree equivalent of arm M, for a human:
 *
 * (The trailing `.` is load-bearing: without an explicit path `rg` reads stdin
 * and hangs rather than scanning the tree.)
 *
 *     rg -n --pcre2 \
 *       '(?<![\w-])(?i:thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty-one|twenty-two|twenty-three|twenty-four|twenty-five|1[3-9]|2[0-5])(?![\w-])[^\n]{0,40}?(?<![/\w])(GETs?|[Ee]ndpoints?|[Hh]andlers?|[Cc]omponents?)' .
 *
 * EVERY SCAN BELOW CARRIES A SELF-NEGATIVE-CONTROL (learning 1094), and every
 * false-positive control is a MEASUREMENT rather than a hope: the controls
 * assert silence on real lines of the real corpus that must never be reported.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MAINTAINING = join(REPO_ROOT, "MAINTAINING.md");

/** The map row that owns the local dashboard surface. 1-based, as cited. */
const MAP_ROW = 110;

// ---------------------------------------------------------------------------
// The ladder, the vocabulary, and the arms. (How many arms there are is
// `ARMS.length`; it was written here as a figure and went stale inside the
// very brief that added this file, the day arm R landed.)
// ---------------------------------------------------------------------------

/** Index 0 is `one`. The ladder a count on these sets has ever occupied. */
const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three",
  "twenty-four", "twenty-five",
] as const;

/** See stated limit L1 — measured, not chosen. */
const MAGNITUDE_FLOOR = 13;
const MAGNITUDE_CEILING = 25;

/** How far a number may sit from its noun and still be read as quantifying it. */
const NOUN_GAP = 40;

/** The exemption. A surviving count must name the brief whose record it is. */
const MARKER_ID = /^(?:FR|TD|BR|GL|MG)-\d+$/;

function numberAtom(loWord: number, hiWord: number, loNum: number, hiNum: number): string {
  const words = NUMBER_WORDS.slice(loWord - 1, hiWord)
    .slice()
    .sort((a, b) => b.length - a.length)
    .join("|");
  const numerals: string[] = [];
  for (let n = hiNum; n >= loNum; n--) numerals.push(String(n));
  // `(?<![\w.])…(?![\w.%])` on the numeral keeps line numbers, byte counts,
  // status codes, decimals and percentages out: `15.9%`, `404`, `1_684_456`.
  return `(?<![\\w-])(?:${words}|(?<![\\w.])(?:${numerals.join("|")})(?![\\w.%]))(?![\\w-])`;
}

/**
 * `(?<![/\w])` is what stops a PATH matching the noun — without it every
 * `brain-mcp-server/src/engine/components` citation in the map reads as a
 * component count.
 */
const SET_NOUN = "(?<![/\\w])(GETs?|endpoints?|handlers?|components?|route arms?)(?![\\w])";
const CARVE_NOUN = "(?<![/\\w])(GETs?|endpoints?|handlers?|others?|route arms?)(?![\\w])";

/**
 * The slot between `of` and the total in a carve-out. Closed, and every member
 * is a determiner or a limiting adverb — never a noun, so it cannot let the
 * pattern skip over the set it is supposed to be counting. Measured: without
 * `only`, `routes.ts`'s TWO copies of the same stale vec-door claim split — one
 * reported and its twin, eleven-hundred lines away, did not.
 */
const DETERMINER = "(?:(?:the|those|these|only|just|all|its|our)\\s+){0,2}";

/**
 * A number that is QUANTIFYING a noun phrase rather than sitting in code: a
 * determiner, then the number. `one` is out of the ladder here — in this
 * neighbourhood it is a pronoun ("reports each one") — while the numeral 1
 * stays.
 */
/**
 * F3 — the arm-R connector. Arm M reads NUMBER -> NOUN only, so a claim written
 * from the noun side went green: `"the endpoint count is nineteen"` (count:record TD-420)
 * and the `number nineteen` phrasing were both invisible to every sweep this
 * brief ran. (The marker sits on the SAME line as the figure it covers — a
 * wrapped one covers nothing, which this file proved by rejecting an earlier
 * draft of this very paragraph.)
 *
 * THIS SET IS A CALIBRATION AGAINST THIS CORPUS, NOT A THEORY OF COUNTS VERSUS
 * RATIOS. What was measured, and it is all that is claimed: over the row-110
 * corpus an UNGATED reverse arm reported six lines, two of them ratios
 * (`"more than one component in twenty is lost"`, in two files); gating on this
 * connector set drops both and keeps four, all of them genuine dated records.
 * Zero false positives on this corpus.
 *
 * WHERE IT IS KNOWN TO BE WRONG — an earlier draft of this comment asserted
 * that a ratio reaches its number through a PREPOSITION and a count through a
 * copula. The preposition half holds. The copula half is false in BOTH
 * directions: `"the failure rate is nineteen percent"` is a ratio that this arm
 * REPORTS, and `"the endpoint set now has nineteen members"` is a count it
 * MISSES. Those probes are pinned with their measured verdicts in the
 * CALIBRATION test below, so the limit is a fixture rather than a sentence.
 * Do not restate the rule; extend the table.
 */
const COUNT_CONNECTOR =
  "(?:(?:is|was|are|were|stays?|stayed|remains?|remained|becomes?|became|numbers?|totals?)\\s+|#)";

const QUANTIFIED =
  "(?<![\\w-])(?:the|other|those|these|all|only|just|remaining)\\s+" +
  numberAtom(2, 25, 1, 99);

/**
 * `GET`/`GETs` name the HTTP method and are always upper-case here. A lower-case
 * match is the English verb — a different WORD, so the case fold must not reach
 * it (limit L4).
 */
function nounIsReal(noun: string): boolean {
  return /^gets?$/i.test(noun) ? /^GETs?$/.test(noun) : true;
}

interface Arm {
  readonly id: string;
  readonly what: string;
  readonly rx: () => RegExp;
}

const ARMS: readonly Arm[] = [
  {
    id: "M",
    what: "a magnitude claim about the endpoint set or the component set",
    rx: () =>
      new RegExp(
        `${numberAtom(MAGNITUDE_FLOOR, MAGNITUDE_CEILING, MAGNITUDE_FLOOR, MAGNITUDE_CEILING)}` +
          `[^\\n]{0,${NOUN_GAP}}?${SET_NOUN}`,
        "gi",
      ),
  },
  {
    id: "P",
    what: "a carve-out stated as `N of the M …` rather than as its members",
    // No floor: the defect this arm exists for wore the values 4, 5, 10 and 11.
    // The two-word adjective slot is measured — at three words it starts
    // reporting correct prose about OTHER sets ("12 of 17 briefs with the
    // other 5"), at two it reports the three real carve-outs and nothing else.
    rx: () =>
      new RegExp(
        `${numberAtom(1, 25, 1, 99)}\\s+of\\s+${DETERMINER}${numberAtom(1, 25, 1, 99)}` +
          `\\s*(?:[A-Za-z][\\w-]*\\s+){0,2}${CARVE_NOUN}`,
        "gi",
      ),
  },
  {
    id: "R",
    what: "a count reached from the NOUN side (`the endpoint count is N`)",
    // Arm M is directional. This is the same magnitude claim written backwards,
    // and it is where every DATED record on this surface turned out to live:
    // all four findings on the post-fix tree were legitimate FR-245 records
    // that arm M could not see, and all four took a marker. The connector set
    // is calibrated, not derived — see COUNT_CONNECTOR's header and the
    // CALIBRATION test for the shapes it gets wrong.
    rx: () =>
      new RegExp(
        `${SET_NOUN}[^\\n]{0,${NOUN_GAP}}?${COUNT_CONNECTOR}` +
          numberAtom(MAGNITUDE_FLOOR, MAGNITUDE_CEILING, MAGNITUDE_FLOOR, MAGNITUDE_CEILING),
        "gi",
      ),
  },
  {
    id: "F",
    what: "a count of the endpoints reached through `parseFilters`",
    // The identifier IS the derivation for the carve-out that drifted in FOUR
    // copies carrying three different values. This arm has no set-noun to
    // anchor on, so it anchors on a DETERMINER instead: that is what separates
    // a quantified noun phrase ("the 6 that hand-parse") from a numeric
    // literal sitting near a call site (`limit=10`, `20 }); const filters =
    // parseFilters(`), which is what a determiner-free version reported on the
    // wrapped pass. The word `one` is out of the ladder here because it is a
    // pronoun in this neighbourhood ("reports each one"); the numeral 1 stays.
    rx: () =>
      new RegExp(
        `(?:${QUANTIFIED}[^\\n]{0,60}?parseFilters` +
          `|parseFilters[^\\n]{0,60}?${QUANTIFIED})`,
        "gi",
      ),
  },
];

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly arm: string;
  readonly text: string;
  /** Offset of the match within the scanned string. Needed by the wrap pass. */
  readonly index: number;
}

/**
 * How far a `count:record` marker reaches. **The exemption is FIGURE-scoped, not
 * LINE-scoped, and that distinction is the whole of M1.**
 *
 * The first version of this file asked `hasValidMarker(line)` and skipped the
 * whole line. On ordinary source that is indistinguishable from this rule. On
 * `MAINTAINING.md` it was catastrophic: a map row is ONE LINE — row 110
 * measured 64_050 characters — so a single marker anywhere in it exempted the
 * entire contract row. Rows 110 and 114 were never scanned at all, and row 114
 * is the row whose capitalised `SEVENTEEN` motivated this file's own
 * case-folding rule. The blind spot was visible in TD-422's floor-9 table,
 * which listed `MAINTAINING.md:109` and `:112` and NOT `:110`, even though 110
 * carries two of the figures that table is about.
 *
 * 120 is derived, not chosen: measured across every marker-bearing line in the
 * corpus, the largest legitimate marker-to-figure distance is 73 characters
 * (this file's own fixture rows, whose marker is a trailing line comment).
 * 120 clears that with margin and is four hundred times smaller than the row it
 * had to stop exempting. `MARKER_REACH_HEADROOM` below re-derives the 73 at
 * test time, so this constant cannot quietly stop covering the real cases.
 */
const MARKER_REACH = 120;

/** Spans of every well-formed marker in `text`. */
function markerSpans(text: string): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const m of text.matchAll(/count:record\s+([A-Za-z-]+-\d+)/g)) {
    if (MARKER_ID.test(m[1]!)) out.push([m.index!, m.index! + m[0].length] as const);
  }
  return out;
}

/** Character gap between two spans; 0 if they touch or overlap. */
function spanGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd <= bStart) return bStart - aEnd;
  if (bEnd <= aStart) return aStart - bEnd;
  return 0;
}

function isExempt(
  spans: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([a, b]) => spanGap(start, end, a, b) <= MARKER_REACH);
}

/**
 * Scan one file's text.
 *
 * TWO PASSES, and the second one is not optional. A claim that WRAPS is
 * invisible to a line-scoped scan — measured on this very corpus, where
 * `docs/dashboard.md` splits "the N endpoints that route" / "through
 * `parseFilters`" across two lines and every line-scoped arm reads past it.
 * The wrap pass joins each adjacent pair and keeps only matches that actually
 * CROSS the join, so a hit is reported once, against the line it starts on.
 */
function scanText(rel: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n");
  const strip = (s: string): string => s.replace(/^[\s*/#>|-]*/, "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const spans = markerSpans(line);
    for (const f of matchesIn(rel, i + 1, line)) {
      if (!isExempt(spans, f.index, f.index + f.text.length)) out.push(f);
    }
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!;
    const tail = strip(lines[i + 1]!);
    if (head.trim().length === 0 || tail.length === 0) continue;
    const joined = `${head} ${tail}`;
    const spans = markerSpans(joined);
    for (const f of matchesIn(rel, i + 1, joined)) {
      // Keep only what the single-line pass could not have seen. The offset
      // comes from the MATCH, never from `indexOf` — a fragment that repeats on
      // the line would otherwise be located at its first occurrence.
      const start = f.index;
      if (start >= head.length || start + f.text.length <= head.length + 1) continue;
      if (!isExempt(spans, start, start + f.text.length)) out.push(f);
    }
  }
  return out;
}

function matchesIn(rel: string, line: number, text: string): Finding[] {
  const out: Finding[] = [];
  for (const arm of ARMS) {
    const rx = arm.rx();
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const noun = m.slice(1).find((g) => typeof g === "string");
      if (arm.id !== "F" && noun !== undefined && !nounIsReal(noun)) continue;
      out.push({ file: rel, line, arm: arm.id, text: m[0], index: m.index });
    }
  }
  return out;
}

function render(findings: readonly Finding[]): string {
  return findings
    .map((f) => `  ${f.file}:${f.line}  [arm ${f.arm}]  ${f.text.replace(/\s+/g, " ").slice(0, 100)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// The corpus, parsed from the map row itself.
// ---------------------------------------------------------------------------

function mapRow(n: number): string {
  const lines = readFileSync(MAINTAINING, "utf-8").split("\n");
  const row = lines[n - 1];
  expect(row, `MAINTAINING.md has no line ${n}`).toBeDefined();
  return row!;
}

function consumersCell(row: string): string {
  const cells = row.split("|");
  // Leading empty + five columns + trailing empty. `check_contract_consumers.sh`
  // reads the same split, so a row that fails this is a row the repo's own
  // contract gate is silently mis-reading too.
  expect(cells.length, "row " + MAP_ROW + " is not a 5-column map row").toBe(7);
  return cells[3]!;
}

let trackedCache: string[] | null = null;
function tracked(): string[] {
  if (trackedCache === null) {
    trackedCache = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf-8" })
      .split("\n")
      .filter((l) => l.length > 0);
  }
  return trackedCache;
}

/**
 * The same classification `MAINTAINING.md`'s "Citation conventions" section and
 * `scripts/check_contract_consumers.sh` already apply: a slash-bearing token in
 * the path charset, not rooted, resolved repo-root-first then as a unique
 * suffix of the tracked set. Globs and bare directories are left to that script.
 */
function corpusFiles(): string[] {
  const cell = consumersCell(mapRow(MAP_ROW));
  const toks = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const files = new Set<string>(["MAINTAINING.md", "docs/dashboard.md"]);
  for (const tok of toks) {
    if (!tok.includes("/")) continue;
    if (/[^A-Za-z0-9_./*{},+-]/.test(tok)) continue;
    if (tok.startsWith("~") || tok.startsWith("/") || tok.startsWith("..")) continue;
    // `isFile`, not `existsSync`: row 110 also cites bare DIRECTORIES
    // (`core/`, `cli/dist/`) and globs, which that script expands and this
    // scan does not. Reading one is an EISDIR, not a corpus member.
    if (isFile(join(REPO_ROOT, tok))) {
      files.add(tok);
      continue;
    }
    const hits = tracked().filter((t) => t.endsWith("/" + tok));
    if (hits.length === 1) files.add(hits[0]!);
  }
  return [...files].sort();
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function scanCorpus(): Finding[] {
  const out: Finding[] = [];
  for (const rel of corpusFiles()) {
    const abs = join(REPO_ROOT, rel);
    if (!isFile(abs)) continue;
    out.push(...scanText(rel, readFileSync(abs, "utf-8")));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Part 1's derivations. Each reads source; none carries a total.
// ---------------------------------------------------------------------------

const DASH = join(REPO_ROOT, "cli", "src", "lib", "dashboard");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf-8");
}

/** Every `^export … function` in `routes.ts`, in declaration order. */
function routesExports(): string[] {
  return [...read(DASH, "routes.ts").matchAll(/^export (?:async )?function (\w+)/gm)].map(
    (m) => m[1]!,
  );
}

/** `server.ts`'s exact-match GET arms, as `path -> handler`. */
function serverGetArms(): Map<string, string> {
  const src = read(DASH, "server.ts");
  const rx = /if \(pathname === "([^"]+)"\) \{\s*sendJson\(res, 200, (?:await )?routes\.(\w+)\(/g;
  const out = new Map<string, string>();
  for (const m of src.matchAll(rx)) out.set(m[1]!, m[2]!);
  return out;
}

function writePath(): string {
  const m = /export const WRITE_PATH = "([^"]+)"/.exec(read(DASH, "server.ts"));
  expect(m, "server.ts no longer declares WRITE_PATH").not.toBeNull();
  return m![1]!;
}

/** The `--smoke` probe list, verbatim from the constant. */
function smokeProbePaths(): string[] {
  const src = read(REPO_ROOT, "cli", "src", "verbs", "dashboard.ts");
  const start = src.indexOf("const SMOKE_PROBE_PATHS");
  expect(start, "verbs/dashboard.ts no longer declares SMOKE_PROBE_PATHS").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n];", start));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * `dashboard.bats`'s exact-set assertion, split back into members. A member is
 * either a bare path (a GET) or `POST <path>` — so the method token has to be
 * re-joined to the path that follows it, or the write path reads as a GET.
 */
function batsExpectedSet(): { reads: string[]; writes: string[] } {
  const src = read(REPO_ROOT, "cli", "tests", "integration", "dashboard.bats");
  const m = /local expected="([^"]+)"/.exec(src);
  expect(m, "dashboard.bats no longer carries `local expected=\"…\"`").not.toBeNull();
  const toks = m![1]!.trim().split(/\s+/);
  const reads: string[] = [];
  const writes: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (/^[A-Z]+$/.test(toks[i]!)) {
      writes.push(`${toks[i]} ${toks[++i]}`);
    } else {
      reads.push(toks[i]!);
    }
  }
  return { reads, writes };
}

/** The `N read paths` figure inside the bats digest assertion. */
function batsReadPathFigure(): number {
  const src = read(REPO_ROOT, "cli", "tests", "integration", "dashboard.bats");
  const m = /'(\d+) read paths all 200, (\d+) write path 400'/.exec(src);
  expect(m, "dashboard.bats no longer asserts the `N read paths …` digest line").not.toBeNull();
  return Number(m![1]);
}

/**
 * The endpoints whose handler routes its query through `parseFilters` — the
 * derivation that replaced a quoted carve-out in four places.
 */
function parseFilterEndpoints(): string[] {
  const src = read(DASH, "routes.ts");
  const lines = src.split("\n");
  const owners = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!/\bparseFilters\(/.test(lines[i]!)) continue;
    for (let j = i; j >= 0; j--) {
      const d = /^export (?:async )?function (\w+)/.exec(lines[j]!);
      if (d !== null) {
        owners.add(d[1]!);
        break;
      }
    }
  }
  const arms = serverGetArms();
  const paths: string[] = [];
  for (const [path, handler] of arms) if (owners.has(handler)) paths.push(path);
  return paths.sort();
}

/**
 * The endpoints whose handler opens the shared read preamble — `openReadContext`'s
 * call sites. The declaration itself is skipped: it is the definition, not a use.
 */
function readPreambleEndpoints(): string[] {
  const lines = read(DASH, "routes.ts").split("\n");
  const owners = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/\bopenReadContext\(\)/.test(line)) continue;
    if (/function openReadContext/.test(line)) continue;
    if (line.trimStart().startsWith("*")) continue;
    for (let j = i; j >= 0; j--) {
      const d = /^export (?:async )?function (\w+)/.exec(lines[j]!);
      if (d !== null) {
        owners.add(d[1]!);
        break;
      }
    }
  }
  const paths: string[] = [];
  for (const [path, handler] of serverGetArms()) if (owners.has(handler)) paths.push(path);
  return paths.sort();
}

/** `componentFactories`' members, by factory name, from the engine's own array. */
function componentFactories(): string[] {
  const src = read(REPO_ROOT, "brain-mcp-server", "src", "engine", "index.ts");
  const start = src.indexOf("const componentFactories = [");
  expect(start, "engine/index.ts no longer declares `componentFactories`").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n  ];", start));
  return [...block.matchAll(/^\s*(create\w+Component),/gm)].map((m) => m[1]!);
}

function apiOnly(paths: readonly string[]): string[] {
  return paths.filter((p) => p.startsWith("/api/")).sort();
}

// ===========================================================================
// PART 0 — the corpus. A scan over nothing is indistinguishable from a pass.
// ===========================================================================

describe("TD-420 part 0 — the scan has a corpus, derived from the map row itself", () => {
  it("row " + MAP_ROW + " parses as a 5-column map row and yields a non-empty corpus", () => {
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(20);
    for (const anchor of [
      "MAINTAINING.md",
      "docs/dashboard.md",
      "cli/src/lib/dashboard/routes.ts",
      "cli/src/lib/dashboard/server.ts",
      "cli/src/lib/dashboard/params.ts",
      "cli/src/verbs/dashboard.ts",
      "cli/src/lib/brain-write-bridge.ts",
      "cli/src/__tests__/dashboard-layers-endpoint.test.ts",
      "cli/tests/integration/dashboard.bats",
    ]) {
      expect(files, `row ${MAP_ROW} no longer cites ${anchor} — the guard just lost it`).toContain(
        anchor,
      );
    }
  });

  it("every corpus member resolves on disk", () => {
    for (const rel of corpusFiles()) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} is in the corpus but not on disk`).toBe(true);
    }
  });

  it("SELF-NEGATIVE-CONTROL — a row whose Consumers cell cites nothing yields no corpus", () => {
    const empty = " no citations here at all ";
    const toks = [...empty.matchAll(/`([^`]+)`/g)];
    expect(toks.length).toBe(0);
  });
});

// ===========================================================================
// PART 1 — assert-MATCHES. Derivation against derivation, as SETS.
// ===========================================================================

describe("TD-420 part 1 — the independent enumerations of the local surface agree", () => {
  it("`server.ts` arms, `SMOKE_PROBE_PATHS` and `dashboard.bats` name the same GET paths", () => {
    const arms = [...serverGetArms().keys()].sort();
    const smoke = apiOnly(smokeProbePaths());
    const bats = batsExpectedSet();
    expect(smoke, "SMOKE_PROBE_PATHS has drifted from server.ts's route arms").toEqual(arms);
    expect(
      apiOnly(bats.reads),
      "dashboard.bats's exact-set string has drifted from server.ts's arms",
    ).toEqual(arms);
    expect(bats.writes, "dashboard.bats's write-half probe has changed shape").toEqual([
      `POST ${writePath()}`,
    ]);
  });

  it("`routes.ts` exports exactly the GET handlers plus the one write handler", () => {
    const exported = new Set(routesExports());
    const dispatched = new Set(serverGetArms().values());
    for (const h of dispatched) {
      expect(exported, `server.ts dispatches routes.${h} but routes.ts does not export it`).toContain(
        h,
      );
    }
    const extra = [...exported].filter((h) => !dispatched.has(h));
    // The write handler is the ONLY export server.ts does not reach through a
    // 200 arm. Naming it derives the exception instead of tolerating a count.
    expect(extra, "routes.ts exports a handler no GET arm dispatches").toEqual(["triage"]);
    expect(writePath()).toBe("/api/triage");
  });

  it("`SMOKE_PROBE_PATHS` covers the shell root plus every GET path, and the bats digest figure agrees", () => {
    const smoke = smokeProbePaths();
    expect(smoke, "SMOKE_PROBE_PATHS no longer probes the shell root").toContain("/");
    expect(new Set(smoke).size, "SMOKE_PROBE_PATHS carries a duplicate").toBe(smoke.length);
    expect(
      batsReadPathFigure(),
      "dashboard.bats's `N read paths` figure has drifted from SMOKE_PROBE_PATHS",
    ).toBe(smoke.length);
  });

  it("the `parseFilters` carve-out row 110 ENUMERATES is the set `routes.ts` actually calls", () => {
    const derived = parseFilterEndpoints();
    expect(
      derived.length,
      "no handler calls parseFilters — the derivation is disarmed",
    ).toBeGreaterThan(1);

    // The sentence in row 110 is about `/api/suggestions`' project axis and
    // says "the OTHERS", so its own subject is excluded BY THE SENTENCE, not by
    // a hand-list. Assert the subject really is in the derived set, or the
    // subtraction below would be quietly excluding nothing.
    const SUBJECT = "/api/suggestions";
    expect(
      derived,
      `${SUBJECT} no longer routes through parseFilters — row ${MAP_ROW}'s carve-out has a different subject now`,
    ).toContain(SUBJECT);
    const others = derived.filter((p) => p !== SUBJECT);

    const cell = mapRow(MAP_ROW);
    const anchor = cell.indexOf("route through `parseFilters`");
    expect(
      anchor,
      "row " + MAP_ROW + " no longer states the parseFilters carve-out",
    ).toBeGreaterThan(-1);
    // Scope to the PARENTHETICAL that follows the anchor. A fixed-width window
    // runs straight into the complementary list in the same sentence.
    const open = cell.indexOf("(", anchor);
    const close = cell.indexOf(")", open);
    expect(open, "row " + MAP_ROW + " no longer enumerates the carve-out").toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const listed = [...cell.slice(open, close).matchAll(/`(\/api\/[a-z/-]+)`/g)]
      .map((m) => m[1]!)
      .sort();
    expect(
      listed,
      "row " +
        MAP_ROW +
        "'s parseFilters enumeration has drifted from routes.ts. Do not quote a count — DERIVE it: re-read the parseFilters call sites and re-list the paths.",
    ).toEqual(others);
  });

  it("the SHARED READ PREAMBLE list in `routes.ts` is the set that calls `openReadContext`", () => {
    // F1/option-c: this claim used to be a COUNT ("all nine handlers"), which sat
    // below the magnitude floor and was wrong in both directions — it named two
    // paths that open no handle and omitted one that does. Converting it to an
    // enumeration is only an improvement if the enumeration is GATED, so this is
    // the gate.
    const derived = readPreambleEndpoints();
    expect(
      derived.length,
      "nothing calls openReadContext — the derivation is disarmed",
    ).toBeGreaterThan(1);

    const src = read(DASH, "routes.ts");
    const anchor = src.indexOf("SHARED READ PREAMBLE:");
    expect(anchor, "routes.ts no longer carries the SHARED READ PREAMBLE enumeration").toBeGreaterThan(
      -1,
    );
    // Read to the end of that comment paragraph — a blank ` *` line — so the
    // scan cannot run on into the next paragraph's paths.
    const end = src.indexOf("\n *\n", anchor);
    expect(end).toBeGreaterThan(anchor);
    const listed = [...src.slice(anchor, end).matchAll(/`(\/api\/[a-z/-]+)`/g)]
      .map((m) => m[1]!)
      .sort();
    expect(
      listed,
      "routes.ts's SHARED READ PREAMBLE list has drifted from openReadContext's call sites. " +
        "Do not quote a count — DERIVE it: re-read the call sites and re-list the paths.",
    ).toEqual(derived);
  });

  it("SELF-NEGATIVE-CONTROL — the read-preamble pin is not empty-vs-empty", () => {
    const derived = readPreambleEndpoints();
    expect(derived).toContain("/api/briefs");
    // FR-241's path shares the preamble and is NOT an FR-240 layer path — the
    // exact asymmetry the old "all nine handlers" count got wrong.
    expect(derived).toContain("/api/suggestions");
    expect(derived).not.toContain("/api/context-docs");
    expect(derived).not.toContain("/api/learnings/search");
  });

  it("the engine component set is read from `componentFactories`, and it is non-trivial", () => {
    const factories = componentFactories();
    expect(new Set(factories).size, "componentFactories carries a duplicate").toBe(factories.length);
    expect(factories.length, "componentFactories parsed to almost nothing").toBeGreaterThan(5);
    expect(factories).toContain("createCognitionComponent");
    expect(factories).toContain("createCatalogComponent");
  });

  it("SELF-NEGATIVE-CONTROL — the set comparison reports a path present in only one derivation", () => {
    const arms = [...serverGetArms().keys()].sort();
    const drifted = [...arms, "/api/invented"].sort();
    expect(drifted).not.toEqual(arms);
    // …and the shape the pin uses (sorted array equality) is what discriminates,
    // not merely the lengths: a swap of one member must also report.
    const swapped = [...arms.slice(0, -1), "/api/other"].sort();
    expect(swapped.length).toBe(arms.length);
    expect(swapped).not.toEqual(arms);
  });

  it("SELF-NEGATIVE-CONTROL — the parseFilters derivation is not vacuously empty-vs-empty", () => {
    expect(parseFilterEndpoints()).toContain("/api/briefs");
  });
});

// ===========================================================================
// PART 2 — assert-ABSENT. No unmarked count over these sets, in the corpus.
// ===========================================================================

describe("TD-420 part 2 — no quoted count for these sets survives in the corpus", () => {
  it("the contract corpus carries no unmarked count", () => {
    const findings = scanCorpus();
    expect(
      findings.length === 0,
      findings.length === 0
        ? ""
        : "A count is true at one instant, against one instrument, over one corpus. It rots " +
          "silently, reads as measured forever, and a reviewer can refute it in one grep. A " +
          "DERIVATION does not rot — and when it is wrong it is wrong visibly, because you can " +
          "run it. (L-1314)\n\nDelete the number and cite the source that enumerates the set. " +
          "If the sentence is a dated RECORD of a past measurement, add `count:record <BRIEF-ID>` " +
          "on the same line; there is no marker for a live claim.\n\n" +
          render(findings),
    ).toBe(true);
  });

  it("every `count:record` marker in the corpus names a real brief id", () => {
    const bad: string[] = [];
    for (const rel of corpusFiles()) {
      const abs = join(REPO_ROOT, rel);
      if (!isFile(abs)) continue;
      const lines = readFileSync(abs, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Same token grammar the exemption uses. `\S+` would swallow the
        // punctuation that ends the sentence carrying the marker and report
        // every correct marker in the tree as malformed.
        for (const m of lines[i]!.matchAll(/count:record\s+([A-Za-z][A-Za-z0-9-]*)/g)) {
          if (!MARKER_ID.test(m[1]!)) bad.push(`${rel}:${i + 1}  -> ${m[1]}`);
        }
      }
    }
    expect(bad, "a `count:record` marker does not name a brief id").toEqual([]);
  });
});

describe("TD-420 part 2 — the scanner fires, and fires only on what it claims", () => {
  const plant = (body: string): Finding[] => scanText("PLANT", body);

  it("SELF-NEGATIVE-CONTROL — a planted stale magnitude claim is reported", () => {
    expect(plant("the SIXTEEN handlers hold zero SQL").map((f) => f.arm)).toContain("M"); // count:record TD-420
    expect(plant("all sixteen GET API paths plus the shell root").map((f) => f.arm)).toContain("M"); // count:record TD-420
    expect(plant("the other seventeen GETs rest on it").map((f) => f.arm)).toContain("M"); // count:record TD-420
    expect(plant("the live surface is EIGHTEEN GET and one POST").map((f) => f.arm)).toContain("M"); // count:record TD-420
    expect(plant("pulls in all sixteen components on every beat").map((f) => f.arm)).toContain("M"); // count:record TD-420
  });

  it("SELF-NEGATIVE-CONTROL — a planted carve-out is reported by its SHAPE, below any floor", () => {
    expect(plant("reported by the 5 of the 11 OTHERS that route through it").map((f) => f.arm)).toContain( // count:record TD-420
      "P",
    );
    expect(plant("the 4 of the 10 others, and this drives 3 of those 4").map((f) => f.arm)).toContain( // count:record TD-420
      "P",
    );
    expect(
      plant("4 of the 10 OTHER project-bearing endpoints say so").map((f) => f.arm), // count:record TD-420
    ).toContain("P");
  });

  it("SELF-NEGATIVE-CONTROL — arm R reads the claim written BACKWARDS", () => {
    // Arm M is directional: NUMBER -> NOUN. Every string here is the same
    // magnitude claim reached from the NOUN side, and each was GREEN before
    // arm R existed.
    for (const line of [
      "The endpoint count is nineteen today.", // count:record TD-420
      "The GET endpoints on this surface number nineteen today.", // count:record TD-420
      "the route arms are eighteen as of today", // count:record TD-420
      "NO ENDPOINT WAS ADDED: the count stays SIXTEEN", // count:record TD-420
      "would have been endpoint #17", // count:record TD-420
    ]) {
      expect(plant(line).map((f) => f.arm), `arm R missed: ${line}`).toContain("R");
    }
  });

  it("ARM CHECK — the connector set drops the PREPOSITION ratios it was calibrated on", () => {
    // Measured over the real corpus: an arm R without COUNT_CONNECTOR reported
    // `"more than one component in twenty is lost over a single octave"` in two
    // files, and gating on the connector set drops both. That is the whole of
    // the claim — see the CALIBRATION test for the copula shapes it does NOT
    // get right. Both halves asserted, or the exclusion is a hope.
    expect(plant("more than one component in twenty is lost over a single octave")).toEqual([]);
    expect(plant("a 4-connected component count over twenty runs")).toEqual([]);
    expect(plant("the component count is twenty exactly").length).toBeGreaterThan(0); // count:record TD-420
    // …and arm R inherits the floor, in both directions.
    expect(plant("the endpoint count is twelve today")).toEqual([]);
    expect(plant("the endpoint count is thirteen today").length).toBeGreaterThan(0); // count:record TD-420
  });

  it("ARM R's CALIBRATION, pinned as MEASURED verdicts rather than as a rule", () => {
    // G2. An earlier draft of this file claimed COUNT_CONNECTOR separates a
    // count from a ratio "because a ratio reaches its number through a
    // preposition". The preposition half of that holds. THE COPULA HALF DOES
    // NOT, in either direction, and these probes are the proof. They are pinned
    // with the verdicts the shipped predicate actually produces, so the
    // connector set is documented as a CALIBRATION against this corpus and not
    // as a theory of English. Change the connector set and this table moves —
    // which is the point of it being a table.
    const probes: ReadonlyArray<readonly [string, boolean, string]> = [
      // probe                                                    reported?  what it really is
      ["the component failure rate is nineteen percent", true, "RATIO via copula — a FALSE POSITIVE"], // count:record TD-420
      ["the endpoint error rate is 19 percent of all calls", true, "RATIO via copula — a FALSE POSITIVE"], // count:record TD-420
      ["the endpoint p50 is 19 ms on this machine", true, "LATENCY via copula — a FALSE POSITIVE"], // count:record TD-420
      ["the handler index is 14 in that array", true, "INDEX via copula — a FALSE POSITIVE"], // count:record TD-420
      ["the endpoint set now has nineteen members", false, "a COUNT, MISSED — `has` is not a connector"], // count:record TD-420
      ["the endpoint count reached nineteen at FR-266", false, "a COUNT, MISSED — `reached`"], // count:record TD-420
      ["the handler count sits at nineteen", false, "a COUNT, MISSED — `sits at`"], // count:record TD-420
      ["endpoints: 19", false, "a COUNT, MISSED — no connector at all"], // count:record TD-420
      ["more than one component in twenty is lost", false, "RATIO via preposition — correctly silent"], // count:record TD-420
      ["the endpoint count is nineteen today", true, "a COUNT — correctly reported"], // count:record TD-420
      ["NO ENDPOINT WAS ADDED: the count stays SIXTEEN", true, "a dated COUNT — correctly reported"], // count:record TD-420
    ];
    for (const [probe, expected, why] of probes) {
      const reported = plant(probe).some((f) => f.arm === "R");
      expect(reported, `arm R verdict moved for: ${probe}  (${why})`).toBe(expected);
    }
    // THE HONEST SUMMARY: on THIS corpus the arm is clean — it reports the
    // genuine dated records and nothing else. None of the false-positive shapes
    // above occurs in the corpus today, but the latency one is NOT hypothetical:
    // `docs/dashboard.md` already carries a millisecond reading beside a `GET`
    // column, and it is silent only because that reading has no copula. Treat a
    // new rate/latency sentence near a set-noun as a known cost of this arm.
  });

  it("SELF-NEGATIVE-CONTROL — a count near `parseFilters` is reported even with no set-noun", () => {
    expect(plant("routed through `parseFilters`. The other 6 are SILENT").map((f) => f.arm)).toContain( // count:record TD-420
      "F",
    );
    expect(plant("IGNORED by the 6 that hand-parse it, unlike parseFilters").map((f) => f.arm)).toContain( // count:record TD-420
      "F",
    );
  });

  it("M1 REGRESSION — the exemption is FIGURE-scoped: a distant marker exempts nothing", () => {
    // The defect this replaces: `hasValidMarker(line)` skipped the WHOLE line.
    // `MAINTAINING.md`'s map rows are single lines of tens of thousands of
    // characters, so one marker took two contract rows out of the scan
    // entirely — including the row whose capitalised figure motivated this
    // file's own case-folding rule.
    const near = `the SIXTEEN handlers hold zero SQL (count:record TD-420)`; // count:record TD-420
    expect(plant(near), "a marker beside the figure must exempt it").toEqual([]);

    const far =
      `the SIXTEEN handlers hold zero SQL` + // count:record TD-420
      " filler".repeat(Math.ceil((MARKER_REACH + 60) / 7)) +
      " count:record TD-420";
    expect(
      plant(far).map((f) => f.arm),
      "a marker beyond MARKER_REACH must NOT exempt the figure",
    ).toContain("M");

    // …and the boundary is where it says it is, from both sides.
    const at = (gap: number): string =>
      `the SIXTEEN handlers` + " ".repeat(gap) + "count:record TD-420"; // count:record TD-420
    expect(plant(at(MARKER_REACH - 1))).toEqual([]);
    expect(plant(at(MARKER_REACH + 1)).length).toBeGreaterThan(0);
  });

  it("MARKER_REACH still covers every real marker-to-figure distance in the corpus", () => {
    // Derived, never pinned: if a future marker is written further from its
    // figure than MARKER_REACH allows, this fails and names it rather than
    // letting the figure quietly start reporting.
    let worst = 0;
    let where = "";
    for (const rel of corpusFiles()) {
      const abs = join(REPO_ROOT, rel);
      if (!isFile(abs)) continue;
      const lines = readFileSync(abs, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const spans = markerSpans(lines[i]!);
        if (spans.length === 0) continue;
        for (const f of matchesIn(rel, i + 1, lines[i]!)) {
          const d = Math.min(
            ...spans.map(([a, b]) => spanGap(f.index, f.index + f.text.length, a, b)),
          );
          if (d <= MARKER_REACH && d > worst) {
            worst = d;
            where = `${rel}:${i + 1}`;
          }
        }
      }
    }
    expect(worst, "no marker-bearing figure found — this check is vacuous").toBeGreaterThan(0);
    expect(
      worst,
      `the furthest real marker-to-figure distance is now ${worst} at ${where}, ` +
        `which is within MARKER_REACH (${MARKER_REACH}) but leaves little headroom — ` +
        `move the marker next to its figure rather than raising the constant`,
    ).toBeLessThan(MARKER_REACH);
  });

  it("the map's mega-rows are INSIDE the scan, not skipped by their own markers", () => {
    // The blind spot was invisible because it looked exactly like silence.
    // Assert the shape that caused it: these rows are single lines, they are
    // enormous, and they carry markers.
    const lines = readFileSync(MAINTAINING, "utf-8").split("\n");
    for (const n of [MAP_ROW, 114]) {
      const row = lines[n - 1]!;
      expect(row.length, `row ${n} is no longer a large single line`).toBeGreaterThan(5_000);
      expect(markerSpans(row).length, `row ${n} no longer carries a marker`).toBeGreaterThan(0);
    }
    // …and a figure planted far from the marker in a row of that shape reports.
    const synthetic = `x`.repeat(20_000) + " count:record TD-420 " + `y`.repeat(20_000) +
      " the SIXTEEN handlers"; // count:record TD-420
    expect(plant(synthetic).map((f) => f.arm)).toContain("M");
  });

  it("the marker exempts a dated record, and ONLY with a well-formed brief id", () => {
    expect(plant("the surface was sixteen GET and one POST count:record FR-247")).toEqual([]);
    expect(plant("the surface was sixteen GET and one POST <!-- count:record TD-420 -->")).toEqual([]);
    // A malformed id does not exempt: the line is scanned as if unmarked…
    // (Composed rather than written out, so this FIXTURE is not itself a
    // malformed marker in a file the audit above reads.)
    const malformed = `count:record ${"nonsense"}`;
    expect(plant(`the surface was sixteen GET ${malformed}`).length).toBeGreaterThan(0); // count:record TD-420
    // …and the marker audit reports it independently.
    expect(MARKER_ID.test("nonsense")).toBe(false);
    expect(MARKER_ID.test("FR-247")).toBe(true);
  });

  it("FALSE-POSITIVE CONTROL — real corpus lines that must stay silent", () => {
    // Every string here is a real line from a file INSIDE the corpus. Three of
    // them live in `MAINTAINING.md` itself, so nothing but the noun vocabulary
    // is protecting them — which is the point of anchoring on the noun.
    for (const line of [
      "the sixteen lines under it are the derivation",
      "a change to ALL FIFTEEN gates is a contract change",
      "the grid is sixteen columns wide",
      "Triage spans all nineteen projects on this brain",
      "there are 6 goals on the operator brain",
      "SIXTEEN lines under the marker",
      "eighteen lines below the fixture",
      "710 nodes render as 354 connected components in the ink map",
      "the fit reading is 15.9% of the FIT component count",
      "a full crawl of every endpoint, added 2026-08-03 to get parity",
      "`brain-mcp-server/src/engine/components/briefs/index.ts:297` is the fourth statement",
      "19 read paths all 200, 1 write path 400",
      "sendJson(res, 404, { error: `no such endpoint: ${pathname}` })",
      "405, including the read endpoints",
      "12 of 17 briefs with the other 5 asserted byte-identical",
    ]) {
      expect(plant(line), `predicate over-fired on: ${line}`).toEqual([]);
    }
  });

  it("ARM CHECK — the false-positive controls are not silent by accident", () => {
    // If the whole predicate stopped matching anything, the block above would
    // pass vacuously. Each control is paired with the ONE edit that must make
    // it fire, so silence is a measurement rather than a stuck instrument.
    expect(plant("the sixteen handlers under it are the derivation").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("a change to ALL FIFTEEN endpoints is a contract change").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("Triage spans all nineteen endpoints on this brain").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("12 of 17 endpoints with the other 5").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("19 read handlers all 200").length).toBeGreaterThan(0); // count:record TD-420
  });

  it("ARM CHECK — the case rule separates the HTTP method from the English verb", () => {
    expect(plant("the other seventeen GETs rest on it").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("the other seventeen gets rest on it")).toEqual([]);
    // …while the NUMBER half folds case unconditionally (row 114's stale copy
    // was upper-case and four lower-case sweeps could not see it).
    expect(plant("the other SEVENTEEN GETs rest on it").length).toBeGreaterThan(0); // count:record TD-420
  });

  it("ARM CHECK — the magnitude floor is what it claims, in both directions", () => {
    expect(plant("the nineteen endpoints on this surface").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("the thirteen endpoints on this surface").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("the twelve endpoints on this surface")).toEqual([]);
    expect(plant("the twenty-five endpoints on this surface").length).toBeGreaterThan(0); // count:record TD-420
    expect(plant("the twenty-six endpoints on this surface")).toEqual([]);
  });

  it("ARM CHECK — the scanner reads a real FILE, not only a string", () => {
    // The corpus scan reads from disk; the plants above go through the same
    // function, but this proves the disk path end to end, outside the repo so
    // a fixture can never become a finding on a real run.
    const dir = mkdtempSync(join(tmpdir(), "td420-"));
    try {
      const f = join(dir, "planted.md");
      writeFileSync(f, "line one\nthe SIXTEEN handlers hold zero SQL\nline three\n"); // count:record TD-420
      const found = scanText("planted.md", readFileSync(f, "utf-8"));
      expect(found.length).toBe(1);
      expect(found[0]!.line).toBe(2);
      expect(resolvePath(f).startsWith(REPO_ROOT)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
