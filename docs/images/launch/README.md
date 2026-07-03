# Launch Assets

This directory is reserved for public launch media used by the README and storefront docs.

## FR-175 cross-harness handoff asset

**README asset:** `docs/images/launch/fr175-cross-harness-storyboard.gif`

**Status:** screenshot handoff storyboard. This is not the original screen
recording and is not the B2/G-14 proof asset.

The current README asset is a two-still storyboard generated from
operator-provided FR-175 screenshots:

- `fr175-claude-limit.png` — Claude stopped at the weekly limit after settling
  FR-175 and prompting `/hunt FR-175`.
- `fr175-codex-boot-recommendation.png` — Codex `/boot` surfaced `/hunt
  FR-175` as the recommended action from the shared work state.

Generated asset:

```bash
ffmpeg -y \
  -loop 1 -t 2.5 -i docs/images/launch/fr175-claude-limit.png \
  -loop 1 -t 2.5 -i docs/images/launch/fr175-codex-boot-recommendation.png \
  -filter_complex "[0:v]scale=760:-1:force_original_aspect_ratio=decrease,pad=760:1000:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1[v0];[1:v]scale=760:-1:force_original_aspect_ratio=decrease,pad=760:1000:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1[v1];[v0][v1]concat=n=2:v=1:a=0,fps=1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  docs/images/launch/fr175-cross-harness-storyboard.gif
```

One local media candidate from the B2 period was inspected and found to be only
a 1.5 second logo animation, not a usable session recording. It must not be
used as evidence for the B2 handoff.

## Evidence

The B2/G-14 evidence lives in:

`~/.igris/projects/igris-ai/plans/feature-map/evidence/b2-test-plan.md`

Summary from that evidence:

- Passed on 2026-06-16.
- Crossed four vendors: Claude -> OpenCode -> Codex -> Antigravity.
- Proved mid-workflow, zero-context resume.
- Included crash recovery, held-claim refusal, force-reclaim, quality gates, and final recovery.
- Remaining frontier: cross-machine hop via VPS sync.

If an original B2/G-14 screen recording is captured later, keep this storyboard
as supplemental illustration or replace the README embed with the recording. Do
not relabel this storyboard as a recording or as B2 proof.
