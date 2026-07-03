---
name: handoff
tier: opt-in
description: "Guided project handoff — export a project's brain slice to a portable bundle, or import one with a preview/confirm ceremony. Usage: /handoff export <project> | /handoff import <bundle>"
disable-model-invocation: false
allowed-tools:
  - Read
  - Glob
  - Bash
triggers:
  - "HANDOFF"
  - "handoff export"
  - "handoff import"
  - "export project"
  - "import project"
---

# HANDOFF - Portable Project Hand-off / Take-over

Hand a project's brain slice to another owner as a portable file, or take one over on a fresh machine. This skill RUNS the deterministic `igris export` / `igris import` verbs and interprets their **agnostic JSON digest** — there is NO harness-specific behavior. Each verb writes a JSON digest to **stdout** and human progress to **stderr**; parse stdout as JSON.

**Exit-code map (identical on every harness):**
- `0` — success / dry-run / no-op
- `1` — hard failure (missing brain DB · tar error · corrupt/tampered/checksum-mismatch bundle · non-importable store) — ZERO DB writes
- `2` — usage error (bad slug / `--tier` / `--include`)
- `3` — **partial apply** (import only: some rows failed; the bundle is NOT marked applied) — NEVER treat as success

## Two portability modes (context)

- **bundle export/import** (this skill) = cross-owner, project-scoped, point-in-time, offline file.
- **VPS push/pull** (`/sync`, `/rest`) = same-owner, whole-brain, continuous.

A project slice carries the operator's KNOWLEDGE, never machinery: instances, session, sync-queue, metrics, suggestions, embeddings (re-derived on next use), loadout, catalog, definitions, and the executable surfaces skills/agents/hooks are ALWAYS excluded.

## Mode dispatch

Parse `$ARGUMENTS`:
- First token `export` → run **Export** with the second token as `<project>` (slug).
- First token `import` → run **Import** with the second token as `<bundle>` (path).
- Anything else → print the usage line and STOP:
  `Usage: /handoff export <project> [--tier core|standard|full] [--out <path>] | /handoff import <bundle> [--as <slug>]`

---

## Export — `/handoff export <project> [--tier core|standard|full] [--out <path>]`

Export is non-destructive — it only writes a file, so there is no pre-apply gate; the "confirm" is a completion summary.

1. **Resolve the slug.** Use the positional `<project>` if given; otherwise resolve the current project with `igris detect` and use its slug.
2. **Tier.** If the operator did NOT pass `--tier`, state that the default is `standard` and what each tier includes, then proceed with the chosen (or default) tier:
   - `core` = briefs (status + files)
   - `standard` (default) = core + brief↔brief edges + goals + context docs
   - `full` = standard + approved learnings + errors + project concept-graph
3. **Run the verb:**
   ```bash
   igris export <slug> [--tier <tier>] [--out <path>]
   ```
4. **Parse the `ExportDigest` from stdout** and render a summary:
   - `tier`, `out_path`, `checksum` (first 12 chars)
   - per-store counts from `stores` + `counts` (one line per store, e.g. `brief_status: 12`)
   - a reminder that instances / session / loadout / catalog and the executable surfaces (skills / agents / hooks) are excluded from the slice.
5. **On a non-zero exit**, surface the stderr error verbatim and STOP (exit 1 = missing brain DB or tar error; exit 2 = bad `--tier` / `--include`).

`ExportDigest` shape:
```jsonc
{ "tier": "core|standard|full",
  "stores": ["brief_status", "..."],
  "counts": { "brief_status": 12, "context_docs": 4 },
  "out_path": "/abs/path/<slug>.igris-pack.tar.gz",
  "checksum": "<sha256>" }
```

---

## Import — `/handoff import <bundle> [--as <slug>]`

Import writes to the brain DB from an UNTRUSTED bundle. ALWAYS preview first, get an explicit operator confirm in-chat, then apply with a CONCRETE conflict policy.

### 1. Resolve the bundle path

Use the positional `<bundle>` if it is a file. If a directory or a pattern was given, `Glob` for `*.igris-pack.tar.gz` and pick the intended match (ask the operator if more than one).

### 2. Preview (dry-run — writes NOTHING)

```bash
igris import <bundle> --dry-run [--as <slug>]
```

Parse the `ImportDigest` (`dry_run:true`, `applied:"none"`). Render the preview:
- `totals`: **NEW / UNCHANGED / INCOMING / LOCAL_ONLY / CONFLICT**
- `per_store`: one line per store with its five counts
- `context_docs`: `new` / `unchanged` / `conflict`

STOP conditions:
- If `already_imported:true`, or every `totals` count is `0` → report a **no-op** (nothing to apply) and STOP.
- If exit is `1` → the bundle is corrupt / tampered / checksum-mismatch / declares a non-importable store; surface the stderr error and STOP (zero DB writes already guaranteed).

`ImportDigest` shape:
```jsonc
{ "bundle": "...", "target_slug": "...", "policy": "ask|theirs|mine|newer",
  "dry_run": true, "already_imported": false, "applied": "full|partial|none",
  "failed": 0, "registered_project": null,
  "totals": { "NEW": 0, "UNCHANGED": 0, "INCOMING": 0, "LOCAL_ONLY": 0, "CONFLICT": 0 },
  "per_store": { "<store>": { "NEW": 0, "UNCHANGED": 0, "INCOMING": 0, "LOCAL_ONLY": 0, "CONFLICT": 0 } },
  "conflicts": [ ],
  "context_docs": { "new": 0, "unchanged": 0, "conflict": 0, "written": [], "backed_up": [] },
  "source_fingerprint": "<slug>@<created_at>#<checksum12>",
  "reembed_hint": "...", "scope_note": "..." }
```

### 3. Confirm ceremony (in-chat — harness-agnostic)

Present the preview to the operator, then get an EXPLICIT decision. The import verb's own `--on-conflict ask` path needs an interactive TTY; a harness Bash tool is non-TTY, so `ask` would preview and apply NOTHING. Therefore drive the confirm HERE, in chat, and pass a concrete policy on the apply.

- If `totals.CONFLICT > 0` OR `context_docs.conflict > 0`: ask the operator to choose a blanket conflict policy —
  - `theirs` — take the bundle's version
  - `mine` — keep the local version
  - `newer` — last-writer-wins by timestamp (CONFLICT rows only)
  - or **abort**.
- If there are no conflicts: ask a plain "apply? (yes/no)" — any policy is inert; default to `theirs` for the incoming/new rows.
- **NEVER apply without an explicit operator "yes."** On abort → report nothing applied and STOP.

### 4. Apply (real write — ALWAYS pass a CONCRETE policy, never `ask`)

```bash
igris import <bundle> --on-conflict <theirs|mine|newer> [--as <slug>]
```

`--on-conflict ask` would no-op under the harness Bash tool (non-TTY) — always pass the concrete policy the operator chose in step 3.

Parse the final `ImportDigest` and report:
- `applied` (`full` / `partial`)
- rows written per store (from `per_store` / `result`)
- `context_docs.written` + `context_docs.backed_up`
- `registered_project` if a new project row was auto-registered
- surface `reembed_hint` and `scope_note` to the operator.

### 5. Partial apply (exit 3, `applied:"partial"`)

Surface the failures LOUDLY (the verb prints a capped failure sample to stderr) and state that the bundle was **NOT** marked applied — re-importing after fixing the cause retries. NEVER present a partial apply as success.
