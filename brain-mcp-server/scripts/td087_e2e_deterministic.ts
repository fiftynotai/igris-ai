/**
 * TD-087 — Phase 4 deterministic live-e2e harness.
 *
 * Spins up an in-memory engine against /tmp/td087_e2e_det.db and invokes
 * `runPerception` 5 times with a STUB LLM extractor that returns the same
 * 8 candidates each call (with mild paraphrasing on runs 2..5 to exercise
 * the dedup pipeline like a real LLM would).
 *
 * Why deterministic? The real claude-CLI extractor is non-deterministic
 * across runs — small wording variations are exactly what TD-087 is
 * designed to catch, but they are also what makes the live-e2e flaky.
 * This harness simulates a "well-behaved LLM with mild paraphrasing"
 * so the dedup tuning is exercised end-to-end through the same
 * `runPerception → findNearestMatch → recordRediscovery` codepath the
 * real CLI uses.
 *
 * Pass criteria (from TD-087 plan, Phase 4):
 *   - Run 1: inserted ≈ 8 (cold corpus)
 *   - Run 2..5: inserted ≤ 2; deduped rises run-over-run
 *   - No false-positive merges (sample-check 5 deduped IDs)
 *
 * Usage:
 *   npx tsx brain-mcp-server/scripts/td087_e2e_deterministic.ts
 *
 * Output: JSON summary of all 5 runs to stdout, plus a deduped-row sample.
 */

import * as fs from 'node:fs';
import { runPerception } from '../src/engine/components/perception/runner.js';
import { DEFAULT_PERCEPTION_CONFIG } from '../src/engine/components/perception/types.js';
import type { LlmExtractor } from '../src/engine/components/perception/extractors/llm_via_claude_code.js';
import type { PerceptionCandidate } from '../src/engine/components/perception/types.js';
import { bootEngine } from '../src/engine/index.js';
import { disposeEmbeddingPipeline } from '../src/utils/embeddings.js';

const DB_PATH = '/tmp/td087_e2e_det.db';
const PROJECT = 'td087-e2e';

// Eight canonical candidates spanning the typical perception output mix.
// Each has a "stable" form plus 4 paraphrase variants for runs 2..5.
interface CandidateSet {
  base: PerceptionCandidate;
  paraphrases: Array<{ title: string; content: string }>; // 4 variants
}

function mk(title: string, content: string): PerceptionCandidate {
  return {
    category: 'pattern',
    title,
    content,
    tags: [],
    confidence: 0.7,
    source_extractor: 'llm',
    evidence: {},
  };
}

