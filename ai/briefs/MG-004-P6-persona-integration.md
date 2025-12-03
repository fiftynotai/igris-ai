# MG-004-P6: Persona Integration

**ID:** MG-004-P6
**Type:** Migration
**Status:** In Progress
**Priority:** P1-High
**Created:** 2025-12-03
**Updated:** 2025-12-03
**Effort:** M-Medium (1-2 days)
**Parent:** MG-004 (IGRIS v3.1 Migration)
**Phase:** 6 of 8

---

## Summary

Implement the persona-centric alias system where personas define their own agent names, NOT hardcoded in agent files. This enables unlimited community personas without modifying core agent files.

---

## Problem

Current approach is not scalable:
- Agent aliases hardcoded in agent files
- Adding new persona = editing 10 agent files
- Community can't create personas with custom agent names
- No standard format for persona agent customization

---

## Goal

Create a scalable persona-centric alias system:
1. Agents have static names (planner, coder, etc.)
2. Personas define aliases in their persona.json
3. Main agent resolves display names at runtime
4. Fallback to STATIC_NAME.upper() if no alias

---

## Deliverables

### 1. Persona JSON Schema Extension

Add `agent_aliases` and `agent_phrases` to persona.json format:

```json
{
  "$schema": "https://igris.ai/schemas/persona.json",
  "version": "1.0.0",

  "name": "{persona-name}",
  "full_name": "{DISPLAY NAME}",

  "branding": {
    "title": "{Title}",
    "tagline": "{Catchphrase}"
  },

  "agent_aliases": {
    "planner": "{PERSONA_PLANNER_NAME}",
    "coder": "{PERSONA_CODER_NAME}",
    "tester": "{PERSONA_TESTER_NAME}",
    "reviewer": "{PERSONA_REVIEWER_NAME}",
    "documenter": "{PERSONA_DOCUMENTER_NAME}",
    "releaser": "{PERSONA_RELEASER_NAME}",
    "auditor": "{PERSONA_AUDITOR_NAME}",
    "debugger": "{PERSONA_DEBUGGER_NAME}",
    "ideator": "{PERSONA_IDEATOR_NAME}",
    "explorer": "{PERSONA_EXPLORER_NAME}"
  },

  "agent_phrases": {
    "summon": "{emoji} Summoning {agent}...",
    "working": "{emoji} {agent} is working...",
    "complete": "{emoji} {agent} complete!",
    "failed": "{emoji} {agent} encountered an issue."
  },

  "commands": {
    "session_start": "AWAKEN",
    "session_end": "REST",
    "implement": "HUNT",
    "status": "SCAN",
    "register": "REGISTER",
    "archive": "ARCHIVE",
    "audit": "AUDIT",
    "document": "CHRONICLE",
    "release": "HERALD",
    "ideate": "DREAM",
    "explore": "EXPLORE",
    "digivolve": "DIGIVOLVE"
  }
}
```

### 2. Update Crimson Persona

Update `ai/personas/crimson/persona.json`:

```json
{
  "persona": "cyber-monkey",
  "name": "Crimson",
  "full_name": "CRIMSON - Cyber Monkey Guardian",
  "version": "2.0.0",

  "branding": {
    "title": "Crimson",
    "tagline": "SAY. LESS. 😈🔥"
  },

  "agent_aliases": {
    "planner": "ARCHITECT",
    "coder": "FORGER",
    "tester": "SENTINEL",
    "reviewer": "WARDEN",
    "documenter": "CHRONICLER",
    "releaser": "HERALD",
    "auditor": "INQUISITOR",
    "debugger": "MENDER",
    "ideator": "ORACLE",
    "explorer": "SEEKER"
  },

  "agent_phrases": {
    "summon": "🐒🔥 Summoning {agent}...",
    "working": "🐒⚡ {agent} is forging...",
    "complete": "🐒💥 {agent} mission complete!",
    "failed": "🐒😤 {agent} hit a snag!"
  },

  "commands": {
    "session_start": "AWAKEN",
    "session_end": "REST",
    "implement": "HUNT",
    "status": "SCAN",
    "register": "REGISTER",
    "archive": "ARCHIVE",
    "audit": "AUDIT",
    "document": "CHRONICLE",
    "release": "HERALD",
    "ideate": "DREAM",
    "explore": "EXPLORE",
    "digivolve": "DIGIVOLVE"
  }
}
```

