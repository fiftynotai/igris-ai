---
obligation: "Consumer sweep — re-point every consumer when a mapped contract changes"
mechanism: gate
status: shipped
lives_in: "scripts/check_contract_consumers.sh"
summary: "FR-186 pre-commit checker parses MAINTAINING.md, WARNs on rename/delete of a mapped token, and hard-fails on a stale-map citation — since TD-334 that covers BOTH the bare-path and the path:line form, plus globs and out-of-range line numbers."
---

# Consumer sweep (FR-186)

The FR-186 contract checker is the mechanical layer of the consumer-sweep rule:
it parses `MAINTAINING.md`, scans the staged diff for deletions/renames of mapped
tokens, and surfaces each contract's consumer list. WARN-only on a legitimate
refactor; a stale-map citation is a hard-fail. Backed at planning by the
architect's `## Consumer Sweep` section and at review by warden.

**What the hard-fail covers (TD-334, merging TD-322).** Until TD-334 it covered
only `path:line` citations — the RAREST form — and never looked at the line
number. It now classifies every backticked token in the Consumers column and
hard-fails when one that is recognisable as a repo path does not resolve
(including bare paths, short forms, and globs that match nothing), or when a
cited line number is past the end of the file. A line that exists but is blank
or a bare closing delimiter is a WARNING, not a failure. Every skip is counted
and reported, so an exit 0 states what it checked. Full rules:
`scripts/check_contract_consumers.sh --help`, and the "Citation conventions"
section at the bottom of `MAINTAINING.md`.

**What an exit 0 does NOT prove.** In default (pre-commit) mode the map check
runs ONLY when `MAINTAINING.md` is itself staged. `--paths` mode always runs it;
that is the invocation to reach for when you want the map's health as an answer.