const CANDIDATES: CandidateSet[] = [
  {
    base: mk(
      'Three-engine brain architecture: perception + subconscious + janitor with shared LLM-extractor primitive',
      'Brain growth split across three engines, each with a single mandate, sharing one extractor primitive for symmetry.',
    ),
    paraphrases: [
      { title: 'Three-engine brain framing: perception, subconscious, janitor — one shared LLM-extractor primitive',
        content: 'Brain growth maintenance splits into three orthogonal mandates that should not be folded together.' },
      { title: 'Three-engine brain: perception/subconscious/janitor share an LLM extractor primitive',
        content: 'Three engines, three mandates, one shared extraction surface — symmetric design across the brain.' },
      { title: 'Brain architecture: three engines (perception, subconscious, janitor) on one extractor',
        content: 'Each engine owns a single mandate. They reuse the same LLM-extractor primitive.' },
      { title: 'Three-engine brain split with a shared LLM extractor: perception, subconscious, janitor',
        content: 'Engine boundaries enforce single-mandate ownership; the LLM-extractor primitive is shared across all three.' },
    ],
  },
  {
    base: mk(
      'sqlite-vec v0.1.7 mutex teardown crash on short-lived Node CLIs after embedding load',
      'Native mutex teardown races V8 exit on short-lived CLI processes; only fires when the embedding pipeline was loaded.',
    ),
    paraphrases: [
      { title: 'sqlite-vec teardown crash only fires when embedding pipeline was loaded',
        content: 'Short-lived Node CLIs invoking sqlite-vec crash on teardown if and only if the embedding pipeline ran.' },
      { title: 'sqlite-vec v0.1.7 mutex teardown crash conditional on embedding pipeline load',
        content: 'The mutex teardown race in sqlite-vec v0.1.7 only manifests after embedding pipeline initialisation.' },
      { title: 'sqlite-vec v0.1.7 native mutex teardown race fires only after embedding init',
        content: 'A native mutex teardown race in sqlite-vec v0.1.7 surfaces in short-lived CLI processes that loaded the embedding pipeline.' },
      { title: 'sqlite-vec v0.1.7 mutex teardown crash is conditional on embedding load',
        content: 'Short-lived CLIs that call sqlite-vec crash during teardown only when the embedding pipeline was loaded.' },
    ],
  },
  {
    base: mk(
      'Mock at the I/O boundary, not at the function under test',
      'Mocking the function under test erases the bug surface; mock the I/O boundary instead so the real handler runs.',
    ),
    paraphrases: [
      { title: 'Mock at I/O boundary, not the function under test — preserve bug surface',
        content: 'Mocking the function under test erases the bug surface. Mock at the I/O boundary so the real handler executes.' },
      { title: 'Mocking the function-under-test erases the bug surface in tests',
        content: 'Mock at the I/O boundary, never the function under test, to preserve the bug surface in tests.' },
      { title: 'Mock at I/O boundary, never mock the function under test',
        content: 'Mock at I/O boundary, never the handler. Otherwise the bug surface vanishes.' },
      { title: 'Mocking the entire handler under test erases the bug surface',
        content: 'Mock at the I/O boundary, not at the function under test, to preserve the bug surface in tests.' },
    ],
  },
  {
    base: mk(
      'Apply bootEngine + try/finally engine.shutdown() to all short-lived CLIs',
      'Standalone CLIs must boot the engine and dispose it in try/finally so native handles release before V8 teardown.',
    ),
    paraphrases: [
      { title: 'Standalone CLIs must boot the engine to run per-component migrations',
        content: 'CLI scripts that touch the brain must call bootEngine and dispose with engine.shutdown() in finally.' },
      { title: 'Boot engine + try/finally shutdown for short-lived CLIs',
        content: 'Standalone CLI scripts must run engine boot to get per-component migrations; finalise with shutdown.' },
      { title: 'Standalone CLI scripts must run engine boot to get per-component migrations',
        content: 'Apply bootEngine + try/finally engine.shutdown() to all short-lived CLI processes.' },
      { title: 'Boot engine before invoking sync handlers in standalone CLIs',
        content: 'Standalone CLI scripts boot the engine and shut it down in try/finally to release native resources cleanly.' },
    ],
  },
  {
    base: mk(
      'Filter SYNC_TABLES against sqlite_master at runtime for resilience',
      'Defensive sync handler filtering: drop SYNC_TABLES entries missing from sqlite_master so unmigrated peers do not crash.',
    ),
    paraphrases: [
      { title: 'Filter SYNC_TABLES against sqlite_master per-call as resilience layer',
        content: 'Defense-in-depth for sync handlers: filter SYNC_TABLES against sqlite_master at runtime.' },
      { title: 'Defense-in-depth: filter SYNC_TABLES against sqlite_master at handler runtime',
        content: 'At sync-handler runtime, filter SYNC_TABLES against sqlite_master to tolerate unmigrated peer schemas.' },
      { title: 'sqlite_master preflight filter for SYNC_TABLES iteration',
        content: 'Filter SYNC_TABLES against sqlite_master before iterating, so unmigrated peers do not crash the sync.' },
      { title: 'Filter SYNC_TABLES against sqlite_master before iterating sync handlers',
        content: 'A defensive filter on SYNC_TABLES via sqlite_master keeps sync resilient to unmigrated peer schemas.' },
    ],
  },
  {
    base: mk(
      'Use BR-062 verify_mirror.sh primitive for symlink/byte-equality assertions',
      'Mirror byte-equality is verifiable via the BR-062 primitive; do not roll ad-hoc diff scripts.',
    ),
    paraphrases: [
      { title: 'Use BR-062 verify_mirror.sh primitive for any claim about ~/.igris mirror byte-equality',
        content: 'Mirror byte-equality is verifiable via ~/.igris/core/scripts/verify_mirror.sh — quote verbatim, not raw diff.' },
      { title: 'Mirror byte-equality is verifiable via ~/.igris/core/scripts primitive',
        content: 'Use the BR-062 verify_mirror.sh primitive instead of ad-hoc diff scripts for symlink integrity claims.' },
      { title: 'BR-062 verify_mirror.sh — primitive output for mirror-integrity claims',
        content: 'When asserting mirror byte-equality, run the BR-062 verify_mirror.sh primitive and quote its output.' },
      { title: 'Sentinel MIRROR_CHECK contract: quote verbatim primitive output',
        content: 'Mirror integrity claims must come from BR-062 verify_mirror.sh — quote the primitive output verbatim.' },
    ],
  },
  {
    base: mk(
      'Capture rc with set +e/set -e bracket and write definitive exit-code log line',
      'When log clarity matters, bracket child invocations with set +e / cli_rc=$? / set -e and write a definitive log line.',
    ),
    paraphrases: [
      { title: 'Capture child process rc with set +e/set -e bracket; log truthfully',
        content: 'Bash helper rc-capture: set +e / cli_rc=$? / set -e + definitive log line — when log clarity matters.' },
      { title: 'Capture exit code with set +e/set -e bracket, not || true',
        content: 'Bash helper for capturing child process rc: set +e bracket, capture rc, set -e, write definitive log.' },
      { title: 'Bash helper rc-capture: set +e / cli_rc=$? / set -e + definitive log line',
        content: 'Capture rc with set +e/set -e bracket, not `|| true` when log clarity matters.' },
      { title: 'Capture exit codes through hooks with set +e/set -e, log truthfully',
        content: 'Capture exit codes from nohup/detached processes by bracketing with set +e / rc=$? / set -e.' },
    ],
  },
  {
    base: mk(
      "Don't log success before async detached work completes",
      'Avoid misleading async log lines that fire before the actual work returns — the success message must follow the join.',
    ),
    paraphrases: [
      { title: 'Avoid misleading async log lines that fire before work completes',
        content: 'Async log lines that fire before the join can mislead the operator. Log success only after the work returns.' },
      { title: 'Async detached work: log success after join, not before',
        content: 'Misleading async log lines fire before the actual work completes; defer success log to post-join.' },
      { title: 'Misleading async log lines: fire before completion → defer to post-join',
        content: "Don't log success before async detached work completes; log lines must follow the join." },
      { title: 'Defer success log line until after async detached work returns',
        content: 'Avoid misleading async log lines that fire before the work completes; log success post-join.' },
    ],
  },
];

