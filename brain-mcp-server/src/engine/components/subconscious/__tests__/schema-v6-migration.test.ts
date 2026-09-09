/**
 * TD-457 — subconscious schema v6: the re-key after the anchor change.
 *
 * `entityKey` no longer takes an illustrative `evidence.brief_id` when the
 * title names no brief, so every stored `dedupe_key` / `entity_key` computed
 * under the old anchor is suspect for the rows that move (26 of 1,918 on the
 * 2026-09-08 copy). v6 is the design-independent form TD-452's plan chose
 * (D-2): NULL BOTH key columns on every row and let `backfillFindingKeys` —
 * v5's own mechanism, now inside one transaction — re-key them on the next
 * `runSubconscious`. A targeted `WHERE` would re-implement the pre-TD-457
 * anchor inside SQL (the L-930 class) to find the moved rows; NULL-all needs
 * no such knowledge and re-keys the unmoved rows to byte-identical values.
 *
 * The "migration chain moved by one" template (test_standards.md, BR-100):
 * a fresh DB through v6; a DB stopped at v5 with keyed rows → both key
 * columns NULL and no other column touched; idempotent on re-run; v1→v6 on an
 * empty table. Plus AC-3, the fresh-vs-migrated agreement: DB-A is keyed by
 * the WRITER (`persistSubconsciousCandidate` under the new code), DB-B holds
 * the same rows with the STALE keys the 2026-09-08 copy stored, takes v6 and
 * the backfill — every key must agree, and the unmoved rows' keys must be the
 * stored values byte-for-byte (the idempotency pin).
 *
 * @module engine/components/subconscious/__tests__/schema-v6-migration.test
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { subconsciousMigrations } from '../schema.js';
import { backfillFindingKeys, candidateFromRow, entityKey, findingKey, GLOBAL_ENTITY_KEY } from '../finding-key.js';
import {
  persistSubconsciousCandidate,
  type SubconsciousContext,
} from '../../cognition/extractors/subconscious.js';
import type { BrainDigest } from '../digest.js';

const V6 = subconsciousMigrations.find((m) => m.version === 6);
const THROUGH_V5 = subconsciousMigrations.filter((m) => m.version <= 5);

function throughV5(): Database.Database {
  const db = new Database(':memory:');
  for (const m of THROUGH_V5) db.exec(m.sql);
  return db;
}

type KeyRow = { id: number; dedupe_key: string | null; entity_key: string | null };

/**
 * Eighteen real rows (2026-09-08 copy, verbatim): the twelve TD-452 rows plus
 * family 1 (1822/1883/1885), 1880, and the highest-scoring (a-narrow) SAME
 * pair (1570/1677) — with the keys the copy STORED under the pre-TD-457
 * anchor. `moved` marks the eight whose `brief:` anchor the new rule drops
 * (title names no id): 1434, 1474, 1570, 1596, 1677, 1822, 1883, 1885.
 */
interface StoredRow {
  id: number;
  source_module: string;
  project_slug: string | null;
  title: string;
  evidence: string;
  suggested_action: string | null;
  dedupe_key: string;
  entity_key: string;
  moved: boolean;
}

