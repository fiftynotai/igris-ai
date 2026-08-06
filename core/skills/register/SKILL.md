---
name: register
tier: essential
description: "Create a new brief - usage: /register bug|feature|migration|debt \"title\""
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Glob
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_brief_list
  - mcp__igris-brain__igris_brief_similar
triggers:
  - "REGISTER"
  - "register a bug"
  - "register a feature"
  - "create a brief"
  - "add to queue"
  - "register bug"
  - "register feature"
  - "register migration"
  - "register debt"
---

# REGISTER - Create New Brief

Register a new brief for tracking bugs, features, migrations, or technical debt.

## Usage

```
/register bug "Title of the bug"
/register feature "Title of the feature"
/register migration "Title of migration"
/register debt "Title of technical debt"
```

Or without type (will prompt):
```
/register "Brief title"
```

## Arguments

`$ARGUMENTS` format: `[type] "title"` or just `"title"`

Types and their prefixes — **one kind, one prefix** (TD-331; the `bug, feature
→ BR` collision was retired 2026-08-06). This list and §2's table below are two
copies of one mapping and are pinned against each other by
`test/validate_brief_type_parity.test.bash`:
- `bug` → BR-XXX
- `feature` → FR-XXX
- `migration` → MG-XXX
- `debt` → TD-XXX
- `testing` → TS-XXX
- `process` → PI-XXX
- `request` → FR-XXX
- `dependency` → DU-XXX
- `performance` → PF-XXX
- `architecture` → AC-XXX

## Execution

### 1. Parse Arguments

Extract type and title from `$ARGUMENTS`.
If type not specified, ask user which type.

### 2. Determine Prefix

Map type to brief prefix — and to the canonical `brief_type` value you will
write in step 5. **The two sets move together**: a prefix with no matching
canonical type is how `brief_type` drifted to 50 spellings (TD-328), because a
`DU-`/`AC-` brief had no legal type to write and one got invented. If you ever
add a prefix here, add its canonical type in
`brain-mcp-server/src/tools/brief-normalize.ts` in the same change.

| Type | Prefix | Canonical `brief_type` |
|------|--------|------------------------|
| bug | BR | `Bug` |
| feature | FR | `Feature` |
| migration | MG | `Migration` |
| debt | TD | `Technical Debt` |
| testing | TS | `Testing` |
| process | PI | `Process Improvement` |
| request | FR | `Feature` |
| dependency | DU | `Dependency Update` |
| performance | PF | `Performance` |
| architecture | AC | `Architecture` |
| (no prefix — docs work) | — | `Documentation` |
| (no prefix — see note) | — | `Refactor` |

`Refactor` is canonical but has **no mint prefix**: it was promoted on measured
evidence (only 41% of refactor briefs carried a `TD-` prefix) and the operator
declined an `RF-` prefix. Use it for refactor work minted under `BR-` or `TD-`.
See `core/enforcement/brief-type-vocabulary.md`.

**`feature` mints `FR-`, not `BR-` (TD-331, operator decision 2026-08-06).**
Until then this table's first row read `bug, feature | BR`, and it was the ONLY
prefix that named two kinds. That collision is why 20 briefs are permanently
untypeable: 17 NULL-type `BR-` rows could not be inferred (every other prefix
inferred losslessly — `FR-` 25, `TD-` 21, `TS-` 2, `PF-` 1) and 3 rows typed
literally `BR` cannot be folded, because `BR` meant either thing.

So the rule this table states — *a prefix names exactly one canonical type* — is
now TIGHTENED rather than patched. After TD-331 every canonical type with a mint
prefix has exactly ONE, and `Refactor` (above) remains the single documented
prefix-less canonical type. There is no second exception.

`FR-` now covers what used to be split across "feature" and "request". They were
never distinct at the mint surface — the distinction was an artifact of having
two rows, not a concept the corpus tracks.

**The 20 historical rows are NOT retro-assigned.** They are dispositioned as
permanently ambiguous, by decision, and the reason is recorded: at the time they
were minted `BR-` did not distinguish bug from feature, and no non-guessing
source of that distinction survives. An inference that can be wrong should
surface, not silently write (TD-311). What the decision DID buy is that the
unresolvable set is now capped at 20 rather than growing with every new brief.

### 3. Find Next Available Number

Call `igris_brief_list` to find next available number, fallback to cache glob at `~/.igris/projects/{project}/briefs/`.
Find highest number, add 1.
Example: If BR-007 exists, next is BR-008.

### 3.5 Dup-check (enforcement gate)

