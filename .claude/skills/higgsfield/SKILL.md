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
- `upscale this image`
- `speech video saying "hello world"`

If no arguments provided, ask the user what they want to generate.

## Model Selection Guide

When the user doesn't specify a model, pick the best one based on the task:

### Images
| Need | Best Model | Why |
|------|-----------|-----|
| General purpose / versatile | `gpt-image-1.5` | Strong all-rounder |
| Photorealistic | `seedream-4.5` | ByteDance photorealism |
| Creative / artistic | `flux-2` | Black Forest Labs creative |
| Fast draft / iteration | `z-image-turbo` | Fastest generation |
| Style presets / character refs | `soul` | Only model with styles + characters |
| Text rendering in image | `nano-banana-pro` | Best text-in-image |
| Stylized / illustration | `popcorn` | ByteDance stylized |
| Artistic / painterly | `reve` | Artistic style |

### Videos
| Need | Best Model | Why |
|------|-----------|-----|
| Animate a still image | `dop` | Image-to-video with motion presets |
| Text-to-video (general) | `sora-2` | OpenAI quality |
| High quality text-to-video | `kling-2.6` | Kuaishou high fidelity |
| Long form video | `veo-3.1` | Google long-form |
| Dance / body motion | `seedance-1.5-pro` | ByteDance dance motion |
| Quick / efficient video | `minimax-02` | Fastest video |
| Diverse styles | `wan-2.6` | Alibaba style variety |

### Editing
| Need | Best Tool |
|------|----------|
| Fix/replace part of image | `inpaint` |
| Increase resolution | `upscale` |
| Change lighting | `relight` |
| Swap faces | `face-swap` |
| Swap full character | `character-swap` |
| Paint-based editing | `draw-to-edit` |
| Upscale video | `video-upscale` |
| Sync lips to audio | `lipsync` |
| Cinematic enhancement | `cinema-studio` |
| Control motion paths | `motion-control` |

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
2. Use the returned `public_url` as `input_image_url` or `input_url`

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
- **Video**: `generate_video` with chosen model
- **Edit**: `edit_media` with chosen tool
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
   - "Want to upscale this?"
   - "Want to animate this image into a video?"
   - "Want to edit or modify this result?"

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
→ Auto-selects `gpt-image-1.5`, crafts enhanced prompt, returns result

### Specific Model
```
/generate soul style image of a warrior character
```
→ Uses Soul model, can apply style presets

### Image to Video
```
/generate animate this image into a video: /path/to/image.png
```
→ Uploads file, uses DOP model with motion presets

### Edit
```
/generate upscale this: https://example.com/image.jpg
```
→ Uses `edit_media` with `upscale` tool

### Speech
```
/generate speech video saying "Welcome to our platform"
```
→ Uses `generate_speech`
