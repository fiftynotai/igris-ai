---
name: ideate
description: Feature brainstorming and ideation - value/effort matrix, feature briefs
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - mcp__igris-brain__igris_brief_create
triggers:
  - "IDEATE"
  - "ORACLE"
  - "suggest features"
  - "brainstorm"
  - "what could we add"
  - "feature ideas"
  - "suggest improvements"
---

# Ideate Skill

Feature brainstorming and ideation workflow. Generates ideas, assesses value vs effort, and creates FR-XXX briefs for promising concepts.

## Arguments

`$ARGUMENTS` can specify focus area:
- Empty: General brainstorming for the project
- Topic: Focus brainstorming on specific area (e.g., "UX", "performance", "API")

## Capabilities

1. **Feature Brainstorming** - Generate new feature ideas
2. **Improvement Suggestions** - Enhance existing features
3. **UX Analysis** - Identify user experience gaps
4. **Integration Ideas** - Suggest useful integrations
5. **Value Assessment** - Estimate idea impact vs effort
6. **Feature Ideation Audit** - Systematic feature generation with FR-XXX briefs

## Value/Effort Matrix

Use this matrix to prioritize ideas:

```
         | Low Effort | Med Effort | High Effort
---------+------------+------------+-------------
High Val | DO NOW     | PLAN       | CONSIDER
Med Val  | QUICK WIN  | BACKLOG    | MAYBE
Low Val  | IF TIME    | SKIP       | SKIP
```

## Workflow

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "ideate" 2>/dev/null || true
```

### Step 1: Understand Context
- Read project structure and purpose
- Understand existing features
- Identify target users
- Review existing briefs for prior ideas

### Step 2: Generate Ideas
- Brainstorm features aligned with project goals
- Consider user pain points
- Look for integration opportunities
- Think about automation possibilities

### Step 3: Assess Each Idea
For each promising idea:
- **Value:** How much does this help users? (High/Med/Low)
- **Effort:** How hard to implement? (Low/Med/High)
- **Feasibility:** Can we build this with current architecture?
- **Matrix Position:** DO NOW / QUICK WIN / PLAN / etc.

### Step 4: Create FR Briefs
For ideas rated DO NOW or QUICK WIN:
- Create via `igris_brief_create` MCP tool, fallback to cache write at `~/.igris/projects/{project}/briefs/FR-XXX-{name}.md`
- Include value assessment and effort estimate
- Reference related existing features

## Constraints

1. **NEVER implement ideas** - Ideation only, create briefs
2. **ALWAYS assess feasibility** - Don't suggest impossible features
3. **ALWAYS consider existing patterns** - Build on what exists
4. **ALWAYS estimate effort honestly** - No fantasy sizing
5. **ALWAYS tie to user value** - No tech for tech's sake

## Output Format

```markdown
# Feature Ideation: {focus area}

## Ideas

### 1. {Idea Name}
- **Value:** High | **Effort:** Low | **Matrix:** DO NOW
- **Description:** {what it does}
- **User Benefit:** {why it matters}
- **Brief:** FR-XXX created

### 2. {Idea Name}
- **Value:** Med | **Effort:** Med | **Matrix:** BACKLOG
- **Description:** {what it does}
- ...

## Summary
- DO NOW: {count} ideas
- QUICK WIN: {count} ideas
- PLAN: {count} ideas
- BACKLOG: {count} ideas
```
