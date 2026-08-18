#!/usr/bin/env python3
"""
validate_skill_required_args.py

Recurrence net for SKILL CALL SITES that omit a brain tool's REQUIRED argument
(TD-324, the sweep half of BR-080).

WHY THIS EXISTS
---------------
BR-080 made `inputSchema.required` enforceable at the brain gateway: a tool
call that omits a declared-required key is now rejected at dispatch instead of
binding `undefined` into the handler. Skills are the largest population of
callers, and they are PROSE — no compiler, no type checker, no test sees them.

Before this script the compensating control was, verbatim from the project
architecture map, "a manual caller audit at the time of the change." TD-323
measured that control directly: the manual audit found 8 sites; a mechanical
sweep found 52. TD-324 then measured the comparable figure at 54-55 with a
further-corrected instrument. Either way the gap against 8 is the whole case
for this file — the manual control missed roughly six sevenths of the surface.

The load-bearing trigger is NOT a skill edit. It is a brain edit: adding a key
to an existing tool's `required` array silently invalidates every skill line
that already calls it. See the pre-commit trigger, which fires on
`engine/components/*/index.ts` for exactly that reason.

SCOPE — read this before trusting a green run
---------------------------------------------
This guard sees SKILL PROSE ONLY (`core/skills/**/*.md`). It does NOT see:
  - programmatic callers in `cli/` (TypeScript — the compiler sees those),
  - the brain's own in-process `engine.ready` dispatchers,
  - agent prompts under `core/agents/`, or any doc outside `core/skills/`.
A clean run means "no unclassified skill-prose site", never "no unsafe caller".

THE LEDGER, AND WHY IT IS NOT KEYED ON LINE NUMBERS
---------------------------------------------------
Most sites that carry a residual required key are NOT defects. TD-324
classified every site this instrument reports on the tree as of 2026-08-07 —
53 ledgered here plus 3 fixed as regressions — into three verdicts:

  NOTE ON THE COUNT, because three different numbers are in circulation and one
  of them is refuted. TD-324's brief says 45; that figure came from TD-323's
  sweep at commit 69b5350. THIS instrument measures 54 at that same commit, and
  55 at HEAD (the 55th landed the same day, from TD-325). The delta was
  RECONCILED, never tuned — 10 of 14 skills match the brief exactly once you
  count per (line, tool), `boot:103` names three tools on one line and
  `search:109` names two, and the remainder is `rest`'s section-scoped argument
  specs. Do not "correct" this instrument toward 45; two earlier sweeps were
  rejected for exactly that loosening (8 -> 49 -> 47 -> 45).


  prose        - the line names a tool but is not an instruction to call it
                 (a table cell, a "subsumes the former X" note, a cross-ref).
  already-loud - the call is deficient, but the handler or the schema already
                 rejects it in-band with a readable message, or a NOT NULL
                 column does. BR-080 only improved the wording.
  regression   - neither holds: the call previously bound NULL / silently
                 degraded, or it gates later steps. These were FIXED, so they
                 are NOT in the ledger.

Those verdicts ship below as LEDGER, an explicit commented constant (the
L-448 pattern that `validate_skill_os_harness_leak.py` already uses). Clean-tree
output is therefore ZERO, not ~40 standing WARNs. A gate whose standing output
is a wall of known-and-decided entries trains `--no-verify` — that failure is
named in `validate_brief_status_vocabulary.sh`'s own header, and it is the
precondition the operator attached to landing this script at all.

Ledger entries are keyed `(relative_path, tool, sorted(residual_keys))`.
NEVER on line numbers. Four separate line-number drifts have been recorded in
this contract's neighbourhood: MAINTAINING row 113 records TD-321 drifting a
line form; TD-324's own brief cited `architecture_map.md:286-288` when the
passage was at `:386`; it cited `briefs/index.ts:487` for an empty
`required: []` that was at `:491`; and TD-402 drifted BOTH of the line-form
citations THIS FILE carried into `brain-mcp-server/src/tools/projects.ts`, by
inserting prose above them. The fourth is the instructive one, because neither
pointer went OUT OF BOUNDS — one came to name a DIFFERENT function's body and
the other a doc comment, so both stayed plausible while pointing at the wrong
code. Deliberately stated as a PROPERTY and carrying no line numbers or file
length: a first draft of this very paragraph quoted the before/after lines and
the file's line count, and the brief's own next round moved all three, so the
paragraph diagnosing drift had drifted — plausibly, and still in bounds, which
is the failure mode it describes one sentence up. NOTHING mechanical catches
that: the ledger is
deliberately not line-keyed, so a stale line inside a citation STRING is
invisible to every check here. Both are now cited by SYMBOL, which survives an
insertion above them. A line-keyed ledger silently goes blind the first time
someone inserts a paragraph; a line-keyed citation lies instead.

Each key carries an `expected_count`. A site whose key is in the ledger is
subtracted; a site whose key is ABSENT is reported; and if a ledgered key is
observed MORE times than expected, the excess is reported too (the TD-333
accumulation-observer pattern), so a genuinely-new site that happens to share
an already-classified shape still surfaces.

HOW A SITE IS FOUND
-------------------
Pass A - tool -> required map. Parse `engine/components/*/index.ts`. Bound each
  tool's block between its own `name: 'igris_*'` and the NEXT one (never a
  character window), then take the SHALLOWEST-INDENTED `required: [...]` inside
  that block. The shallowest-indent rule is load-bearing: `igris_memory_store`
  declares a NESTED `required: ['to_type','to_id','edge_type']` (the
  `edges[]` item schema) BEFORE its real one, so a first-match parser builds a
  wrong map and every conclusion downstream is noise. Tools with `required: []`
  are dropped. COUNT SENTINEL: 75 (see below).

Pass B - site scan. Every `.md` under `core/skills/`, recursive — not only
  `SKILL.md`. That restriction is precisely how `hunt/workflow-template.md`
  stayed invisible through two sweeps. The `allowed-tools:` frontmatter block
  is excluded (it is an allowlist, not a call); the REST of the frontmatter is
  kept, because `description:` can legitimately name a tool.

  THE WINDOW RULE (the one free parameter — pinned by its own fixtures):
    A site is one (line, tool) pair. Its window is:
      - the site line, PLUS
      - the immediately-following fenced code block, when the site line ends in
        `:` or an em dash (the `harvest` "store call" shape: an imperative that
        introduces the literal call), OR
      - the following lines while they are CONTINUATION of the site line —
        strictly deeper-indented and non-blank. A blank line, or a line at the
        site's own indent or shallower (the next sibling bullet), closes it.
    Inside a fenced block the window extends to the end of the fence, so a
    multi-line literal call is scored as one unit.

Pass C - coverage, BY NAMED ARGUMENT ONLY. Never by token proximity. A required
  key K counts as NAMED only when written as an argument: `` `K` ``, `K:`,
  `K =`, `K=`, "with K", or "and K". Residual = required keys not named.

  That form rule is what kills the false negative that hid `hunt/SKILL.md:79` —
  Phase 1 step 1 of the flagship skill — where an earlier sweep counted
  `{project}` inside the filesystem path `~/.igris/projects/{project}/briefs/`
  as "project is named". A bare word is never a named argument, in a path or
  anywhere else.

  Before scoring, whitespace-delimited tokens containing `/` are additionally
  stripped, KEEPING any `key=` / `key:` prefix. Be precise about what this
  earns: measured against the real corpus it changes NOTHING (53 sites either
  way), because the form rule already refuses the bare-word case. It is a
  second, independent guard against a `key=`/`key:` living INSIDE a path-shaped
  token — `.../sync?project=other` — which the form rule alone WOULD credit.
  Its prefix-preserving half is load-bearing today: without it,
  `filename=instances/<id>.md` (a properly named argument whose value is a
  path) was reported as deficient. Both halves are armed by their own fixtures;
  see T8b and T10 in the bats twin, and do not "simplify" either away on the
  strength of a green real-tree run.

Pass D - ledger subtraction (above).

COUNT SENTINEL
--------------
The tool map must have exactly 75 entries on the real tree:
    80 `required: [` literals
   -  4 empty `required: []`  (memory x2, errors, briefs)
   -  1 nested item schema    (memory `edges[]`)
   = 75
This is in-family with `gateway-tool-count.test.ts` pinning 112 registered
tools. When a tool is legitimately added the sentinel goes red on purpose: bump
the constant AND re-read the ledger, because a new tool means new call sites.
The sentinel is skipped when the components root is overridden for fixtures.

Discovers:
  - repo `core/skills/**/*.md` and
    `brain-mcp-server/src/engine/components/*/index.ts`.
  - SKILL_ARGS_SCAN_ROOT      env override -> alternate skills root (fixtures).
  - SKILL_ARGS_COMPONENTS_ROOT env override -> alternate components root; also
    disables the 75 sentinel and the ledger (a fixture map has neither).

Usage:
    python3 scripts/validate_skill_required_args.py
    python3 scripts/validate_skill_required_args.py --no-ledger --list
    SKILL_ARGS_SCAN_ROOT=/tmp/prefix/core/skills \\
      python3 scripts/validate_skill_required_args.py --no-ledger

Flags:
    --no-ledger  Report every residual site, classified or not (the sweep mode
                 used to produce the ledger in the first place, and the mode
                 the known-positive validation runs in).
    --list       Also print the ledger-subtracted sites, marked with their
                 recorded verdict. Diagnostic; does not change the exit code.

Exit codes:
    0 - no UNCLASSIFIED residual site
    1 - one or more unclassified residual sites (or a ledger count exceeded)
    2 - setup error (no files, unreadable file, sentinel mismatch)

See: TD-324, TD-323, BR-080, TD-128, MAINTAINING.md row 113,
     L-448 (validator + explicit ledger makes the drift class preventable),
     L-400 (recurrence-net scope honesty).
"""
from __future__ import annotations

