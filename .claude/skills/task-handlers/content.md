# Task Handler: content

## When to Use

This handler is for tasks with `task_type: 'content'`. Content tasks involve writing documentation, blog posts, READMEs, tutorials, and other written material.

## Required Capabilities

- `write` — Produce written content
- `research` — Research topics for accuracy

## Execution Steps

1. **Read the task** via `igris_task_get` with the provided task ID
2. **Understand requirements:** Parse the task description for topic, audience, format, and length
3. **Research if needed:** Use codebase search, web search, or existing docs for source material
4. **Draft the content:** Write following the project's style and tone
5. **Review and refine:** Check for accuracy, clarity, and completeness
6. **Save output:**
   - Write files to `~/.igris/output/content/` or directly to the project
   - If writing to project files (README, docs), commit the changes
7. **Store results** via `igris_task_result_add`:
   - result_type: `file` — path to the written content
   - result_type: `text` — summary of what was written
   - result_type: `commit` — commit SHA if changes were committed
8. **Complete the task** via `igris_task_complete` with a summary

## Output Convention

- Project docs: written directly to project, committed
- Standalone content: saved to `~/.igris/output/content/{task-id}-{slug}.md`
- Result types: `file`, `text`, `commit`

## Error Handling

- On missing context or unclear requirements: call `igris_task_fail` with details about what's missing
- On recoverable error: add `error` result, retry
