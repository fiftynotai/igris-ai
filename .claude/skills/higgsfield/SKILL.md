---
name: higgsfield
description: Generate images, videos, edits, or speech using Higgsfield AI via browser automation
disable-model-invocation: true
allowed-tools:
  - mcp__claude-in-chrome__navigate
  - mcp__claude-in-chrome__computer
  - mcp__claude-in-chrome__find
  - mcp__claude-in-chrome__read_page
  - mcp__claude-in-chrome__form_input
  - mcp__claude-in-chrome__get_page_text
  - mcp__claude-in-chrome__take_screenshot
  - mcp__claude-in-chrome__javascript_tool
  - mcp__claude-in-chrome__tabs_context_mcp
  - mcp__claude-in-chrome__tabs_create_mcp
  - mcp__claude-in-chrome__upload_image
  - Read
triggers:
  - "higgsfield"
  - "higgsfield generate"
  - "generate with higgsfield"
  - "create image with higgsfield"
  - "create video with higgsfield"
  - "generate image"
  - "generate video"
  - "create image"
  - "create video"
---

# GENERATE - Asset Generation via Higgsfield AI (Browser Automation)

Generate images, videos, edits, or speech by automating the Higgsfield website via Chrome browser tools. Uses the user's UNLIMITED website subscription instead of API credits.

## Prerequisites

- Chrome must be open with the claude-in-chrome extension active
- User must be logged into `higgsfield.ai`
- If the user is not logged in, stop and tell them: "Please log in to higgsfield.ai in Chrome first, then retry."

## Arguments

`$ARGUMENTS` describes what to generate. Examples:
- `a cyberpunk city at night with neon signs`
- `video of a cat walking on a beach`
- `seedream photorealistic portrait of a woman in golden hour`
- `speech saying "hello world"`
- `edit this image to add sunglasses`
- `cinema studio cinematic shot of a forest`

If no arguments provided, ask the user what they want to generate.

---

## Model Selection Guide

When the user doesn't specify a model, pick the best one based on the task. Use the **Best Model Recommendations** table for quick selection.

### Best Model Recommendations

| Use Case | Best Pick | Why |
|----------|-----------|-----|
| General image | GPT Image 1.5 | Reasoning-first, perfect text, versatile |
| Photorealistic | Seedream 4.5 | 4K, fashion-grade, cinematic lighting |
| Anime / illustration | Reve | Concept art, anime, up to 4 refs |
| Text in image | Nano Banana Pro or GPT Image 1.5 | Native text rendering |
| Fastest image | Z-Image (1-3s) | Instant ideation |
| Highest quality image | FLUX.2 Max or Seedream 4.5 | Maximum detail |
| General video | Sora 2 | OpenAI quality, text-to-video |
| Best cinematic video | Kling 3.0 | 4K/60fps, native audio + dialogue |
| Fastest video | Minimax Hailuo 02 or Grok Imagine | Quick iteration |
| Video with audio | Grok Imagine or Kling 3.0 | Native audio generation |
| Animate a still image | DoP | 50+ motion presets |
| Lip sync / talking head | Speak 2.0 + Lipsync Studio | Text-to-speech with emotion |
| Motion transfer | Motion Control (Kling 2.6) | Transfer motion from reference video |
| Professional cinematic | Cinema Studio | Camera sensors, lenses, aperture, multi-shot |

### Image Models (16 models)

| Need | Model | URL Slug | Speed | Strengths |
|------|-------|----------|-------|-----------|
| General / versatile | GPT Image 1.5 | `gpt-1.5` | Fast | Reasoning-first, perfect text rendering, diagrams |
| Photorealistic portraits | Seedream 4.5 | `seedream-4.5` | Medium | 4K output, fashion-grade, cinematic lighting |
| Photorealistic (older) | Seedream 4.0 | `seedream` | Medium | Soft textures, studio composition |
| Creative / artistic | FLUX.2 Pro | `flux-2-pro` | Medium | Production-grade, reliable |
| Maximum quality | FLUX.2 Max | `flux-2-max` | Slower | Maximum detail, web search grounding |
| Developer control | FLUX.2 Flex | `flux-2-flex` | Variable | Adjustable steps/guidance, text rendering |
| Style presets / characters | Soul | `soul` | Medium | 60+ presets, Soul ID character refs |
| Text in images | Nano Banana Pro | `nano-banana-pro` | Fast (<10s) | Native 4K, up to 8 refs, best prompt-following |
| Multi-ref compositing | Nano Banana | `nano-banana` | Medium | Draw-to-edit, 8 references |
| Fastest generation | Z-Image | `z-image` | Very Fast (1-3s) | Instant ideation, minimal filtering |
| Artistic / painterly | Reve | `reve` | Medium | Concept art, anime, up to 4 refs |
| Hyperrealistic multi-style | Wan 2.2 Image | `wan2` | Medium | Character animation bridge |
| Multi-reference | Multi Reference | `multi-reference` | Medium | Up to 4 image references |
| Multimodal | Kling O1 Image | `kling-o1` | Medium | Up to 7 image refs |
| Reference editing | Kontext | `kontext` | Medium | Multi-reference generation/editing |
| OpenAI standard | GPT Image | `gpt-image` | Medium | Clean outputs, instruction following |