import os
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_SKILLS_ROOT = REPO_ROOT / "core" / "skills"
DEFAULT_COMPONENTS_ROOT = (
    REPO_ROOT / "brain-mcp-server" / "src" / "engine" / "components"
)

# Count sentinel — see COUNT SENTINEL in the module docstring for the
# arithmetic. Bumping this is a conscious act that must be paired with a ledger
# review, because a new tool means new (unclassified) call sites.
EXPECTED_TOOL_COUNT = 75


# --- The disposition ledger (explicit constant — L-448) ----------------------
# TD-324's classification of every residual site on the tree as of 2026-08-07.
# KEY:   (repo-relative path, tool, tuple(sorted(residual keys)))  -- NEVER a
#        line number; see the module docstring for the three recorded drifts.
# VALUE: (verdict, expected_count, citation)
#
# `verdict` is one of "prose" or "already-loud". A "regression" verdict is NOT
# ledgered — regressions were fixed, so they no longer produce a residual.
# `citation` must be a code fact (a named validator line, a NOT NULL column, or
# the reason the line is not an instruction), not an opinion. A ledger entry
# with no citation is not a classification.
#
# TD-324 outcome: 53 ledgered + 3 fixed regressions = 56 classified.
#   The tree measured 55 residual at classification time; the arithmetic
#   differs by one because a ledger entry below (harvest igris_memory_update)
#   is a pointer TD-324 itself added, not a pre-existing site.
#   3 REGRESSIONS  — fixed in TD-324, therefore absent from this ledger:
#       boot/SKILL.md  igris_memory_recall     (named the project by VALUE only)
#       boot/SKILL.md  igris_project_register  (see below — the sharp one)
#       hunt/SKILL.md  igris_brief_update      (gates the TD-325 AC commit gate)
#  26 PROSE
#  27 ALREADY-LOUD
#
# The `boot` `igris_project_register` fix is worth reading before adding an
# entry here, because its shape is the trap this whole contract keeps setting.
# The naive fix — "name the three required args" — would have made `/boot` pass
# a slug-derived `name` into an UPSERT whose conflict arm is `name =
# excluded.name` (the `ON CONFLICT(slug) DO UPDATE SET` arm inside
# `handleProjectRegister`, in `brain-mcp-server/src/tools/projects.ts` — cited by
# symbol, not by line, because TD-402 already drifted the line form of this exact
# citation), silently overwriting the operator's curated project name on EVERY
# session start.
#
# AND THAT FIX, APPLIED TO ONE COLUMN, OPENED THE NEXT ONE. The same conflict
# arm also carries `tech_stack = excluded.tech_stack`, and the handler binds
# `args.tech_stack ?? ''` — so the three-argument call that fixes `name` writes
# an EMPTY STRING over curated `tech_stack` instead. Only `archetype` is
# COALESCEd. Pre-fix the call was gateway-REJECTED and wrote nothing; post-fix
# it SUCCEEDS and clobbers. The repair created the exposure.
#
# THE STOPPING RULE, because this contract keeps setting the same trap:
# **when a change moves a call across a liveness boundary — rejected -> accepted,
# never-ran -> runs, WARN -> block — audit everything the newly-live path does,
# not the delta you authored.** For a write that reduces to: enumerate every
# column the statement assigns; for each, does the caller supply it, and what
# does the handler bind when it does not? `x = excluded.x` behind an optional
# key with a `?? default` bind is a clobber, always. The cheap tell here: a call
# site naming three arguments to a handler whose write touches five.
#
# The fix is read-then-register, echoing back every column the write touches.
# A site is not "fixed" by making the gateway stop complaining.
LEDGER: dict[tuple[str, str, tuple[str, ...]], tuple[str, int, str]] = {
    # --- audit / ideate / migrate-analyze: the shared brief_create shape ------
    ("core/skills/audit/SKILL.md", "igris_brief_create",
     ('brief_id', 'content', 'project', 'title')): (
        "already-loud", 1,
        "briefs.ts:572-576 returns in-band 'Error: \"project\", \"brief_id\", "
        "\"title\", and \"content\" are required.' The line also prescribes "
        "'fallback to cache write', so a rejection is fail-SAFE by design."),
    ("core/skills/ideate/SKILL.md", "igris_brief_create",
     ('brief_id', 'content', 'project', 'title')): (
        "already-loud", 1,
        "briefs.ts:572-576, same in-band guard and same cache-fallback shape "
        "as audit."),
    ("core/skills/migrate-analyze/SKILL.md", "igris_brief_create",
     ('brief_id', 'content', 'project', 'title')): (
        "already-loud", 1,
        "briefs.ts:572-576, same in-band guard and same cache-fallback shape "
        "as audit."),

    # --- boot ----------------------------------------------------------------
    ("core/skills/boot/SKILL.md", "igris_brain_pull",
     ('api_key', 'remote_url')): (
        "prose", 1,
        "The FR-195 'what replaced what' note, naming the sections boot-sync "
        "SUBSUMED. No imperative, no call — a changelog sentence."),
    ("core/skills/boot/SKILL.md", "igris_sync_queue_drain",
     ('api_key', 'remote_url')): (
        "prose", 1, "Same FR-195 note line as igris_brain_pull above."),
    ("core/skills/boot/SKILL.md", "igris_session_file_pull", ('project',)): (
        "prose", 1, "Same FR-195 note line as igris_brain_pull above."),
    ("core/skills/boot/SKILL.md", "igris_instance_remove", ('instance_id',)): (
        "prose", 2,
        "Two lines in the stale-instance DISPLAY section: one narrates that "
        "/rest's own §2.5 already called it, the other is a NEGATIVE "
        "instruction ('Do NOT call ...'). Neither is a call to make."),

    # --- harvest -------------------------------------------------------------
    ("core/skills/harvest/SKILL.md", "igris_catalog_add",
     ('github_repo', 'name', 'type')): (
        "already-loud", 3,
        "catalog.name / .type / .github_repo are NOT NULL (db.ts:566-570 — the "
        "v17 rename of the `registry` DDL) and handleCatalogAdd binds them "
        "straight into the INSERT (catalog.ts:191-200), so an omission is a "
        "NOT NULL constraint failure. Two of the three lines are additionally "
        "cross-references (to the shared catalog recipe, and back to the "
        "Phase-3 call) rather than calls."),
    ("core/skills/harvest/SKILL.md", "igris_catalog_search", ('query',)): (
        "already-loud", 2,
        "Read-only. catalog.ts:242-247 — sanitizeFts5Query(args.query) is "
        "falsy, so it returns in-band 'No catalog entries found for query "
        "\"undefined\".' Nothing is written."),
    ("core/skills/harvest/SKILL.md", "igris_memory_search", ('query',)): (
        "prose", 1,
        "A parenthetical aside — 'optionally X for an FTS pass, and Y to ...' "
        "— inside a sentence about the dedup approach."),
    ("core/skills/harvest/SKILL.md", "igris_memory_get", ('id',)): (
        "prose", 1, "Same parenthetical aside as igris_memory_search above."),
    ("core/skills/harvest/SKILL.md", "igris_memory_update", ('id',)): (
        "prose", 1,
        "TD-324's own note pointing at the tool that CAN set confidence until "
        "TD-364 ships. A pointer, not a step."),
    ("core/skills/harvest/SKILL.md", "igris_catalog_update", ('id',)): (
        "already-loud", 1,
        "catalog.ts:450-454 returns in-band 'Catalog entry \"undefined\" not "
        "found.' before any write."),
    ("core/skills/harvest/SKILL.md", "igris_memory_recall",
     ('context', 'project')): (
        "prose", 1,
        "A Phase-4 rules checklist item ('DEDUP before writing'), not the "
        "dedup step itself."),
    ("core/skills/harvest/SKILL.md", "igris_memory_store",
     ('category', 'content', 'project', 'title')): (
        "prose", 1,
        "A Phase-4 rules checklist item about source_extractor. The actual "
        "store call is the fenced literal earlier in Phase 4, which names all "
        "four required keys and is NOT flagged."),

    # --- hunt ----------------------------------------------------------------
    ("core/skills/hunt/SKILL.md", "igris_error_lookup",
     ('message', 'project')): (
        "already-loud", 1,
        "errors.ts:90-94 returns in-band 'Validation error: project must be "
        "1-N characters.' / '... message must be ...'. The line instructs "
        "MENDER what its first diagnostic action must be; the orchestrator's "
        "own call in the same phase names project, message and solution and is "
        "NOT flagged."),
    ("core/skills/hunt/SKILL.md", "igris_agent_event",
     ('agent', 'event_type', 'instance_id')): (
        "prose", 1,
        "The section's topic sentence ('you MUST emit ... calls if ...'). The "
        "argument contract is the scoped preamble immediately below it, which "
        "names all three required keys and covers the four numbered calls "
        "that follow — TD-323's fix, and the reason this instrument reads a "
        "list's introducer."),

    # --- promote (read-only, fail-open — warden's TD-323 disposition) ---------
    ("core/skills/promote/SKILL.md", "igris_memory_recall",
     ('context', 'project')): (
        "already-loud", 3,
        "Read-only and fail-open. memory.ts:497-503 returns in-band 'No "
        "relevant learnings found for project ...'. Two of the three lines are "
        "additionally prose: one states what the default filter already hides, "
        "the other describes what recall SHOWS after a promotion."),
    ("core/skills/promote/SKILL.md", "igris_memory_search", ('query',)): (
        "already-loud", 1,
        "Read-only FTS pass named in the same sentence as the recall above; "
        "no write path."),
    ("core/skills/promote/SKILL.md", "igris_memory_get", ('id',)): (
        "already-loud", 1,
        "memory.ts:772-776 returns in-band 'Learning with ID undefined not "
        "found.' Read-only."),

    # --- register ------------------------------------------------------------
    ("core/skills/register/SKILL.md", "igris_brief_similar", ('query',)): (
        "prose", 1,
        "A degradation branch label — 'Tool unavailable (... returns a "
        "capability message ...)'. Describes the tool's absence, not a call."),
    ("core/skills/register/SKILL.md", "igris_brief_create",
     ('brief_id', 'content', 'project', 'title')): (
        "prose", 2,
        "A failure-branch header ('If ... fails or MCP is unavailable:') and a "
        "scope rule under '## Important'. The real call is the argument list "
        "earlier in the same file, which names all four and is NOT flagged."),

    # --- rest ----------------------------------------------------------------
    ("core/skills/rest/SKILL.md", "igris_memory_store",
     ('category', 'content', 'project', 'title')): (
        "already-loud", 1,
        "validateMemoryInput (memory.ts:253-262) rejects with 'Invalid title: "
        "must be 1-N characters.' before the INSERT — a loud in-band error "
        "pre-BR-080. Warden's TD-323 disposition, confirmed against the code."),
    ("core/skills/rest/SKILL.md", "igris_memory_store",
     ('content', 'project', 'title')): (
        "already-loud", 1,
        "Same validateMemoryInput guard (memory.ts:253-262); this line names "
        "category by value so the residual set is one key smaller."),
    ("core/skills/rest/SKILL.md", "igris_brief_sync",
     ('brief_id', 'project', 'status', 'title')): (
        "already-loud", 1,
        "brief_status.project / .brief_id / .title / .status are all NOT NULL "
        "(db.ts:298-302) and handleBriefSync binds args straight into the "
        "INSERT (briefs.ts:283-300). The sub-bullet under this line DOES "
        "enumerate the fields, but as a bare comma list; the instrument does "
        "not credit an unmarked word as a named argument, by design."),
    ("core/skills/rest/SKILL.md", "igris_sync_queue_drain",
     ('api_key', 'remote_url')): (
        "prose", 4,
        "Four sentences ABOUT the tool, none of them the call: what the CLI "
        "drains for you (and that it reads both values from config itself), a "
        "negative instruction, the CONDITION under which to call it directly, "
        "and the BR-080 rule statement itself ('requires BOTH arguments'). "
        "The call spec is the sub-list in the same section, which names "
        "remote_url and api_key and is NOT flagged."),
    ("core/skills/rest/SKILL.md", "igris_brain_push",
     ('api_key', 'remote_url')): (
        "prose", 1,
        "A mandate sentence ('You MUST call ... when remote brain is "
        "configured'). The call spec is the sub-list four lines below, which "
        "names remote_url and api_key and is NOT flagged."),

    # --- reuse ---------------------------------------------------------------
    ("core/skills/reuse/SKILL.md", "igris_catalog_get", ('id',)): (
        "already-loud", 1,
        "catalog.ts:315-319 returns in-band 'Catalog entry \"undefined\" not "
        "found.' Read-only. The line writes the call as `({ id })` — a "
        "destructuring shorthand the named-argument rule deliberately does "
        "not credit, since crediting bare braced words would re-open the "
        "token-proximity hole BR-080's sweep closed."),
    ("core/skills/reuse/SKILL.md", "igris_catalog_update", ('id',)): (
        "already-loud", 2,
        "catalog.ts:450-454 in-band 'Catalog entry \"undefined\" not found.' "
        "One of the two lines is additionally a parenthetical aside."),

    # --- scan ----------------------------------------------------------------
    ("core/skills/scan/SKILL.md", "igris_goal_progress", ('goal_id',)): (
        "already-loud", 1,
        "goals/handlers.ts:625 returns errorResult('Missing required field: "
        "goal_id'). The id is the loop variable over igris_goal_list's "
        "results, which the same line names."),
    ("core/skills/scan/SKILL.md", "igris_project_status", ('slug',)): (
        "already-loud", 1,
        "handleProjectStatus's not-found branch in "
        "brain-mcp-server/src/tools/projects.ts returns in-band 'Project "
        "\"undefined\" not found. Use igris_project_register to register it "
        "first.' (cited by symbol — TD-402 drifted this citation's line form). "
        "READ-only, and the section states 'skip this step silently'. This is "
        "the principled twin of the boot igris_project_register site that WAS "
        "fixed: same 'for the current project' phrasing, but that one is an "
        "UPSERT. What a MISSING slug does there was MEASURED on 2026-08-17 and "
        "it is loud on both reachable paths, never a NULL: through the gateway "
        "BR-080 refuses first with \"igris_project_register: missing required "
        "argument 'slug'. Required: slug, name, path. (strict-input contract; "
        "BR-080)\", and called in-process the INSERT dies on 'NOT NULL "
        "constraint failed: projects.slug' (db.ts declares slug TEXT UNIQUE NOT "
        "NULL on the projects table) with no row written. TD-402's own guard is "
        "about the PATH, never slug presence, and is inert on a slug-less call "
        "anyway — a NULL bind makes 'slug != ?' match no row."),
    ("core/skills/scan/SKILL.md", "igris_suggestion_dismiss", ('id',)): (
        "prose", 1,
        "Display text — a quoted hint string rendered TO the operator showing "
        "the CLI form `... <id> --reason ...`, not a call the skill makes."),

    # --- search --------------------------------------------------------------
    ("core/skills/search/SKILL.md", "igris_memory_hybrid_search", ('query',)): (
        "prose", 2,
        "The skill's overview sentence, and a capability statement ('only "
        "reads via X and Y'). Neither is a step."),
    ("core/skills/search/SKILL.md", "igris_memory_get", ('id',)): (
        "prose", 1, "The same 'only reads via X and Y' capability statement."),

    # --- team ----------------------------------------------------------------
    ("core/skills/team/SKILL.md", "igris_brief_get", ('brief_id', 'project')): (
        "already-loud", 4,
        "briefs.ts:497-501 returns in-band 'Error: \"project\" and "
        "\"brief_id\" are required.' All four lines also offer a cache "
        "fallback in the same breath, so a rejection is fail-SAFE."),
    ("core/skills/team/SKILL.md", "igris_brief_update",
     ('brief_id', 'project')): (
        "prose", 2,
        "A table cell, and a sentence comparing which record works across "
        "CLIs. Neither is an instruction to call."),

    # --- visualize -----------------------------------------------------------
    ("core/skills/visualize/SKILL.md", "igris_brief_graph_render",
     ('project',)): (
        "prose", 1,
        "The skill's overview sentence ('Wraps X + cross-platform openers')."),
}


