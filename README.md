# IGRIS

the engineering workbench for claude code.

build everything possible, but architect it first.

---

## ai made coding faster. it did not make it better.

you shipped a 2000-line pr because nothing stopped you. your context reset mid-task and you rebuilt from scratch. three sessions prompted the same fix because nobody tracked who was doing what.

speed without structure is not engineering. it is chaos with better autocomplete.

---

## claude writes. IGRIS decides what gets written.

claude writes. IGRIS decides what gets written, by whom, and whether it ships. it is hierarchical actor-critic with bounded iteration. metagpt split the roles. self-refine ran the loop. we did both, then made the brief a contract. it is not the model. it is the workbench around it — the brief-protocol that gates every write, the brain that survives your context reset, the seven agents with tool restrictions that mean a planner cannot implement and a reviewer cannot fix.

every file modification routes through a brief. every brief routes through a plan. every plan routes through a role. nothing ships because the prompt sounded confident.

---

## watch one hunt.

`/hunt` runs the pipeline end-to-end. architect plans, forger builds, sentinel tests, warden reviews, orchestrator commits. one command. real output below.

```text
$ /hunt TD-161

[architect]  planning  · plan written to ~/.igris/projects/igris-ai/plans/TD-161-plan.md
[forger]     building  · core/SOUL.md edited · mirror cp ~/.igris/core/SOUL.md
[sentinel]   testing   · verify_mirror.sh → verdict: MATCH (1 pair, 0 mismatch)
[sentinel]   testing   · git grep "Crimson" -- ':!docs/archive/' ':!CHANGELOG.md' → 0 matches
[warden]     reviewing · brand canon audit · IGRIS-native register restored · APPROVE
[orchestrator] CHANGELOG.md amended in place · TD-160 bullet refined with TD-161 note

result: ready for commit · 1 file changed · 0 retries · PASS
```

---

## three weapons.

the architect plans. the forger builds. the sentinel tests. the warden reviews.

the architect cannot write files. the reviewer cannot fix what it rejects.

### brief-protocol

every file modification requires a tracked brief. no brief, no write. briefs carry priority, acceptance criteria, test plan, lifecycle state. nine types cover the engineering surface — bug, feature, tech debt, migration, testing, process, dependency, performance, architecture. read-only work is brief-free. anything that writes a file is gated.

### the brain

one sqlite database at `~/.igris/memory/knowledge.db`. wal mode, fts5 search, served through the `igris-brain` mcp server. it remembers across projects, sessions, and context resets. when your session dies mid-hunt, the brain tells the next session which brief was active, which phase it was in, and which retry it was on.

### tool-enforced roles

architect has `read, grep, glob`. it cannot write. warden has the same constraint. this is not a prompt instruction the model can rationalise its way around — it is the tool list in the agent definition. the planner plans. the reviewer reviews. nobody negotiates.

---

## install in three commands.

```bash
npm install -g igris-ai
igris init
cd /path/to/your-project && igris install .
```

the `igris-brain` mcp server is bundled inside the `igris-ai` npm package — `igris init` registers it into all 4 supported harnesses (claude, gemini, codex, opencode) for you, no separate clone-build step. restart your harness afterward so it loads the new server, then run `/hunt BR-001` against the first brief you register. install matrix, channels, and v6 upgrade paths live in [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md) and [`docs/UPDATE_GUIDE.md`](docs/UPDATE_GUIDE.md).

---

## the unfinished edges.

- agent teams (`/team hunt`) requires an experimental claude code flag. parallel works. quality gates work. the ergonomics are still rough.
- cross-cli adapters are on the roadmap. today, IGRIS is built for claude code.
- the comparison table got cut from this readme on purpose. a v2 pass is parked.
- the brain has 17 mcp components. some are heavily used. some are waiting for their first real call.

---

## three doors.

- build log → [fifty.dev/journal](https://fifty.dev/journal)
- the repo → [github.com/fiftynotai/igris-ai](https://github.com/fiftynotai/igris-ai)
- the license → [mit](LICENSE)
