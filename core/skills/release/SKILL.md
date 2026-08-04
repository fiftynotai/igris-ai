---
name: release
tier: opt-in
description: Release preparation - changelog generation, version bumps, release notes
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
triggers:
  - "RELEASE"
  - "HERALD"
  - "prepare release"
  - "generate changelog"
  - "version bump"
  - "release notes"
---

# Release Skill

Release preparation workflow for generating changelogs, determining version bumps, and drafting release notes.

## Arguments

`$ARGUMENTS` can specify:
- Empty: Full release preparation
- `changelog`: Generate changelog only
- `version`: Determine version bump only
- `notes`: Draft release notes only

## Workflow

### Step 0: Pre-Tag Broken-Feature Audit (BLOCKING)

**Run this FIRST, before any release preparation.** It enforces
coding_guidelines **§17.2** ("no broken features in release"): zero
P0/P1 `Ready` / `In Progress` / `Blocked` Bug / Feature-Request rows before a
release is allowed. If this step does not PASS, the ENTIRE workflow aborts — do
not proceed to Steps 1–4, do not bump the version, do not author a changelog,
do not tag.

The query below is DRY-sourced from coding_guidelines §17.2 — the `priority`
literals, the `status` notation-fold expression, the `brief_type` literals and
the `brief_status` table MUST stay byte-aligned with that section (they move in
lockstep). "`In Progress`" above means the STATE, in any notation — the query
folds `In Progress` / `InProgress` / `in_progress` / `IN-PROGRESS` together
(TD-340). It does NOT fold terminal states: see the asymmetry note in the
query's comment block.

```bash
DB="$HOME/.igris/memory/knowledge.db"

# Resolve the project slug portably (never hard-code the project name).
SLUG="$(igris detect --json 2>/dev/null | grep -E '^\{' | jq -r '.project_slug // empty')"
[ -z "$SLUG" ] && SLUG="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"

# ROBUSTNESS: a missing DB or an absent brief_status table must NOT fail OPEN.
# A wrong/empty DB is NOT a legitimate "zero rows" pass — it is a HARD-WARN.
if [ ! -f "$DB" ]; then
  echo "AUDIT=HARDWARN reason=db-missing db=$DB slug=$SLUG"
elif [ "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='brief_status';" 2>/dev/null)" != "1" ]; then
  echo "AUDIT=HARDWARN reason=table-absent db=$DB slug=$SLUG"
else
  # §17.2 audit query — byte-aligned with coding_guidelines §17.2. It has TWO
  # halves; each has been holed once. Move BOTH in lockstep with §17.2 and
  # with the pins in cli/tests/integration/release-audit-brief-type.bats.
  #
  # brief_type half (TD-289) — the IN-list enumerates the real (inconsistent)
  # feature/bug vocabulary: 'Bug'/'BR' + 'Feature'/'FR'/'Feature Request'. Do
  # NOT drop synonyms: FR/Feature-typed P0/P1 blockers escaped the old
  # ('Bug','Feature Request') list.
  #
  # status half (TD-340) — FOLDS NOTATION instead of enumerating literals. It
  # used to read `status IN ('Ready','In Progress','Blocked')`, which cannot
  # match the 'InProgress' spelling that exists in the live brain; three
  # P1-High attendance_app blockers were invisible and the gate printed
  # AUDIT=PASS. The fold collapses case + space + hyphen + underscore, so
  # 'In Progress' / 'InProgress' / 'in_progress' / 'IN-PROGRESS' all block.
  # Do NOT "simplify" it back to a literal list, and do NOT patch a future
  # spelling by appending one more literal — that re-opens the same hole one
  # notation further out.
  #
  # !! ASYMMETRY — DO NOT "COMPLETE" THE STATUS LIST !!
  # This IN-list enumerates states that BLOCK a release. 'Done', 'Completed',
  # 'Complete' and 'Archived' are ABSENT BY DESIGN: a FINISHED brief must not
  # block a release. Their absence is CORRECT, not an oversight. Adding them
  # would INVERT the gate and make every release un-taggable. The fold above
  # collapses NOTATION only, never VOCABULARY — 'Completed' folds to
  # 'completed', which is deliberately not in the list. The canonical status
  # vocabulary (a new WORD, as opposed to a new SPELLING) WILL be owned by
  # normalizeStatus / CANONICAL_STATUSES in
  # brain-mcp-server/src/tools/brief-normalize.ts once TD-333 ships. NOT
  # SHIPPED as of TD-340 — that file names them only as a forward reference.
  ROWS="$(sqlite3 -noheader "$DB" "
    SELECT brief_id || '  ' || priority || '  ' || status || '  ' || brief_type || '  ' || title
    FROM brief_status
    WHERE project='$SLUG'
      AND priority IN ('P0-Critical','P1-High')
      AND replace(replace(replace(lower(status),' ',''),'-',''),'_','') IN ('ready','inprogress','blocked')
      AND brief_type IN ('Bug','BR','Feature','FR','Feature Request');")"
  if [ -z "$ROWS" ]; then
    echo "AUDIT=PASS slug=$SLUG (zero P0/P1 broken-feature rows)"
  else
    echo "AUDIT=BLOCK slug=$SLUG — release-blocking briefs:"
    echo "$ROWS"
    if [ "${IGRIS_BYPASS_RELEASE_AUDIT:-}" = "1" ]; then
      BYPASSED_IDS="$(printf '%s\n' "$ROWS" | awk '{print $1}' | paste -sd, -)"
      echo "WARNING: RELEASE AUDIT BYPASSED (IGRIS_BYPASS_RELEASE_AUDIT=1) — bypassed briefs: $BYPASSED_IDS" >&2
      echo "AUDIT=BYPASS ids=$BYPASSED_IDS"
    fi
  fi
fi
```