# --- Pass A: tool -> required map -------------------------------------------

RE_TOOL_NAME = re.compile(r"^(\s*)name:\s*'(igris_[A-Za-z0-9_]+)'")
RE_REQUIRED = re.compile(r"^(\s*)required:\s*\[")
RE_QUOTED = re.compile(r"'([^']*)'|\"([^\"]*)\"")


def _collect_required(lines: list[str], start: int) -> tuple[list[str], int]:
    """Read a `required: [...]` literal starting at `start`, joining
    continuation lines until the closing `]`.

    Returns (keys, indent). Joining is load-bearing: a future multi-line array
    must not silently parse as empty.
    """
    indent = len(lines[start]) - len(lines[start].lstrip())
    buf = lines[start].split("required:", 1)[1]
    idx = start
    while "]" not in buf and idx + 1 < len(lines):
        idx += 1
        buf += " " + lines[idx]
    body = buf.split("]", 1)[0]
    keys = [m.group(1) if m.group(1) is not None else m.group(2)
            for m in RE_QUOTED.finditer(body)]
    return keys, indent


def build_tool_map(components_root: pathlib.Path) -> dict[str, list[str]]:
    """Return {tool_name: [required keys]} for every tool with a NON-EMPTY
    required list.

    Each tool's block is bounded by its own `name:` line and the NEXT tool's
    `name:` line (or EOF). Within the block the SHALLOWEST-INDENTED `required:`
    wins — `igris_memory_store`'s nested `edges[]` item schema declares a
    `required` before the real one, so first-match is wrong.
    """
    tool_map: dict[str, list[str]] = {}
    for path in sorted(components_root.glob("*/index.ts")):
        lines = path.read_text().splitlines()

        # Bound the blocks first.
        marks: list[tuple[int, str]] = []
        for i, line in enumerate(lines):
            m = RE_TOOL_NAME.match(line)
            if m:
                marks.append((i, m.group(2)))

        for pos, (start, tool) in enumerate(marks):
            end = marks[pos + 1][0] if pos + 1 < len(marks) else len(lines)
            best: tuple[int, list[str]] | None = None
            i = start
            while i < end:
                if RE_REQUIRED.match(lines[i]):
                    keys, indent = _collect_required(lines, i)
                    if best is None or indent < best[0]:
                        best = (indent, keys)
                i += 1
            if best is None or not best[1]:
                # No required list, or an empty one -> the tool declares no
                # required key and can never produce a residual.
                continue
            tool_map[tool] = best[1]
    return tool_map


