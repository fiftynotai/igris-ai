# review-model fixtures (FR-277)

Two real igris-ai briefs, snapshotted read-only from the brain on 2026-11-24
for `test/review_model_gate.test.bash` (coding_guidelines §18.11: a hard-fail
gate's red-first fixture is a REAL brief, unedited, whose refusal is quoted
before the gate is trusted).

- `FR-267.md` and `TD-497.md` are `brief_files.content`, byte-for-byte. Each
  was written with python3 (no trailing newline added) and compared with the
  stored value: `open(path, "rb").read() == content.encode("utf-8")` printed
  `True` for both. The files carry no header, so the comparison keeps working;
  this README is the header.
- `FR-267.events.tsv` and `TD-497.events.tsv` are every `agent_events` row for
  the brief, ordered by `created_at` then `id`, as tab-separated `agent`,
  `event_type`, `model_requested`, `model_resolved`, `created_at`, `project`,
  with `\N` for NULL. The suite inserts them in file order, so the `id`
  tie-break is kept, and rewrites the project `igris-ai` to its sandbox
  project.

```bash
python3 - ~/.igris/memory/knowledge.db test/fixtures/review-model <<'PY'
import sqlite3, sys, os
from urllib.parse import quote
db, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect("file:%s?mode=ro" % quote(db), uri=True)
for bid in ("FR-267", "TD-497"):
    (content,) = con.execute("SELECT content FROM brief_files WHERE project='igris-ai' AND brief_id=?", (bid,)).fetchone()
    open(os.path.join(out, bid + ".md"), "w", encoding="utf-8", newline="").write(content)
    rows = con.execute("SELECT agent, event_type, model_requested, model_resolved, created_at, project"
                       " FROM agent_events WHERE brief_id=? ORDER BY created_at, id", (bid,)).fetchall()
    with open(os.path.join(out, bid + ".events.tsv"), "w", encoding="utf-8", newline="") as fh:
        fh.write("agent\tevent_type\tmodel_requested\tmodel_resolved\tcreated_at\tproject\n")
        for r in rows:
            fh.write("\t".join("\\N" if v is None else str(v) for v in r) + "\n")
PY
```

## FR-267 — RED (the review ran on the author's model)

FR-267 (Done) holds 29 rows. Its latest warden `stop` row and all of its
forger rows read `inherit:claude-fable-5`: the change was reviewed on the
model that wrote it, which DECISIONS row 25 forbids. The real Agent Log names
architect, forger, sentinel, warden and document, and each has rows, so §2 and
§3 pass on this brief and the refusal is §4's alone.

The shipped hook on this world (a sandbox brain seeded from the two files,
the checker copied into the sandbox repo; 2026-11-24, `/bin/bash` 3.2):

```
$ printf 'fix(x): a change\n\nbody line\n\ncloses #FR-267\n' > "$X/msg"
$ cd "$X/gproj" && HOME="$X/fakehome" /bin/bash scripts/git-hooks/commit-msg "$X/msg"; echo "exit=$?"

[commit-msg] FR-277 review-model gate: refusing to close a brief reviewed on its author's model

REVIEW-MODEL FR-267: VERDICT=EQUAL reviewer=inherit:claude-fable-5 authors=inherit:claude-fable-5
  a change is reviewed by a model other than its author's (DECISIONS row 25).
  Re-run warden on a different model:
    bash <sandbox>/gproj/core/scripts/cli-adapters/model_tier.sh resolve --agent warden --differ-from <the author's model>

  One-shot bypass (leaves a trail in this terminal, never export it):
    IGRIS_BYPASS_REVIEW_MODEL_GATE=1 git commit ...

exit=1
```

The 4013c55 hook (no §4) on the same world exits 0 — the RED arm. RM-RED pins
the refusal; its self-negative deletes §4 from a copy of the hook by the
`[[ FR-277 REVIEW-MODEL GATE BEGIN/END ]]` markers and shows the same world
passing, which proves RM-RED exercises §4 and not something beside it.

## TD-497 — GREEN (a different model reviewed it)

TD-497 (Done) holds 17 rows: warden `sonnet`, forger
`inherit:claude-opus-5-5`. The checker reads
`REVIEW-MODEL TD-497: VERDICT=PASS reviewer=sonnet authors=inherit:claude-opus-5-5`
and §4 is silent. The stored TD-497 Agent Log also names a `tempo` row that has
no agent event, which §3 refuses on its own, so RM-GREEN bypasses §2 and §3
to isolate §4.

The gate's first run against the live brain is the FR-277 close itself (plan
§7.1), from the main checkout.
