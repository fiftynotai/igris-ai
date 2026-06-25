---
name: ground
tier: essential
description: "Author any project-context doc (coding_guidelines, architecture_map, api_pattern, design_system, test_standards) from its catalog skeleton, using one of 4 acquisition modes. Default type: coding_guidelines. `inventory` lists which docs exist vs missing-but-applicable."
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - mcp__igris-brain__igris_project_status
triggers:
  - "GROUND"
  - "STANDARDIZE"
  - "LAWKEEPER"
  - "generate guidelines"
  - "generate standards"
  - "generate coding guidelines"
  - "coding standards"
  - "author context doc"
  - "context doc inventory"
---

# Ground Skill

Author a project-context doc from the **doc-type catalog** — the self-describing
source of truth at `~/.igris/core/context-doc-types/*.md`. Each type declares its
`target` (the on-disk file name) and a body **section skeleton**; this skill picks
a type, acquires the project's actual conventions via one of 4 modes, fills that
type's skeleton, and writes the `target` under
`~/.igris/projects/{project}/context/`.

`coding_guidelines` is the **default type** — `ground` with no doc-type
authors `coding_guidelines.md` exactly as before.

## Arguments

`$ARGUMENTS` = **`<doc-type> [mode]`**.

**First token — the doc-type** (which doc to author):
- A catalog type id — `coding_guidelines`, `architecture_map`, `api_pattern`,
  `design_system`, `test_standards` (or any new `core/context-doc-types/<type>.md`).
- `inventory` → run the **inventory view** instead of authoring (see below). Not a
  doc-type; it lists status for the project.
- **Empty / omitted** → defaults to `coding_guidelines` (back-compat — a no-arg
  `ground` authors `coding_guidelines.md` as it always has).

**Second token — the acquisition mode** (how to gather the content), optional:
- `analyze` → Mode B: Analyze current project (**default** when omitted)
- `from-base` → Mode A: Extract from base architecture repo
- `hybrid` → Mode C: Merge base repo + project analysis
- `minimal` → Mode D: Platform-specific best practices only

If the doc-type is given but the mode is omitted, default to Mode B (analyze).
If `$ARGUMENTS` is entirely empty, author `coding_guidelines` via Mode B (or ask
the user which mode, exactly as before).

## Resolve the doc-type from the catalog

Before authoring (any type, including the default `coding_guidelines`):

1. **Glob** `~/.igris/core/context-doc-types/*.md` and **Read** the definition
   whose `type` (== file stem) matches the requested doc-type. If no doc-type was
   given, read `coding_guidelines.md`.
2. From its **frontmatter**, take:
   - `target` — the on-disk file name to write (e.g. `design_system.md`).
   - `consult_when` / `summary` — context for the header you author.
3. From its **body** (the `## Section skeleton` block), take the **section
   headings** — these ARE the structure to author. Each catalog definition owns
   its own skeleton; this skill does **not** hardcode per-type sections.
4. If the requested doc-type has no catalog definition, tell the user the known
   types (the globbed stems) and stop — do not invent a doc-type.

The doc you write goes to `~/.igris/projects/{project}/context/<target>`.

## Modes

Modes are the *acquisition strategy* — how the section content is gathered. They
apply to **any** doc-type; the type only changes which skeleton gets filled.

### Mode A: Base Repository
**When:** User has a reference architecture or base project.
1. Ask for base repo path or URL
2. Analyze base repo structure, patterns, naming (scoped to the doc-type's domain
   — e.g. for `design_system`, its UI/tokens; for `api_pattern`, its endpoints)
3. Extract the conventions relevant to this type
4. Fill the type's skeleton from the base repo's patterns

### Mode B: Project Analysis (Default)
**When:** Existing project, no base repo.
1. Scan project structure (`find` / `glob`)
2. Detect platform/framework (Flutter, React, Vue, etc.)
3. Analyze the conventions relevant to this doc-type (code conventions for
   `coding_guidelines`; layers/modules for `architecture_map`; endpoints for
   `api_pattern`; UI/tokens for `design_system`; the test suite for
   `test_standards`)
4. Infer the type's standards from the existing code/assets
5. Fill the type's skeleton reflecting current patterns

### Mode C: Merge
**When:** Both base repo and project exist.
1. Run Mode A on base repo
2. Run Mode B on current project
3. Identify conflicts between base and project patterns
4. Merge with base repo taking precedence for architecture
5. Project-specific overrides documented

### Mode D: Best Practices
**When:** New project, no base repo, no existing code (or the doc-type's domain
isn't built out yet).
1. Ask for platform (Flutter, React, Node, Python, etc.)
2. Apply industry best practices for that platform and this doc-type
3. Fill the type's skeleton with starter conventions
4. Include common patterns and anti-patterns

## Workflow

### Step 1: Resolve type + gather inputs
- Resolve the doc-type from the catalog (above) → `target` + section skeleton.
- Acquisition questions for the chosen mode:
  - Do you have a base architecture repository? (Mode A/C)
  - Should I analyze your current project? (Mode B/C)
  - What platform/framework? (all modes)

### Step 2: Execute the selected mode
- Scan, analyze, extract patterns per mode logic above, **scoped to this
  doc-type's domain** (use the definition's `consult_when` as the lens for what
  to look at).