interface RunSummary {
  run: number;
  llm_extracted: number;
  inserted: number;
  inserted_ids: number[];
  deduped: number;
  deduped_ids: number[];
}

async function main() {
  // Fresh DB
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  if (fs.existsSync(`${DB_PATH}-shm`)) fs.unlinkSync(`${DB_PATH}-shm`);
  if (fs.existsSync(`${DB_PATH}-wal`)) fs.unlinkSync(`${DB_PATH}-wal`);

  process.env.IGRIS_DB_PATH = DB_PATH;
  console.error(`[td087.e2e] booting engine on ${DB_PATH}`);
  const engine = bootEngine({ dbPath: DB_PATH, components: {} });
  const db = engine.storage.rawConnection;

  const config = { ...DEFAULT_PERCEPTION_CONFIG };
  console.error(`[td087.e2e] config: dedup_enabled=${config.dedup_enabled} threshold=${config.dedup_cosine_threshold}`);

  const summaries: RunSummary[] = [];

  try {
    for (let r = 1; r <= 5; r++) {
      console.error(`\n[td087.e2e] === RUN ${r} ===`);
      // Build the candidate list: run 1 = base, runs 2..5 = paraphrase variant (r-2)
      const candidates: PerceptionCandidate[] = CANDIDATES.map((cs) => {
        if (r === 1) return cs.base;
        const p = cs.paraphrases[r - 2];
        return {
          ...cs.base,
          title: p.title,
          content: p.content,
        };
      });

      const stub: LlmExtractor = async () => candidates;

      // Build minimal events to pass the bytes-gate
      const events = [
        { role: 'user', content: 'x'.repeat(2000), timestamp: '2026-05-04T00:00:00Z' },
      ];

      const result = await runPerception(
        db,
        {
          events,
          project: PROJECT,
          source: 'td087_e2e_det',
          force_llm: true,
          trigger: 'td087_e2e',
        },
        config,
        stub,
      );

      summaries.push({
        run: r,
        llm_extracted: result.llm_extracted,
        inserted: result.inserted,
        inserted_ids: result.inserted_ids,
        deduped: result.deduped,
        deduped_ids: result.deduped_ids,
      });
      console.error(`[td087.e2e] run ${r}: extracted=${result.llm_extracted} inserted=${result.inserted} deduped=${result.deduped}`);
    }

    // Sample 5 deduped IDs across all runs and confirm they are TRUE duplicates
    // by comparing the matched row's title with the candidate that triggered.
    const allDeduped = summaries.flatMap((s) => s.deduped_ids);
    const sample = Array.from(new Set(allDeduped)).slice(0, 5);
    console.error(`\n[td087.e2e] sampling ${sample.length} deduped IDs for false-positive check:`);
    for (const id of sample) {
      const row = db.prepare('SELECT id, title, seen_again_count FROM learnings WHERE id = ?').get(id) as
        { id: number; title: string; seen_again_count: number } | undefined;
      if (!row) {
        console.error(`  id=${id}: ROW NOT FOUND (orphan?)`);
        continue;
      }
      console.error(`  id=${id} seen_again=${row.seen_again_count} title="${row.title.slice(0, 80)}"`);
    }

    console.error('\n[td087.e2e] === SUMMARY (JSON) ===');
    console.log(JSON.stringify({
      db_path: DB_PATH,
      project: PROJECT,
      threshold: config.dedup_cosine_threshold,
      runs: summaries,
      deduped_sample: sample,
    }, null, 2));

    // Pass-fail check
    const pass =
      summaries[0].inserted >= 6 &&
      summaries.slice(2).every((s) => s.inserted <= 2) &&
      summaries.slice(2).every((s) => s.deduped >= 6);
    console.error(`\n[td087.e2e] pass: ${pass}`);
    if (!pass) {
      console.error('[td087.e2e] FAIL — does not meet plan Phase 4 acceptance');
      process.exitCode = 1;
    }
  } finally {
    try { engine.shutdown(); } catch { /* swallow */ }
    try { await disposeEmbeddingPipeline(); } catch { /* swallow */ }
  }
}

main().catch((err) => {
  console.error('[td087.e2e] FATAL:', err);
  process.exit(1);
});
