# BR-016: Higgsfield MCP Server — Wrong Model Paths

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09

---

## Problem

**What's broken or missing?**

All 8 image models and most video models return "Model not found" (404) from the Higgsfield API. The application paths in `registry.py` were guessed when building the MCP server (BR-014) and most are incorrect. Live API probing reveals:

- `higgsfield/soul/v2/text-to-image` → 404 (correct: `higgsfield-ai/soul/standard`)
- `bytedance/seedream/v4.5/text-to-image` → 404 (correct: `bytedance/seedream/v4/text-to-image`)
- `reve/reve/v1/text-to-image` → 404 (correct: `reve/text-to-image`)
- `kuaishou/kling/v2.6/text-to-video` → 404 (correct: `kling-video/v2.1/pro/image-to-video`)
- 9 models (flux-2, gpt-image-1.5, nano-banana-pro, popcorn, z-image-turbo, veo-3.1, wan-2.6, minimax-02) don't exist on the API at all
- All 10 editing tools (inpaint, upscale, relight, etc.) don't exist on the API
- Speech endpoint uses a different REST surface (`/v1/speak/higgsfield` with `params` wrapper)

**Why does it matter?**

The entire Higgsfield MCP integration is non-functional. Zero models can be used.

---

## Goal

**What should happen after this brief is completed?**

All 18 verified Higgsfield API models work correctly through the MCP server. Registry reflects only real, API-verified models with correct application paths.

---

## Context & Inputs

### Verified Model Catalog (18 models)

**Image Generation (5):**
1. `higgsfield-ai/soul/standard` — Soul Standard
2. `higgsfield-ai/soul/reference` — Soul Reference
3. `higgsfield-ai/soul/character` — Soul Character
4. `reve/text-to-image` — Reve
5. `bytedance/seedream/v4/text-to-image` — Seedream v4

**Image Editing (1):**
6. `bytedance/seedream/v4/edit` — Seedream Edit

**Video — Image-to-Video (10):**
7. `higgsfield-ai/dop/lite` — DOP Lite
8. `higgsfield-ai/dop/standard` — DOP Standard
9. `higgsfield-ai/dop/turbo` — DOP Turbo
10. `higgsfield-ai/dop/lite/first-last-frame` — DOP Lite FLF
11. `higgsfield-ai/dop/standard/first-last-frame` — DOP Standard FLF
12. `higgsfield-ai/dop/turbo/first-last-frame` — DOP Turbo FLF
13. `kling-video/v2.1/pro/image-to-video` — Kling v2.1 Pro
14. `kling-video/v2.1/standard/image-to-video` — Kling v2.1 Standard
15. `bytedance/seedance/v1/pro/image-to-video` — Seedance Pro
16. `bytedance/seedance/v1/lite/image-to-video` — Seedance Lite

**Video — Text-to-Video (1):**
17. `sora-2/text-to-video` — Sora 2

**Speech (1 — REST /v1/ endpoint):**
18. `/v1/speak/higgsfield` — Speak (uses `{"params": {...}}` format)

### Affected Modules
- [x] `tools/higgsfield-mcp/src/higgsfield_mcp/registry.py`
- [x] `tools/higgsfield-mcp/src/higgsfield_mcp/tools/generate.py`
- [x] `tools/higgsfield-mcp/src/higgsfield_mcp/tools/edit.py`
- [x] `tools/higgsfield-mcp/src/higgsfield_mcp/tools/speech.py`
- [x] `tools/higgsfield-mcp/src/higgsfield_mcp/server.py`
- [x] `.claude/skills/higgsfield/SKILL.md`

### Related Files
- `tools/higgsfield-mcp/src/higgsfield_mcp/rest_client.py` — may need updates for speech
- `.claude.json` — MCP server config (no changes needed)

### API Reference
- Docs: https://docs.higgsfield.ai/
- Base URL: `https://platform.higgsfield.ai`
- Auth: `Authorization: Key {api_key}:{api_secret}`
- Submit: `POST /{model_id}` with JSON body
- Status: `GET /requests/{request_id}/status`
- Cancel: `POST /requests/{request_id}/cancel`

---

## Constraints

### Architecture Rules
- Keep SDK `client.submit()` for all models except speech
- Speech requires REST client with `params` wrapper to `/v1/speak/higgsfield`
- Maintain lazy singleton pattern for clients

### Out of Scope
- Adding credits to the account (manual user action)
- Web-only editing tools (inpaint, upscale, relight, face-swap, lipsync, etc.)
- Models not available on API (flux-2, gpt-image, nano-banana-pro, etc.)

---

## Tasks

### Pending
- [ ] Task 1: Rewrite `registry.py` with 18 verified models and correct application paths
- [ ] Task 2: Update `generate.py` — fix image/video model enums and parameter handling
- [ ] Task 3: Rewrite `edit.py` — collapse to seedream-edit only (uses `image_urls` param)
- [ ] Task 4: Fix `speech.py` — use REST client with `/v1/speak/higgsfield` and `params` wrapper
- [ ] Task 5: Update `server.py` — adjust tool handler mapping
- [ ] Task 6: Update `/higgsfield` skill to reflect correct model catalog
- [ ] Task 7: Reinstall MCP server via pipx

### In Progress

### Completed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered, ready for HUNT.

### Next Steps
Start PLANNING phase — delegate to architect.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

1. [ ] All 5 image models return 403 (credits) not 404 when called
2. [ ] All 11 video models return 403 (credits) not 404 when called
3. [ ] Seedream edit returns 400 (missing params) not 404
4. [ ] Speech endpoint returns 422 (validation) not 404
5. [ ] No phantom models in registry (only 18 verified)
6. [ ] MCP tool schemas reflect correct model enums
7. [ ] `/higgsfield` skill updated with correct model names
8. [ ] `pipx` reinstall succeeds cleanly

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Image Generation Path Verification
**Steps:**
1. Call `generate_image` with model="soul" and a test prompt
2. Verify response is 403 (credits) not 404 (model not found)
3. Repeat for reve, seedream, soul-reference, soul-character

**Expected Result:** All return credit error, not model-not-found

#### Test Case 2: Video Generation Path Verification
**Steps:**
1. Call `generate_video` with model="dop" and test params
2. Verify non-404 response
3. Repeat for all video models

**Expected Result:** All return credit/validation error, not 404

---

## Delivery

### Code Changes
- [ ] Modified: `registry.py` (complete rewrite)
- [ ] Modified: `generate.py` (enum + param fixes)
- [ ] Modified: `edit.py` (collapse to seedream-edit)
- [ ] Modified: `speech.py` (REST client approach)
- [ ] Modified: `server.py` (handler mapping)
- [ ] Modified: `.claude/skills/higgsfield/SKILL.md`

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Crimson (Igris AI)