### Step 3: Author the target doc from the catalog skeleton
Create `~/.igris/projects/{project}/context/<target>` (the `target` resolved from
the catalog — **not** hardwired to `coding_guidelines.md`):
- A header (the doc's purpose, from the definition's `summary`).
- **One section per heading in the type's `## Section skeleton`**, filled from the
  mode's analysis. Use the catalog definition's section headings verbatim so the
  doc matches its declared structure; replace the skeleton's guidance prose with
  the project's *actual* conventions.
- Include concrete examples drawn from the project (or platform best-practices in
  Mode D).
- Note which mode (A/B/C/D) was used at the foot of the doc.

> Example: `ground design_system` reads
> `~/.igris/core/context-doc-types/design_system.md`, writes
> `~/.igris/projects/{project}/context/design_system.md` with the sections
> *Design tokens / Components / Layout & spacing / Conventions & decisions*
> (its skeleton), filled from the project's UI. `ground` (no arg) reads
> `coding_guidelines.md`, writes `coding_guidelines.md` with *Naming conventions
> / Structure & organization / Idiomatic patterns / Decisions* — identical to the
> prior behavior.

## Inventory (`ground inventory`)

A read-only, derived **status view**: for the current project, which context docs
exist, which **apply** (the project's archetype matched against each type's
`applies_when`), and which are **missing-but-applicable** (apply but absent on
disk). This is the signal `conduct.md` #9 ("ensure the project has the docs it
needs") and FR-199's presence-enforcement read against — it does NOT author or
modify anything.

**Compute it from three inputs:**
1. **The catalog** — Glob `~/.igris/core/context-doc-types/*.md`, Read each, and
   parse from frontmatter: `type`, `target`, `applies_when`, `optional`.
2. **The project archetype** — call `igris_project_status` (slug = current
   project) and read its `archetype` + `tech_stack`. This is the project-kind the
   `applies_when` predicate is matched against.
3. **The on-disk docs** — Glob `~/.igris/projects/{project}/context/` and list
   which `target` files are present.

**For each catalog type, derive:**
- **exists?** — is the type's `target` present in the context dir?
- **applies?** — does the project's archetype/tech-stack satisfy the type's
  `applies_when` predicate? Judge the natural-language predicate against the
  archetype: e.g. `applies_when: UI-bearing projects` applies to a
  `brand-website` / `design-kit` / mobile-app archetype; `applies_when: all
  projects` always applies (`coding_guidelines`, the non-optional one); an
  `API-bearing` predicate applies when the stack exposes/consumes an API. When the
  archetype is unknown or ambiguous, mark **applies? = unknown** rather than
  guessing a hard no.
- **missing-but-applicable?** — `applies? = yes` AND `exists? = no`. This is the
  actionable signal.

**Print the table:**

```
## Context-doc inventory — <slug> (archetype: <archetype>)

| doc-type | target | applies? | exists? | status |
|---|---|---|---|---|
| coding_guidelines | coding_guidelines.md | yes | yes | present |
| architecture_map  | architecture_map.md  | yes | no  | MISSING (applicable) |
| design_system     | design_system.md     | yes | no  | MISSING (applicable) |
| api_pattern       | api_pattern.md       | no  | no  | n/a (does not apply) |
| test_standards    | test_standards.md    | unknown | yes | present |

Missing-but-applicable: architecture_map, design_system
→ Author one with: ground <type>
```

End by naming the missing-but-applicable types and pointing at
`ground <type>` to author each. Do not author them automatically — the
inventory only reports.

## Constraints

1. **NEVER modify source code** — only author context docs.
2. **AUTHOR the resolved `target`** — write the file the catalog definition names,
   never hardwire `coding_guidelines.md` (except as the default type).
3. **SKELETON from the catalog** — a type's section structure comes from its
   `core/context-doc-types/<type>.md` body, not from this skill.
4. **BACK-COMPAT** — `ground` with no doc-type authors `coding_guidelines.md`
   exactly as before (default type = `coding_guidelines`, default mode = B).
5. **ALWAYS detect platform** — for relevant best practices.
6. **ALWAYS include examples** — concrete examples in the authored doc.
7. **ALWAYS note source mode** — document which mode (A/B/C/D) was used.
8. **`inventory` is read-only** — it reports exists/applies/missing-but-applicable
   and never writes a doc.

## Output

`~/.igris/projects/{project}/context/<target>` — the authored doc for the chosen
doc-type (default `coding_guidelines.md`), structured by that type's catalog
skeleton. Or, for `ground inventory`, the printed status table (no file
written).
