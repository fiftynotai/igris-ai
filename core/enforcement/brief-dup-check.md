---
obligation: "Dup-check — call brief_similar before creating a brief"
mechanism: gate
status: shipped-this-brief
lives_in: "core/skills/register/SKILL.md"
summary: "Brain obligation #3. FR-199 wires igris_brief_similar (threshold 0.85) into /register as a creation-time gate-step: a hit >= threshold stops for operator confirm; tool-unavailable fails open."
---

# Brain obligation #3 — Dup-check

Before creating a brief, `/register` calls `igris_brief_similar` (threshold 0.85).
A near-duplicate at or above the threshold is surfaced and the skill STOPS for
operator confirmation before creating; if similarity search is unavailable
(sqlite-vec or embeddings absent — a clean capability message, not a crash) the
step fails open, matching every other Igris gate. This is the one genuinely-new
gate FR-199 ships.