# --- Pass B: site scan -------------------------------------------------------

RE_FENCE = re.compile(r"^\s*(?:```|~~~)")
RE_LIST_KEY = re.compile(r"^\s*-\s")
# A markdown list bullet: `- `, `* `, `+ `, or an ordered marker (`1.`, `6.5.`).
RE_BULLET = re.compile(r"^\s*(?:[-*+]\s|\d+(?:\.\d+)*\.\s)")
RE_HEADING = re.compile(r"^\s{0,3}#{1,6}\s")


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def excluded_frontmatter_lines(lines: list[str]) -> set[int]:
    """0-based indices of the `allowed-tools:` frontmatter block.

    Only that block is dropped, not the whole frontmatter: `description:`
    legitimately names tools and a leak there is a real (prose) site.
    """
    if not lines or lines[0].strip() != "---":
        return set()
    close = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            close = i
            break
    if close is None:
        return set()

    dropped: set[int] = set()
    i = 1
    while i < close:
        if lines[i].lstrip().startswith("allowed-tools:"):
            dropped.add(i)
            j = i + 1
            while j < close and (not lines[j].strip() or RE_LIST_KEY.match(lines[j])
                                 or lines[j].startswith((" ", "\t"))):
                dropped.add(j)
                j += 1
            i = j
            continue
        i += 1
    return dropped


