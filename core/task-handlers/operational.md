# Task Handler: operational

## When to Use

This handler is for tasks with `task_type: 'operational'`. Operational tasks involve system maintenance, configuration changes, deployments, cleanup, and workflow automation.

## Required Capabilities

- `ops` — System administration and maintenance
- `code` — Modify configuration and scripts

## Execution Steps

1. **Read the task** via `igris_task_get` with the provided task ID
2. **Understand the operation:** Parse what needs to be done (deploy, configure, clean up, migrate, etc.)
3. **Assess risk:** Determine if the operation is reversible and what could go wrong
4. **Execute the operation:**
   - Config changes: Edit configuration files, validate syntax
   - Deployments: Run deploy scripts, verify health
   - Cleanup: Remove stale files, prune data, optimize storage
   - Automation: Create or update scripts, cron jobs, scheduled tasks
5. **Verify success:** Run health checks, validate expected state
6. **Store results** via `igris_task_result_add`:
   - result_type: `text` — description of what was done
   - result_type: `commit` — commit SHA if files were changed
   - result_type: `json` — structured operation log (action, before_state, after_state)
7. **Complete the task** via `igris_task_complete` with a summary

## Output Convention

- Operational logs saved to project or `~/.igris/output/operational/`
- Config changes committed to git
- Result types: `text`, `commit`, `json`

## Error Handling

- On destructive operation without confirmation: call `igris_task_fail` with safety concern
- On deployment failure: call `igris_task_fail` with rollback instructions
- On partial completion: add `error` result with details of what succeeded vs failed