### 3. Create Igris Persona (Baseline)

Create `ai/personas/igris/persona.json`:

```json
{
  "persona": "shadow-knight",
  "name": "Igris",
  "full_name": "IGRIS - The Shadow Knight",
  "version": "1.0.0",

  "branding": {
    "title": "Igris",
    "tagline": "Structure over chaos."
  },

  "agent_aliases": {
    "planner": "TACTICIAN",
    "coder": "SCRIBE",
    "tester": "WATCHER",
    "reviewer": "GUARDIAN",
    "documenter": "LOREKEEPER",
    "releaser": "ANNOUNCER",
    "auditor": "INSPECTOR",
    "debugger": "HEALER",
    "ideator": "VISIONARY",
    "explorer": "SCOUT"
  },

  "agent_phrases": {
    "summon": "✦ {agent} rises...",
    "working": "✦ {agent} is analyzing...",
    "complete": "✦ {agent} stands down.",
    "failed": "✦ {agent} requires assistance."
  },

  "commands": {
    "session_start": "ARISE",
    "session_end": "REST",
    "implement": "HUNT",
    "status": "REPORT",
    "register": "REGISTER",
    "archive": "ARCHIVE",
    "audit": "AUDIT",
    "document": "CHRONICLE",
    "release": "HERALD",
    "ideate": "DREAM",
    "explore": "EXPLORE",
    "digivolve": "DIGIVOLVE"
  }
}
```

### 4. Persona Template for Community

Create `ai/personas/PERSONA_TEMPLATE/persona.json`:

```json
{
  "$schema": "https://igris.ai/schemas/persona.json",
  "version": "1.0.0",

  "_comment": "Copy this template to create your own persona!",

  "persona": "{your-persona-id}",
  "name": "{YourPersonaName}",
  "full_name": "{YOUR PERSONA - Full Title}",

  "branding": {
    "title": "{Display Title}",
    "tagline": "{Your catchphrase}",
    "theme_color": "#HEXCODE"
  },

  "personality": {
    "core_traits": ["trait1", "trait2", "trait3"],
    "voice": "Description of how your persona speaks"
  },

  "emojis": {
    "primary": "🔥",
    "secondary": "⚡",
    "success": "✅",
    "error": "❌",
    "working": "⚙️"
  },

  "agent_aliases": {
    "_comment": "Give each agent a themed name that fits your persona",
    "planner": "PLANNER_ALIAS",
    "coder": "CODER_ALIAS",
    "tester": "TESTER_ALIAS",
    "reviewer": "REVIEWER_ALIAS",
    "documenter": "DOCUMENTER_ALIAS",
    "releaser": "RELEASER_ALIAS",
    "auditor": "AUDITOR_ALIAS",
    "debugger": "DEBUGGER_ALIAS",
    "ideator": "IDEATOR_ALIAS",
    "explorer": "EXPLORER_ALIAS"
  },

  "agent_phrases": {
    "_comment": "Use {agent} as placeholder for the alias",
    "summon": "{emoji} Activating {agent}...",
    "working": "{emoji} {agent} is working...",
    "complete": "{emoji} {agent} complete!",
    "failed": "{emoji} {agent} failed!"
  },

  "commands": {
    "_comment": "Define command aliases for persona actions",
    "session_start": "START",
    "session_end": "END",
    "implement": "BUILD",
    "status": "STATUS",
    "register": "CREATE",
    "archive": "ARCHIVE",
    "audit": "AUDIT",
    "document": "DOCS",
    "release": "RELEASE",
    "ideate": "IDEATE",
    "explore": "EXPLORE",
    "digivolve": "EVOLVE"
  },

  "masks": {
    "_comment": "Define different personality levels (optional)",
    "none": {
      "level": "Standard Mode",
      "description": "Basic helpful mode",
      "tone": "Professional and helpful"
    },
    "half": {
      "level": "Enhanced Mode",
      "description": "More personality",
      "tone": "Energetic and focused"
    },
    "full": {
      "level": "Full Mode",
      "description": "Maximum personality",
      "tone": "Fully themed and immersive"
    }
  }
}
```

### 5. Resolution Logic in CLAUDE.md

Add resolution logic to main agent:

