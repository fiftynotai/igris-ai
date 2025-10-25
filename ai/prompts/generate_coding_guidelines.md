# Generate Coding Guidelines Prompt

This prompt analyzes your codebase and/or base architecture repository to create comprehensive coding guidelines for Igris AI.

---

## Purpose

Generate `ai/context/coding_guidelines.md` that defines your team's standards for:
- Architecture patterns and layer boundaries
- Naming conventions (files, classes, variables)
- Code structure and organization
- Documentation requirements
- Testing standards
- Best practices and common pitfalls

These guidelines serve as the foundation for:
- Migration analysis (comparing existing code to standards)
- Code reviews
- New development
- Team onboarding

---

## Usage Scenarios

### Scenario 1: Extract from Base Architecture Repo
**When:** You have a reference implementation (base architecture repo) that defines your standards
**Result:** Extract patterns and conventions from the base repo

### Scenario 2: Infer from Existing Project
**When:** You have existing code but no documented standards
**Result:** Analyze patterns in your code and formalize them as guidelines

### Scenario 3: Merge Base Repo + Project
**When:** You have both a base repo AND existing project code
**Result:** Merge intelligently (base repo = primary, project = supplementary)

---

## Instructions for Claude

When user asks to generate coding guidelines, follow this process:

### Step 1: Gather Inputs

Ask the user these questions:

**Question 1:** "Do you have a base architecture repository that defines your standard patterns?"
- **If YES:** Ask for repository URL
- **If NO:** Proceed to Question 2
- **If UNSURE:** Explain what a base repo is, then ask again

**Question 2:** "Should I analyze your current project code to understand existing patterns?"
- **If YES:** Confirm directory to analyze (default: current directory)
- **If NO:** Skip to Step 3

**Question 3:** "What platform/framework is this for?"
- Flutter
- React Native
- React (Web)
- Vue.js
- Angular
- Node.js Backend
- Other (specify)

**Result:** Determine mode (A/B/C) based on answers:
- Mode A: Base repo only (Q1=Yes, Q2=No)
- Mode B: Project analysis only (Q1=No, Q2=Yes)
- Mode C: Merge both (Q1=Yes, Q2=Yes)
- Mode D: Best practices fallback (Q1=No, Q2=No)

---

### Step 2: Analysis

Execute the appropriate mode:

#### Mode A: Extract from Base Repository

**Process:**
1. Clone base repository to temporary directory:
   ```bash
   git clone <base-repo-url> /tmp/base-arch-XXXXX
   ```

2. Scan base repo structure:
   - Use Glob to find all source files
   - Identify example modules (lib/features/, src/modules/, etc.)
   - Look for documentation files

3. Read key documentation files:
   - README.md (architecture overview)
   - CONTRIBUTING.md (contribution guidelines)
   - docs/ directory (any architecture docs)
   - CODE_STYLE.md, ARCHITECTURE.md if present

4. Analyze example modules (read 2-3 complete examples):
   - Identify layer structure (view/viewmodel/service/model)
   - Extract file naming patterns
   - Extract class naming patterns
   - Identify state management approach
   - Find DI patterns
   - Document testing patterns

5. Extract patterns:
   - **Architecture:** What pattern is used? (MVVM, MVC, Clean, etc.)
   - **Layers:** What layers exist and how do they interact?
   - **Naming:** File names (snake_case? camelCase?), Class names (PascalCase?), Variables (camelCase?)
   - **Documentation:** What format for doc comments?
   - **Testing:** What test structure? Coverage requirements?
   - **State Management:** Which library? (GetX, Provider, Redux, etc.)

6. Find code examples:
   - Copy 1-2 examples of "golden" code for each layer
   - These will be used as reference in guidelines

#### Mode B: Infer from Project Code

**Process:**
1. Scan project directory:
   - Use Glob to find all source files
   - Identify file types and counts
   - Map directory structure

