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
3. **Route by brief linkage:**

### If brief_id exists → Use /hunt workflow

The task is linked to a brief. Execute the full hunt workflow which includes architect planning, forger implementation, sentinel testing, warden review, and brief status updates.

1. Run `/hunt {brief_id}` — this triggers the complete agent pipeline
2. The hunt workflow will handle all phases: PLANNING → BUILDING → TESTING → REVIEWING → COMMITTING
3. After hunt completes, store results via `igris_task_result_add`:
   - result_type: `commit` — the commit SHA
   - result_type: `text` — summary of changes made
4. **Complete the task** via `igris_task_complete` with a summary

### If no brief_id → Direct implementation

The task is standalone with no brief. Execute directly:

1. **Plan the implementation:** Identify files to modify, changes needed, test scenarios
2. **Implement changes:** Write clean code following `~/.igris/projects/{project}/context/coding_guidelines.md`
3. **Run tests:** Execute the project's test suite, fix any failures
4. **Commit:** Use conventional commit format
5. **Store results** via `igris_task_result_add`:
   - result_type: `commit` — the commit SHA after committing
   - result_type: `text` — summary of changes made
   - result_type: `file` — list of files modified (in content field)
6. **Complete the task** via `igris_task_complete` with a summary

## Error Handling

- On test failure after 3 retries: call `igris_task_fail` with failure details
- On missing dependencies or blocked state: call `igris_task_block` with reason
- On recoverable error: add diagnostic metadata via `igris_task_result_add` with result_type `error`, then retry
