---
obligation: "A brief must not be closed when its review ran on its author's model"
mechanism: gate
status: shipped
lives_in: "scripts/git-hooks/commit-msg"
summary: "FR-277 review-model gate, §4 of the commit-msg hook (DECISIONS row 25: one review per change, by a model other than the author's). One checker, core/scripts/cli-adapters/model_tier.sh review, compares the latest warden stop/error agent_events row with every forger and orchestrator row for the brief (each row's model_resolved, else model_requested; rows where project = the resolved slug OR project IS NULL), after normalising ids (inherit:, anthropic/, openai/ and a trailing -YYYYMMDD stripped; a Claude alias matches any version of its family; a GPT id compares exactly). The hook HARD-FAILS a closes-footer commit on EQUAL when the shared provider is one compile projects tiers for (anthropic until TD-385 adds openai); it prints EQUAL_UNPROJECTED and UNKNOWN and passes (UNKNOWN is never a pass, only not a refusal); PASS and NO_REVIEW are silent; an unreadable brain is a WARN. One-shot escape via IGRIS_BYPASS_REVIEW_MODEL_GATE, independent of the AC, event and signature bypasses. Does NOT cover: a close with no commit, --no-verify, a checkout without hooks, a brain with no agent_events table (skipped), a brief with no warden row (silent; TD-499's audit lists unreviewed closes), an equal pair on an unprojected provider (reported), and a reviewer whose event row names a different model than it ran on (the row is the record)."
---

# Review model differs from the author's (FR-277)

DECISIONS row 25: one review per change, by a model other than the author's.
Before FR-277 every core agent said `model: inherit` (or a pinned alias), so a
reviewer ran on the orchestrator's model and nothing checked it. FR-277 puts
reviewers on their own tier (the `model_tiers` map in `harness-manifest.json`)
and adds this gate so the rule is checked at the close, from the record.

## The layers, and what each does not cover

| # | layer | surface | posture | does NOT cover |
|---|---|---|---|---|
| L1 | authoring | `core/skills/hunt/SKILL.md` Phase 5 step 2.5: `model_tier.sh resolve --agent warden --differ-from {author model}` picks a warden tier whose model differs from the author's | stop-and-ask when no tier differs | an orchestrator that skips the step |
| L2 | mechanical | `scripts/git-hooks/commit-msg` §4 | **HARD-FAIL** on EQUAL (projected provider) | a close with NO commit; `--no-verify`; a checkout without hooks; a brief with no warden row; an equal pair on a provider compile does not project yet |
| L3 | audit | TD-499 (weekly audit queries) calls the same `model_tier.sh review` | report | not built yet |

## What the checker reads

`model_tier.sh review --brief-id <ID> --project <slug> --db <path>` opens the
brain read-only (`sqlite3` URI `mode=ro`) with bound parameters, so neither the
id nor the slug is ever spliced into SQL. The reviewer is the **latest** warden
`stop` or `error` row (ordered by `created_at`, then `id`); the authors are
every `forger` row and every `orchestrator` row (FR-279's builds emit the
latter). Each value is `model_resolved`, else `model_requested`.

| Verdict | Exit | Hook action |
|---|---|---|
| PASS | 0 | silent |
| EQUAL (shared provider projected: anthropic) | 1 | refusal block, exit 1 |
| UNKNOWN (an empty or unrecognised value, no author rows) | 3 | printed: `UNKNOWN (not a pass)` |
| NO_REVIEW (no warden stop/error row) | 4 | silent |
| unreadable DB | 5 | WARN |
| EQUAL_UNPROJECTED | 6 | printed: reported, not refused until TD-385 |

## Red-first

The gate was shown refusing a REAL review on the author's model before it was
trusted: FR-267 (igris-ai) holds a warden stop row and forger rows that all
read `inherit:claude-fable-5`. Its stored content and every one of its
`agent_events` rows are snapshotted at `test/fixtures/review-model/`; the
refusal is quoted in that directory's README and pinned by
`test/review_model_gate.test.bash` RM-RED, whose self-negative deletes §4 from
a copy of the hook and shows the same world passing. TD-497 is the GREEN twin.

## Escape hatch

`IGRIS_BYPASS_REVIEW_MODEL_GATE=1 git commit ...` — one-shot, never
`export`ed. It skips §4 only; §2 and §3 still run, and their bypasses do not
silence §4 (RM-B1, RM-B2). The healthy path is to re-run warden on a different
model: `model_tier.sh resolve --agent warden --differ-from <author model>`.
