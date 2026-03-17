# Task Handler: media-gen

## When to Use

This handler is for tasks with `task_type: 'media-gen'`. Media generation tasks involve creating images, videos, audio, or other media assets using AI generation tools.

## Required Capabilities

- `media` — Access to media generation MCP tools (Higgsfield, DALL-E, etc.)
- `creative` — Prompt engineering for quality output

## Execution Steps

1. **Read the task** via `igris_task_get` with the provided task ID
2. **Parse requirements:** Identify media type (image, video, audio, speech), style, dimensions, and any reference material
3. **Prepare prompt:** Craft a generation prompt based on task requirements
4. **Generate media** using available MCP tools:
   - Images: `mcp__higgsfield__generate_image` or similar
   - Video: `mcp__higgsfield__generate_video`
   - Speech: `mcp__higgsfield__generate_speech`
   - Edits: `mcp__higgsfield__edit_media`
5. **Save output** to `~/.igris/output/media-gen/`
6. **Store results** via `igris_task_result_add`:
   - result_type: `image` — path or URL to generated image
   - result_type: `file` — path to generated media file
   - result_type: `url` — URL if hosted externally
   - result_type: `json` — generation metadata (prompt, model, dimensions, duration)
7. **Complete the task** via `igris_task_complete` with a summary

## Output Convention

- Media saved to `~/.igris/output/media-gen/`
- File naming: `{task-id}-{type}-{index}.{ext}`
- Result types: `image`, `file`, `url`, `json`

## Error Handling

- On generation failure: call `igris_task_fail` with error details from the generation API
- On missing MCP tools: call `igris_task_fail` noting which tools are unavailable
- On rate limiting: add `error` result with retry metadata, retry after delay
