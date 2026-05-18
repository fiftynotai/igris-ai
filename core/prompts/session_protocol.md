# Session Management Protocol — Per-Instance Session Contract

## Core Principle

**Each instance owns its own session file.** The session file is a
per-instance handoff document — nothing more. Responsibilities split cleanly:

- **Briefs** track brief work (tasks, workflow state, technical substance).
- **The instance registry** tracks liveness (who is on what, last active when).
- **The per-instance session file** carries session conclusions and handoff
  context for the next instance.
- **A brain goal** carries cross-session standing state.

**Model shift:** the old model was one project-scoped `CURRENT_SESSION.md`
per project. This protocol replaces it wholesale with **per-instance session
files keyed by `instance_id`** — one file per running instance, no shared
file, no write-contention.

---

## 1. Per-Instance Session Files  [Lock 3 — file model]

Every instance writes exactly one session file, located by its lifecycle
state:

| State          | Path                                               |
|----------------|----------------------------------------------------|
| LIVE / RESTED  | `session/instances/<instance_id>.md`               |
| ARCHIVED       | `session/archive/<instance_id>-<rested_at>.md`     |

- `instance_id` is the UUID minted by `igris_instance_heartbeat`. The
  `<rested_at>` suffix on archived paths is the rest timestamp — it prevents
  collision when one instance rests repeatedly.
- **Each instance writes its own file freely.** Each instance *is* Igris; it
  manages its own file. There is zero write-contention because no file is
  ever co-written by two instances.
- **What the file carries:** session conclusions, "prioritize X next
  session," handoff notes, carry-forward context. Briefs are referenced **by
  number only** — the spec lives in the brief, not in the session file.
- **Brain mirror:** the file is also a row in the `session_files` table.
  `UNIQUE(project, filename)` holds because per-instance UUID filenames never
  collide. The row is written via `igris_session_file_update` with the
  `instance_id` and `state` arguments.

---

## 2. The 3-State Lifecycle: LIVE → RESTED → ARCHIVED  [Lock 2]

A session file moves through exactly three states:

| State    | Meaning                                                          |
|----------|------------------------------------------------------------------|
| LIVE     | Running scratchpad of an active instance. Not a handoff.         |
| RESTED   | A completed handoff awaiting read. Stays in the active dir.      |
| ARCHIVED | Consumed AND superseded. Moved to `session/archive/`.            |

- **Authoritative state is the `session_files.state` column**
  (`CHECK (state IN ('live','rested','archived'))` — lowercase enum values).
  Disk location (`instances/` vs `archive/`) is a *derived convenience*, not
  the source of truth.
- **`/rest` does LIVE → RESTED only.** It does NOT archive.
- **RESTED → ARCHIVED is done by the NEXT instance, at ITS OWN `/rest`** —
  after that instance has provably consumed the handoff and produced its own
  superseding RESTED file.
- **Invariant:** a file is ALWAYS read before it is archived. It is archived
  by whoever superseded it — never by its own author.
- **Archive is MOVE-NOT-DELETE.** Archived files go to `session/archive/` and
  remain readable and greppable forever.
- **Crash-safety:** archiving is tied to the next *successful* `/rest`
  (supersession), not to "read." A reader that crashes before producing its
  own RESTED file does not bury the handoff — the original RESTED file is
  still there for the instance after it.
- **Sequential degeneration:** one clean `/rest` produces one RESTED file;
  the next `/awaken` reads exactly that one file. This is identical to the
  old single-`CURRENT_SESSION.md` behavior in the common single-instance
  case.

---

## 3. Liveness: the Registry is the Source  [Lock 1]

Liveness is the **instance registry's** job — never the session file's.

- **Heartbeat is DISPLAY-ONLY.** It reports "last active at T" and nothing
  more. It MUST NOT trigger any destructive action — no auto-archive, no
  auto-adopt, no auto-release.
- **Ownership is EXPLICIT:**
  - *Register-on-hunt* — `current_brief` is set when a hunt starts.
  - *Release-on-`/rest`* — `/rest` explicitly clears `current_brief`. This
    clear is the deliberate "task closed" signal.
- **The registry is visible.** `/hunt` and `/awaken` surface "instance X is
  on BR-Y, last active T."
- **Stale or crashed instance:** `current_brief` stays set, the session file
  stays in place and readable, and it shows as "stale, unconfirmed." Nothing
  auto-destroys it. Reclaim is either an explicit operator action, or a
  conservative long-threshold sweep that ONLY clears the ownership flag —
  it never archives the file.