Before creating the brief, run the dup-check — the enforced form of brain
obligation #3 ("Dup-check before creating a brief"), tracked in
`core/enforcement/INDEX.md`.

Call `igris_brief_similar` with:
- **query:** `"{title}. {problem}"` (the title plus the one-line problem, if known)
- **project:** the current project slug
- **threshold:** `0.85`

Then branch:
- **A hit at or above the threshold** → STOP. Display the near-duplicate brief(s)
  (ID, title, similarity) and ask the operator to confirm they want a new brief
  anyway, or to abort / amend the existing one. Do NOT proceed to step 4 without
  operator confirmation.
- **No hit** → proceed to step 4.
- **Tool unavailable** (`igris_brief_similar` returns a capability message —
  sqlite-vec extension or embeddings backend not loaded — rather than results) →
  proceed to step 4 (fail-open, matching every other Igris gate's posture). Do not
  treat the capability message as an error.

### 4. Build Brief Content

Construct brief markdown content using this structure:

```markdown
# {PREFIX}-{XXX}: {title}

## Metadata
- **Type:** {Feature | Bug | Migration | Technical Debt | Testing | Process Improvement | Documentation | Acceptance | Performance | Architecture | Dependency Update | Refactor}
- **Priority:** {priority, default P2}
- **Status:** Ready
- **Effort:** {effort if known, otherwise omit}
- **Created:** {today's date}

## Problem

{Description of the problem or need — ask user if not clear from title}

## Goal

{What should happen after this is implemented}

## Context and Inputs

{Relevant files, modules, APIs — fill in what's known}

## Acceptance Criteria

{Testable outcomes — fill in what's known, leave for user to complete if unclear}

## Test Plan

{How to verify — fill in what's known}

## Delivery

{Migrations, feature flags, docs to update — fill in what's known}
```

### 5. Store Brief in Brain

Call `igris_brief_create` with:
- **project:** current project slug
- **brief_id:** the new brief ID (e.g., "FR-031")
- **title:** the brief title
- **content:** the constructed markdown from step 4
- **brief_type:** ONE of the canonical types from the §2 table — `Feature`,
  `Bug`, `Migration`, `Technical Debt`, `Testing`, `Process Improvement`,
  `Documentation`, `Acceptance`, `Performance`, `Architecture`,
  `Dependency Update`, `Refactor`. If none fit, pick the CLOSEST canonical type
  and explain the nuance in the brief body — do not invent a new spelling or a
  compound like `Feature / Infrastructure`. The brain accepts anything (it never
  rejects a brief over a type) but it will REPORT a non-canonical value back to
  you in the tool response, and it will keep showing up in the vocabulary
  validator until someone resolves it (TD-328).
- **status:** "Ready" (or "Draft" if info incomplete)
- **priority:** the assigned priority (default "P2")
- **effort:** the assigned effort if known

If `igris_brief_create` fails or MCP is unavailable:
1. Write to `~/.igris/projects/{project}/briefs/{PREFIX}-{XXX}-{slug}.md` as fallback.
2. Display: `WARNING: Brain MCP unavailable — brief {PREFIX}-{XXX} saved to local cache only. Queued for sync on next /boot or /sync data.`
3. Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
   ```json
   {"timestamp":"{ISO-8601 now}","operation":"brief_create","project":"{project}","brief_id":"{PREFIX}-{XXX}","title":"{title}","status":"Ready","priority":"{priority}","brief_type":"{type}","cache_path":"~/.igris/projects/{project}/briefs/{PREFIX}-{XXX}-{slug}.md"}
   ```

**DO NOT write brief files to the repo.** Briefs live in the brain DB only.

### 6. Handle P0/P1 Priority

If user specifies P0 or P1 priority, also add entry to `~/.igris/projects/{project}/session/BLOCKERS.md`.

### 7. Confirm Registration

Display:
```
Brief registered: {PREFIX}-{XXX}

Brief: {PREFIX}-{XXX} (stored in brain DB)
Type: [Bug | Feature | Migration | etc.]   (canonical values only — `Bug Fix` is an ALIAS that BRIEF_TYPE_ALIASES folds, and a non-canonical spelling on the mint surface is how the 50-spelling drift started)
Priority: P2 (default)
Status: Ready

To implement: /hunt {PREFIX}-{XXX}
To change priority: "change {PREFIX}-{XXX} priority to P0"
```

## Important

- DO NOT load context files
- DO NOT start implementation
- DO NOT create tasks
- ONLY store the brief in the brain DB via `igris_brief_create`
- DO NOT write brief files to the repo
