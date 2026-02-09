# BR-014: Higgsfield MCP Server (Full Platform SDK)

**Type:** Feature / Infrastructure
**Priority:** P1 - High
**Effort:** M - Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Monarch
**Status:** In Progress
**Created:** 2026-02-08
**Completed:** _(pending)_

---

## Problem

**What's broken or missing?**

The existing Higgsfield MCP server (`~/.local/share/higgsfield_ai_mcp/`) only supports a limited set of models (Soul text-to-image, DOP video, speech) through direct REST API calls with a non-standard auth pattern. The Soul model is currently offline, blocking asset generation across projects.

Higgsfield now offers 15+ models (Nano Banana Pro, Seedream 4.5, FLUX.2, GPT Image 1.5, Reve, Sora 2, Kling 2.6, Veo 3.1, etc.) plus editing tools (Inpaint, Upscale, Relight, Face Swap, etc.) - none of which are accessible through the existing MCP.

An official Python SDK (`higgsfield-client`) exists with a unified `submit(application, arguments)` pattern that covers ALL models through a single endpoint.

**Why does it matter?**

- Content generation workflows across all projects need multi-model access
- The existing MCP uses an outdated auth pattern and limited endpoint set
- Subagents need MCP tool access for a dedicated content-generation workflow
- Cross-project dependency: fifty_eco_system/BR-071 (Tactical Grid) asset generation is blocked

---

## Goal

**What should happen after this brief is completed?**

A new Higgsfield MCP server built on the official `higgsfield-client` SDK that:
1. Exposes ALL Higgsfield models through unified MCP tools
2. Supports image generation, video generation, editing tools, and speech
3. Uses the official SDK auth pattern (`HF_KEY` or `HF_API_KEY`+`HF_API_SECRET`)
4. Provides metadata tools (list styles, list motions, character management)
5. Handles job polling and result retrieval through the SDK
6. Is installable via pipx and configurable in Claude Code

---

## Context & Inputs

### Architecture Decision: Option B (Unified SDK Approach)

Use the official `higgsfield-client` SDK as the foundation. The SDK covers ALL generation via `submit(application_path, arguments)`. Only 3 gaps require direct REST:
- List styles (`GET /v1/text2image/soul-styles`)
- List motions (`GET /v1/motions`)
- Character CRUD (`POST/GET/DELETE /v1/custom-references`)

### SDK Details

- **Package:** `higgsfield-client` v0.1.0 (already installed in pipx venv)
- **Location:** `~/.local/pipx/venvs/higgsfield-mcp/lib/python3.14/site-packages/higgsfield_client/`
- **Base URL:** `https://platform.higgsfield.ai`
- **Auth:** `Authorization: Key {api_key}` where key = `HF_KEY` env var or `{HF_API_KEY}:{HF_API_SECRET}`
- **Core pattern:**
  ```python
  from higgsfield_client import AsyncClient
  client = AsyncClient()
  controller = await client.submit(application="model/path", arguments={...})
  result = await controller.get()  # polls until complete
  ```
- **File uploads:** `await client.upload(data, content_type)` returns public URL
- **Job management:** `await client.status(request_id)`, `await client.cancel(request_id)`

### Available Models (Application Paths)

**Image Generation:**
| Model | Application Path | Key Features |
|-------|-----------------|--------------|
| Soul | `higgsfield/soul/v2/text-to-image` | Styles, character refs |
| Nano Banana Pro | `google/gemini-3-pro/text-to-image` | 4K, text rendering |
| Seedream 4.5 | `bytedance/seedream/v4.5/text-to-image` | Photorealistic |
| FLUX.2 | `black-forest-labs/flux/v2/text-to-image` | Creative |
| GPT Image 1.5 | `openai/gpt-image/v1.5/text-to-image` | Versatile |
| Reve | `reve/reve/v1/text-to-image` | Artistic |
| Popcorn | `bytedance/popcorn/v1/text-to-image` | Stylized |
| Z Image Turbo | `z-image/turbo/v1/text-to-image` | Fast |

**Video Generation:**
| Model | Application Path | Key Features |
|-------|-----------------|--------------|
| DOP | `higgsfield/dop/v1/image-to-video` | Motions, turbo/lite/preview |
| Sora 2 | `openai/sora/v2/text-to-video` | Text-to-video |
| Kling 2.6 | `kuaishou/kling/v2.6/text-to-video` | High quality |
| Veo 3.1 | `google/veo/v3.1/text-to-video` | Long form |
| Wan 2.6 | `alibaba/wan/v2.6/text-to-video` | Diverse styles |
| Minimax 02 | `minimax/minimax/v02/text-to-video` | Efficient |
| Seedance 1.5 Pro | `bytedance/seedance/v1.5-pro/image-to-video` | Dance/motion |

**Editing Tools:**
| Tool | Application Path |
|------|-----------------|
| Inpaint | `higgsfield/inpaint/v1/edit` |
| Upscale | `higgsfield/upscale/v1/edit` |
| Relight | `higgsfield/relight/v1/edit` |
| Face Swap | `higgsfield/face-swap/v1/edit` |
| Character Swap | `higgsfield/character-swap/v1/edit` |
| Draw to Edit | `higgsfield/draw-to-edit/v1/edit` |
| Video Upscale | `higgsfield/video-upscale/v1/edit` |
| Lipsync | `higgsfield/lipsync/v1/edit` |
| Cinema Studio | `higgsfield/cinema-studio/v1/edit` |
| Motion Control | `higgsfield/motion-control/v1/edit` |

