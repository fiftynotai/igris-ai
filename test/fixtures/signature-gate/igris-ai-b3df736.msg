fix(prompts): igris_os.md line 58 — "Claude Code subagents" → "harness subagents"

Surfaced by SEEKER investigation after Gemini (running /content-pipeline)
misidentified itself as Claude. Line 58 of igris_os.md — globally loaded
by every harness at /awaken startup — hardcoded "IGRIS v7.0 uses native
Claude Code subagents" which Gemini interpreted as an identity assertion.

Single-word substitution to harness-neutral terminology. "harness" is
the existing internal vocabulary (FR-124/FR-125 multi-harness
distribution layer) and the preceding section header
"Multi-Agent Architecture (v7.0)" already frames the term correctly.

This is the OS-level identity leak. The content-pipeline SKILL.md
identity assertions (lines 2/7/9 + 56/67) were already fixed inline
on 2026-06-01 by editing source + re-vendoring via
`igris registry update content-pipeline`.

Remaining "Claude Code" mentions in igris_os.md:
- Lines 187/193/241: /team paragraphs (Claude-Code-only feature today)
  — owned by TD-204
- Line 727: "DO NOT add 'Generated with Claude Code' footers" rule
  — intentional keep (names Claude only to forbid Claude branding)

Tests: bats 211/211 ok; cli vitest 557 pass / 1 fail (TD-140
pre-existing, unrelated). TD-096 runtime mirror verified MATCH.

closes #TD-203
