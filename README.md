# IGRIS

they resume your chat — IGRIS resumes your work.

the engineering OS for AI coding agents: cross-harness work-state handoff, enforcement-as-code, and one brain across every harness.

---

## ai made coding faster. it did not make it better.

you shipped a 2000-line pr because nothing stopped you. your context reset mid-task and you rebuilt from scratch. three sessions prompted the same fix because nobody tracked who was doing what.

speed without structure is not engineering. it is chaos with better autocomplete.

IGRIS is the workbench around the model. it makes the brief the contract, makes the phase explicit, makes ownership atomic, and makes every write pass through gates the agent cannot talk its way around.

## what IGRIS adds.

| Spearhead | What changes |
|-----------|--------------|
| Cross-harness work-state handoff | A new harness resumes the actual work state: brief, phase, atomic claim, instance identity, supersession lifecycle, working tree, and agent log. |
| Enforcement-as-code | Brief-first write gates, role tool restrictions, test phases, and review phases are installed as executable workflow constraints. |
| One brain across every harness | SQLite + FTS5 at `~/.igris/memory/knowledge.db` stores briefs, sessions, plans, learnings, claims, and sync state for every registered project. |

First-class harnesses: Claude Code, OpenCode, and Antigravity. Codex and Gemini CLI are supported bridges.

Cursor remains an onboarding target, not a shipped surface.

## install in three commands.

```bash
npm install -g igris-ai
igris init
cd /path/to/your-project && igris install .
```

`igris init` bootstraps the centralized brain and projects skills, agents, MCP, and hooks globally. `igris install .` is register-only: it records the project in the brain so the global surfaces apply, without copying IGRIS files into your repo.

Restart your harness afterward so it loads the `igris-brain` MCP server, then run `/register feature "first brief"` and `/hunt BR-001`. Install matrix, verification commands, and upgrade paths live in [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md) and [`docs/UPDATE_GUIDE.md`](docs/UPDATE_GUIDE.md).

## the flagship proof.

On 2026-06-16, B2/G-14 passed across four vendors: Claude -> OpenCode -> Codex -> Antigravity. A hunt was interrupted mid-workflow, resumed zero-context in the next harness, picked up at the recorded phase, ran the missing tests, and preserved crash recovery plus force-reclaim behavior.

That proof matters because IGRIS did not hand off a transcript. It handed off work-state: the brief, the phase, the claim, the instance, the supersession lifecycle, and the uncommitted code.

The visual below is a later FR-175 handoff storyboard that shows the same class of failure: Claude stopped at a weekly limit after settling the next brief, then Codex booted and recommended that exact brief.

![FR-175 cross-harness handoff storyboard](docs/images/launch/fr175-cross-harness-storyboard.gif)

The storyboard uses two stills, not the original operator screen recording, and it is not the B2/G-14 proof asset. Provenance is tracked in [`docs/images/launch/README.md`](docs/images/launch/README.md).

## the core workflow.

`/hunt` runs the pipeline end-to-end. architect plans, forger builds, sentinel tests, warden reviews, orchestrator commits. one command. bounded roles.

```text
$ /hunt TD-161

[architect]  planning  · plan written to ~/.igris/projects/igris-ai/plans/TD-161-plan.md
[forger]     building  · core/SOUL.md edited · mirror cp ~/.igris/core/SOUL.md
[sentinel]   testing   · verify_mirror.sh -> verdict: MATCH (1 pair, 0 mismatch)
[sentinel]   testing   · git grep "Crimson" -- ':!docs/archive/' ':!CHANGELOG.md' -> 0 matches
[warden]     reviewing · brand canon audit · IGRIS-native register restored · APPROVE
[orchestrator] CHANGELOG.md amended in place · TD-160 bullet refined with TD-161 note

result: ready for commit · 1 file changed · 0 retries · PASS
```

## essential skills.

| Need | Skills |
|------|--------|
| Start and end grounded work | `/boot`, `/rest` |
| Create, run, inspect, and close briefs | `/register`, `/hunt`, `/scan`, `/archive` |
| Capture and harden reusable knowledge | `/harvest`, `/promote` |
| Reuse proven assets before rebuilding | `/reuse` |
| Generate project context docs | `/ground` |
| Sync code or brain data | `/sync` |

## why not just compose other tools?

You can get pieces of this elsewhere: spec-first planning, shared rule files, agent memory, and lightweight checkpointing. That stack is real, useful, and often enough.

IGRIS is for the failure mode where pieces are not enough: multiple harnesses, multiple sessions, mid-workflow interruption, write enforcement, stale claims, crash recovery, cross-project memory, and sync all need one lifecycle. The detailed comparison is in [`docs/substitution.md`](docs/substitution.md).

## the unfinished edges.

- Agent teams (`/team hunt`) remain experimental. Parallelism works; the ergonomics are still being hardened.
- Resume path was proven in B2, but deterministic phase entry is still being tightened so every harness follows the same skip/re-walk behavior.
- Cross-machine B2 is the next frontier; same-machine cross-harness is proven.
- Some brain components are mature and heavily used. Others are intentionally parked until a real workflow needs them.

## three doors.

- build log -> [fifty.dev/journal](https://fifty.dev/journal)
- the repo -> [github.com/fiftynotai/igris-ai](https://github.com/fiftynotai/igris-ai)
- the license -> [mit](LICENSE)