**Speech:**
| Feature | Application Path |
|---------|-----------------|
| Speech Video | `higgsfield/speak/v1/speech` |

### Layers Touched
- [x] Other: New standalone MCP server package

### Dependencies
- [x] Existing package: `higgsfield-client` v0.1.0 (official SDK)
- [x] Existing package: `mcp` (Model Context Protocol server library)
- [x] External API: Higgsfield AI Platform

---

## Constraints

### Architecture Rules
- Use official SDK (`higgsfield-client`) as the primary interface - no raw HTTP for generation
- Only use direct REST for 3 metadata gaps (styles, motions, characters)
- Follow MCP server best practices (proper tool schemas, error handling)
- Auth via environment variables only (never hardcode keys)

### Technical Constraints
- Must work with Claude Code's MCP server configuration
- Must support both sync polling and async patterns
- Job status polling should have configurable timeouts
- Large results (images/videos) should return URLs, not binary data

### Out of Scope
- Web UI for the MCP server
- Caching layer (can be added later)
- Rate limiting (rely on platform limits)
- Multi-tenant auth (single user)

---

## Tasks

### Pending
- [ ] Task 1: Project scaffolding (pyproject.toml, package structure, entry point)
- [ ] Task 2: SDK client wrapper (unified generation, metadata endpoints)
- [ ] Task 3: MCP tool definitions (image gen, video gen, editing, speech, utilities)
- [ ] Task 4: Job status polling and result formatting
- [ ] Task 5: Character management tools (create, get, delete)
- [ ] Task 6: Style and motion listing tools
- [ ] Task 7: File upload tool (local file -> Higgsfield CDN URL)
- [ ] Task 8: Error handling and user-friendly messages
- [ ] Task 9: Installation and Claude Code configuration
- [ ] Task 10: Testing with live API (generate test image)

### In Progress
_(none)_

### Completed
_(none)_

---

## Session State (Tactical - This Brief)

**Current State:** BUILDING phase complete, ready for TESTING
**Next Steps When Resuming:** Test MCP server with live API
**Active Agent:** none
**Agent Log:**
- [2026-02-09] ARCHITECT: Plan approved — 9 unified tools, SDK-first, registry pattern
- [2026-02-09] FORGER: Built complete MCP server — 14 files, 26 models, 9 tools. Installed via pipx v2.0.0. Updated claude.json env vars (HF_API_KEY/HF_API_SECRET)
**Last Updated:** 2026-02-08
**Blockers:** None

---

## Acceptance Criteria

### Must Have
1. [ ] MCP server starts and registers tools with Claude Code
2. [ ] Can generate images using at least 3 different models (Soul, Nano Banana Pro, Seedream)
3. [ ] Can generate videos using DOP model
4. [ ] Can check job status and retrieve results
5. [ ] Auth works via `HF_KEY` or `HF_API_KEY`+`HF_API_SECRET` env vars
6. [ ] Error messages are clear and actionable
7. [ ] Installable via pipx

### Should Have
8. [ ] All image models accessible
9. [ ] All video models accessible
10. [ ] Editing tools accessible (inpaint, upscale, relight)
11. [ ] Character management (create, list, delete)
12. [ ] Style and motion listing
13. [ ] File upload for image/video inputs

### Nice to Have
14. [ ] Speech video generation
15. [ ] Cinema Studio and Motion Control tools
16. [ ] Batch generation support

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Image Generation
**Steps:**
1. Configure MCP server in Claude Code
2. Use generate_image tool with Nano Banana Pro model
3. Verify image URL is returned and accessible

**Expected Result:** Valid image URL returned, image viewable

#### Test Case 2: Job Status Polling
**Steps:**
1. Submit a generation job
2. Check status while processing
3. Wait for completion

**Expected Result:** Status transitions from queued -> in_progress -> completed

#### Test Case 3: Auth Failure
**Steps:**
1. Remove HF_KEY env var
2. Attempt generation

**Expected Result:** Clear error message about missing credentials

---

## Delivery

### Code Changes
- [ ] New package: `tools/higgsfield_mcp/` (standalone, not in fifty_eco_system)
- [ ] pyproject.toml with dependencies
- [ ] src/higgsfield_mcp/server.py (MCP server)
- [ ] src/higgsfield_mcp/client.py (SDK wrapper)
- [ ] src/higgsfield_mcp/tools.py (tool definitions)
- [ ] src/higgsfield_mcp/models.py (application path registry)

### Configuration Changes
- [ ] Claude Code MCP config update (`~/.claude.json` or project config)
- [ ] Environment variables: `HF_KEY` or `HF_API_KEY` + `HF_API_SECRET`

---

## Notes

- The official SDK uses a unified `submit(application, arguments)` pattern where `application` is the model path (e.g., `google/gemini-3-pro/text-to-image`)
- This replaces the existing MCP at `~/.local/share/higgsfield_ai_mcp/` which only supports Soul, DOP, and speech
- Consider adding a Claude Code Skill alongside this MCP for content-generation prompt patterns and brand guidelines
- Application paths listed above are based on research and may need verification against live API
- Cross-project: fifty_eco_system/BR-071 (Tactical Grid) asset generation depends on this

---

**Created:** 2026-02-08
**Last Updated:** 2026-02-08
**Brief Owner:** Igris AI
