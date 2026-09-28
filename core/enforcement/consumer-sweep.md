---
obligation: "Consumer sweep — re-point every consumer when a mapped contract changes"
mechanism: gate
status: shipped
lives_in: "scripts/check_contract_consumers.sh"
summary: "FR-186 pre-commit checker parses MAINTAINING.md up to its MAP:END marker, WARNs on rename/delete of a distinctive mapped token, and hard-fails on a stale map — a missing, ambiguous or out-of-range citation, an empty glob, or a malformed row; git-ignored citations are classified generated first, so the verdict is the same in every checkout."
---

# Consumer sweep (FR-186)

The FR-186 contract checker is the mechanical layer of the consumer-sweep rule:
it parses `MAINTAINING.md`, scans the staged diff for deletions/renames of mapped
tokens, and surfaces each contract's consumer list. WARN-only on a legitimate
refactor; a stale-map citation is a hard-fail. Backed at planning by the
architect's `## Consumer Sweep` section and at review by warden.

**What the hard-fail covers (TD-334, merging TD-322; TD-313, TD-435, TD-466,
TD-346).** Until TD-334 it covered only `path:line` citations — the RAREST
form — and never looked at the line number. It now classifies every backticked
token in the Consumers column and hard-fails when one that is recognisable as a
repo path does not resolve (including bare paths and globs that match nothing),
when a short form is AMBIGUOUS (more than one tracked path ends with it; every
candidate is named), or when a cited line number is past the end of the file.
The map itself must parse: a row that does not split into five columns (a pipe
inside a cell is written `\|`), a row whose Contract cell registers no
distinctive token, a map row after the `<!-- MAP:END -->` terminator, and a map
with no terminator are all hard-fails too. A git-ignored citation is classified
GENERATED before anything is resolved, so a built tree, a clean clone and a
worktree give the same verdict and the same counts. A line that exists but is
blank or a bare closing delimiter is a WARNING, not a failure. Every skip is
counted and reported, so an exit 0 states what it checked. The one list of
every hard-fail cause is `scripts/check_contract_consumers.sh --help`; the
author-facing version is the "Citation conventions" section (with its "Row
grammar") at the bottom of `MAINTAINING.md`.

**What an exit 0 does NOT cover.** A citation that still points at a real,
non-blank line after its code moved passes: the checker cannot tell whether a
line is the construct the row names. `file#symbol` citations are counted and
reported as NOT checked, and generated paths are never validated. The run prints
this as a `coverage:` line under the summary.

**When the map check runs.** In default (pre-commit) mode the map check runs
ONLY when `MAINTAINING.md` is itself staged; a map problem that keeps rows out of
the token sweep is still announced there as a WARN. `--paths` mode always runs
it; that is the invocation to reach for when you want the map's health as an
answer.