const ROWS: StoredRow[] = [
  { id: 1291, source_module: "learning_capture_gap", project_slug: "lifeOS", title: "lifeOS has 14 open briefs including a P0-Critical a11y regression but zero learnings and no recorded activity — work is being briefed but nothing is being harvested", evidence: "{\"brief_id\":\"BR-023\",\"note\":\"lifeOS: open_briefs 14, learnings 0, days_since_activity null. BR-023 is P0-Critical, In Progress, 105 days since update. Same zero-learning profile applies to attendance_app (4 briefs) and fifty_eco_system (34 briefs).\"}", suggested_action: null, dedupe_key: "87c013bc623976883b22871b04d2543f72e392b7", entity_key: "project:lifeos", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1341, source_module: "suggestion_queue_flooding", project_slug: "fifty_eco_system", title: "58 of 61 open suggestions are mechanical 'stalled'/'gap' rows for one project — the review queue is saturated and will bury any genuinely novel finding", evidence: "{\"note\":\"open_suggestions ids 4–32 and 40–42 are 'stalled' rows and 43–69 are 'gap' rows, nearly all project_slug=fifty_eco_system. Every one of those briefs shows days_since_update=169 or 148 — the same freeze, re-reported per brief. One rolled-up suggestion per (project, module) would carry the same information at 1/30th the review cost.\"}", suggested_action: "{\"kind\":\"collapse_suggestions\",\"source_modules\":[\"stalled\",\"gap\"],\"group_by\":[\"project_slug\",\"source_module\"]}", dedupe_key: "0c3b651542f6d7b52a53ed9625620f884c5916e0", entity_key: "project:fifty_eco_system", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1355, source_module: "suggestion_queue_flood", project_slug: "fifty_eco_system", title: "60 of the 60 open suggestions are mechanical stalled/gap rows on fifty_eco_system — the review queue is saturated and will hide any real finding", evidence: "{\"note\":\"open_suggestions ids 4–42 are 'stalled' rows and 43–69 are 'marked Done but has unchecked acceptance criteria' rows, nearly all project_slug fifty_eco_system. This is one decision (what to do with the dormant fifty_eco_system backlog), fragmented into 60 items. Recommend a single bulk disposition rather than per-brief triage.\"}", suggested_action: null, dedupe_key: "8798eb0b9b6baea695f6706205342a4d1bff6518", entity_key: "project:fifty_eco_system", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1430, source_module: "learning_capture_gap", project_slug: null, title: "Four active projects with open briefs have recorded zero learnings — attendance_app (4 briefs), lifeOS (14), hadir-system (1), moca-hr-agent (1) — so nothing from that work is reaching the brain", evidence: "{\"note\":\"projects[] shows learnings=0 and days_since_activity=null for attendance_app, lifeOS, hadir-system, moca-hr-agent, customerpulse and igris-os-eval. lifeOS in particular carries 14 open briefs including a P0-Critical (BR-023) — either work happens outside the harness or the activity/learning pipeline is not wired for these projects.\"}", suggested_action: "{\"kind\":\"investigate_project_wiring\",\"project_slugs\":[\"lifeOS\",\"attendance_app\",\"hadir-system\",\"moca-hr-agent\"]}", dedupe_key: "e582fe67644a7c28d9fd30df43c5134f2bc75770", entity_key: "global", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1434, source_module: "detector_blind_spot", project_slug: null, title: "The stalled detector appears to miss projects with null days_since_activity — attendance_app, lifeOS, hadir-system and hadir briefs idle 118–159 days produce no suggestions", evidence: "{\"brief_id\":\"BR-001\",\"note\":\"hadir-system BR-001 (In Progress, 159 days), hadir BR-027/BR-028 (In Progress, 131–133 days) and lifeOS BR-024..BR-036 (118 days) are all older than the fifty_eco_system briefs that did fire at 48 days, yet none appear in open_suggestions. attendance_app BR-001 fired but its three In Progress siblings did not.\"}", suggested_action: null, dedupe_key: "8df4019c67aa9c986f0f08ba9481393bc5f92945", entity_key: "brief:br-001", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1474, source_module: "detector_coverage_gap", project_slug: null, title: "The stalled-brief detector appears scoped to two projects — hadir, hadir-system, igris-ai and lifeOS all have 110+ day stale briefs with no corresponding suggestion", evidence: "{\"brief_id\":\"BR-001\",\"note\":\"hadir-system BR-001 (160 days), hadir BR-027 (134 days), igris-ai FR-112/FR-114/FR-115 (113 days) all exceed the ~48-day threshold that produced suggestions 39-42 for attendance_app/fifty_eco_system, yet none of these projects appear in open_suggestions at all.\"}", suggested_action: "{\"kind\":\"audit_module\",\"module\":\"stalled\",\"note\":\"verify project enumeration and threshold application across all active projects\"}", dedupe_key: "e6a95dd249bfa01e06fd5b1f4cdb9be34875e46b", entity_key: "brief:br-001", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1486, source_module: "learning_capture_gap", project_slug: null, title: "Four active projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work there is not reaching the brain", evidence: "{\"note\":\"projects rows: lifeOS (14 open briefs, 0 learnings, null activity), attendance_app (4/0/null), hadir-system (1/0/null), moca-hr-agent (1/0/null). Meanwhile briefs in lifeOS and attendance_app carry recent-ish update timestamps (118-156 days), so briefs are being written for these projects but no session activity or learning is being captured — the instrumentation, not the work, is likely missing.\"}", suggested_action: "{\"kind\":\"investigate_instrumentation\",\"project_slugs\":[\"lifeOS\",\"attendance_app\",\"hadir-system\",\"moca-hr-agent\"]}", dedupe_key: "d98e673e297b5d504413ee170ed252974fe3eb2e", entity_key: "global", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1495, source_module: "unlearning_project", project_slug: "lifeOS", title: "lifeOS has 14 open briefs including a P0 accessibility regression but zero learnings and no recorded activity — the brain is capturing nothing from this project", evidence: "{\"brief_id\":\"BR-023\",\"note\":\"Project row shows learnings=0 and days_since_activity=null while 14 briefs (BR-023 P0-Critical, plus BR-024..BR-036) sit Ready/In Progress at 118-119 days. Same shape for attendance_app, hadir-system, moca-hr-agent — likely briefs imported without a working session attached.\"}", suggested_action: null, dedupe_key: "4d022bdfc840ccc3cbb2477582c9117d5a2a466d", entity_key: "project:lifeos", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1570, source_module: "duplicate_project_slug", project_slug: null, title: "Four overlapping hadir project slugs (hadir, hadir-system, fya-hadir-app, moca-hadir-app) each hold open briefs — likely one product split across duplicate brain entries", evidence: "{\"brief_id\":\"BR-027\",\"note\":\"Projects list shows hadir (2 open, 116d), hadir-system (1 open, no activity), fya-hadir-app (1 open, 27d), moca-hadir-app (7 open, 26d). hadir-system's BR-001 ('Implement Hadir mobile app UI design system in web admin portal') and hadir's BR-027/BR-028 (MOCA UI updates, report card redesign) read as the same product line. Similar shape on the fifty side: fifty-dev (61 open) vs fifty_eco_system (34 open) vs animated-fifty-dev vs retro_fifty. Worth confirming which slugs are live and merging or archiving the rest before brief counts are used for any prioritisation.\"}", suggested_action: null, dedupe_key: "5882e7d6792c3a7cef60da5f796b4d3908918d89", entity_key: "brief:br-027", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1596, source_module: "no_learning_capture", project_slug: null, title: "Four active projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work is either happening outside the brain or these are dead entries", evidence: "{\"brief_id\":\"BR-024\",\"note\":\"Project rows show learnings 0 and days_since_activity null for lifeOS, attendance_app, hadir-system, moca-hr-agent, while lifeOS carries 14 open briefs (e.g. BR-024). Learning 1366 documents a related failure mode: perception runs advancing watermarks for tables they never push.\"}", suggested_action: null, dedupe_key: "b1f4b52ddbde4a40b4d7135835f6d6f008b4515f", entity_key: "brief:br-024", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1677, source_module: "duplicate_project_slugs", project_slug: null, title: "Overlapping Hadir project slugs (hadir, hadir-system, fya-hadir-app, moca-hadir-app) each hold open briefs — likely one product tracked under four brain identities", evidence: "{\"brief_id\":\"BR-001\",\"note\":\"projects lists hadir (2 briefs, 122d), hadir-system (1 brief, activity null), fya-hadir-app (2 briefs, 0d), moca-hadir-app (7 briefs, 32d). hadir-system BR-001 'Implement Hadir mobile app UI design system in web admin portal' and hadir BR-027 'MOCA UI updates' describe adjacent work. Recent commits 23c880f and 7ef7766 show the brain has been actively folding duplicate project rows onto one directory.\"}", suggested_action: "{\"kind\":\"review_project_identity\",\"slugs\":[\"hadir\",\"hadir-system\",\"fya-hadir-app\",\"moca-hadir-app\"]}", dedupe_key: "8af2c5568d222825337ddf1b419e6fb358f2bfd1", entity_key: "brief:br-001", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1698, source_module: "knowledge_capture_gap", project_slug: null, title: "Four projects with open briefs (lifeOS 14, attendance_app 4, hadir-system 1, moca-hr-agent 1) have zero learnings and null activity — work is being briefed but never executed or never harvested", evidence: "{\"note\":\"Project rows: lifeOS (14 open_briefs, 0 learnings, days_since_activity null), attendance_app (4, 0, null), hadir-system (1, 0, null), moca-hr-agent (1, 0, null). 20 open briefs total behind projects the brain has never observed activity on. Contrast with igris-ai/mbrgea-ai/moca-ai-agent, all at days_since_activity 0. Either these projects are worked outside the brain's view (an instrumentation gap) or the briefs are dead inventory.\"}", suggested_action: null, dedupe_key: "7d87a4eae6d2fa23b4085981de774e6459f69d56", entity_key: "global", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1801, source_module: "suggestion_channel_flooded", project_slug: null, title: "44 of the 60 open suggestions are low-value edge_inference rows — the operator's review queue is 73% noise, which will bury the 16 substantive findings", evidence: "{\"note\":\"open_suggestions ids 1712–1755 are all source_module='edge_inference', each proposing a single learning→learning edge (e.g. 'Inferred related_to edge: learning 224 → learning 227'). These are mechanical graph links, not operator decisions. They should be auto-applied below a confidence threshold, batched into one review item, or routed to a separate queue — not interleaved with findings like 1697 (the only P0 brief stalled 130 days).\"}", suggested_action: "{\"kind\":\"reroute_suggestion_module\",\"source_module\":\"edge_inference\",\"note\":\"Auto-apply or batch edge_inference proposals; keep the review queue for judgement calls.\"}", dedupe_key: "ffe3e9401c8c6dc4bb3cfbf580cffc570b480012", entity_key: "global", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1822, source_module: "in_progress_status_is_meaningless", project_slug: null, title: "Eleven briefs across five projects are marked 'In Progress' with 132–191 days since update — 'In Progress' is being used as a filing state, not a work state, so no dashboard can tell what is actually being worked on", evidence: "{\"brief_id\":\"BR-074\",\"note\":\"In Progress + stale: BR-074/BR-076/TD-004/TD-006/TD-007/TS-003 (fifty_eco_system, 170-191d), BR-001 hadir-system (175d), BR-002/BR-003/BR-004 attendance_app (170d), BR-027/BR-028 hadir (147-149d), BR-023 lifeOS (132d). Meanwhile igris-ai/mbrgea-ai/moca-ai-agent show days_since_activity 0 with work shipping. Suggestion 1697 covers BR-023 alone; this is the systemic version — a staleness rule that auto-demotes In Progress back to Ready.\"}", suggested_action: "{\"kind\":\"add_brain_gate\",\"gate\":\"stale_in_progress_demotion\",\"rule\":\"A brief in status 'In Progress' with no update for N days (suggest 30) is auto-demoted to 'Ready' and flagged, so 'In Progress' always means someone is on it\"}", dedupe_key: "68b40b8cdbbe9ff47e88da1df8e719fd88d55e83", entity_key: "brief:br-074", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1880, source_module: "self_diagnosis_from_own_commits", project_slug: "igris-ai", title: "The digest's own edge_inference module emitted 44 of 60 open suggestions as one-line 'inferred edge' rows over learnings 6–1447, drowning the 17 substantive findings — the subconscious queue needs the same dedup/batching treatment commit 6d077a1 applied to findings", evidence: "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single graph edge, many over learnings from the 6–425 range (i.e. long-settled history). Commit 6d077a1 'fix(subconscious): dedup findings on a key stable under LLM paraphrase' shows the noise problem is already recognized for findings but not for edge proposals. An operator review queue where 73% of rows are mechanical edge assertions is one an operator stops reading.\"}", suggested_action: "{\"kind\":\"batch_or_autoapply_suggestion_module\",\"source_module\":\"edge_inference\",\"proposal\":\"auto-apply high-confidence edges without operator review, or collapse into a single batched 'N inferred edges' row\"}", dedupe_key: "a1f98f66a74ee0740469805db3c0754835453b42", entity_key: "project:igris-ai", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1883, source_module: "in_progress_status_unreliable", project_slug: null, title: "Ten briefs are 'In Progress' with 133–191 days since update across five projects with zero recorded activity — 'In Progress' has decayed into a synonym for 'abandoned mid-flight' and no longer signals anything to the operator", evidence: "{\"brief_id\":\"TS-003\",\"note\":\"In Progress + stale: BR-074, BR-076, TD-004, TD-006, TD-007 (191d), BR-002/003/004 attendance_app and TS-003 (171d), BR-001 hadir-system (175d), BR-027/BR-028 hadir (147-149d), BR-023 lifeOS (133d). attendance_app and lifeOS both report days_since_activity null, so nothing was ever in progress. Suggestion 1697 covers only BR-023; this is the class.\"}", suggested_action: "{\"kind\":\"bulk_status_reset\",\"rule\":\"In Progress with no project activity for >90 days reverts to Ready or Deferred with a note\",\"affected_count\":12}", dedupe_key: "cd0a9b5807397437ba54436305018f3eb2b6e81b", entity_key: "brief:ts-003", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1885, source_module: "stale_in_progress_across_system", project_slug: null, title: "Fourteen briefs across six projects sit at 'In Progress' with 133–191 days since update — no project has more than one genuinely active workstream, so the In Progress set is almost entirely false", evidence: "{\"brief_id\":\"BR-001\",\"note\":\"In Progress briefs with null or ancient activity: attendance_app BR-002/BR-003/BR-004 (171d, activity null), hadir-system BR-001 (175d, activity null), hadir BR-027/BR-028 (147-149d, activity 126d), lifeOS BR-023 (133d, activity null), fifty_eco_system BR-074/BR-076/TD-004/TD-006/TD-007/TS-003 (191d, activity 188d). A system-wide status hygiene pass is needed, not per-project fixes.\"}", suggested_action: "{\"kind\":\"propose_status_hygiene_rule\",\"rule\":\"auto-flag any brief in 'In Progress' whose project has no activity for N days, and require a resume-or-reset decision\",\"threshold_days\":60}", dedupe_key: "9ed63705570e83a5ad30a3a7365a6d45b34f3cf5", entity_key: "brief:br-001", moved: true }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
  { id: 1888, source_module: "self_referential_finding_risk", project_slug: "igris-ai", title: "44 of 60 open suggestions are low-value edge_inference rows — they crowd out substantive findings in the review queue and should be batched or auto-applied rather than queued individually", evidence: "{\"note\":\"open_suggestions ids 1712–1755 are all source_module=edge_inference, each proposing a single learning→learning edge. They occupy 73% of the operator's queue while carrying no decision content. Commit 6d077a1 ('fix(subconscious): dedup findings on a key stable under LLM paraphrase') shows queue quality is already a known concern; edge inference is the remaining volume source.\"}", suggested_action: "{\"kind\":\"change_suggestion_routing\",\"source_module\":\"edge_inference\",\"from\":\"individual_queued_suggestion\",\"to\":\"batched_review_or_auto_apply_above_threshold\"}", dedupe_key: "238a334741067ecc7b9912460c02ba5026768d8b", entity_key: "project:igris-ai", moved: false }, // gitleaks:allow — a sha1 dedupe_key fixture row (TD-457), not a credential
];

