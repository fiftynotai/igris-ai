---
name: boot
tier: essential
description: Start or resume session - loads state and continues work
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__igris-brain__igris_session_file_update
  - mcp__igris-brain__igris_instance_remove
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_suggestion_list
  - mcp__igris-brain__igris_perception_review_pending
  - mcp__igris-brain__igris_memory_recall
  - mcp__igris-brain__igris_session_recall
  - mcp__igris-brain__igris_project_status
  - mcp__igris-brain__igris_project_register
triggers:
  - "BOOT"
  - "AWAKEN"
  - "start session"
  - "resume session"
---

# BOOT - Start/Resume Session

Initialize Igris AI and resume any pending work.

## Execution

### 1. Detect — L0

Run the detection verb first and read its JSON digest:

```bash
igris detect
```

The digest is the lifecycle handoff from the environment into Boot:

```jsonc
{ "harness": "claude|codex|gemini|opencode|antigravity|cursor|unknown",
  "project_slug": "igris-ai",
  "project_path": "/abs/project/path",
  "brain_root": "~/.igris",
  "brain_db": true,
  "sqlite3": true,
  "remote_brain": true,
  "mode": "full|degraded-no-db|degraded-no-remote" }
```

Carry these fields forward:
- `detect.harness` selects the harness-specific OS context file in §2.
- `detect.project_slug` is the `<slug>` used by Mount verbs below.
- `detect.project_path` is the absolute project path passed to `session register`.
- `detect.brain_root` is the runtime brain root for context reads.
- `detect.mode` / booleans drive degraded notices only; detection never blocks boot.

### 2. Boot — L1 OS Core

Read `<detect.brain_root>/core/os/INDEX.md` first — this is the **module map** for what context to load. There is no monolith to slice: each row is a self-contained module, and the modules ARE the sections.

1. Read `<detect.brain_root>/core/os/INDEX.md`
2. From the module table, load every module whose `tier` is `boot` except `USER` — read each from `<detect.brain_root>/core/os/<module>.md`. The `SOUL` row lives at `<detect.brain_root>/core/SOUL.md`; the `USER` row is visible in the map but is deferred to Login (§3).
3. Read all resolved modules silently. `on-demand` / `reference` modules are NOT loaded here — pull them later when their `consult_when` fires.
4. From the `Harness-specific roster`, if a row's `harness` equals `detect.harness`, read `<detect.brain_root>/core/os/<file>` for that row. If no row matches, this is a clean no-op (native-static harnesses need no file; `unknown` is not an error).

**Always-needed files** (boot mechanics, not context modules):
- `<detect.brain_root>/config.json` - Remote brain URL and API key

**Degradation:** if `<detect.brain_root>/core/os/INDEX.md` is absent, fall back to reading `<detect.brain_root>/core/SOUL.md` + `<detect.brain_root>/USER.md` + `<detect.brain_root>/config.json`, display one short degraded-context notice, and continue — never block session start.

### 3. Login — L2 Operator

Read `<detect.brain_root>/USER.md`. This is the Login layer: the machine-home operator profile and preferences. It is distinct from Boot's OS core so the operator layer can vary per machine without being shipped as core OS content.

### 4. Mount — L3 Remote Sync

Mount starts with the remote channel so restored session files are visible before handoff selection. Run the boot-sync verb and read its JSON digest:
```bash
igris boot-sync --project <detect.project_slug>
```

**The boot-sync digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,                              // true ⟺ remote unconfigured
  "brain_pull":  { "ok": true, "summary": "5 learnings, 2 errors" },
  "queue_drain": { "ok": true, "drained": 3 },
  "session_files_pulled": 2,                       // session_files rows merged from the pull
  "definitions_updated": { "agents": 1, "skills": 0, "rules": 2, "prompts": 0 },
  "skipped": [] }                                  // one-line reasons any part was skipped
