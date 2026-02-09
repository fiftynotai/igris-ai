---
name: higgsfield
description: Generate images, videos, or speech using Higgsfield AI platform
disable-model-invocation: true
allowed-tools:
  - mcp__higgsfield__generate_image
  - mcp__higgsfield__generate_video
  - mcp__higgsfield__edit_media
  - mcp__higgsfield__generate_speech
  - mcp__higgsfield__list_styles
  - mcp__higgsfield__list_motions
  - mcp__higgsfield__manage_character
  - mcp__higgsfield__manage_job
  - mcp__higgsfield__upload_file
  - Read
triggers:
  - "higgsfield"
  - "higgsfield generate"
  - "generate with higgsfield"
  - "create image with higgsfield"
  - "create video with higgsfield"
---

# GENERATE - Asset Generation via Higgsfield AI

Generate images, videos, edits, or speech using the full Higgsfield platform.

## Arguments

`$ARGUMENTS` describes what to generate. Examples:
- `an isometric game icon of a fire sword`
- `video of a cat walking on a beach from this image`
- `edit this image to add sunglasses`
- `speech video saying "hello world"`

If no arguments provided, ask the user what they want to generate.

## Model Selection Guide

When the user doesn't specify a model, pick the best one based on the task:

### Images (5 models)
| Need | Best Model | Why |
|------|-----------|-----|
| General purpose / flagship | `soul` | Higgsfield flagship, supports styles + characters + batch |
| Image reference guidance | `soul-reference` | Soul with image reference input |
| Character consistency | `soul-character` | Soul with character reference for consistent characters |
| Artistic / painterly | `reve` | Artistic text-to-image |
| Photorealistic | `seedream` | ByteDance Seedream v4 photorealism |

### Videos (11 models)
| Need | Best Model | Why |
|------|-----------|-----|
| Fast image-to-video | `dop-lite` | Fastest DOP tier |
| Standard image-to-video | `dop` | Balanced quality/speed |
| Best quality image-to-video | `dop-turbo` | Highest DOP quality |
| Fast first-last frame interpolation | `dop-lite-flf` | Fast frame interpolation |
| Standard first-last frame | `dop-flf` | Balanced frame interpolation |
| Best first-last frame | `dop-turbo-flf` | Highest quality frame interpolation |
| High-fidelity cinematic | `kling-pro` | Kling v2.1 Pro image-to-video |
| Standard cinematic | `kling` | Kling v2.1 Standard image-to-video |
| Professional image-to-video | `seedance-pro` | ByteDance Seedance Pro |
| Fast image-to-video | `seedance-lite` | ByteDance Seedance Lite |
| Text-to-video | `sora-2` | OpenAI text-to-video |

### Editing (1 tool)
| Need | Best Tool |
|------|----------|
| AI image editing | `edit_media` (Seedream Edit) |

### Speech (1 model)
| Need | Best Model |
|------|-----------|
| Talking-head video from text | `generate_speech` (Speak) |

## Execution

### Step 1: Parse the Request

From `$ARGUMENTS`, determine:
- **Asset type**: image, video, edit, or speech
- **Subject/prompt**: what to generate
- **Model preference**: if user specified one, use it; otherwise auto-select
- **Input files**: if user references a file, upload it first via `upload_file`

### Step 2: Handle File Inputs

If the request references a local file (for image-to-video, editing, etc.):
1. Use `upload_file` with the file path
2. Use the returned `public_url` as `image_url` (video) or in `image_urls` array (edit)

### Step 3: Craft the Prompt

Enhance the user's description into an effective generation prompt:
- Be specific about composition, lighting, style, mood
- Add technical quality terms: "high detail", "professional", "8K"
- For characters: describe pose, expression, clothing
- For scenes: describe environment, time of day, atmosphere
- Keep it concise — the model's `enhance_prompt` will expand it further

### Step 4: Generate

Call the appropriate MCP tool:
- **Image**: `generate_image` with chosen model
- **Video**: `generate_video` with chosen model and `image_url` for image-to-video
- **Edit**: `edit_media` with `image_urls` array and edit prompt
- **Speech**: `generate_speech`

Default settings:
- `wait_for_result`: `true` (poll until done, return the result)
- `enhance_prompt`: `true` (let the model improve the prompt)
- `quality`: `1080p` for images when available

### Step 5: Present Results

After generation completes:
1. Show the result URL(s)
2. Mention which model was used and why
3. Offer follow-up options:
   - "Want to try a different model?"
   - "Want to animate this image into a video?"
   - "Want to edit this result?"

### If Generation Fails

- Check job status with `manage_job` action `status`
- If NSFW flagged: inform user, suggest rephrasing
- If failed: show error, suggest different model or simpler prompt
- If timeout: return request_id and explain how to check later with `manage_job`

## Examples

### Basic Image
```
/generate a cyberpunk city at night with neon signs
```
-> Auto-selects `soul`, crafts enhanced prompt, returns result

### Specific Model
```
/generate seedream photorealistic portrait of a woman in golden hour
```
-> Uses Seedream v4 model for photorealism

### Image to Video
```
/generate animate this image into a video: /path/to/image.png
```
-> Uploads file, uses `dop` model for standard quality image-to-video

### Edit
```
/generate edit this image to add sunglasses: https://example.com/image.jpg
```
-> Uses `edit_media` with Seedream Edit

### Speech
```
/generate speech video saying "Welcome to our platform"
```
-> Uses `generate_speech`
