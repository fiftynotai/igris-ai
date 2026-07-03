---
obligation: "Relevant context docs must be consulted, obeyed, and maintained when triggered"
mechanism: gate
status: shipped
lives_in: "core/skills/hunt/SKILL.md + core/agents/warden.md + core/skills/document/SKILL.md"
summary: "FR-213 makes /hunt route consult_when and maintain_when through the context-doc catalog; Warden rejects context-doc violations and ignored maintenance triggers, while DOCUMENTING resolves queued maintenance."
---

# Context-Doc Compliance

The project-context-doc catalog has three distinct concerns:

- `applies_when` stays deterministic and project-level through
  `igris context-docs inventory`.
- `consult_when` routes the LLM's pre-work decision about which existing
  project context docs to read.
- `maintain_when` routes the post-change decision about whether an existing
  project context doc must be updated.

FR-213 makes this a shipped `/hunt` gate. Architect plans the relevant docs from
the catalog, Forger reads them and reports `Context doc impact`, DOCUMENTING
resolves queued maintenance, and Warden rejects direct violations or ignored
maintenance triggers. Missing applicable docs remain a soft presence nudge under
`context-doc-presence.md`; this gate is about compliance with relevant docs and
maintenance of triggered standards.