### Video Models (15+ models)

| Need | Model | URL Slug | Duration | Audio |
|------|-------|----------|----------|-------|
| Best cinematic (4K/60fps) | Kling 3.0 | `kling-3.0` | 3-15s | Native audio + dialogue |
| Cinematic with audio | Kling 2.6 | `kling-2.6` | 5-10s | Beat-sync, voice, lip-sync |
| Unified gen + edit | Kling O1 | `kling-o1` | 5-10s | - |
| Short stories, branded | Grok Imagine | `grok-imagine` | 1-15s | Native audio |
| Landscapes / atmospheric | Veo 3.1 | `veo-3.1` | 4-8s | With sound |
| Cinematic storytelling | Sora 2 | `sora-2` | Variable | - |
| Multi-shot cinematic | WAN 2.6 | `wan-2.6` | Up to 15s | With audio |
| General cinematic | WAN 2.5 | `wan-2.5` | Up to 10s | Native audio |
| Multi-asset generation | Seedance 2.0 | `seedance-2.0` | Up to 15s | Native + upload |
| Audio-visual sync | Seedance 1.5 Pro | `seedance-1.5-pro` | Variable | Native |
| Fast iteration | Minimax Hailuo 02 | `minimax-02` | Variable | - |
| Image animation | DoP | `dop` | Variable | - (50+ motion presets) |
| Stylized clips | Mixed Media | `mixed-media` | Up to 15s | Custom FPS |
| Video stabilize/refine | Sora 2 Enhancer | `sora-2-enhancer` | N/A | N/A |

### Editing Tools

| Need | Tool | URL Path |
|------|------|----------|
| Add/remove objects | Soul Inpaint | `/edit` |
| Structure-preserving edit | Nano Banana Pro Inpaint | `/edit` |
| Video editing | Kling O1 Edit | `/video-edit` |
| Video restyling | Grok Imagine Edit | (via Grok page) |
| Adjust lighting | Relight | `/app/relight` |
| Upscale to 4K | Upscale | `/library/upscale` |
| Face swap | Face Swap | `/app/face-swap` |
| Character swap | Character Swap 2.0 | `/app/character-swap` |
| Video face swap | Video Face Swap | `/app/video-face-swap` |
| Video character swap | Recast | `/app/recast` |

### Speech & Avatar

| Need | Tool | URL Path |
|------|------|----------|
| Text-to-speech with emotion | Speak 2.0 | `/create/speech` |
| Lip sync to audio | Lipsync Studio | `/lipsync-studio` |
| Talking head avatar | Kling AI Avatar | (via Kling page) |
| Long-form avatar | Kling Avatar 2.0 | (via Kling page) |

### Special Features

| Feature | URL Path | What It Does |
|---------|----------|--------------|
| Cinema Studio | `/cinema-studio` | Professional film suite — camera sensors, lenses, aperture, 21:9, multi-shot |
| Motion Control | `/create/motion-control` | Kling 2.6 — motion transfer from reference video, up to 30s |
| Vibe Motion | `/vibe-motion` | No-code motion graphics, AI-generated animation code |
| AI Influencer Studio | `/ai-influencer-studio` | Game-style character customizer, zero-prompting |
| 40+ Mini Apps | `/apps` then `/app/{slug}` | Specialized tasks (face swap, recast, angles, shots, transitions) |

---

## Prompting Guide

Per-model prompting tips for best results:

- **General:** Short direct sentences, active verbs, one action per shot. Be specific about composition, lighting, style, mood.
- **Nano Banana Pro:** Use the 6-variable framework: Subject, Composition, Action, Location, Style, Technical. Example: "A samurai warrior, centered full-body shot, drawing katana, on a misty mountain bridge, ukiyo-e watercolor style, 4K detailed"
- **Soul:** Leverage the 60+ built-in style presets via the Style dropdown. Use Soul ID for character consistency across generations.
- **Seedream 4.5:** Direct like a photo shoot — specify lighting (golden hour, studio softbox), fabric details, soft focus areas. Best for fashion and portrait work.
- **GPT Image 1.5:** Use structured reasoning prompts with explicit layout instructions. Great for diagrams, infographics, and text-heavy compositions.
- **Reve:** Emphasize artistic style keywords — "concept art", "anime cel-shading", "oil painting". Supports up to 4 reference images.
- **Z-Image:** Keep prompts simple and direct for fastest results. Best for rapid ideation and iteration.
- **Speak 2.0:** Use stage directions in brackets `[whispers]`, ALL CAPS for emphasis, `...` for pauses. Example: "Welcome to... [dramatic pause] the FUTURE of AI."
- **Cinema Studio:** Specify camera body (RED V-Raptor, ARRI ALEXA), lens (anamorphic, 85mm prime), focal length, aperture (f/1.4 for shallow DOF), and aspect ratio (21:9 for cinematic).
- **Video models:** Describe the motion and camera movement explicitly. "Slow dolly forward through a foggy forest, golden light filtering through trees, handheld subtle shake"

---

## Execution Flow

### Step 1: Parse the Request

From `$ARGUMENTS`, determine:
- **Asset type**: image, video, edit, speech, cinema, motion-control, or app
- **Subject/prompt**: what to generate
- **Model preference**: if user specified a model name, match to the model tables above
- **Input files**: if user references a local file path for editing/animation

If asset type is ambiguous, default to **image**.

### Step 2: Open Higgsfield Tab

1. Call `tabs_context_mcp` to check if a `higgsfield.ai` tab is already open
2. If found: switch to that tab
3. If not found: call `tabs_create_mcp` to open a new tab
4. Navigate to the target URL based on generation type + model:

**URL routing:**
- Image: `https://higgsfield.ai/image/{model_slug}` (e.g., `/image/gpt-1.5`, `/image/seedream-4.5`)
- Video (text-to-video): `https://higgsfield.ai/create/video` (then select model from dropdown)
- Video (image-to-video with DoP): `https://higgsfield.ai/image/dop`
- Edit / Inpaint: `https://higgsfield.ai/edit`
- Video Edit: `https://higgsfield.ai/video-edit`
- Speech: `https://higgsfield.ai/create/speech`
- Cinema Studio: `https://higgsfield.ai/cinema-studio`
- Motion Control: `https://higgsfield.ai/create/motion-control`
- Upscale: `https://higgsfield.ai/library/upscale`
- Mini Apps: `https://higgsfield.ai/app/{slug}` (e.g., `/app/face-swap`, `/app/relight`)

### Step 3: Verify Page State

1. Call `read_page` to get the accessibility tree
2. Verify: correct page loaded, no login modal/redirect
3. If login page or auth modal detected: **STOP** — tell user "Please log in to higgsfield.ai in Chrome first, then retry."
4. Call `take_screenshot` for visual confirmation of page state

### Step 4: Upload Source Files (if needed)

If the request involves editing, image-to-video, or reference images:
1. Look for an upload area/button on the page via `read_page` or `find`
2. Use `upload_image` to upload the source file from the local path
3. Verify the upload completed by checking the page state

### Step 5: Configure Generation

1. **Enter prompt:** Find the prompt text area using `find` or `read_page`, then use `form_input` or `computer` (type action) to enter the crafted prompt
2. **Select model (if needed):** If the URL didn't route directly to the correct model:
   - Find the model selector dropdown
   - Click to open it
   - Find and click the target model name
3. **Set options (optional):** If user specified preferences:
   - Aspect ratio: find and click the ratio selector (1:1, 16:9, 9:16, 4:3, 21:9)
   - Quality: find and click quality setting (1K, 2K, 4K where available)
   - Duration (video): set duration if the model supports it
   - Batch count: set number of outputs if specified

### Step 6: Generate

1. Find the "Generate" button (typically yellow, labeled "Generate +1" or similar)
2. Click it using `computer` (click action)
3. Call `take_screenshot` to confirm generation has started
4. Look for loading indicators, progress bars, or "Generating..." text

