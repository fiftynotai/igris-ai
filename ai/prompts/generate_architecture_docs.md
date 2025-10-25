# Generate Architecture Documentation

This prompt guides Claude to analyze your project and generate comprehensive architecture documentation for Igris AI.

---

## Instructions for Claude

Please analyze this project and generate the following architecture documentation files in `ai/context/`:

### 1. architecture_map.md

Analyze the project structure and create a comprehensive architecture map including:

**Questions to ask:**
- What architecture pattern is used? (MVVM, MVC, Clean Architecture, MVP, etc.)
- What are the layer boundaries? (View, ViewModel, Service, Model, etc.)
- How do layers communicate?
- What is the folder structure convention?
- What are the key infrastructure files?
- Are there any deviations from standard patterns?

**What to include:**
- Architecture pattern name and reference (if based on external pattern)
- Layer boundaries diagram
- Module structure (canonical layout)
- Module inventory (list all feature modules with purposes)
- Key infrastructure files and their roles
- Dependency injection pattern
- State management approach
- Common gotchas and anti-patterns to avoid

### 2. api_pattern.md

Analyze how the project interacts with APIs and manages data:

**Questions to ask:**
- How are API calls made? (HTTP client, GraphQL, REST, etc.)
- What state management is used? (Redux, MobX, GetX, Riverpod, Provider, etc.)
- How are loading/error states handled?
- What is the authentication flow?
- How are API responses structured?
- How is error handling implemented?

**What to include:**
- HTTP client setup and configuration
- API call pattern (example code)
- State management for async operations
- Error handling strategy
- Authentication/authorization flow
- Token refresh mechanism (if applicable)
- Request/response interceptors
- Common API patterns in the codebase

### 3. coding_guidelines.md

Analyze code style and create guidelines:

**Questions to ask:**
- What are the naming conventions? (files, classes, variables, functions)
- What documentation format is used? (JSDoc, Dart doc-comments, etc.)
- What linting rules are enforced?
- Are there testing conventions?
- What are the import/export patterns?

**What to include:**
- File and folder naming conventions
- Class naming conventions
- Variable and function naming
- Documentation comment format (with examples)
- Linting configuration summary
- Testing patterns
- Code review checklist
- Common pitfalls to avoid
- Best practices specific to this project

### 4. module_catalog.md

Create an inventory of all feature modules:

**Questions to ask:**
- What are all the feature modules?
- What is the purpose of each module?
- What are the key files in each module?
- What are the dependencies between modules?

**What to include:**
- Table of all modules with purposes
- Module directory structure
- Key files in each module
- Inter-module dependencies
- Module-specific patterns or deviations

---

## Process

1. **Scan the project structure** - Use Glob to explore directories
2. **Read key files** - Examine main application files, config files, example modules
3. **Ask clarifying questions** - If unclear about patterns, ask the user
4. **Generate each document** - Create well-structured markdown files
5. **Save to ai/context/** - Use Write tool to create the files

---

## Template Structure

### architecture_map.md Template

```markdown
# Architecture Map — [Project Name]

## Base Architecture Reference

[If based on external pattern, link to it]

**Pattern:** [Name]
**State Management:** [Tool/Library]

---

## Layer Boundaries

[Diagram showing layers and their interactions]

**Golden Rule:** [Key architectural principle]

---

## Repo-Specific Adaptations

[How this project differs from base pattern]

---

## Module Structure

[Canonical module layout]

---

## Module Inventory

[Table of all modules]

---

## Key Infrastructure Files

[Table of critical files and their purposes]

---

## Dependency Injection Pattern

[How DI is implemented]

---

## State Management Patterns

[How state is managed throughout the app]

---

## Common Repo-Specific Gotchas

[Things to watch out for]
```

### api_pattern.md Template

```markdown
# API Pattern — [Project Name]

## HTTP Client Setup

[How HTTP client is configured]

---

## API Call Pattern

[Standard pattern for making API calls with example]

---

## State Management for Async Operations

[How loading/success/error states are handled]

---

## Authentication Flow

[How auth works end-to-end]

---

## Error Handling

[How errors are caught and displayed]

---

## Common Patterns

[Frequently used API patterns in this codebase]
```

### coding_guidelines.md Template

```markdown
# Coding Guidelines — [Project Name]

## Documentation Comment Style

[Required format with examples]

---

## Naming Conventions

[Files, classes, variables, functions]

---

## Linting

[What linting tools are used and key rules]

---

## Testing Pattern

[How to write tests]

---

## Common Pitfalls

[What to avoid]

---

## Code Review Checklist

[Items to check before submitting code]
```

### module_catalog.md Template

```markdown
# Module Catalog — [Project Name]

## All Modules

[Table with: Module | Purpose | Key Features]

---

## Module Structure

[Standard structure for a module]

---

## Module Dependencies

[Dependency graph or list]
```

---

## Example Session

```
User: Please generate architecture documentation for this project

Claude: I'll analyze your project and generate architecture documentation. Let me start by exploring the structure.

[Uses Glob to scan directories]
[Reads key files]

I can see this is a [Flutter/React Native/Web/etc.] project using [architecture pattern].

Let me ask a few questions to ensure accuracy:

1. I see you're using [state management tool]. Is this used consistently across all modules?
2. I noticed [pattern]. Is this intentional or a deviation?
3. For API calls, I see [approach]. Is there a standard you follow?

[After getting answers...]

Great! I'll now generate the four documentation files:

1. architecture_map.md
2. api_pattern.md
3. coding_guidelines.md
4. module_catalog.md

[Uses Write tool to create each file]

✅ Architecture documentation generated!

The files are now in ai/context/ and ready to use for Igris AI workflows.
```

---

**Last Updated:** 2025-10-13
**Version:** 1.0.0