```

**Display from the digest:**
- `brain_pull.summary` → "Pulled {summary} from remote brain" (when `brain_pull.ok`).
- `queue_drain.drained` → "Drained {n} queued sync op(s)" (when `> 0`).
- `session_files_pulled` / `definitions_updated` → optional one-line restore/refresh summary.
- `skipped[]` → surface each as a one-line notice (e.g. "Brain pull skipped (remote unconfigured)").

**Degradation:** the verb ALWAYS exits 0 and NEVER blocks session start. When `degraded: true` (remote unconfigured) or any part fails (`ok: false`, recorded in `skipped[]`), display the one-line notice and continue — a missing/unreachable remote is a local-only run, not an error. Each part is independent: a failed pull does not abort the drain or vice-versa.

> **What replaced what (FR-195):** boot-sync subsumes the former §3.6 (`igris_brain_pull`), §3.6.1 (`igris_sync_queue_drain`), §3.6.1.1 (`igris sync data` local drain), §3.6.2 (`igris_session_file_pull`), and §3.6.3 (`igris_definition_pull`) — five separate MCP/CLI calls collapsed into one verb. The `_pull` (VPS→local restore) vs `_list` (state-aware local enumerate) distinction that mattered when the skill called both is now internal: this Mount step owns the `_pull` side (restore), and §4.1 gather owns the `_list` side (classification). They no longer share a call site to conflate.

### 4.1 Mount — Load Session State / Gather

The session model is **per-instance** (see `session_protocol.md`): every instance owns one `session/instances/<instance_id>.md` file, keyed by its `instance_id`. There is no shared `CURRENT_SESSION.md`. `/boot` does NOT read a single fixed file — it *gathers*: it enumerates the project's session files + the live instance registry, classifies each file (the Lock-2/3 truth table), and picks THE handoff. As of FR-195 the entire enumerate→classify→pick algorithm is OWNED by the `igris session gather` verb — the skill does not re-derive it.

Run the gather verb and read its JSON digest:
```bash
igris session gather --project <detect.project_slug> [--self-instance-id <recovered-id>]
```
- `--self-instance-id` is OPTIONAL — pass it only if THIS harness can locate its own prior per-instance file (an `instance_id` persisted in the harness's working dir / `$CLAUDE_PROJECT_DIR` heuristics, the G4 chicken-and-egg). The common case omits it; the verb leaves `self_instance_id: null` and §4.4's registration mints a fresh id. Gather is an *observer* — it never mints, never writes a session file (Lock-2 "nothing destructive in gather").
- The verb does ALL the classification: it enumerates `session_files` + the live `instances` registry, applies the Lock-2/3 truth table (LIVE SIBLING / ABANDONED LIVE / GENUINE HANDOFF), handles the FR-133 legacy `CURRENT_SESSION.md`-adoption fall-through, picks the newest GENUINE HANDOFF, and fetches content for THAT one only.

**The gather digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "handoff": {                  // null when fresh_start (no genuine handoff)
    "instance_id": "…|null",    // null for a legacy CURRENT_SESSION.md row
    "filename": "instances/<id>.md|CURRENT_SESSION.md",
    "mode": "REST MODE|null",   // the handoff file's **Mode:** line
    "resume_point": "…",        // feeds §5's resume display
    "next_steps": "…",          // seeds §4.4's LIVE file (resume carry-forward)
    "is_legacy": false },       // FR-133 legacy-adoption flag
  "self_instance_id": "…|null", // recovered (G4) else null → §4.4 mints
  "siblings":  [{ "instance_id": "…", "current_brief": "…|null", "last_active": "…" }],
  "crashed":   [{ "instance_id": "…", "last_active": "…", "scratchpad": "session/…" }],
  "fresh_start": false }        // true ⟺ handoff is null
```

**What the digest means for display (G5):**
- `handoff.resume_point` / `handoff.next_steps` → feed §5's resume display (only when `handoff.mode == "REST MODE"`; see §5).
- `siblings[]` → render a one-line-per-entry "Active siblings" list ("instance {short_id} ({liveness_status}) on {current_brief}, last activity {last_active}"). Same-machine `alive` is process-proof; `unknown_remote` / `unknown_no_metadata` is a coordination fallback, not a liveness proof.
- `crashed[]` → render a one-line-per-entry "Crashed scratchpads" list ("instance {short_id} crashed mid-session — scratchpad at {scratchpad}"). This is the ABANDONED LIVE surface (§4.3.1 below is the same set — display only, NEVER destructive: no auto-archive, no ownership clear; Lock 1).
- `self_instance_id` → carry to §4.4 (recovered id to reuse, or null to mint).

All gather output is **display-only** — nothing destructive happens. The verb writes nothing to `session_files` and no longer treats activity age as liveness.

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, "fresh_start": true, "handoff": null, … }` and exits 0 — treat it as a fresh start (no resume). NEVER block session start on a degraded gather.

**Ordering contract:** boot-sync MUST run before gather, and gather MUST run BEFORE §4.4 register and BEFORE §4.5 housekeeping. The verbs are separate processes and do NOT enforce cross-process order — the skill's call sequence (boot-sync → gather → register → housekeeping → assess) is the contract. H0's Lock-2 "the legacy row was provably read before it is archived" holds ONLY because this skill ran gather before housekeeping.

### 4.2 Display Persona Greeting

Use the persona (from `SOUL`) loaded in §2 and user config (from `USER.md`) loaded in §3:
```
[PERSONA GREETING FROM soul context]

