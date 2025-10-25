# Persona Configuration

## Overview

Igris AI supports persona customization with **two-tier configuration**:

1. **Repository default:** `ai/persona.json.default` (tracked, mode: none)
2. **Personal config:** `ai/persona.json` (gitignored, your settings)

## Quick Start - Change What I Call You

Edit your personal config:

```bash
# Option 1: Direct edit
nano ai/persona.json
# Change "title": "Monarch" to whatever you prefer

# Option 2: Use jq
jq '.branding.title = "Your Name"' ai/persona.json > temp.json && mv temp.json ai/persona.json

# Apply changes
./scripts/persona_mask.sh adjust light  # or your current mask level
```

## Configuration Structure

```json
{
  "persona": "igris",           // Persona pack name
  "mask": "light",              // none | half | light | full
  "branding": {
    "title": "Monarch",         // ← What I call you
    "company": "Shadow Industries",
    "intro": "Welcome message",
    "tagline": "Project tagline"
  },
  "tone": {
    "level": "C1",              // C1 (professional) | C2 (dramatic) | C3 (epic)
    "addressing_mode": "T3"
  }
}
```

## Mask Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `none` | Dormant (no persona) | Default, open source contributors |
| `half` | Branding only | Corporate, minimal theming |
| `light` | Professional + flair | Balanced, workplace appropriate |
| `full` | Complete immersion | Solo dev, maximum theming |

## Privacy & Git

✅ **Safe to commit:**
- `ai/persona.json.default` - Repository default (mode: none)
- `ai/templates/persona.json.example` - Template for users

❌ **Never committed (gitignored):**
- `ai/persona.json` - Your personal configuration
- `ai/personas/` - Installed persona packs
- `ai/prompts/persona_loader.md` - Generated hook

## Common Tasks

### Change Title (What I Call You)

```bash
# Edit config
nano ai/persona.json
# Change: "title": "Monarch" → "title": "Your Name"

# Regenerate
./scripts/persona_mask.sh adjust light
```

### Change Company Branding

```bash
jq '.branding.company = "Your Company"' ai/persona.json > temp.json
mv temp.json ai/persona.json
./scripts/persona_mask.sh adjust light
```

### Switch Mask Level

```bash
./scripts/persona_mask.sh adjust none   # Turn off
./scripts/persona_mask.sh adjust half   # Minimal
./scripts/persona_mask.sh adjust light  # Balanced
./scripts/persona_mask.sh adjust full   # Maximum
```

### Check Current Settings

```bash
./scripts/persona_mask.sh status
# or
cat ai/persona.json
```

## For Contributors

If you clone this repo:

1. **Default behavior:** Mode `none` (no persona)
2. **To customize:** Copy default to personal config:
   ```bash
   cp ai/persona.json.default ai/persona.json
   # Edit ai/persona.json
   ./scripts/persona_mask.sh adjust light
   ```

Your personal `ai/persona.json` will never be committed.

## Troubleshooting

**Q: I changed persona.json but nothing happened**
A: Run `./scripts/persona_mask.sh adjust <level>` to regenerate CLAUDE.md

**Q: Can I share my persona settings?**
A: Yes! Share your `ai/persona.json` file directly (not via git)

**Q: How do I reset to defaults?**
A: `cp ai/persona.json.default ai/persona.json`

---

**Current system:**
- Default (repo): mode `none` (no personalization)
- Your local: mode `light` (professional + flair)
- Never pushed to git ✅
