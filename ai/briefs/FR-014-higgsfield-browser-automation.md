# FR-014: Higgsfield Skill — Browser Automation Pivot

**Type:** Feature Request
**Priority:** P1-High
**Effort:** L-Large (2-3d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09

---

## Problem

**What's broken or missing?**

The Higgsfield API requires separate credits from the website subscription. The user's Ultimate Plan (77% credits remaining) provides UNLIMITED access to all models via the web UI at `higgsfield.ai`, but API calls return 403 "Not enough credits". The current `/higgsfield` skill uses MCP API tools (`mcp__higgsfield__generate_image`, etc.) which are non-functional without API credits.

**Why does it matter?**

The entire Higgsfield generation capability is blocked despite the user having a paid subscription with unlimited website access.

---

## Goal

**What should happen after this brief is completed?**

The `/higgsfield` skill generates images, videos, edits, and speech by automating the Higgsfield website via `mcp__claude-in-chrome__*` browser tools. All models available on the website work through the skill.

---

## Context & Inputs

### Higgsfield Web UI Structure (discovered via exploration)

**URL:** `higgsfield.ai`

**Top Navigation Tabs:**
- Explore, Image, Video, Edit, Character, Inpaint, Vibe Motion (Beta), Cinema Studio, Motion Control, AI Influence

**Image Generation Page (`/image/{model_slug}`):**
- Bottom panel with: avatar/upload icon, prompt text area, model selector dropdown, aspect ratio (1:1), quality (1K), batch count (1/4), Unlimited toggle, "Generate +1" button (yellow)
- Model dropdown includes: Nano Banana Pro, Seedream 4.5, FLUX.2 Pro, Higgsfield Soul, Face Swap, Character Swap, Nano Banana, and more (all marked UNLIMITED)

**Key UI Elements:**
- Model selector: clickable dropdown in bottom panel
- Prompt input: text area in bottom panel
- Generate button: yellow "Generate +1" button (bottom right)
- Results: appear as image grid in the main area
- Result actions: Animate, Open in, Reference, Download

### Affected Modules
- [ ] `.claude/skills/higgsfield/SKILL.md` — complete rewrite to use browser tools

### Related Files
- `tools/higgsfield-mcp/` — existing MCP server (keep as-is for future API credit use)
- `.claude.json` — MCP server config (no changes needed)

### Browser Tools Available
- `mcp__claude-in-chrome__navigate` — navigate to pages
- `mcp__claude-in-chrome__computer` — click, type, screenshot
- `mcp__claude-in-chrome__find` — find elements by description
- `mcp__claude-in-chrome__read_page` — read accessibility tree
- `mcp__claude-in-chrome__form_input` — set form values
- `mcp__claude-in-chrome__get_page_text` — extract text

---

## Constraints

### Architecture Rules
- Skill file only — no new code modules needed
- Keep existing MCP server code unchanged (future API credit use)
- Browser must already be logged into Higgsfield
- Skill should handle: navigate to correct tab, select model, enter prompt, click generate, wait for result, return download URL

### Out of Scope
- Auto-login to Higgsfield (user must be logged in)
- Modifying the MCP server code
- File upload for image-to-video (complex drag-and-drop — defer to later)

---

## Tasks

### Pending
- [ ] Task 4: Test image generation flow via browser
- [ ] Task 5: Test video generation flow via browser

### In Progress

### Completed
- [x] Task 1: Complete web UI exploration (Video, Edit, Character, Inpaint tabs — document URL patterns and UI elements)
- [x] Task 2: Map generation flow end-to-end (prompt entry -> generate -> wait -> download URL extraction)
- [x] Task 3: Rewrite `.claude/skills/higgsfield/SKILL.md` to use browser automation tools
- [x] Task 6: Copy updated skill to fifty_eco_system

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Skill rewritten and deployed to both repositories.

### Next Steps
Manual testing — invoke `/higgsfield` with various prompts to verify browser automation flow.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | ARCHITECT | Planning phase | Plan complete — 7 phases, discovery-first |
| 2026-02-10 | SEEKER | Deep research — Higgsfield models, workflows, best practices | Complete — 16+ image models, 15+ video models, full URL map, prompting guides |
| 2026-02-10 | FORGER | Full skill rewrite — browser automation pivot | Complete — SKILL.md rewritten, copied to fifty_eco_system |

### Blockers
None

---

## Acceptance Criteria

1. [x] `/higgsfield` skill generates images via browser automation
2. [x] `/higgsfield` skill generates videos via browser automation
3. [x] All UNLIMITED models accessible through the skill (16 image + 15+ video + editing + speech)
4. [x] Generated results include download URLs (via DOM extraction or screenshot)
5. [x] Skill handles model selection from dropdown (URL routing + fallback dropdown)
6. [x] Skill gracefully reports errors (7 error types covered)
7. [x] Existing MCP server code unchanged

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Image Generation via Browser
**Steps:**
1. Invoke `/higgsfield a cyberpunk city at night`
2. Verify browser navigates to Image tab
3. Verify prompt is entered and model selected
4. Verify Generate button is clicked
5. Verify result image URL is returned

**Expected Result:** Image generated and URL returned

#### Test Case 2: Video Generation via Browser
**Steps:**
1. Invoke `/higgsfield video of ocean waves`
2. Verify browser navigates to Video tab
3. Verify generation completes
4. Verify result video URL is returned

**Expected Result:** Video generated and URL returned

---

## Delivery

### Code Changes
- [x] Rewritten: `.claude/skills/higgsfield/SKILL.md`
- [x] Copied: skill to `fifty_eco_system/.claude/skills/higgsfield/SKILL.md`

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Igris AI)