def fence_spans(lines: list[str]) -> dict[int, tuple[int, int]]:
    """Map each line index INSIDE a fence to that fence's (start, end) body
    range, and each fence-OPENING line to the same range.

    Used twice: to extend a site's window to the whole literal call, and to
    let an imperative line that introduces a fence pull the fence in.
    """
    spans: dict[int, tuple[int, int]] = {}
    i = 0
    while i < len(lines):
        if RE_FENCE.match(lines[i]):
            start = i + 1
            j = i + 1
            while j < len(lines) and not RE_FENCE.match(lines[j]):
                j += 1
            end = j  # exclusive; j is the closing fence (or EOF)
            for k in range(start, end):
                spans[k] = (start, end)
            spans[i] = (start, end)
            i = j + 1
            continue
        i += 1
    return spans


def owner_start(lines: list[str], idx: int) -> int:
    """Index of the LIST ITEM that owns the site line, or `idx` itself.

    A markdown list item's body may span several indented paragraphs separated
    by blank lines, and the arguments of a call are routinely named in a
    sibling line of that body rather than on the line naming the tool. Walking
    back to the owning bullet is what lets the instrument see
    `hunt/SKILL.md` step 6.5, where the tool is named at `:139` and its three
    required keys at `:112-113` — same list item, seven lines and one blank
    apart.

    The walk stops at a heading, at a top-level (indent 0) paragraph, or at the
    first bullet indented LESS than the site line. It never crosses out of the
    item it started in.
    """
    site_ind = _indent(lines[idx])
    if site_ind == 0:
        return idx
    j = idx - 1
    while j >= 0:
        line = lines[j]
        if RE_HEADING.match(line):
            return idx
        if not line.strip():
            # Blank line: keep walking only while we are still INSIDE the item
            # (the line above it is indented, or is a bullet).
            k = j
            while k >= 0 and not lines[k].strip():
                k -= 1
            if k < 0:
                return idx
            if _indent(lines[k]) == 0 and not RE_BULLET.match(lines[k]):
                return idx        # a top-level paragraph — we left the item
            j = k
            continue
        if RE_BULLET.match(line) and _indent(line) < site_ind:
            return j              # the owning bullet
        if _indent(line) == 0 and not RE_BULLET.match(line):
            return idx            # not inside a list item at all
        j -= 1
    return idx