2. Analyze multiple modules (sample 3-5):
   - Look for consistent patterns (what's done similarly?)
   - Identify good patterns (well-structured code)
   - Identify inconsistencies (what varies?)
   - Identify potential anti-patterns

3. Infer patterns:
   - **Architecture:** What pattern appears to be used? Look for folders like views/, viewmodels/, controllers/, services/
   - **Naming:** What naming is used most consistently?
   - **Documentation:** Are doc comments present? What format?
   - **Testing:** Are tests present? What coverage?

4. Parse linter configuration:
   - Read analysis_options.yaml (Dart/Flutter)
   - Read .eslintrc.json (JavaScript/TypeScript)
   - Read tsconfig.json (TypeScript)
   - Extract rules and preferences

5. Identify strengths:
   - What is this codebase doing well?
   - What should be preserved?

6. Identify weaknesses:
   - What inconsistencies exist?
   - What needs standardization?
   - What best practices are missing?

7. Supplement with platform best practices:
   - Based on platform (Flutter/React/etc.), add missing best practices
   - Recommend industry standards not currently followed

#### Mode C: Merge Base Repo + Project

**Process:**
1. Execute Mode A (analyze base repo)
2. Execute Mode B (analyze project)
3. Compare findings:
   - Where do they align?
   - Where do they conflict?
4. Merge with priority:
   - **Primary:** Base repo patterns (this is the target standard)
   - **Secondary:** Project patterns (if not conflicting)
   - **Supplementary:** Linter rules from project
5. Document conflicts:
   - List where project deviates from base repo
   - These become migration recommendations
6. Create merged guidelines with:
   - Base repo patterns as "standard"
   - Project patterns as "current state (needs alignment)"
   - Clear migration path from current to standard

#### Mode D: Best Practices Fallback

**Process:**
1. Confirm platform with user
2. Use industry best practices for that platform:
   - Flutter: Clean Architecture, MVVM, GetX/Provider/Riverpod patterns
   - React: Component structure, Hooks, Context, Redux patterns
   - etc.
3. Recommend creating a base architecture repo
4. Offer to generate basic guidelines as starting point

---

### Step 3: Generate coding_guidelines.md

Create `ai/context/coding_guidelines.md` using this template:

```markdown
# Coding Guidelines — [Project Name]

**Generated:** [Date]
**Source:** [Base Repo URL / Project Analysis / Merged / Best Practices]
**Platform:** [Flutter/React/etc.]
**Mode:** [A/B/C/D]

---

## Overview

[Brief description of the standards defined in this document]

[If Mode A or C:]
**Base Architecture:** [Base repo URL]
**Reference Implementation:** [Link to example modules in base repo]

[If Mode B:]
**Note:** These guidelines were inferred from existing project code. Consider creating a base architecture repository for future reference.

[If Mode C:]
**Merge Status:** Base repository patterns are the target standard. Current project deviations are documented below.

---

## Architecture Pattern

**Pattern:** [MVVM / MVC / Clean Architecture / Layered / Other]

**Description:**
[Explain the architecture pattern and its principles]

[If Mode A or C, include:]
**Based on:** [Base repo reference]

**Layer Boundaries:**
```
View (UI)
   ↓ (calls)
Actions (UI Logic) [If applicable]
   ↓ (calls)
ViewModel/Controller (Business Logic)
   ↓ (calls)
Service/Repository (Data Layer)
   ↓ (uses)
Model (Data Structures)
```

**Golden Rule:** [Key principle, e.g., "Views never call Services directly"]

**Layer Responsibilities:**
- **View:** UI rendering, user input handling
- **Actions:** Navigation, dialogs, snackbars (UI side effects) [If applicable]
- **ViewModel/Controller:** Business logic, state management
- **Service/Repository:** API calls, data persistence, external integrations
- **Model:** Data structures, business entities

---

## Project Structure

### Canonical Module Structure

[Show the standard folder structure for a feature module]

**Example:**
```
lib/features/example/
├── data/
│   ├── models/
│   │   └── example_model.dart
│   └── services/
│       └── example_service.dart
├── domain/
│   └── viewmodels/
│       └── example_viewmodel.dart
└── presentation/
    ├── actions/
    │   └── example_actions.dart [If applicable]
    ├── views/
    │   └── example_page.dart
    └── widgets/
        └── example_widget.dart
```

[If Mode A or C:]
**Reference:** [Link to example module in base repo]

[If Mode C and conflicts exist:]
**Current Project State:**
```
[Show how project currently structures modules - if different]
```
**Migration Note:** Rename folders to match canonical structure above.

### Module Naming

- Folder names: [snake_case / camelCase / kebab-case]
- File names: [snake_case / camelCase / kebab-case]

[If Mode C and conflicts:]
**Current Project:** Uses [current pattern]
**Target Standard:** Use [base repo pattern]

---

## Naming Conventions

### Files
- Pattern: [e.g., snake_case with suffix: `example_viewmodel.dart`]
- Suffix conventions:
  - ViewModels: `*_viewmodel.dart`
  - Services: `*_service.dart`
  - Models: `*_model.dart`
  - Pages/Views: `*_page.dart` or `*_view.dart`
  - Widgets: `*_widget.dart`
  - Actions: `*_actions.dart` [If applicable]

[If Mode A or C, include example from base repo]

### Classes
- Pattern: [e.g., PascalCase]
- Examples:
  - ViewModel: `ExampleViewModel`
  - Service: `ExampleService`
  - Model: `ExampleModel`
  - Widget: `ExampleWidget`

### Variables & Functions
- Variables: [e.g., camelCase: `userName`, `eventList`]
- Functions: [e.g., camelCase: `fetchEvents()`, `navigateToDetails()`]
- Constants: [e.g., UPPER_SNAKE_CASE: `API_BASE_URL`, `MAX_RETRIES`]
- Private members: [e.g., leading underscore: `_privateMethod()`]

### Boolean Names
- Use positive phrasing: `isEnabled`, `hasError`, `canSubmit`
- Avoid negatives: ~~`isNotReady`~~

---

## Code Organization

### Import Ordering
[If found in linter config or base repo:]
1. Dart/Flutter core imports
2. Third-party package imports
3. Project imports
4. Relative imports

### File Size Limits
- Maximum file size: [e.g., 300-400 lines]
- Maximum function size: [e.g., 50 lines]
- If exceeding limits, split into multiple files/functions

### Class Organization
**Order within a class:**
1. Static constants
2. Instance variables
3. Constructor
4. Lifecycle methods (`initState`, `dispose`, etc.)
5. Public methods
6. Private methods
7. Static methods

---

## State Management

**Library:** [GetX / Provider / Riverpod / Redux / BLoC / MobX / etc.]

[If Mode A or C:]
**Reference:** [Link to state management example in base repo]

**Pattern:**
[Describe how state management is implemented]

**Example:**
```[language]
// [Show code example from base repo or project]
```

---

## Documentation Requirements

### Required Documentation

**Doc Comments Required For:**
- [ ] All public classes
- [ ] All public methods
- [ ] All public properties
- [ ] Complex private methods (optional but recommended)

**Format:**
[Show format - Dart doc comments, JSDoc, etc.]

**Example:**
```[language]
/// Fetches events from the API for the specified venue.
///
/// [venueId] The unique identifier of the venue.
/// [date] Optional date filter (defaults to today).
///
/// Returns a list of [Event] objects.
/// Throws [ApiException] if the request fails.
///
/// Example:
/// ```dart
/// final events = await fetchEvents('venue-123');
/// ```
Future<List<Event>> fetchEvents(String venueId, {DateTime? date}) async {
  // implementation
}
```

**Required Sections:**
- Summary (one line)
- Parameters (describe each)
- Return value
- Exceptions (if any)
- Example usage (for complex APIs)

---

## Testing Standards

### Required Tests

**Unit Tests Required For:**
- [ ] All ViewModels/Controllers
- [ ] All Services/Repositories
- [ ] All business logic functions
- [ ] All Models (if complex logic)

**Widget/Component Tests Required For:**
- [ ] Complex UI components
- [ ] Custom widgets with logic
- [ ] Critical user flows

**Integration Tests Required For:**
- [ ] Key user journeys
- [ ] Critical business flows

### Coverage Requirements

**Minimum Coverage:** [e.g., 70% for new code]
**Target Coverage:** [e.g., 80% overall]

### Test Structure

[Show test structure example from base repo or project]

**Example:**
```[language]
// [Test example showing describe/it or group/test structure]
```

### Test Naming

- Test file: `*_test.dart` (same name as source file + `_test`)
- Test group: `describe('ClassName', ...)` or `group('ClassName', ...)`
- Test case: Clear description of what's being tested

---

## Dependency Injection

**Pattern:** [Constructor injection / Service locator / Provider / GetX bindings / etc.]

[If Mode A or C:]
**Reference:** [Link to DI example in base repo]

**How to inject dependencies:**
```[language]
// [Show example from base repo or project]
```

**Rules:**
- Always inject dependencies (no hard-coded instantiation)
- Use interfaces/abstract classes when possible
- Keep constructors simple (just assignments)

---

## Error Handling

### API Errors

**Pattern:**
[Describe how API errors are handled]

**Example:**
```[language]
// [Show error handling pattern]
```

### UI Errors

**Pattern:**
- Show user-friendly error messages
- Log technical details for debugging
- Provide retry mechanism when appropriate

### Logging

**When to log:**
- All API errors
- Unexpected exceptions
- Critical user actions

**What NOT to log:**
- User credentials or sensitive data
- API keys or secrets
- Personal information (PII)

---

## Best Practices

### DO ✅

- Follow the layer boundaries defined above
- Write doc comments for all public APIs
- Write tests for all business logic
- Use meaningful variable names
- Keep functions small and focused
- Make models immutable (final fields)
- Handle all error cases
- Use const constructors when possible (Flutter)
- Close streams/sockets/subscriptions when done

[If Mode A or C, add base repo specific practices]

### DON'T ❌

- Skip layers (e.g., View calling Service directly)
- Put UI logic in ViewModel (navigation, dialogs)
- Put business logic in View
- Hardcode strings (use i18n/localization)
- Hardcode API keys or credentials
- Leave empty catch blocks
- Create god classes (classes doing too much)
- Use mutable state without state management
- Forget to dispose controllers/streams

[If Mode A or C, add base repo specific anti-patterns]

---

## Linting & Analysis

### Linter Configuration

**Config File:** [Path to analysis_options.yaml or .eslintrc.json]

**Key Rules:**
[List important linting rules from config]

**Must Pass:**
Before submitting code, ensure:
- [ ] `flutter analyze` / `npm run lint` passes with zero issues
- [ ] No warnings or errors

---

## Code Review Checklist

Before submitting code for review:

**Architecture:**
- [ ] Follows defined layer boundaries
- [ ] Doesn't skip layers
- [ ] UI logic is in Actions layer (if applicable)
- [ ] Business logic is in ViewModel/Controller
- [ ] Data fetching is in Service/Repository

**Code Quality:**
- [ ] Follows naming conventions
- [ ] Has required documentation
- [ ] Functions are small and focused
- [ ] No code duplication
- [ ] Error handling is present

**Testing:**
- [ ] Has unit tests for logic
- [ ] Has widget/component tests for UI (if complex)
- [ ] All tests pass
- [ ] Meets coverage requirements

**Standards:**
- [ ] Linter passes with zero issues
- [ ] No hardcoded strings
- [ ] No hardcoded credentials
- [ ] Follows best practices listed above

---

## Common Pitfalls

[Project/platform-specific gotchas to avoid]

[If Mode C, include deviations from base repo:]
**Current Project Issues:**
- [List patterns in current project that violate base repo standards]

---

## Code Examples

[If Mode A or C, include golden examples from base repo]

### Example 1: ViewModel
[Full example of well-structured ViewModel]

### Example 2: Service
[Full example of well-structured Service]

### Example 3: View/Component
[Full example of well-structured View]

[Link to more examples in base repo if available]

---

## Migration Notes

[If Mode C - Merge mode, include this section:]

### Current Project Deviations

**Folder Structure:**
- Current: [What project currently does]
- Target: [What base repo standard is]
- Action: [What needs to change]

**Naming Conventions:**
- Current: [What project currently does]
- Target: [What base repo standard is]
- Action: [What needs to change]

**Architecture Patterns:**
- Current: [What project currently does]
- Target: [What base repo standard is]
- Action: [What needs to change]

**Recommended Next Steps:**
1. Run migration analysis: `ai/prompts/migration_analysis.md`
2. This will generate specific migration briefs (MG-XXX) for each deviation
3. Prioritize and execute migration briefs

---

## References

**Base Architecture:** [Base repo URL if Mode A or C]
**Platform Documentation:** [Link to Flutter/React/etc. docs]
**Style Guides:** [Links to any external style guides followed]

[If Mode A or C:]
**Example Modules in Base Repo:**
- [lib/features/example/ or similar path]

---

**Generated:** [Date]
**Last Updated:** [Date]
**Version:** 1.0.0
```

---

### Step 4: Generate Supplementary Files (Optional)

If analyzing project code (Mode B or C), consider also generating:

1. **architecture_map.md** - If not already present
2. **module_catalog.md** - Inventory of all modules in project

(Reuse logic from `generate_architecture_docs.md`)

---

### Step 5: Summary Report

Print a summary to the user:

#### For Mode A (Base Repo):
```
✅ Coding guidelines generated from base architecture repository!

📁 Files Created:
   - ai/context/coding_guidelines.md

📊 Extracted Standards:
   • Architecture: [Pattern name]
   • Platform: [Flutter/React/etc.]
   • State Management: [Library name]
   • Layers: [Number] layers with clear boundaries
   • Documentation: [Requirements summary]
   • Testing: [Coverage requirements]

📖 Guidelines Include:
   • Architecture pattern definition
   • Naming conventions
   • Code organization rules
   • Documentation requirements
   • Testing standards
   • Best practices and pitfalls
   • Code examples from base repo

🎯 Next Steps:
   1. Review the generated guidelines
   2. Share with your team
   3. Use for new development
   4. Run migration analysis to align existing code:
      "Analyze codebase using ai/prompts/migration_analysis.md"
```

#### For Mode B (Project Analysis):
```
✅ Coding guidelines inferred from your project code!

📁 Files Created:
   - ai/context/coding_guidelines.md
   [- ai/context/architecture_map.md]
   [- ai/context/module_catalog.md]

📊 Inferred Standards:
   • Architecture: [Detected pattern]
   • Platform: [Flutter/React/etc.]
   • State Management: [Detected library]
   • Naming: [Detected patterns]
   • Testing: [Current coverage]%

⚠️ Inconsistencies Found:
   • [List major inconsistencies]

💡 Recommendations:
   1. Standardize [specific item]
   2. Improve [specific area]
   3. Consider creating a base architecture repository

📖 Guidelines Include:
   • Inferred architecture pattern
   • Current naming conventions
   • Recommended best practices
   • Areas needing improvement

🎯 Next Steps:
   1. Review the generated guidelines
   2. Formalize any missing standards
   3. Consider creating a base architecture repository
   4. Run migration analysis to find improvement areas:
      "Analyze codebase using ai/prompts/migration_analysis.md"
```

#### For Mode C (Merged):
```
✅ Coding guidelines generated by merging base repo and project analysis!

📁 Files Created:
   - ai/context/coding_guidelines.md

📊 Standards Loaded:
   • Primary Source: Base architecture repository
   • Supplementary: Current project patterns
   • Linting: Project configuration

✅ Alignment:
   • [List areas where project matches base repo]

⚠️ Deviations Found:
   • [List conflicts where project differs from base repo]

**Conflict Resolution:** Base repository patterns take precedence

📖 Guidelines Include:
   • Base repo architecture as target standard
   • Current project state documented
   • Clear migration path
   • Code examples from base repo

🎯 Next Steps:
   1. Review the generated guidelines
   2. Note the documented deviations
   3. Run migration analysis to generate specific migration tasks:
      "Analyze codebase using ai/prompts/migration_analysis.md"
   4. Migration analysis will create briefs (MG-XXX) for each deviation
```

---

## Example Usage Sessions

### Example 1: Startup with Base Repo

```
User: Generate coding guidelines from our base architecture

Claude: I'll help you generate coding guidelines. Let me ask a few questions:

Do you have a base architecture repository that defines your standard patterns?
(Yes/No)

User: Yes

Claude: Please provide the repository URL:

User: https://github.com/mycompany/flutter-base-architecture

Claude: Should I also analyze your current project code to see how it compares?
(Yes/No)

User: No, just extract from the base repo for now

Claude: What platform is this for?
1. Flutter
2. React Native
3. React (Web)
4. Other

User: Flutter

Claude: Got it! I'll extract coding guidelines from your base architecture repository.

[Cloning repository...]
[Analyzing structure...]
[Extracting patterns...]
[Finding code examples...]

✅ Coding guidelines generated from base architecture repository!

📁 Files Created:
   - ai/context/coding_guidelines.md (150 lines)

📊 Extracted Standards:
   • Architecture: MVVM + Actions layer
   • Platform: Flutter
   • State Management: GetX
   • Layers: 5 layers (View/Actions/ViewModel/Service/Model)
   • Documentation: Dart doc comments required for all public APIs
   • Testing: 70% minimum coverage

📖 Guidelines Include:
   • Complete architecture pattern definition
   • File and class naming conventions
   • Code organization rules
   • Documentation format and examples
   • Testing requirements and examples
   • 15+ best practices
   • 10+ common pitfalls to avoid
   • 3 complete code examples from base repo

🎯 Next Steps:
   1. Review: cat ai/context/coding_guidelines.md
   2. Share with your team
   3. To check your project against these standards:
      "Analyze codebase using ai/prompts/migration_analysis.md"
```

### Example 2: Infer from Existing Project

```
User: Generate coding guidelines by analyzing my existing project

Claude: Do you have a base architecture repository? (Yes/No)

User: No

Claude: Should I analyze your current project code to infer patterns? (Yes/No)

User: Yes

Claude: What platform?

User: Flutter

Claude: I'll analyze your project and create coding guidelines based on patterns I find.

[Scanning project...]
[Found 87 Dart files across 8 modules]
[Analyzing patterns...]
[Checking for consistency...]

✅ Coding guidelines inferred from your project!

📁 Files Created:
   - ai/context/coding_guidelines.md (120 lines)
   - ai/context/architecture_map.md (60 lines)
   - ai/context/module_catalog.md (40 lines)

📊 Inferred Standards:
   • Architecture: MVVM (detected)
   • State Management: GetX (detected)
   • File Naming: Mostly snake_case (80% consistent)
   • Class Naming: PascalCase (100% consistent)
   • Testing: 45% coverage currently

⚠️ Inconsistencies Found:
   • 3 modules use "controllers/" folder, 5 use "viewmodels/"
   • 2 modules use "service/" (singular), 6 use "services/" (plural)
   • File naming is inconsistent in 20% of files

💡 Recommendations:
   1. Standardize on "viewmodels/" folder name
   2. Standardize on "services/" (plural) folder name
   3. Use snake_case consistently for all file names
   4. Increase test coverage to 70%+
   5. Add doc comments (currently 30% of public APIs documented)
   6. Consider creating a base architecture repository

📖 Guidelines Include:
   • Detected architecture pattern
   • Most common naming conventions
   • Recommended best practices for Flutter
   • Areas needing standardization

🎯 Next Steps:
   1. Review: cat ai/context/coding_guidelines.md
   2. Address inconsistencies
   3. Formalize standards with your team
   4. To see detailed improvement tasks:
      "Analyze codebase using ai/prompts/migration_analysis.md"
```

---

**Last Updated:** 2025-10-14
**Version:** 1.0.1
