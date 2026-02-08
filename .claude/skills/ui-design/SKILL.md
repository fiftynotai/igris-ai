---
name: ui-design
description: UI design guidelines and workflow - accessibility, component states, responsive design, dark mode
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
triggers:
  - "ui design"
  - "design component"
  - "ARTISAN"
  - "accessibility"
  - "design system"
  - "component states"
  - "responsive design"
---

# UI Design Skill

Visual design workflow for creating intuitive, accessible user interfaces.

**Note:** This skill can be preloaded by forger for UI-focused briefs.

## Arguments

`$ARGUMENTS` describes the component or feature to design.

## Workflow

### Step 1: Gather Design Context

Before designing, gather:
- Brand guidelines / design system (if exists)
- Target platform (iOS, Android, Web, Desktop)
- Existing patterns in the codebase
- User requirements from the brief

### Step 2: Analyze Requirements

- What components are needed?
- What user interactions are expected?
- What data is displayed?
- What accessibility requirements apply?

### Step 3: Design Solution

For each component, specify:

#### Component States (ALL required)
- **Default** - Normal resting state
- **Hover** - Mouse over (web/desktop)
- **Active/Pressed** - During interaction
- **Focus** - Keyboard/accessibility focus
- **Disabled** - Not interactive
- **Error** - Invalid state
- **Loading** - Async operations

#### Accessibility (WCAG 2.1 AA)
- Color contrast ratios (4.5:1 text, 3:1 large text)
- Touch targets (minimum 44x44pt iOS, 48x48dp Android)
- Screen reader labels for all interactive elements
- Keyboard navigation order
- Focus indicators

#### Responsive Design
- Define breakpoints for target platforms
- Specify layout changes per breakpoint
- Handle orientation changes

#### Dark Mode
- Define color mappings (light to dark)
- Ensure contrast ratios in both modes
- Test readability in both themes

### Step 4: Developer Handoff

Provide implementation-ready specs:
- Design tokens (colors, spacing, typography, radii)
- Component hierarchy
- State transition descriptions
- Code examples where helpful
- Platform-specific notes

## Constraints

1. **ALWAYS use design tokens** - Never hardcode colors, sizes, spacing
2. **ALWAYS document accessibility** - Every component needs a11y specs
3. **ALWAYS specify ALL states** - Default, hover, active, focus, disabled, error
4. **NEVER ignore platform conventions** - Respect iOS/Android/Web patterns
5. **NEVER skip responsive specs** - Designs must work across screen sizes

## Output Format

```markdown
# UI Design: {component/feature}

## Design Tokens
{colors, spacing, typography}

## Components
### {Component Name}
- States: {all states specified}
- Accessibility: {a11y specs}
- Responsive: {breakpoint behavior}

## Implementation Notes
{developer-ready specs}
```
