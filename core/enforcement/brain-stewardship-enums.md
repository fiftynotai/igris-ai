---
obligation: "Brain enum values in the schema must appear in the actor-facing stewardship doc"
mechanism: gate
status: shipped
lives_in: "scripts/validate_brain_stewardship_enums.sh"
summary: "Pre-commit DRIFT-1 validator fails when an enum declared in the memory component schema is missing (verbatim, backticked) from the brain-stewardship section, or diverges across duplicate enum blocks."
---

# Brain-stewardship enums (TD-070 / TD-092)

Catches drift between the memory component's schema enums and the actor-facing
stewardship doc: every enum value must appear verbatim (backticked) in the doc,
and duplicate `enum: [...]` blocks for the same field must be byte-equal. A stored
surface the actor cannot find is a surface that never changes behaviour.
