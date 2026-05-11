---
name: sync
description: Deploy code and/or data to VPS brain - usage: /sync [code|data|all|status]
disable-model-invocation: false
allowed-tools:
  - Bash
triggers:
  - "SYNC"
  - "sync to vps"
  - "sync brain"
  - "deploy to vps"
  - "push to vps"
---

# SYNC

Run `igris sync $1` for the requested sub-verb (code/data/all/status).

If `$ARGUMENTS` is empty, default to `all` (matches the legacy /sync skill
behavior). Pass `--if-changed` for cron-parity with the retired
`scripts/igris_vps_update.sh --if-changed`.

```bash
ARG="${1:-all}"
igris sync "$ARG" "${@:2}"
```

The Igris CLI owns the entire sync pipeline natively as of MG-014 M4.
The retired `scripts/igris_vps_update.sh` is replaced by `igris sync code`
(with `--if-changed` for cron parity). See `cli/README.md` for the full
sub-verb table and the manual code-sync runbook.
