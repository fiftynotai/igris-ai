---
obligation: "Relevant context docs should exist for the current project"
mechanism: honor-system
status: honor-system
lives_in: "igris context-docs inventory + core/skills/{ground,boot,scan}/SKILL.md"
summary: "FR-209 surfaces missing-but-applicable project-context docs as a soft /boot and /scan nudge, with /ground <type> remediation. It never blocks work."
---

# Context-Doc Presence

The project-context-docs subsystem defines which context docs apply through the
catalog in `core/context-doc-types/`. FR-209 makes the relevant-docs-exist rule
visible by routing `/ground inventory`, `/boot`, and `/scan` through the shared
`igris context-docs inventory` primitive.

This is intentionally not a hard gate. Missing docs produce a short remediation
nudge; the operator decides when to author them with `/ground <type>`.
