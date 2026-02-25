# Task Handler: dev

## When to Use

This handler is for tasks with `task_type: 'dev'`. Dev tasks involve code implementation, testing, refactoring, bug fixes, and technical work.

## Required Capabilities

- `code` — Write and modify source code
- `test` — Run and write tests
- `review` — Self-review for quality

## Execution Steps

1. **Read the task** via `igris_task_get` with the provided task ID
2. **Understand context:** Read the task description, metadata, and any linked brief_id
3. **If brief_id exists:** Read the brief via `igris_brief_get` for full requirements
4. **Plan the implementation:** Identify files to modify, changes needed, test scenarios
5. **Implement changes:** Write clean code following `ai/context/coding_guidelines.md`
6. **Run tests:** Execute the project's test suite, fix any failures
7. **Store results** via `igris_task_result_add`:
   - result_type: `commit` — the commit SHA after committing
   - result_type: `text` — summary of changes made
   - result_type: `file` — list of files modified (in content field)
8. **Complete the task** via `igris_task_complete` with a summary

## Output Convention

- Results stored in the project's git history (commits)
- Summary stored as `text` result type
- File list stored as `file` result type

## Error Handling

- On test failure after 3 retries: call `igris_task_fail` with failure details
- On missing dependencies or blocked state: call `igris_task_block` with reason
- On recoverable error: add diagnostic metadata via `igris_task_result_add` with result_type `error`, then retry