def block_end(lines: list[str], start: int) -> int:
    """Exclusive end index of the block opened at `start` — the next sibling
    (a non-blank line at the opener's indent or shallower) or a heading."""
    base = _indent(lines[start])
    end = start + 1
    j = start + 1
    while j < len(lines):
        line = lines[j]
        if not line.strip():
            j += 1
            continue
        if RE_HEADING.match(line) or _indent(line) <= base:
            break
        j += 1
        end = j
    return end


def list_start(lines: list[str], start: int) -> int:
    """Index of the FIRST item of the contiguous list `start` belongs to.

    A preamble introduces the whole list, not only its first item, so the
    introducer lookup has to run from the list's head. Without this,
    `hunt/SKILL.md:787` would be covered by the `:782-785` preamble but
    `:788-790` — the same list, the same preamble — would not.
    """
    if not RE_BULLET.match(lines[start]):
        return start
    ind = _indent(lines[start])
    first = start
    j = start - 1
    while j >= 0:
        line = lines[j]
        if not line.strip():
            k = j
            while k >= 0 and not lines[k].strip():
                k -= 1
            if k < 0:
                break
            prev = lines[k]
            if _indent(prev) > ind or (RE_BULLET.match(prev) and _indent(prev) == ind):
                j = k          # a loose list: blank lines between items
                continue
            break
        if RE_BULLET.match(line) and _indent(line) == ind:
            first = j
            j -= 1
            continue
        if _indent(line) > ind:
            j -= 1             # the body of an earlier item
            continue
        break
    return first


def introducer_range(lines: list[str], start: int) -> tuple[int, int] | None:
    """Range of the paragraph that INTRODUCES the block at `start`, if any.

    An introducer is the contiguous non-blank block immediately above (at most
    one blank line between) whose last line ends in `:` or an em dash. This is
    the second remediation idiom TD-323 established: a scoped preamble that
    names the required keys once for a whole following list, as at
    `hunt/SKILL.md:782-785` ("all three of `instance_id`, `agent` and
    `event_type` are REQUIRED") covering the four numbered calls at `:787-790`.
    Without this rule the instrument penalises the repo's own fix pattern.
    """
    j = start - 1
    if j >= 0 and not lines[j].strip():
        j -= 1
    if j < 0 or not lines[j].strip():
        return None
    if RE_HEADING.match(lines[j]) or RE_FENCE.match(lines[j]):
        return None
    if not lines[j].rstrip().endswith((":", "—", "–")):
        return None
    k = j
    while k > 0 and lines[k - 1].strip() and not RE_HEADING.match(lines[k - 1]) \
            and not RE_FENCE.match(lines[k - 1]):
        k -= 1
    return (k, j + 1)


