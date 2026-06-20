---
obligation: "igris_os.md section line-ranges in igris_tree.json must stay accurate"
mechanism: gate
status: shipped
lives_in: "scripts/validate_igris_tree_lineranges.py"
summary: "Pre-commit DRIFT-3 validator fails when an igris_os.md section edit crosses a SECTION marker without bumping the matching context_files.igris_os.sections.<name>.lines range."
---

# Tree line-ranges (BR-065 / TD-070)

Section-selective context loading reads `igris_tree.json`
`context_files.igris_os.sections.<name>.lines`. Any `igris_os.md` edit that
crosses a `<!-- SECTION: -->` boundary must bump the matching range in both the
repo and runtime tree; the DRIFT-3 validator is the pre-commit safety net.
