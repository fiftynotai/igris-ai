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

## the idea.

most AI coding tools are a smarter autocomplete with memory bolted on. IGRIS inverts it: a persistent operating system the model runs inside.

the model is the CPU. IGRIS is the OS. every session boots it, mounts your project, runs your work — then saves state back, so the next session picks up exactly where you left off.

the payoff is an agent that actually knows your project — its conventions, its decisions, its open work, the mistakes already made — not for one chat, but across every session you run.

## install in three commands.

```bash
npm install -g igris-ai
igris init
cd /path/to/your-project && igris install .
```

`igris init` bootstraps the centralized brain and projects skills, agents, MCP, and hooks globally. `igris install .` is register-only: it records the project in the brain so the global surfaces apply, without copying IGRIS files into your repo.

Restart your harness afterward so it loads the `igris-brain` MCP server, then run `/register feature "first brief"` and `/hunt BR-001`. Install matrix, verification commands, and upgrade paths live in [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md) and [`docs/UPDATE_GUIDE.md`](docs/UPDATE_GUIDE.md).

## the lifecycle.

every session starts with `/boot` and ends with `/rest`. in between, the agent is grounded, not guessing.

`/boot` runs the boot sequence:

- **detect** — the harness (Claude, OpenCode, Antigravity, Codex, Gemini) and its capabilities.
- **boot** — load the OS: who the agent is, how it must operate, what it can do.
- **login** — load who you are and how you work.
- **mount** — pull the brain, restore session state, surface where your work stands: active brief, phase, blockers, what's next.

`/rest` closes the session: it writes your work-state — mode, active brief, next steps, the uncommitted lay of the land — to the brain and syncs it. nothing is a transcript; everything is state.

so a `/boot` in a different harness resumes the actual work, not a summary of it. because the brain syncs to a central store, that state travels across machines too — full cross-machine handoff is the frontier we're proving now (see the edges below).

## grounding.

a fresh model writes generic code. a grounded one writes your code.

`/ground` authors your project's context docs — coding guidelines, architecture map, design system, test standards, API patterns — and the OS consults the right one before it works. the agent follows your conventions and boundaries because they're written down and routed to it, not re-guessed every session.

the brain holds the experience (what worked, what broke, why); the context docs hold the standards. a lesson that hardens into a standard graduates from one to the other. one fact, one home.

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

## the architecture.

IGRIS is built like an OS so it can grow without rotting.

- **layers, not a monolith.** every concern — identity, conduct, capabilities, protocols, memory — is one layer with one job and one way to extend it. adding a skill, agent, harness, or doc-type is a known move, not a refactor.
- **self-describing, self-assembling.** modules declare their own metadata; the OS discovers them and generates its own index. no hand-maintained registry to drift.
- **contract vs. implementation.** what the model reads never names the code behind it, so any mechanism swaps without touching what the agent understands.
- **agnostic core, per-harness adapters.** the skills and the OS are harness-neutral; each harness gets a thin adapter. one behavior, every surface.

that discipline is why the same brief, brain, and lifecycle work identically whether you boot Claude, OpenCode, or Antigravity.

## the cognition layer.

memory you tell it is half the story. the cognition layer is the other half — memory the OS infers.

it's a host that runs small, single-purpose instances. each one observes the brain and proposes something for you to review. one job each:

- **perception** — reads your session transcripts, proposes the learnings worth keeping.
- **subconscious** — reads the brain's state, surfaces suggestions: a stalled brief, a gap, a pattern worth acting on.
- **synapse** — infers the relationships between learnings and draws the edges.
- **janitor** — finds near-duplicate learnings and proposes the merge.
- **arbiter** — catches two learnings that contradict and resolves which one wins.
- **curator** — flags learnings that have gone stale and proposes pruning them.
- **cartographer** — clusters related learnings and distills each cluster into one meta-learning.

nothing here writes to your memory behind your back. every instance proposes; you approve. the OS sharpens itself while you're away — you stay in control of what it learns.

and the layer is open. a new instance is a new self-describing file; the host doesn't change. teaching the OS a new kind of reflection is the same move as adding a skill or an agent — drop it in, it's discovered, it runs.

it ships **off by default** — nothing is observed until you turn it on. enable the instances you want in `~/.igris/config.json` (`cognition.<instance>.enabled: true`); the flags, budgets, and review-gate knobs are documented in [`docs/COGNITION.md`](docs/COGNITION.md).

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