def site_window(lines: list[str], idx: int,
                spans: dict[int, tuple[int, int]]) -> str:
    """Return the text of the site's window. See THE WINDOW RULE in the
    module docstring — this is the one free parameter, and it is pinned by its
    own fixtures in test/validate_skill_required_args.test.bash.
    """
    line = lines[idx]
    parts = [line]

    if idx in spans:
        # The site is inside a fenced block: the whole fence body is the call.
        start, end = spans[idx]
        return "\n".join(lines[start:end])

    stripped = line.rstrip()
    if stripped.endswith((":", "—", "–")):
        # An imperative that INTRODUCES the call body. Skip blanks, then pull
        # in a fenced block if one immediately follows.
        j = idx + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j < len(lines) and RE_FENCE.match(lines[j]) and j in spans:
            start, end = spans[j]
            parts.extend(lines[start:end])
            return "\n".join(parts)
        # ...otherwise the body is the following list / paragraph, handled by
        # the continuation walk below.

    indent = _indent(line)
    site_is_bullet = bool(RE_BULLET.match(line))
    j = idx + 1
    while j < len(lines):
        nxt = lines[j]
        if not nxt.strip():
            break                      # a blank line closes the window
        if RE_HEADING.match(nxt) or RE_FENCE.match(nxt):
            break
        nxt_indent = _indent(nxt)
        if RE_BULLET.match(nxt):
            # When the site line is ITSELF a bullet, a SIBLING bullet (same
            # indent or shallower) closes the window and a deeper one is a
            # sub-item of this call. When the site line is a paragraph that
            # INTRODUCES a list (the `archive` "call X with:" shape), the list
            # is the call body, so only a dedent closes it.
            if nxt_indent <= indent if site_is_bullet else nxt_indent < indent:
                break
        elif nxt_indent < indent:
            break                      # dedented out of the block
        parts.append(nxt)
        j += 1

    # Scope: the enclosing list item, and the paragraph that introduces it.
    start = owner_start(lines, idx)
    if start != idx:
        parts.extend(lines[start:block_end(lines, start)])
    intro = introducer_range(lines, list_start(lines, start))
    if intro:
        parts.extend(lines[intro[0]:intro[1]])
    return "\n".join(parts)


# --- Pass C: coverage by NAMED ARGUMENT --------------------------------------

RE_PATHY_TOKEN = re.compile(r"\S*/\S*")
# An `arg=` / `arg:` prefix at the head of a token. When the token is a path,
# the PREFIX is still a named argument and must survive the strip.
RE_ARG_PREFIX = re.compile(r"^[`'\"(\[]*([A-Za-z_][A-Za-z0-9_]*)\s*([:=])")


def strip_path_tokens(text: str) -> str:
    """Remove every whitespace-delimited token containing `/`, KEEPING any
    `key=` / `key:` prefix the token starts with.

    The strip is the SECOND guard against a key mentioned only inside a path.
    The first is `key_is_named`'s form rule, which already refuses a bare word
    anywhere — so on the real corpus this function changes no verdict. What it
    uniquely catches is a `key=` / `key:` sitting inside a path-shaped token,
    e.g. a URL query `.../sync?project=other`, which the form rule alone would
    credit as a named `project`.

    Keeping the prefix is the symmetric correction. `boot/SKILL.md:629` writes
    `filename=instances/<instance_id>.md` — a properly NAMED argument whose
    VALUE happens to be a path. A blind whole-token strip removed `filename=`
    along with the path and reported the site as deficient, which is the same
    class of defect (scoring on token shape rather than argument form) in the
    opposite direction.
    """
    def _sub(match: re.Match[str]) -> str:
        prefix = RE_ARG_PREFIX.match(match.group(0))
        return f" {prefix.group(1)}{prefix.group(2)} " if prefix else " "

    return RE_PATHY_TOKEN.sub(_sub, text)


def key_is_named(key: str, text: str) -> bool:
    """True iff `key` appears as an ARGUMENT, not merely as a word.

    Accepted forms (TD-323's earned rule): `key`, key:, key =, key=,
    "with key", "and key".
    """
    k = re.escape(key)
    nb = r"(?<![A-Za-z0-9_])"
    na = r"(?![A-Za-z0-9_])"
    patterns = (
        rf"`{k}`",
        rf"{nb}{k}{na}\s*[:=]",
        rf"\bwith\s+{k}{na}",
        rf"\band\s+{k}{na}",
    )
    return any(re.search(p, text) for p in patterns)


RE_TOOL_MENTION = re.compile(r"(?<![A-Za-z0-9_])(igris_[a-z0-9_]+)")


class Site:
    __slots__ = ("path", "rel", "line_no", "tool", "residual", "snippet")

    def __init__(self, path, rel, line_no, tool, residual, snippet):
        self.path = path
        self.rel = rel
        self.line_no = line_no
        self.tool = tool
        self.residual = residual
        self.snippet = snippet

    @property
    def key(self) -> tuple[str, str, tuple[str, ...]]:
        return (self.rel, self.tool, tuple(sorted(self.residual)))


