# Task Handler: research

## When to Use

This handler is for tasks with `task_type: 'research'`. Research tasks involve investigating codebases, exploring technologies, analyzing patterns, and producing summaries of findings.

## Required Capabilities

- `research` — Investigate topics thoroughly
- `investigate` — Deep-dive codebase exploration

## Execution Steps

1. **Read the task** via `igris_task_get` with the provided task ID
2. **Define scope:** Parse the research question, target codebase/technology, and expected deliverables
3. **Investigate:**
   - Codebase: Use Glob, Grep, Read to explore source files
   - Architecture: Map module structure, dependencies, patterns
   - Technology: Use web search for docs, best practices, comparisons
   - Patterns: Identify conventions, anti-patterns, improvement opportunities
4. **Synthesize findings:** Organize into a structured report with sections, evidence, and recommendations
5. **Save output** to `~/.igris/output/research/{task-id}-{slug}.md`
6. **Store results** via `igris_task_result_add`:
   - result_type: `text` — executive summary of findings
   - result_type: `file` — path to full research report
   - result_type: `json` — structured findings (key_files, patterns, recommendations)
7. **Complete the task** via `igris_task_complete` with a summary

## Output Convention

- Reports saved to `~/.igris/output/research/`
- File format: `{task-id}-{slug}.md` (Markdown)
- Result types: `text`, `file`, `json`

## Error Handling

- On insufficient information to research: call `igris_task_fail` with what's missing
- On scope too broad: call `igris_task_block` with suggestion to split into sub-tasks