My capabilities:
- Brief management, session recovery, architecture enforcement
- Quality gates, protocol enforcement
```

### 4.2.1 First-run Welcome (FR-235)

A one-time orientation for a brand-new install. Verb-driven and harness-agnostic — ZERO per-harness branches.

Run the onboarding-status verb:
```bash
igris onboarding status --json
```
It prints `{ "completed": <bool>, "boot_welcomed": <bool>, "first_run": <bool> }`. `first_run` is `!completed`.

- **If `first_run == true` AND `boot_welcomed == false`:** render the compact Welcome, then mark it shown so it never repeats:
  ```
  Welcome to IGRIS — an AI engineering OS that runs on your harness.
  It turns intent into shipped work through a simple loop:
    register (capture the work) → hunt (build it, tested + reviewed) → rest (bank the session).

  New here? Run /setup for a 2-minute guided first hunt.
  ```
  Then run:
  ```bash
  igris onboarding welcomed
  ```
- **Else** (returning user, or the Welcome already rendered once): render NOTHING. Returning boots are silent here.
- If `igris onboarding status` is unavailable or errors (older CLI, degraded shell), degrade silently — render nothing, never block session start.

### 4.3 Query Brain for Context (Optional)

If the `igris-brain` MCP server is available:
- Call `igris_memory_recall` with `project` = the current project slug and
  `context` = "session start, current project priorities". Both are REQUIRED — a
  call omitting either is rejected at the gateway (BR-080).
- Display any relevant cross-project learnings to the user
- Refresh `last_session_at` for this project. **Read first, then register** —
  never register from the detect digest alone:
  - Call `igris_project_status` with `slug` = the current project slug to read
    the existing record. If it reports the project is not registered, SKIP this
    refresh entirely: `/boot` does not mint project records.
  - **If the read fails, is unavailable, or you cannot obtain a `Name:` value
    for any reason, SKIP the refresh.** Do not proceed to register. A missing
    read is the one state where inventing a slug-derived name is the path of
    least resistance, and that is precisely the loss this step exists to
    prevent. A stale `last_session_at` is harmless; a clobbered project record
    is not.
  - Otherwise call `igris_project_register` echoing back what you just read:
    `slug` = the current project slug, `name` = the `Name:` value, `path` = the
    `Path:` value, and `tech_stack` = the `Tech Stack:` value. `slug`, `name`
    and `path` are REQUIRED — a call omitting any is rejected at the gateway
    (BR-080).
  - **`Tech Stack: (none)` is a RENDERING, not a value.** `igris_project_status`
    prints `(none)` when the column is empty, so echoing that string literally
    would write `(none)` into the column. When the read shows `(none)`, omit
    `tech_stack` from the call.
  - Do NOT substitute the slug for `name`, and do NOT invent `path` or
    `tech_stack`. `igris_project_register` is an UPSERT keyed on `slug`, and its
    conflict arm overwrites `name`, `path` AND `tech_stack` with whatever you
    pass — **only `archetype` is `COALESCE`d**. The handler binds
    `args.tech_stack ?? ''`, so a call that omits `tech_stack` writes an EMPTY
    STRING over it, not a no-op.
    The detect digest carries neither a name nor a tech stack, so registering
    from it would overwrite the operator's curated project name with a slug and
    blank their tech stack on EVERY session start. `tech_stack` is curated data
    — `/harvest` writes it and `/ground` and `/scan` read it as half the project
    profile that drives context-doc `applies_when` matching.
    Echoing back what you just read is what makes this refresh safe.
    TD-365 is the handler-side fix that would make this echo unnecessary.
- Call `igris_session_recall` with days=2 to see recent cross-project activity
- If sessions returned, display a "Cross-Project Context" section:
  ```
  ### Cross-Project Context (last 48h)
  - project-a: Worked on BR-012 (auth fix), BUILDING phase
  - project-b: Completed FR-005 (dark mode)
  ```
- This gives a "welcome back" overview across all projects

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 4.3.1 Surface Stale Previous Instances (Mandatory)

Per Lock 1, liveness is **display-only** and NOTHING auto-destroys a stale or dead instance. This section is a *display* of crashed/reclaimable scratchpads — it does NOT remove anything.

A clean `/rest` → `/boot` cycle leaves nothing stale: `/rest` already calls `igris_instance_remove` in its §2.5 "Close Instance Ownership" step, so the prior instance is gone from the registry by the time `/boot` runs. What this section surfaces is the *genuine crash* case — an instance that exited without `/rest`.

This is purely a display of the `crashed[]` list the §4.1 `igris session gather` digest ALREADY computed (the ABANDONED LIVE set — `state='live'` with an absent owner or a same-machine owner proven dead by PID/start-time). No new tool call is needed; the verb did the classification.

- For each entry in `gather.crashed[]`, surface it: "reclaimable, unconfirmed — instance {short_id}, liveness {liveness_status}, last activity {last_active}; scratchpad at {scratchpad}".
- Do NOT call `igris_instance_remove`. Do NOT auto-archive its file. Do NOT clear its `current_brief`. Reclaim is an explicit operator action — never automatic.

If `gather` was degraded (empty `crashed[]`), render nothing. Do NOT block session start.

This is a read of genuine crashes, not a destructive sweep. Multi-instance is valid; a live sibling is left alone (it shows in the §4.1 "Active siblings" list from `gather.siblings[]`, not here).

### 4.4 Mount — Register Instance (Mandatory)

Registration — the instance metadata upsert + the LIVE per-instance file write — is OWNED by the `igris session register` verb (FR-195, extended by FR-190). It mints-or-recovers the `instance_id`, writes the instance row with harness/PID/start-time metadata when available, and writes `session/instances/<id>.md` at `state='live'` with the contract line shape (`**Instance ID:**`, `**Mode:** Active`, `**Active Brief:**`) that the phase-guard fallback and `/hunt` parse. It seeds the LIVE file's "Next Steps" from gather's chosen handoff so the resume context carries forward.

Run the register verb AFTER §4.1 gather (the ordering contract — gather's outputs feed register):
```bash
igris session register --project <detect.project_slug> \
  [--self-instance-id <gather.self_instance_id>] \
  [--project-path <detect.project_path>] \
  [--seed-next-steps "<gather.handoff.next_steps>"]