def scan_file(path: pathlib.Path, rel: str,
              tool_map: dict[str, list[str]]) -> list[Site]:
    lines = path.read_text().splitlines()
    dropped = excluded_frontmatter_lines(lines)
    spans = fence_spans(lines)
    sites: list[Site] = []

    for idx, line in enumerate(lines):
        if idx in dropped:
            continue
        mentioned = []
        for m in RE_TOOL_MENTION.finditer(line):
            tool = m.group(1)
            if tool in tool_map and tool not in mentioned:
                mentioned.append(tool)
        if not mentioned:
            continue
        window = strip_path_tokens(site_window(lines, idx, spans))
        for tool in mentioned:
            residual = [k for k in tool_map[tool] if not key_is_named(k, window)]
            if residual:
                snippet = line.strip()
                if len(snippet) > 110:
                    snippet = snippet[:107] + "..."
                sites.append(Site(path, rel, idx + 1, tool, residual, snippet))
    return sites


# --- main --------------------------------------------------------------------

def discover_markdown(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(root.rglob("*.md"))


def main(argv: list[str]) -> int:
    use_ledger = "--no-ledger" not in argv
    show_list = "--list" in argv

    skills_root = pathlib.Path(
        os.environ.get("SKILL_ARGS_SCAN_ROOT", str(DEFAULT_SKILLS_ROOT))
    )
    components_override = os.environ.get("SKILL_ARGS_COMPONENTS_ROOT")
    components_root = pathlib.Path(components_override or str(DEFAULT_COMPONENTS_ROOT))
    fixture_map = components_override is not None
    if fixture_map:
        # A fixture map has neither the real 75 tools nor the real ledger.
        use_ledger = False

    if not components_root.is_dir():
        print(f"Error: components root not found: {components_root}")
        return 2
    if not skills_root.is_dir():
        print(f"Error: skills root not found: {skills_root}")
        return 2

    try:
        tool_map = build_tool_map(components_root)
    except OSError as exc:
        print(f"Error: cannot read a component file: {exc}")
        return 2

    if not tool_map:
        print(f"Error: no tools with a non-empty `required` found under {components_root}")
        return 2

    if "--dump-tool-map" in argv:
        # Diagnostic: makes Pass A directly assertable (the nested-vs-outer
        # `required` pick, the empty-list exclusion, block bounding) instead of
        # inferring the parser's behaviour from a site count.
        for tool in sorted(tool_map):
            print(f"{tool}: {','.join(tool_map[tool])}")
        return 0

    if not fixture_map and len(tool_map) != EXPECTED_TOOL_COUNT:
        print(
            f"Error: tool -> required map has {len(tool_map)} entries, "
            f"expected {EXPECTED_TOOL_COUNT}.\n"
            "  Arithmetic: 80 `required: [` literals - 4 empty `required: []` "
            "- 1 nested item schema (memory `edges[]`) = 75.\n"
            "  A different number means either the block-bounding / "
            "shallowest-indent rule broke, or a tool was legitimately added.\n"
            "  If a tool was added: bump EXPECTED_TOOL_COUNT *and* re-read the "
            "ledger — a new tool means new, unclassified call sites."
        )
        return 2

    files = discover_markdown(skills_root)
    if not files:
        print(
            f"Error: no skill markdown found under {skills_root}\n"
            "  (Set SKILL_ARGS_SCAN_ROOT to point at a fixture dir, or run "
            "from the repo root.)"
        )
        return 2

    all_sites: list[Site] = []
    for path in files:
        # Key the ledger on the path RELATIVE TO THE SKILLS ROOT, re-prefixed
        # with the canonical `core/skills/`. Deriving it from the scan root
        # rather than the repo root is what lets a checked-in fixture under
        # test/fixtures/ reproduce a real ledger key and so exercise the
        # subtraction and accumulation paths for real.
        rel = "core/skills/" + path.relative_to(skills_root).as_posix()
        try:
            all_sites.extend(scan_file(path, rel, tool_map))
        except OSError as exc:
            print(f"Error: cannot read {path}: {exc}")
            return 2

    unclassified: list[tuple[Site, str]] = []
    classified: list[tuple[Site, str]] = []
    if use_ledger:
        seen: dict[tuple[str, str, tuple[str, ...]], int] = {}
        for site in all_sites:
            entry = LEDGER.get(site.key)
            if entry is None:
                unclassified.append((site, "no ledger entry"))
                continue
            seen[site.key] = seen.get(site.key, 0) + 1
            verdict, expected, _note = entry
            if seen[site.key] > expected:
                unclassified.append(
                    (site, f"ledger count exceeded ({seen[site.key]} > {expected})")
                )
            else:
                classified.append((site, verdict))
    else:
        unclassified = [(s, "") for s in all_sites]

    if show_list and classified:
        print(f"Ledgered sites ({len(classified)}):")
        for site, verdict in classified:
            print(f"  . {site.rel}:{site.line_no}: {site.tool} "
                  f"[{verdict}] missing: {', '.join(sorted(site.residual))}")
        print("")

    if unclassified:
        header = (
            "Skill call sites missing a required argument (TD-324):"
            if use_ledger else
            f"Residual sites ({len(unclassified)}), ledger OFF:"
        )
        print(header)
        for site, reason in unclassified:
            suffix = f"  [{reason}]" if reason and use_ledger else ""
            print(f"  - {site.rel}:{site.line_no}: {site.tool} "
                  f"-> missing: {', '.join(sorted(site.residual))}{suffix}")
            print(f"      {site.snippet}")
        if use_ledger:
            print(
                "\nEach site above names a brain tool but does not name one of its\n"
                "declared-required arguments. Under BR-080 the gateway REJECTS such\n"
                "a call at dispatch, so the step fails instead of degrading.\n"
                "Fix the prose to name the argument, or — if the site is a prose\n"
                "reference or the call is already rejected in-band with a readable\n"
                "message — add it to LEDGER in\n"
                "scripts/validate_skill_required_args.py with a CODE-FACT citation.\n"
                "Do NOT ledger a real regression to silence the gate."
            )
        return 1

    print(
        f"OK: {len(files)} skill markdown files, {len(tool_map)} tools with a "
        f"non-empty `required` — no unclassified call site "
        f"({len(classified)} ledgered)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