```markdown
## 🎭 PERSONA ALIAS RESOLUTION

### Loading Persona
```python
def load_persona():
    """Load active persona from ai/persona.json"""
    persona_path = "ai/persona.json"
    if exists(persona_path):
        return json.load(persona_path)
    return None
```

### Resolving Agent Display Name
```python
def get_agent_display_name(static_name: str) -> str:
    """Get persona-appropriate agent name."""
    persona = load_persona()

    if persona and "agent_aliases" in persona:
        aliases = persona["agent_aliases"]
        if static_name in aliases:
            return aliases[static_name]

    # Fallback: capitalize static name
    return static_name.upper()
```

### Using Agent Phrases
```python
def get_agent_phrase(phrase_type: str, agent_name: str) -> str:
    """Get persona-appropriate phrase for agent action."""
    persona = load_persona()

    if persona and "agent_phrases" in persona:
        phrase_template = persona["agent_phrases"].get(phrase_type, "{agent}")
        return phrase_template.replace("{agent}", agent_name)

    # Fallback
    defaults = {
        "summon": f"Invoking {agent_name}...",
        "working": f"{agent_name} is working...",
        "complete": f"{agent_name} complete.",
        "failed": f"{agent_name} failed."
    }
    return defaults.get(phrase_type, agent_name)
```

### Example Usage in Workflow
```python
# When invoking planner
static_name = "planner"
display_name = get_agent_display_name(static_name)  # "ARCHITECT"
summon_msg = get_agent_phrase("summon", display_name)
# "🐒🔥 Summoning ARCHITECT..."

print(summon_msg)
Task(subagent_type=static_name, prompt=context)

complete_msg = get_agent_phrase("complete", display_name)
# "🐒💥 ARCHITECT mission complete!"
print(complete_msg)
```
```

### 6. Command Mapping

Add command resolution:

```markdown
### Persona Command Resolution
```python
def get_command(action: str) -> str:
    """Get persona command for action, or default."""
    persona = load_persona()

    if persona and "commands" in persona:
        return persona["commands"].get(action, action.upper())

    # Defaults
    defaults = {
        "session_start": "ARISE",
        "session_end": "REST",
        "implement": "HUNT",
        "status": "SCAN"
    }
    return defaults.get(action, action.upper())
```

### Reverse Command Mapping
```python
def parse_command(user_input: str) -> str:
    """Map persona command to action."""
    persona = load_persona()

    if persona and "commands" in persona:
        for action, command in persona["commands"].items():
            if user_input.upper() == command.upper():
                return action

    # Check defaults
    return user_input.lower()
```
```

---

## Tasks

### Schema & Templates
- [ ] Define persona.json schema with agent_aliases
- [ ] Create PERSONA_TEMPLATE directory
- [ ] Document persona creation guide

### Update Existing Personas
- [ ] Update crimson persona.json with agent_aliases
- [ ] Create igris baseline persona.json
- [ ] Test both personas load correctly

### Resolution Logic
- [ ] Add get_agent_display_name() to CLAUDE.md
- [ ] Add get_agent_phrase() to CLAUDE.md
- [ ] Add command resolution logic
- [ ] Integrate into workflow output

### Testing
- [ ] Test alias resolution with crimson persona
- [ ] Test alias resolution with igris persona
- [ ] Test fallback when no persona loaded
- [ ] Test partial aliases (missing some agents)

---

## Acceptance Criteria

- [ ] persona.json schema documented with agent_aliases
- [ ] Crimson persona updated with all 10 agent aliases
- [ ] Igris baseline persona created with all 10 aliases
- [ ] PERSONA_TEMPLATE created for community
- [ ] get_agent_display_name() resolves correctly
- [ ] get_agent_phrase() resolves correctly
- [ ] Command mapping works both directions
- [ ] Fallback to STATIC_NAME.upper() works
- [ ] Workflow displays persona-appropriate names
- [ ] Community can create persona without editing agents

---

## Session State

**Current Status:** Not Started
**Current Task:** None
**Blockers:** None
**Next Step:** Wait for P1-P5 completion

---

## Dependencies

- **Depends on:** MG-004-P1 through P5 (all agents defined)
- **Blocks:** P7, P8

---

## History

- 2025-12-03: Brief created

---

🔥 **YOUR PERSONA, YOUR NAMES** 🔥
