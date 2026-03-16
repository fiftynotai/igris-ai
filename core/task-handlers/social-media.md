# Task Handler: social-media

## When to Use

This handler is for tasks with `task_type: 'social-media'`. Social media tasks involve generating posts, threads, captions, and scheduling content for social platforms.

## Required Capabilities

- `write` — Produce written content
- `creative` — Generate engaging, platform-appropriate copy

## Execution Steps

1. **Read the task** via `igris_task_get` with the provided task ID
2. **Parse requirements:** Identify platform (Twitter/X, LinkedIn, etc.), tone, topic, hashtags, and any constraints
3. **Draft the post(s):** Write platform-appropriate content respecting character limits and formatting
4. **Save output** to `~/.igris/output/social-media/{task-id}-{platform}.md`
5. **Store results** via `igris_task_result_add`:
   - result_type: `text` — the post content ready for publishing
   - result_type: `file` — path to the saved file
   - result_type: `json` — structured post data (platform, content, hashtags, scheduled_at)
6. **Complete the task** via `igris_task_complete` with a summary

## Output Convention

- Posts saved to `~/.igris/output/social-media/`
- File format: `{task-id}-{platform}.md`
- Result types: `text`, `file`, `json`

## Error Handling

- On missing platform or topic: call `igris_task_fail` with details
- On content policy concerns: flag in result metadata, complete with warning
