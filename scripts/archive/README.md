# scripts/archive/

Completed one-shot scripts, kept for historical reference and fresh-install
edge cases. **None of these are invoked by CI, git hooks, or the CLI** — they
ran once against the live brain (or as part of a one-time migration) and are
retained only so the history and the exact transformation logic stay
inspectable.

| Script | Purpose |
|--------|---------|
| `igris_migrate_v5_to_v6.sh` | v5 → v6 brain migration (cache→projects rename, v6 subdir scaffolding, symlink fixups). v5 is EOL; v7 is a clean break — "3 versions back → reinstall" per TD-123. |
| `igris_migrate_briefs.sh` | v4 → v5 brief-storage migration (filesystem `ai/briefs/` → brain DB). |
| `backfill_entity_edges.py` | FR-105 typed-edge backfill — reconstructs `backfill`-provenance edges from structural markers in `brief_files.content`. Already applied to the live brain (`INSERT OR IGNORE`, so a re-run is a no-op). |
| `backfill_goals.sh` | FR-110 goal backfill — proposes goals from master briefs (pass 1 writes a proposal file; pass 2 reads ticked entries and creates goals + `serves_goal` edges). Already run. |
| `__tests__/test_backfill_entity_edges.py` | Regression test for `backfill_entity_edges.py` (kept as a sibling of `__tests__/` so the `Path(__file__).resolve().parent.parent` → `import backfill_entity_edges` resolution still works). |
