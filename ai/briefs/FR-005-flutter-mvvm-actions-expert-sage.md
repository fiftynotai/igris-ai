# FR-005: Add Flutter MVVM + Actions Expert Subagent (SAGE)

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-12-24
**Completed:** 2025-12-24

---

## Feature Description

**What is the proposed feature?**

Add a new Tier 5 custom subagent called `flutter-mvvm-actions-expert` (persona alias: SAGE) that provides deep expertise in the **Kalvad MVVM + Actions Layer Architecture** with GetX. This agent understands the complete pattern: View → Action → ViewModel → Service → Model, with proper layer separation and reactive state management.

**Why is this valuable?**

The Kalvad architecture solves the common MVVM problem of mixing UX concerns with business logic. SAGE ensures all Flutter code follows this pattern correctly, using the existing template classes (ApiResponse, ActionPresenter, ApiService, ApiHandler) rather than recreating them.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI on Flutter projects)
- [x] System (Igris AI itself - dogfooding on Flutter apps)

### Pain Point Solved
**Current situation:**
Generic agents can write Dart code but don't understand the Kalvad architecture's layer boundaries, the Actions layer concept, or when to use ApiResponse vs boolean flags.

**With this feature:**
SAGE enforces proper architecture: Actions handle UX (loaders, toasts), ViewModels handle business logic, Services handle data access. No layer skipping. Uses template classes correctly.

---

## Technical Approach

### High-Level Design
Create agent prompt file with full architecture documentation, register in manifest as Tier 5, add SAGE alias.

### Components Affected
- `.claude/agents/flutter-mvvm-actions-expert.md`: New agent prompt file
- `.claude/agents/manifest.yaml`: Add agent registration
- `ai/persona.json`: Add SAGE alias

### Triggers
```
- "flutter"
- "mvvm"
- "actions layer"
- "getx"
- "kalvad"
- "sage"
```

---

## Tasks

### Pending
_(none)_

### In Progress
_(none)_

### Completed
- [x] Create FR-005 brief (completed: 2025-12-24)
- [x] Create flutter-mvvm-actions-expert.md agent prompt (completed: 2025-12-24)
- [x] Add agent to manifest.yaml Tier 5 (completed: 2025-12-24)
- [x] Add SAGE alias to persona.json (completed: 2025-12-24)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
All tasks completed.

### Next Steps
None - brief complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2025-12-24 | orchestrator | created brief | FR-005 registered |
| 2025-12-24 | orchestrator | created agent prompt | flutter-mvvm-actions-expert.md |
| 2025-12-24 | orchestrator | updated manifest | agent_count: 13 |
| 2025-12-24 | orchestrator | updated persona | SAGE alias added |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [x] `flutter-mvvm-actions-expert.md` exists in `.claude/agents/`
2. [x] Agent registered in `manifest.yaml` under Tier 5
3. [x] SAGE alias added to `persona.json` agent_aliases
4. [x] Agent enforces Kalvad MVVM + Actions Layer patterns
5. [x] Agent knows template classes (ApiResponse, ActionPresenter, ApiService, ApiHandler)

---

## Notes

**Architecture Golden Rule:**
"Is this about WHAT the user wants (Action), HOW to do it (ViewModel), or WHERE to get it (Service)?"

**Key Patterns:**
- ApiResponse<T> for async state (not boolean flags)
- ActionPresenter with actionHandler() for UX
- ApiService base class for HTTP
- ApiHandler widget for state-based rendering
- RouteManager for navigation (not Get.to())

**Reference:** https://github.com/KalvadTech/flutter-mvvm-actions-arch

---

**Created:** 2025-12-24
**Last Updated:** 2025-12-24
**Brief Owner:** Crimson (Igris AI)