function digestStub(): BrainDigest {
  return {} as BrainDigest;
}

function writerCtx(): SubconsciousContext {
  return {
    digest: digestStub(),
    project: 'all',
    existingPending: new Map(),
    projectVocab: new Map(),
    digest_bytes: 0,
  };
}

function keys(db: Database.Database): Map<number, KeyRow> {
  return new Map(
    (db.prepare(`SELECT id, dedupe_key, entity_key FROM suggestions ORDER BY id`).all() as KeyRow[]).map((r) => [r.id, r]),
  );
}

describe('subconscious schema v6 (TD-457)', () => {
  it('exists, is registered exactly once, and the chain is dense through 6', () => {
    expect(V6).toBeDefined();
    expect(subconsciousMigrations.filter((m) => m.version === 6)).toHaveLength(1);
    expect(subconsciousMigrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is an UPDATE only — no ALTER, no DROP, no CREATE (the schema does not change)', () => {
    expect(V6!.sql).toMatch(/UPDATE\s+suggestions/i);
    expect(V6!.sql).not.toMatch(/ALTER|DROP|CREATE/i);
  });

  it('on a v5 DB with keyed rows: NULLs BOTH key columns on every row and touches no other column', () => {
    const db = throughV5();
    try {
      db.prepare(
        `INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, created_at,
                                  dedupe_key, entity_key, seen_count, last_seen_at, recurrence_titles, source_instance)
         VALUES (7, 'abandoned_project', 'fifty_eco_system', 'a stale backlog', '{"brief_id":"BR-1"}', 'high', 'pending',
                 '2026-01-01 00:00:00', 'deadbeef', 'project:fifty_eco_system', 3, '2026-02-01 00:00:00', '["x"]', 'subconscious')`,
      ).run();
      db.prepare(
        `INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, dedupe_key, entity_key)
         VALUES (8, 'k', NULL, 'another finding with words', '{}', 'low', 'dismissed', 'cafe', 'global')`,
      ).run();
      const before = db.prepare(`SELECT * FROM suggestions ORDER BY id`).all() as Record<string, unknown>[];

      db.exec(V6!.sql);

      const after = db.prepare(`SELECT * FROM suggestions ORDER BY id`).all() as Record<string, unknown>[];
      expect(after).toHaveLength(2);
      for (let i = 0; i < before.length; i++) {
        for (const col of Object.keys(before[i]!)) {
          if (col === 'dedupe_key' || col === 'entity_key') expect(after[i]![col], `${col} row ${i}`).toBeNull();
          else expect(after[i]![col], `${col} row ${i}`).toEqual(before[i]![col]);
        }
      }
      // Idempotent: a second application changes nothing.
      db.exec(V6!.sql);
      expect(db.prepare(`SELECT * FROM suggestions ORDER BY id`).all()).toEqual(after);
    } finally {
      db.close();
    }
  });

  it('the full chain applies cleanly from empty, and v6 on an empty table is a no-op', () => {
    const db = new Database(':memory:');
    try {
      for (const m of subconsciousMigrations) db.exec(m.sql);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM suggestions`).get() as { n: number }).n).toBe(0);
      expect(() => db.exec(V6!.sql)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('AC-3 fresh-vs-migrated agreement: the writer under the new code and v6 + backfill over the stale keys produce IDENTICAL keys on every row', () => {
    expect(ROWS.length).toBe(18);
    // DB-A: fresh through v6, the rows persisted by the WRITER path.
    const a = new Database(':memory:');
    // DB-B: the same rows with the STALE keys the copy stored, then v6 + backfill.
    const b = new Database(':memory:');
    try {
      for (const m of subconsciousMigrations) {
        a.exec(m.sql);
        if (m.version <= 5) b.exec(m.sql);
      }
      const insB = b.prepare(
        `INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, suggested_action, dedupe_key, entity_key)
         VALUES (?, ?, ?, ?, ?, 'medium', 'pending', ?, ?, ?)`,
      );
      for (const r of ROWS) {
        // DB-A: the writer computes the keys. A FRESH ctx per row — the
        // writer legitimately merges same-finding rows against an in-run
        // snapshot (1430/1486 would bump), and this arm measures the KEY the
        // writer stamps, not the loop.
        expect(
          persistSubconsciousCandidate(a, candidateFromRow(r), writerCtx()),
        ).toBe('inserted');
        insB.run(r.id, r.source_module, r.project_slug, r.title, r.evidence, r.suggested_action, r.dedupe_key, r.entity_key);
      }
      const staleB = keys(b);
      b.exec(V6!.sql);
      expect([...keys(b).values()].every((k) => k.dedupe_key === null && k.entity_key === null)).toBe(true);
      expect(backfillFindingKeys(b)).toBe(18);
      const freshA = new Map(
        (a.prepare(`SELECT title, dedupe_key, entity_key FROM suggestions`).all() as Array<{ title: string; dedupe_key: string; entity_key: string }>).map((r) => [r.title, r]),
      );
      const migratedB = keys(b);
      let agree = 0;
      for (const r of ROWS) {
        const fa = freshA.get(r.title)!;
        const mb = migratedB.get(r.id)!;
        expect(mb.dedupe_key, `dedupe_key ${r.id}`).toBe(fa.dedupe_key);
        expect(mb.entity_key, `entity_key ${r.id}`).toBe(fa.entity_key);
        // The direct computation agrees too.
        expect(mb.entity_key).toBe(entityKey(candidateFromRow(r)));
        expect(mb.dedupe_key).toBe(findingKey(candidateFromRow(r)));
        agree += 1;
        if (r.moved) {
          // The moved rows: stored `brief:` (no id in the title) → `global` now.
          expect(staleB.get(r.id)!.entity_key).toMatch(/^brief:/);
          expect(mb.entity_key).toBe(GLOBAL_ENTITY_KEY);
          expect(mb.dedupe_key).not.toBe(r.dedupe_key);
        } else {
          // The unmoved rows re-key to the stored values byte-for-byte (idempotency).
          expect(mb.entity_key).toBe(r.entity_key);
          expect(mb.dedupe_key).toBe(r.dedupe_key);
        }
      }
      expect(agree).toBe(18);
      expect(ROWS.filter((r) => r.moved)).toHaveLength(8);
    } finally {
      a.close();
      b.close();
    }
  });
});