```
- `--self-instance-id` — pass `gather.self_instance_id` when it was recovered (non-null); OMIT it to mint a fresh UUID. (This is the G4 recover-or-mint decision, now resolved by gather + register together.)
- `--seed-next-steps` — pass `gather.handoff.next_steps` when gather selected a genuine handoff (the resume carry-forward from §4.1). Omit on a fresh start.
- `--project-path` — the absolute project directory (the instance row's `project_path` field).

**The register digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "instance_id": "…",                  // recovered or freshly minted
  "minted": true,                       // false ⟺ an existing id was recovered+refreshed
  "live_file": "instances/<id>.md",     // relative to the project session dir
  "seeded_from_handoff": true }         // true ⟺ Next Steps were carried from gather's handoff
```

- Display: "Instance registered: {instance_id}".
- Carry `instance_id` forward — it is used for subsequent `igris instance state` work-lease updates (`/hunt`) and the ownership-close on `/rest`, and it is the `<instance_id>` §7 confirms the LIVE file for.
- The register verb is non-destructive (#230): a re-run of a recovered instance PRESERVES the existing on-disk LIVE file (it does not clobber the running instance's scratchpad back to a skeleton).

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, … }` and exits 0 — display "Instance registration skipped (brain unavailable)" and continue. NEVER block session start.

### 4.5 Mount — Housekeeping Sweep (Mandatory)

The crash-robust, idempotent archive sweep (H0–H3) is OWNED by the `igris housekeeping` verb (FR-195). It is NOT a daemon, NOT scheduled — it runs once per `/boot`, AFTER gather (§4.1) and AFTER registration (§4.4), BEFORE the assessment surface (§4.6). The verb's H0–H3 are individually crash-robust and idempotent; running it twice is harmless and a crash mid-sweep leaves a consistent state (Lock 4 — `session_protocol.md` §5). The header-presence guard (idempotency) and per-file append-then-delete (crash-robustness) are the exact atomicity contracts that "cannot be enforced from a skill recipe" — which is why this is CODE, not inline markdown.

Run the housekeeping verb (the ordering contract requires it AFTER boot-sync + gather + register):
```bash
igris housekeeping --project <detect.project_slug>
```

What the verb does (faithful to the prior inline H0–H3):
- **H0** — retire the legacy `CURRENT_SESSION.md` row (`instance_id IS NULL`) that gather provably read this `/boot`: flip its DB state to `archived` (content carried through unchanged, instance_id untouched) and move `session/CURRENT_SESSION.md` → `session/archive/CURRENT_SESSION-<updated_at>.md`. The Lock-2 "read-before-archive" invariant holds because the skill ran gather FIRST (the ordering contract).
- **H1** — RESTED → ARCHIVED supersession (the ONLY steady-state archiving): a `rested` file is archived only when a *newer* `rested` file from a *different* instance proves it was consumed. An ABANDONED LIVE file is NEVER archived here.
- **H2** — roll individual `session/archive/*.md` files older than 30 days into `session/archive/<YYYY-MM>.md` month digests (header-guarded, append-then-delete).
- **H3** — 150-file ceiling burst valve: if >150 individual files remain after H2, roll oldest-first into month digests until ≤150.

**The housekeeping digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "h0_legacy_retired": false,           // true ⟺ the legacy CURRENT_SESSION.md was retired this run
  "h1_archived": ["<id>-<ts>.md"],      // archive filenames produced by the supersession step
  "h2_rolled": 4,                        // individual files folded by the 30-day roll
  "h3_ceiling_rolled": 0,                // individual files folded by the 150-ceiling valve
  "noop": false }                        // true ⟺ nothing was touched (the common fresh-archive case)
```

- Display only when something happened: e.g. "Archived {h1_archived.length} superseded session(s); rolled {h2_rolled} into month digests." When `noop: true`, render nothing.

**Cost guard (preserved):** the verb touches ONLY `session/archive/` + the RESTED set + the one legacy row — NEVER LIVE files, NEVER the brief DB, NEVER the VPS. A fresh install with an empty archive is one list query + an empty dir read; `noop: true`.

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, "noop": true, … }` and exits 0 — there are no session files to sweep on a fresh start. NEVER block session start.

### 4.6 Mount — Perform System Assessment

The MINIMAL system-assessment surface — brief-status summary + active blockers + git snapshot + active-instance count + upcoming goals — is OWNED by the `igris assess` verb (FR-195, decision D-A). It does the brief-dashboard summary SQL, reads `session/BLOCKERS.md`, runs `git status`, counts live instances, and lists goals due within 14 days. It DELIBERATELY OMITS suggestions (§4.10) and perception pending (§4.11) — those re-introduce ceremony noise and stay as the skill's own surfaces below; assess does not cover them.

Run the assess verb and render from its JSON digest:
```bash
igris assess --project <detect.project_slug>
```

**The assess digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "briefs": { "total": 42, "by_status": { "Ready": 8, … }, "by_priority": { "P0": 1, … } },
  "blockers": ["…"],                          // active blockers from session/BLOCKERS.md
  "git": { "branch": "develop", "dirty": true, "ahead": 0 },
  "active_instances": 3,
  "goals_upcoming": [{ "goal_id": "GL-003", "title": "…", "deadline": "2026-05-01", "priority": "P1" }] }
```

Render the assessment from the digest:
- `briefs.by_status` / `briefs.by_priority` → identify Ready briefs to work on (feeds §6 recommendations); show the aggregate counts.
- `blockers[]` → surface active blockers (if any).
- `git` → "On {branch}{, dirty}{, ahead N}".
- `active_instances` → "Active Instances: {n}".
- `goals_upcoming[]` → see §4.9 (the goals surface is now part of this digest).

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, "briefs": {total:0,…}, "goals_upcoming": [], "active_instances": 0, … }` and exits 0 — it STILL reads `blockers` + `git` (those do not need the DB). NEVER block session start.

### 4.7 Mount — Context-Doc Presence Nudge (FR-209)

The project-context-docs presence check is a SOFT nudge, not a gate. It is owned
by the shared CLI primitive; `/boot` only renders the short signal.

Run:

```bash
igris context-docs inventory --project <detect.project_slug> --json 2>/dev/null || true
```

Read only these fields from the JSON digest:

```jsonc
{ "degraded": false,
  "missing_applicable": ["api_pattern", "test_standards"],
  "remediation": ["/ground api_pattern", "/ground test_standards"] }
```

If `degraded` is false and `missing_applicable[]` is non-empty, render exactly
one short line:

```
Context docs: missing applicable docs — /ground api_pattern · /ground test_standards
```

If the list is empty, unknown-only, the command is unavailable, or the JSON is
unparseable, render nothing. NEVER block boot, never author docs automatically,
and do not re-implement the `applies_when` logic here.

### 4.8 Ready Check — Igris Doctor Drift Summary (FR-175)

Run the existing CLI diagnostic in read-only mode after the regular assessment, with a short timeout so boot cannot hang:

```bash
timeout 5s igris doctor 2>/dev/null || true
```

Parse only the markdown drift table rows (`| slug | path | drift-class | recommended-fix |`). Count rows whose `drift-class` is not `clean`, and count the unique non-clean drift classes.

Render exactly one line when non-clean rows exist:

```
Igris Doctor: {issue_count} issue(s) across {class_count} drift class(es) - run /igris-doctor.
```

If the count is zero, render nothing. If `igris doctor` is unavailable, slow, or its output is unparsable, skip this section silently. `/boot` must never block on diagnostics, must never run `igris doctor --fix`, and must not reimplement doctor checks; the CLI verb remains the engine.

### 4.9 Ready Check — Goals Approaching Deadline (FR-110)

The upcoming-goals surface is now part of the §4.6 `igris assess` digest (`goals_upcoming[]` — active goals with a deadline within 14 days). Do NOT make a separate goal call; render from the digest.

For each entry in `assess.goals_upcoming[]`, render:

```
## Goals approaching deadline
- GL-003 "Ship v6.1" — due 2026-05-01 (P1)
- GL-001 "Compliance audit" — due 2026-05-12 (P1)
```

Each entry carries `goal_id` / `title` / `deadline` / `priority`. (The prior "N briefs serving" sub-line is dropped — the assess digest is the MINIMAL D-A surface and does not carry `serving_briefs_count`; run `/scan` for full goal progress.)

If `goals_upcoming[]` is empty, render nothing — no "No goals" line. Token budget: ~120 tokens.

### 4.10 Ready Check — Cognition Health + Subconscious Suggestions (FR-106 / TD-327)

> **TD-102 / FR-118 / FR-191 (V7.1):** The subconscious SUGGESTIONS table below is
> gated behind the `cognition.subconscious.enabled` config flag, which defaults to
> `false`. The old rule-based engine had a 2% true-positive rate; FR-118 SHIPPED the
> redesign — the subconscious is now a cognition instance (digest → isolated LLM call →
> open-typed suggestions), and the rule detectors were deleted. Re-enable is
> just a flag flip — no schedule re-bootstrap needed.

#### Pre-step (TD-327): cognition health WARNING — every instance, DERIVED

Run the deterministic verb and render its output. Do NOT read `config.json` and
do NOT run SQL here: the digest already resolves each instance's declared gate
key, reads the local `event_log` / `schedules` / `schedule_runs`, and scopes
every reading to THIS machine.

```bash
igris cognition health --json 2>/dev/null || true
```

The roster is DERIVED from the brain's projected extractor registry, so this
covers every instance — including ones added after this skill was last edited.
That is the point: the previous version of this section hand-listed two of seven
instances in embedded SQL, and the five it did not name were silent for four
weeks before anyone noticed.

**Render rule — nothing when healthy.** If `degraded` is `true`, render nothing.
If every entry in `instances[]` has `status` of `ok` or `disabled`, render
nothing. Otherwise render ONE block listing only the non-`ok`, non-`disabled`
entries, one line each:

```
## Cognition WARNING
- janitor: WEDGED — janitor_engine has an OPEN run 14.5 days old
- arbiter: BLOCKED_UPSTREAM — runs only inside a janitor run
Investigate: igris cognition health
```

Line format: `- {id}: {status uppercased} — {first sentence of reason}`. Append
each entry of `warnings[]` as its own `- ` line. Token budget: ~80 tokens, and
zero on a healthy brain.

Read the statuses as declared, not as guessed:
- `no_signal` means "silent for at least the retained `event_log` window"
  (`event_log_retention_days`), **NOT** "never ran". The brain purges that table
  on every engine init, so absence of a row is absence of evidence.
- `blocked_upstream` means the instance has no switch or schedule of its own and
  its driver is the thing to fix. Do not investigate the blocked instance.
- `disabled` is a deliberate operator choice and is never a warning.

If the verb is unavailable or emits nothing parseable, skip this pre-step
silently (`2>/dev/null || true` absorbs it). Never block the boot on it.

#### Subconscious suggestions

Gate this sub-block on the SUBCONSCIOUS entry of the digest above: find the
entry with `id == "subconscious"` and use its `enabled` field. (That field is
the resolution of the instance's own declared `gate_keys`, which is
`cognition.subconscious.enabled` — read it from the digest rather than
re-reading `config.json`, so a gate that moves brain-side sweeps itself.) When
the digest is `degraded` or carries no `subconscious` entry, treat as `false`.

If `false`, skip the rest of this section silently — render nothing (no
suggestion MCP tools, no "disabled" notice). Resume reading at §4.11.

If `igris-brain` MCP is available, call `igris_suggestion_list` with:
- `status` = `'pending'`
- `project_slug` = current project slug
- `limit` = `3`

Token budget: bounded to <=3 rows by `limit`. Render at most ~120 tokens.

If results are returned, render:

```
## Suggestions ({total} pending)
- [{priority}] {title} ({source_module})
- [{priority}] {title} ({source_module})
- [{priority}] {title} ({source_module})
```

Use the `total` count from the response (may exceed `limit`) so the user
knows how many are queued in total. Format each row as:
`- [{priority}] {title} ({source_module})` — keep it terse; the user can
run `igris_suggestion_list` directly for full details.

If zero results, render nothing — no "No suggestions" line. If the tool
is unavailable (older brain), skip silently.

> **TD-327 — the janitor health line moved.** This section used to carry a
> second embedded `sqlite3` block reading `brain_maintenance_runs` for a
> one-line janitor summary. That block is gone: the janitor is one of the seven
> instances the health pre-step above now covers, derived rather than named. A
> per-instance line only prints when the janitor is NOT `ok`, which is the same
> render-when-it-matters posture at a seventh of the surface area. `/scan` §6.5
> carries the full roster table for deliberate inspection. Merge PROPOSALS still
> surface through the pending-suggestions block above (`source_module='janitor'`).

### 4.11 Ready Check — Pending Perception Candidates (FR-109 / TD-066)

Extraction happens in a detached background process at session-end (spawned
by `session_end.sh` / `pre_compact.sh` via `perception_extract_and_persist.sh`).
This section is purely a SELECT — it surfaces whatever the background process
has committed since the last boot. /boot does NOT drain any inbox.

#### Pre-step (TD-074, TD-080): perception failure WARNING

Before rendering pending candidates, query the latest perception lifecycle
event so a recent failure surfaces prominently. **TD-080 fix (Gap A):** read
directly from the local DB via `sqlite3` (NOT via `igris_event_log` MCP) so
this machine's local-only events surface here. The MCP tool routes to the
remote brain, which misses any perception runs that happened on this machine
since the last `/rest`. Post-§4 pull, the local DB is the merged superset.

Run (set `$PROJECT_SLUG` from `detect.project_slug`):
```bash
# Defense-in-depth (TD-080 Q-3): refuse to interpolate if slug doesn't match
# the registered slug shape. Belt-and-suspenders against any future code path
# that broadens slug sourcing (e.g., env var override). Same posture as the
# other defensive guards in this section — skip silently if the slug came
# from an unexpected source.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  return 0  # do not surface this section this run
fi

sqlite3 "<detect.brain_root>/memory/knowledge.db" \
  "SELECT created_at, event_name, json_extract(payload, '\$.reason') AS reason
   FROM event_log
   WHERE component = 'perception' AND project_slug = '$PROJECT_SLUG'
   ORDER BY created_at DESC LIMIT 1;"
```

If the latest row's `event_name` is `'perception.run_failed'` AND no later
`'perception.run_succeeded'` row exists for the same project (defensive
follow-up to confirm the failure has not self-recovered), prepend a single
WARNING block before the pending list. Otherwise, render no warning and
proceed to the pending list as normal.

The defensive "no later success" check (substitute the failed row's
`created_at`):
```bash
# Defense-in-depth (TD-080 Q-3): refuse to interpolate if slug doesn't match
# the registered slug shape.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  return 0
fi

sqlite3 "<detect.brain_root>/memory/knowledge.db" \
  "SELECT COUNT(*) FROM event_log
   WHERE component = 'perception' AND project_slug = '$PROJECT_SLUG'
     AND event_name = 'perception.run_succeeded'
     AND created_at > '<failed_row_created_at>';"
```

A return of `0` confirms the failure is the latest terminal state.

**Defensive guards (TD-080):**
- Wrap each `sqlite3` invocation with a `command -v sqlite3 >/dev/null 2>&1`
  pre-check. If sqlite3 is absent on this machine, skip the WARNING silently.
- If the DB file is missing or the query errors, skip the WARNING silently.
  The `2>/dev/null || true` shell pattern absorbs both cases.

```
## Perception WARNING
Latest extraction FAILED at 2026-05-01 04:22 (reason: epipe_on_llm_stdin).
Recent session transcripts may not have produced learnings.
Investigate: tail ~/.igris/projects/{project}/session/perception_extract.log
```

Suppression rules (do NOT render the WARNING when):
- Latest event is `'perception.run_skipped'` — skipping is normal (60s
  min-window, bytes gate, disabled gate).
- Latest event is `'perception.run_started'` with no terminal event yet
  (in-flight run; /scan handles the "stuck RUNNING" surface).
- A `'perception.run_succeeded'` row exists with `created_at` newer than
  the failed row.

Token budget for the WARNING block: ~80 tokens. The pending list below
remains unchanged in budget (~150 tokens). Total §4.11 upper bound: ~230 tokens.

If `sqlite3` is unavailable or the DB file is missing, skip the WARNING silently.

#### Pending list

**TD-080 fix (Gap A):** read directly from the local DB via `sqlite3` (NOT
via `igris_perception_review_pending` MCP). Same rationale as the WARNING
above — local-only pending rows from this machine's recent extractions are
invisible to the remote-routed MCP tool. Post-§4 pull, the local DB is the
merged superset.

Run (set `$PROJECT_SLUG` from `detect.project_slug`):
```bash
# Defense-in-depth (TD-080 Q-3): refuse to interpolate if slug doesn't match
# the registered slug shape.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  return 0
fi

sqlite3 "<detect.brain_root>/memory/knowledge.db" \
  "SELECT title, source_extractor, confidence
   FROM learnings
   WHERE project = '$PROJECT_SLUG' AND review_status = 'pending_review'
   ORDER BY created_at DESC LIMIT 5;"

sqlite3 "<detect.brain_root>/memory/knowledge.db" \
  "SELECT COUNT(*) FROM learnings
   WHERE project = '$PROJECT_SLUG' AND review_status = 'pending_review';"
```

The first query returns the top 5 pending rows for the rendered list. The
second returns the total count (matches the `total` field the MCP tool used
to provide). Token budget: bounded to <=5 rows. Render at most ~150 tokens.

If results are returned, render:

```
## Pending Learnings ({total} pending review)
- [{source_extractor}, conf {confidence}] {title}
- [{source_extractor}, conf {confidence}] {title}
```

Use the `total` count from the response (may exceed `limit`) so the user
knows the queue depth. The `source_extractor` field values are typically
`llm` (from background extraction) or `manual` (from direct memory_store
calls). Legacy rows from pre-TD-066 extractions may render as
`rule:learned_marker`, `rule:retry_chain`, `rule:blocker_resolution`, or
`rule:error_fingerprint` — these are read-side compatible and surface
verbatim. Show `approve` and `reject` MCP tools as next-step hints once per
session, not per row.

If zero results, render nothing — no "No pending" line. If `sqlite3` is
unavailable or the DB file is missing, skip silently (same defensive guards
as the WARNING block above).

If `auto_approve_enabled=true` is set in `<detect.brain_root>/config.json`'s `perception`
section, the background extractor inserts new rows as `approved` directly
and they bypass this surface — they appear in `recall`/`search` immediately
without operator review. Default is opt-in (off).

### 5. Display Resume Point (if resuming)

If the §4.1 `igris session gather` digest selected a genuine handoff with `handoff.mode == "REST MODE"`, display its resume point from the digest fields — `handoff.resume_point` and `handoff.next_steps` (the verb parsed these from the chosen handoff file's content), NOT from any fixed `CURRENT_SESSION.md`:
```
## Resuming Session

**Last Active:** [brief ID — from handoff.resume_point]
**Phase:** [phase — from handoff.resume_point]
**Next Steps:** [handoff.next_steps]
```

If `gather.fresh_start` is true (`handoff` is null), this is a fresh start — skip the resume display. (A legacy `CURRENT_SESSION.md` handoff with `is_legacy: true` is displayed identically — the resume is invisible to the user, exactly as pre-FR-126 `/boot` read it.)

### 6. Display Recommendations

```
## Recommended Actions

1. [Primary - resume current or start highest priority]
2. [Secondary - show status or review briefs]
3. [Tertiary - other relevant action]
```

### 7. Update Session

`igris session register` (§4.4) already wrote this instance's LIVE per-instance file `~/.igris/projects/{project}/session/instances/<instance_id>.md` at `state='live'` (where `<instance_id>` is `register.instance_id` from the §4.4 digest), seeded from the handoff. §7 is the end-of-boot confirm/refresh of THAT file — if the booting surfaced anything that should land in the LIVE scratchpad (or once a hunt starts and `**Mode:**` flips to `HUNT MODE`), update it directly via `igris_session_file_update` with `project`, `filename=instances/<instance_id>.md`, `content`, `instance_id=<instance_id>`, `state='live'`. On a plain boot with no further edits the register write already stands — no extra write is required.

The per-instance file replaces the old single `CURRENT_SESSION.md`. There is no Mode flip on a shared file; each instance owns and writes its own file freely.

Display: "Igris AI initialized. System ready."