Interpret the verdict:

- **`AUDIT=PASS`** → continue to Step 1.
- **`AUDIT=BLOCK`** (and NO bypass) → **STOP the entire release workflow.** Print
  the offending briefs to the operator. Each row must be resolved via one of the
  §17.2 resolution paths (Fixed / Disabled-with-CHANGELOG-note / Explicitly
  downgraded) before `/release` can proceed.
- **`AUDIT=HARDWARN`** → **STOP. Do NOT pass.** The audit could not certify the
  release because the brain DB is missing or the `brief_status` table is absent
  (likely the wrong DB — the gate reads the LOCAL mirror at
  `~/.igris/memory/knowledge.db`, not the VPS). Fix the environment (correct DB
  path / run `igris` from a booted project) and re-run — a wrong/missing DB is
  **not** bypassable, because it is a config fault, not a resolved-brief decision.
- **`AUDIT=BYPASS`** → the operator set the one-shot override. You MUST:
  1. Surface the stderr WARNING (already emitted above) naming every bypassed brief.
  2. **Log the bypass durably** in the CHANGELOG entry authored in Step 3 — add a
     blockquote line directly under the new version heading:
     `> RELEASE AUDIT BYPASSED (IGRIS_BYPASS_RELEASE_AUDIT=1): <bypassed brief-id list>`
     so the bypass ships with the release and is diff-visible to reviewers.
  3. Only then continue to Step 1.

The `IGRIS_BYPASS_RELEASE_AUDIT` override is **one-shot** and must **never** be
`export`ed (it mirrors the `IGRIS_BYPASS_BRIEF_GATE` / `IGRIS_BYPASS_PHASE_GUARD`
convention). Bypassing without the logged CHANGELOG line is a Constraint violation.

### Step 1: Gather Changes

Parse commits since last tag:
```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

Categorize commits by type:
- `feat` → Features (MINOR bump)
- `fix` → Bug Fixes (PATCH bump)
- `refactor` → Refactoring
- `docs` → Documentation
- `chore` → Maintenance
- `BREAKING CHANGE` → Breaking Changes (MAJOR bump)

### Step 2: Determine Version Bump

Semantic versioning decision tree:
- **BREAKING CHANGE present?** → MAJOR (x.0.0)
- **New features present?** → MINOR (0.x.0)
- **Only fixes/refactors?** → PATCH (0.0.x)

### Step 3: Generate Changelog Entry

Format for CHANGELOG.md:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- feat: description (brief ref)

### Fixed
- fix: description (brief ref)

### Changed
- refactor: description

### Breaking Changes
- BREAKING: description
```

### Step 4: Draft Release Notes

User-friendly release notes highlighting:
- Key new features
- Important bug fixes
- Breaking changes with migration steps
- Brief references for traceability

## Constraints

1. **NEVER release with a non-empty §17.2 audit** — Step 0 must PASS. The only
   exception is `IGRIS_BYPASS_RELEASE_AUDIT=1`, which REQUIRES a stderr WARNING
   naming the bypassed briefs AND a logged `> RELEASE AUDIT BYPASSED …` line in
   the CHANGELOG. An `AUDIT=HARDWARN` (missing DB / absent `brief_status`) is a
   hard STOP and is NOT bypassable.
1. **ALWAYS follow semantic versioning** - major.minor.patch
2. **ALWAYS highlight breaking changes** - They're critical for users
3. **ALWAYS reference briefs** - Traceability matters
4. **NEVER skip version determination** - Always calculate the bump
5. **ALWAYS include date** - ISO format YYYY-MM-DD

## Output

Updated CHANGELOG.md and release notes draft.
