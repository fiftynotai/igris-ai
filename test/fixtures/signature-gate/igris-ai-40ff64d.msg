chore(config): enforce the no-AI-signature standard in settings

core/os/standards.md:27 has required "No AI signatures — no 'Generated
with…', no Co-Authored-By tags" for the life of the repo, and the last
50 commits honour it. Nothing enforced it. The harness injects its own
attribution reminder, and on 2026-09-24 it arrived in the variant that
claims to replace earlier guidance, so the standard held only because
the agent chose to follow it over a live instruction to the contrary.

Claude Code 2.1.269 fixed that reminder deferring to a CLAUDE.md or
memory rule, and this machine runs 2.1.281 — but the rule lives in
~/.igris/core/os/standards.md, loaded through /boot. That is neither a
CLAUDE.md nor a harness memory rule, so the precedence check never saw
it. Igris's OS text is invisible to the harness's own rules; config is
the only channel that carries.

The object form is deliberate over the scalar `false`. The schema's own
description says older versions reject a bare boolean here and to use
the object in settings shared across versions, and this file is tracked
— it travels to other machines and other CLI builds. `commit: ""` is
not merely empty text: the resolver reads `attribution.commit === ""`
as the off-switch and returns "disabled". `includeCoAuthoredBy` is the
deprecated predecessor (superseded in 2.0.62) and is not used.

Scope is this repo plus a matching block written to ~/.claude/settings
.json, which is untracked. Igris does NOT propagate this to registered
projects: cli/src/lib/json-merge.ts:19-20 states its contract as hooks
only, "NO other top-level key is touched", naming includeGitInstructions
as a key it preserves but never writes. A project registered on a fresh
machine inherits the hooks and none of this posture — which collides
with the machine-agnostic principle. TD-470 owns that gap, and the gate
that would refuse a trailer no config ever sees.
