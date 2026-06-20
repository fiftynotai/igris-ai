---
obligation: "Mirror sync — a repo core/ file copied to its runtime mirror must be byte-equal"
mechanism: gate
status: shipped
lives_in: "core/scripts/verify_mirror.sh"
summary: "TD-096 primitive verifies byte-equality between a repo core/ source and its ~/.igris/core/ runtime mirror; self-evidencing per-pair verdict, non-zero exit on any MISMATCH/MISSING/SAME_INODE."
---

# Mirror sync (TD-096 / BR-062)

Any `cp` of a tracked `core/` file to its `~/.igris/core/` runtime mirror must be
followed by `verify_mirror.sh`, which produces a self-evidencing per-pair verdict
(realpath of both sides, the exact diff command, exit code, output). Narrative
"bytes-identical" claims are forbidden — the primitive's verdict is the only
acceptable evidence.
