# Igris AI Brief-First Protocol

These rules enforce the brief-first workflow requirement before any file modifications.

---

## Brief Requirement Validation

**Before ANY file modification (Edit/Write/NotebookEdit):**

1. **Does this task write/modify files?**
   - NO -> Skip (Read/Grep/Glob allowed without brief)
   - YES -> Continue to step 2

2. **Does a brief file exist for this work?**
   - YES -> Proceed with implementation
   - NO -> **STOP** - Create brief first

---

## Brief NOT Required For

- Read-only operations (Read, Grep, Glob)
- Listing/showing status
- Research and questions
- Git status/log viewing

---

## Brief Workflow Operations

### Registration (Create Brief Only - Don't Implement)

**Trigger phrases:**
- "register a bug/feature"
- "create a brief"
- "don't implement yet"
- "add to queue"

**Actions:**
1. Scan `ai/briefs/` to find next available number (BR-001, BR-002, etc.)
2. Create brief file from appropriate template
3. Set Status: "Ready" (or "Draft" if info incomplete)
4. Set Priority, Effort, Type
5. DO NOT load context files
6. DO NOT start implementation
7. DO NOT create TodoWrite tasks

**Response:** "Brief registered: BR-XXX. To implement: 'Implement BR-XXX'"

---

### Listing Briefs

**Trigger phrases:**
- "list all bugs/features"
- "show bug briefs"
- "list P0 bugs"
- "show features in Ready status"

**Actions:**
1. Read all files in `ai/briefs/` (exclude templates)
2. Parse metadata from each file (Type, Priority, Status, Effort)
3. Filter by Type if specified (bugs vs features)
4. Filter by Priority if specified (P0, P1, etc.)
5. Filter by Status if specified (Ready, In Progress, etc.)
6. Format as organized table

---

### Implementation (Full Workflow)

**Trigger phrases:**
- "implement BR-XXX"
- "fix BR-XXX"
- "build BR-XXX"
- "start working on BR-XXX"

**Actions:**
1. Read brief from `ai/briefs/[TYPE]-XXX-*.md`
2. Update Status: "Ready" -> "In Progress"
3. Load context files (coding_guidelines -> architecture_map -> api_pattern)
4. Create/update `ai/session/CURRENT_SESSION.md`
5. Create TodoWrite tasks from acceptance criteria
6. Follow workflow: **Plan -> Patch -> Tests -> Run -> Commit**
7. After commit succeeds, update Status: "In Progress" -> "Done"

---

### Other Operations

- **Prioritization:** "change BR-XXX priority to P0"
- **Status updates:** "mark BR-XXX as Done"
- **Next task:** "what should I work on next?"
- **Archiving:** "archive BR-XXX" (only if Status: Done)

---

## Brief Types

| Type | Prefix | Purpose |
|------|--------|---------|
| Bug/Feature | BR-XXX | General bugs and features |
| Technical Debt | TD-XXX | Code quality improvements |
| Migration | MG-XXX | System migrations |
| Testing | TS-XXX | Test additions/improvements |
| Process Improvement | PI-XXX | Workflow improvements |
| Feature Request | FR-XXX | New feature ideas |
| Dependency Update | DU-XXX | Dependency updates |
| Performance | PF-XXX | Performance improvements |
| Architecture Cleanup | AC-XXX | Architecture refactoring |

Each type has independent numbering (PI-001, FR-001, etc.)

---

## Brief Format Expectations

Every brief MUST have:
- **Problem:** What's broken or missing?
- **Goal:** What should happen after the fix/feature?
- **Context and Inputs:** Relevant modules, APIs, data
- **Constraints:** Architecture rules, timeline, scope
- **Acceptance Criteria:** Testable outcomes
- **Test Plan:** How to verify manually + automated tests
- **Delivery:** Migrations, feature flags, docs to update

---

## Session Management

- **Project Level:** `ai/session/CURRENT_SESSION.md` - tracks active briefs
- **Brief Level:** Brief files in `ai/briefs/` - tracks workflow state, tasks, agents

### Quick Reference
- Update CURRENT_SESSION.md when: starting/completing briefs
- Update Brief file when: any work on that brief (tasks, agents, progress)
- Recovery: Read session -> get brief ID -> read brief -> check Workflow State

---

**Rule Purpose:** Ensure all file modifications are tracked and justified through the brief system.
