---
obligation: "Skill/agent frontmatter must parse under strict YAML"
mechanism: gate
status: shipped
lives_in: "scripts/validate_skill_frontmatter_yaml.py"
summary: "Pre-commit validator runs every SKILL.md frontmatter block through strict PyYAML safe_load — catches the unquoted colon-space scalar that silently skips a skill on Codex."
---

# Skill-frontmatter YAML (TD-219 / #587)

A SKILL.md whose frontmatter has an unquoted mid-value `: ` is silently skipped
by strict parsers (Codex). The pre-commit validator parses every discovered
SKILL.md frontmatter block with strict PyYAML and hard-fails on any block that
will not safe_load — the same strict-parse class Codex uses.