- **Abandoned LIVE file** (instance crashed, no `/rest`): surfaced as a
  crashed scratchpad. It is NEVER consumed as a handoff and NEVER
  auto-archived. Only a `state='rested'` file is a genuine handoff.

---

## 4. No Shared Section; Standing State → Goal  [Lock 3 — boundaries]

- **There is NO global or shared section in any session file.**
  Cross-instance liveness is the registry's job (§3) — it is not represented
  as a file section.
- **Routing rule — where each kind of information goes:**

  | Information kind                                           | Goes to                                      |
  |------------------------------------------------------------|----------------------------------------------|
  | Cross-session standing state (release gate, scope, "always do X") | a brain goal (`igris_goal_*`)         |
  | Cross-brief technical substance                            | the brief / a brain memory / a graph edge    |
  | Session conclusions + handoff context                      | the per-instance session file                |
  | Cross-instance liveness                                    | the instance registry                        |

- **Explicit boundary:** standing state does NOT belong in a session file.
  The session file is purely session + handoff.

---

## 5. Archive Housekeeping  [Lock 4]

- **Trigger:** a housekeeping sweep folded into `/awaken` — NOT a scheduled
  job or daemon. It is crash-robust and idempotent (running it twice is
  harmless).
- **Retention:** the last 30 days of archived files are kept individually.
  Files older than 30 days are rolled — by concatenation — into one
  `session/archive/YYYY-MM.md` digest per calendar month.
- **Nothing is ever hard-deleted.** Compaction is concatenation, not
  deletion.
- **~150-individual-file ceiling** acts as a burst safety valve. The 30-day
  window and the 150-file ceiling are tunable knobs, not hard constants.

---

## 6. Brain Tool Reference

The FR-130 sessions-component tools and their roles:

| Tool                       | Role                                                                            |
|----------------------------|---------------------------------------------------------------------------------|
| `igris_session_file_get`   | Read one file by `project` + `filename`; returns content + `instance_id` + `state`. |
| `igris_session_file_update`| Write/update a file; args `project`, `filename`, `content`, optional `instance_id`, optional `state` (`live`/`rested`/`archived`). |
| `igris_session_file_list`  | Enumerate a project's session files; args `project` + optional `state` filter; returns `filename`/`instance_id`/`state`/`content_hash`/`updated_at` per file (content omitted). |
| `igris_session_sync`       | `/rest` session-snapshot recorder.                                              |
| `igris_session_recall`     | Cross-project session recall for `/awaken`.                                     |

**`session_files` columns:** `instance_id TEXT` (nullable; owning instance
UUID), `state TEXT NOT NULL DEFAULT 'live'` (`CHECK` in
`live`/`rested`/`archived`), constraint `UNIQUE(project, filename)`.

**Not a per-instance tool:** `igris_session_file_pull` is a **sync-component**
tool — it bulk-pulls all session files for VPS restore. It is NOT the
per-instance, state-aware gather tool. To enumerate a project's session
files by state, use `igris_session_file_list`.

---

## 7. Recovery Protocol (per-instance)

This section states the recovery *contract*. The `/awaken` step-by-step
procedure is owned by the `/awaken` skill — it is not specified here.

On context reset, an instance:

1. Obtains its `instance_id` — recovered from its own prior session file if
   resuming an existing instance, or minted fresh by
   `igris_instance_heartbeat` for a new one (`igris_instance_heartbeat`
   mints a new ID when called without an `instance_id`; the ID is not
   deterministically derivable).
2. Reads its own `session/instances/<instance_id>.md` — its LIVE scratchpad,
   if one exists.
3. Reads the instance registry to learn sibling state — who else is live,
   what they are on, and whether any RESTED handoff is awaiting it.

Classification of what it finds is a contract, not a procedure:

- A `state='rested'` file from a prior instance is a **genuine handoff** —
  it may be consumed.
- A `state='live'` file owned by an absent or stale instance is an
  **abandoned scratchpad** — it is surfaced but NEVER consumed as a handoff.
- A `state='live'` file owned by a still-live sibling belongs to that
  sibling — it is left alone.

---

**Last Updated:** 2026-05-18
**IGRIS Version:** 7.0.0
**Supersedes:** the project-scoped single-`CURRENT_SESSION.md` model.