### Step 7: Wait for Result

Poll for completion using appropriate intervals:
- **Images:** Check every 5-10 seconds, timeout at 120 seconds
- **Video:** Check every 10-15 seconds, timeout at 300 seconds
- **Cinema Studio:** Check every 15-20 seconds, timeout at 600 seconds

Polling method:
1. Use `javascript_tool` to check DOM for result elements (new images/videos appearing)
2. OR use `read_page` to detect result/download elements
3. OR use `take_screenshot` to visually check for completed results
4. Look for: new image thumbnails, video players, download buttons, or the generation spinner disappearing

If timeout reached: inform user the generation is still processing and they can check the Higgsfield library later.

### Step 8: Extract Result

Once generation is complete:
1. Use `javascript_tool` to query DOM for result image/video URLs (look for `<img src="...">` or `<video src="...">` in the result area)
2. OR find a "Download" button and extract its `href`
3. OR use `take_screenshot` of the result area to show the user visually
4. Return the URL(s) and/or screenshot to the user

### Step 9: Present Results

Show results and offer follow-ups based on what was generated:

**After image generation:**
- "Animate this into a video?" (→ DoP or other image-to-video model)
- "Upscale to 4K?" (→ Upscale tool)
- "Edit this result?" (→ Inpaint/Edit)
- "Try a different model?"

**After video generation:**
- "Enhance this video?" (→ Sora 2 Enhancer)
- "Try a different model?"
- "Generate another with different motion?"

**After speech/avatar:**
- "Try different emotion/tone?"
- "Lip sync to different audio?"

---

## Error Handling

| Error | How to Detect | Response |
|-------|---------------|----------|
| Not logged in | Login page, auth modal, or redirect to `/login` in `read_page` | "Please log in to higgsfield.ai in Chrome first, then retry." |
| Page not loading | Empty `read_page` result or error page | Retry navigation once. If still failing, report: "Could not load the Higgsfield page. Check your internet connection." |
| Model not available | 404 page or model missing from dropdown | Fall back to the default model for that asset type, inform user which model was used instead. |
| Generation failed | Error text in result area (e.g., "Generation failed", red error banner) | Show the error message, suggest trying a different model or rephrasing the prompt. |
| Timeout | No result after max wait time | "Generation is still processing. Check your Higgsfield library for results." |
| NSFW flagged | Warning modal or "content policy" message | "The prompt was flagged by Higgsfield's content filter. Try rephrasing with different terms." |
| Browser extension not responding | Tool calls returning errors | "The Chrome extension is not responding. Make sure Chrome is open with the claude-in-chrome extension active." |

---

## Examples

### Basic Image
```
/higgsfield a cyberpunk city at night with neon signs
```
-> Navigates to `/image/gpt-1.5`, enters prompt, clicks Generate, returns result

### Specific Model
```
/higgsfield seedream photorealistic portrait of a woman in golden hour
```
-> Navigates to `/image/seedream-4.5`, enters prompt, returns 4K photorealistic result

### Fast Draft
```
/higgsfield z-image quick concept sketch of a robot
```
-> Navigates to `/image/z-image`, generates in 1-3 seconds

### Text-to-Video
```
/higgsfield video of ocean waves crashing on a rocky shore at sunset
```
-> Navigates to `/create/video`, selects Sora 2, enters prompt, waits for result

### Cinematic Video
```
/higgsfield kling 3.0 cinematic 4K video of a samurai walking through rain
```
-> Navigates to video page, selects Kling 3.0, generates 4K/60fps with audio

### Image Animation
```
/higgsfield animate this image: /path/to/image.png
```
-> Navigates to `/image/dop`, uploads image, selects motion preset, generates video

### Speech
```
/higgsfield speech saying "Welcome to the future of AI" with dramatic tone
```
-> Navigates to `/create/speech`, enters text with `[dramatic]` direction, generates

### Cinema Studio
```
/higgsfield cinema studio shot of a forest with ARRI ALEXA 85mm anamorphic
```
-> Navigates to `/cinema-studio`, configures camera settings, generates cinematic shot

### Editing
```
/higgsfield edit: add sunglasses to this portrait
```
-> Navigates to `/edit`, uploads image, enters edit prompt, generates result

### Mini App
```
/higgsfield face swap my photo onto this character
```
-> Navigates to `/app/face-swap`, uploads source images, generates swap
