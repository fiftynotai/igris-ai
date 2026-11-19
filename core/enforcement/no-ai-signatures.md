---
obligation: "A commit message must carry no AI signature: no Generated-with line, no co-author trailer (core/os/standards.md)"
mechanism: gate
status: shipped
lives_in: "scripts/git-hooks/commit-msg"
summary: "TD-470 signature gate, §1b of the commit-msg hook (the TD-470 SIGNATURE GATE block). HARD-FAILS any commit, closing or not, whose message carries at column 0, case-insensitive, after the scissors cut and the col-0 # strip: S1a a Co-authored-by: line in the LAST paragraph (git's trailer block); S1b a Co-authored-by: line with a <user@host> identity anywhere (git parses no trailer when it shares a paragraph with closes #X or sits above one); S2a an emoji (U+1F000-U+1FFFF) followed by Generated with; S2b a line that is entirely Generated with [name](scheme://...). Every co-author trailer is refused, a human pair's included. Exits 1 immediately, silent on pass. One-shot escape via IGRIS_BYPASS_SIGNATURE_GATE, independent of the AC and event gate bypasses in both directions. A second, Claude-Code-only layer prevents the signature: igris init / igris update write attribution {commit:'', pr:'', sessionUrl:false} to ~/.claude/settings.json when no attribution or includeCoAuthoredBy is set. Does NOT cover: --no-verify; a checkout without hooks; commits that skip commit-msg (plain cherry-pick, rebase replays, git am); an indented or quoted signature (deliberate); a col-0 # line and a custom core.commentChar; a bare Generated with X with no emoji and no link, or behind a non-U+1Fxxx symbol."
---

# No AI signatures (TD-470)

`core/os/standards.md` has said "no Generated with…, no Co-Authored-By tags"
for the life of the repo. Until TD-470 it was prose: no gate read a trailer,
and no config told the harness. Two layers now, and they fail differently.

## The two layers, and what each does not cover

| # | layer | surface | posture | does NOT cover |
|---|---|---|---|---|
| L1 | prevention (config) | `cli/src/lib/attribution-settings.ts`, composed by the global writer `cli/src/lib/global-hooks.ts` that `igris init` / `igris update` run | writes Claude Code's `attribution` object form into `~/.claude/settings.json` only when the user set no `attribution` and no `includeCoAuthoredBy` | every harness but Claude Code; a machine where `init`/`update` has not run since TD-470; a project whose own `.claude/settings.json` asks for a byline (it wins by Claude's precedence, on purpose) |
| L2 | mechanical | `scripts/git-hooks/commit-msg` §1b | **HARD-FAIL** | `--no-verify`; a checkout without hooks; commits that skip `commit-msg`; an indented or quoted signature; a col-0 `#` line; a bare `Generated with X` with no emoji and no link |

Config prevents the well-behaved harness from writing the line; the gate
catches every other path (a hand-typed commit, a different harness, a future
model). Neither is sufficient alone.

## Why the gate reads more than git's trailer block

git treats the last paragraph as trailers only when every line is one, or 25%
are and one is git-generated. So `closes #FR-1` followed by a co-author line in
one paragraph parses to **zero** trailers (git 2.50.1, measured 2026-09-24),
and so does a co-author paragraph placed above a `closes` paragraph. S1b reads
the identity form anywhere for that reason; it is the one pinned place where
the gate is a deliberate superset of git (`test/commit_signature_gate.test.bash`
SO1). The false-positive side is bounded by column 0: body prose that QUOTES
the standard mid-line or indented passes (L-1668's class; SC6-SC13).

## Red-first

The gate refused a REAL signed message before it was trusted: igris-ai's own
commit `4aaaf8e` (2025-12-03), snapshotted byte-for-byte at
`test/fixtures/signature-gate/igris-ai-4aaaf8e.msg`. Its first refusal is
quoted in `test/fixtures/signature-gate/README.md`; SN1-SN5 delete the block
or one clause from a copy of the hook and show the matching cases turning
green.

## Escape hatch

`IGRIS_BYPASS_SIGNATURE_GATE=1 git commit ...` — one-shot, never `export`ed.
It is a section skip: the length check, the AC gate and the event gate still
run (SB3, SB4), and their bypasses never silence this gate (SB2). It exists for
a genuine human co-author; the healthy path for an AI line is to delete it.
