#!/bin/bash

# Igris AI Initialization Script
# Initializes Igris AI in a target project

set -e

echo "⚔️  Igris AI - Project Initialization"
echo "========================================"
echo ""

# Get target project directory
TARGET_DIR=${1:-.}

if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

cd "$TARGET_DIR"
TARGET_DIR=$(pwd)

echo "📁 Target directory: $TARGET_DIR"
echo ""

# Check if Igris AI already initialized
if [ -d "ai" ]; then
  echo "⚠️  Warning: 'ai/' directory already exists"
  read -p "Continue and overwrite? [y/N]: " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "❌ Initialization cancelled"
    exit 1
  fi
fi

# Create directory structure
echo "📦 Creating directory structure..."
mkdir -p ai/{briefs,prompts,templates,session/archive,context,plugins}
mkdir -p scripts
mkdir -p docs

# Get the Igris AI installation directory
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# Get Igris AI version
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "unknown")

# Copy templates
echo "📄 Copying templates..."
cp "$IGRIS_DIR/ai/briefs/"*-TEMPLATE.md ai/briefs/
cp "$IGRIS_DIR/ai/prompts/"*.md ai/prompts/
cp "$IGRIS_DIR/ai/templates/"*.md ai/templates/

# Copy CLAUDE.md template for persona regeneration
cp "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" scripts/

# Copy CONTRIBUTING guide
cp "$IGRIS_DIR/ai/CONTRIBUTING.md" ai/

# Copy persona.json.default
cp "$IGRIS_DIR/ai/persona.json.default" ai/

# Copy bundled Igris persona
if [ -d "$IGRIS_DIR/ai/personas/igris" ]; then
  mkdir -p ai/personas
  cp -r "$IGRIS_DIR/ai/personas/igris" ai/personas/

  # Create active persona.json with Igris half mask as default
  cat > ai/persona.json <<'EOF'
{
  "persona": "igris",
  "mask": "half",
  "installed_at": null,
  "version": "1.0.0",
  "branding": {
    "title": "Igris",
    "intro": "Welcome to the sanctum of code",
    "tagline": "Where shadows enforce architecture"
  },
  "user": {
    "name": ""
  },
  "tone": {
    "level": "Shadow Knight",
    "description": "Dramatic Persona - Complete immersion",
    "addressing_mode": "Monarch"
  },
  "features": {
    "commands": true,
    "banner": true,
    "shadow_commands": true
  }
}
EOF
fi

# Create empty session files
echo "📝 Creating session files..."
cat > ai/session/CURRENT_SESSION.md <<'EOF'
# Current Session

**Status:** No active session
**Last Updated:** N/A

---

## Session Goal

[No active session]

---

## Tasks

[None]

---

## Current State

[No active work in progress]

---

## Next Steps When Resuming

[N/A]
EOF

cat > ai/session/BLOCKERS.md <<'EOF'
# Active Blockers

**Last Updated:** N/A

---

[No active blockers]
EOF

cat > ai/session/DECISIONS.md <<'EOF'
# Architectural Decisions

**Last Updated:** N/A

---

[No decisions recorded yet]
EOF

cat > ai/session/LEARNINGS.md <<'EOF'
# Learnings & Patterns

**Last Updated:** N/A

---

[No learnings recorded yet]
EOF

# Create context README
cat > ai/context/README.md <<'EOF'
# Architecture Context

This directory should contain project-specific architecture documentation:

- **architecture_map.md** - Architecture pattern, layer boundaries, module structure
- **api_pattern.md** - API call patterns, state management, error handling
- **coding_guidelines.md** - Naming conventions, doc-comments, linting rules
- **module_catalog.md** - Module inventory, purposes, dependencies

## How to Generate

Use the `generate_architecture_docs.md` prompt to have Claude analyze your project and create these files:

```
Please analyze this project using ai/prompts/generate_architecture_docs.md
```

Claude will ask questions about your architecture and generate comprehensive documentation.
EOF

# Create plugins README
cat > ai/plugins/README.md <<'EOF'
# Igris AI Plugins

This directory tracks installed Igris AI plugins.

## Installed Plugins

See `installed.json` for the list of installed plugins.

## Installing a Plugin

```bash
./scripts/plugin_install.sh <plugin-repo-url>
```

## Available Plugins

- **igris-ai-persona-igris** - Shadow Knight persona pack
- **igris-ai-distribution-flutter** - Smart release automation for Flutter projects

## Creating Your Own Plugin

See the main Igris AI documentation for plugin development guide.
EOF

# Initialize plugin registry
cat > ai/plugins/installed.json <<'EOF'
{
  "plugins": [],
  "last_updated": null
}
EOF

# ============================================================================
# Hook System Functions (Enhancement Hooks - v2.5.0)
# ============================================================================
# These functions enable plugins to extend Igris AI with AI capabilities,
# code analysis tools, and workflow augmentations.
#
# Specification: ai/hooks/HOOKS_SPEC.md
# ============================================================================

# Resolve hook script path for a given hook type
# Usage: resolve_hooks "HOOK_TYPE"
# Returns: Hook script path (exit 0) or nothing (exit 1)
resolve_hooks() {
  local hook_type="$1"

  # Check if installed_plugins.json exists
  if [ ! -f "ai/plugins/installed.json" ]; then
    return 1  # No plugins installed
  fi

  # Use Python3 for JSON parsing (jq fallback if available)
  local hook_script=""

  if command -v jq &> /dev/null; then
    # Use jq if available (faster)
    hook_script=$(jq -r ".plugins[] | select(.hooks.$hook_type != null) | .hooks.$hook_type | select(. != null)" ai/plugins/installed.json 2>/dev/null | head -n 1)
  else
    # Fallback to Python3 (always available)
    hook_script=$(python3 <<EOF 2>/dev/null
import json, sys
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    for plugin in data.get('plugins', []):
        if '$hook_type' in plugin.get('hooks', {}):
            print(plugin['hooks']['$hook_type'])
            break
except:
    pass
EOF
)
  fi

  # Validate hook script exists and is executable
  if [ -n "$hook_script" ] && [ -f "$hook_script" ] && [ -x "$hook_script" ]; then
    echo "$hook_script"
    return 0
  fi

  # No valid hook found
  return 1
}

# Execute a hook with input data
# Usage: execute_hook "HOOK_TYPE" "input_data"
# Returns: Hook output (stdout) and exit code (0=success, 1=error, 2=skip)
execute_hook() {
  local hook_type="$1"
  local input_data="$2"

  # Resolve hook script
  local hook_script
  hook_script=$(resolve_hooks "$hook_type")
  if [ $? -ne 0 ]; then
    # No hook registered - skip silently
    return 2
  fi

  # Set environment variables for hook
  export IGRIS_HOOK_TYPE="$hook_type"
  export IGRIS_PROJECT_ROOT="$(pwd)"
  export IGRIS_VERSION="$IGRIS_VERSION"

  # Optional: Set brief-specific variables if available
  if [ -n "$IGRIS_BRIEF_ID" ]; then
    export IGRIS_BRIEF_ID
  fi

  if [ -f "ai/session/CURRENT_SESSION.md" ]; then
    export IGRIS_SESSION_FILE="ai/session/CURRENT_SESSION.md"
  fi

  # Execute hook with input
  local output
  local exit_code
  output=$(echo "$input_data" | "$hook_script" 2>&1)
  exit_code=$?

  # Handle exit codes according to spec
  case $exit_code in
    0)
      # Success - return output
      echo "$output"
      return 0
      ;;
    1)
      # Error - show output to stderr, return error
      echo "⚠️ Hook $hook_type failed:" >&2
      echo "$output" >&2
      return 1
      ;;
    2)
      # Skip - not applicable, continue silently
      return 2
      ;;
    *)
      # Unknown exit code - treat as error
      echo "⚠️ Hook $hook_type returned unexpected exit code: $exit_code" >&2
      echo "$output" >&2
      return 1
      ;;
  esac
}

# ============================================================================
# End Hook System Functions
# ============================================================================

# Create Claude Code integration (hooks + CLAUDE.md)
echo "🤖 Setting up Claude Code integration..."
mkdir -p .claude/hooks

# Copy startup hook
cp "$IGRIS_DIR/scripts/templates/startup.sh.template" .claude/hooks/startup.sh
chmod +x .claude/hooks/startup.sh

# Resolve persona hook (if plugin provides one)
PERSONA_INJECTION=""

# Check if bundled persona is active
if [ -f "ai/persona.json" ]; then
  PERSONA_NAME=$(python3 -c "import json, sys; data=json.load(open('ai/persona.json')); print(data.get('persona', 'none'))" 2>/dev/null || echo "none")
  PERSONA_MASK=$(python3 -c "import json, sys; data=json.load(open('ai/persona.json')); print(data.get('mask', 'none'))" 2>/dev/null || echo "none")

  if [ "$PERSONA_NAME" != "none" ] && [ "$PERSONA_MASK" != "none" ]; then
    PERSONA_MASK_FILE="ai/personas/$PERSONA_NAME/masks/${PERSONA_MASK}.md"
    if [ -f "$PERSONA_MASK_FILE" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_MASK_FILE")
    fi
  fi
fi

# Plugin hooks override bundled persona (if both exist)
if [ -f "ai/plugins/installed.json" ]; then
  if command -v jq &> /dev/null; then
    PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
    if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
    fi
  else
    echo "⚠️  Note: jq not found - plugin hooks will not be processed"
    echo "   Install for full plugin support:"
    echo "   macOS: brew install jq"
    echo "   Ubuntu/Debian: sudo apt install jq"
    echo ""
  fi
fi

# Create CLAUDE.md with variable substitution
# Use a two-step process to handle multi-line PERSONA_INJECTION
INSTALL_DATE=$(date -u +"%Y-%m-%d")

# Determine hook status
HOOK_STATUS="No enhancement hooks installed"
INSTALLED_ENHANCEMENT_PLUGINS="None"

if [ -f "ai/plugins/installed.json" ]; then
  # Count plugins with hooks
  if command -v jq &> /dev/null; then
    PLUGIN_COUNT=$(jq '.plugins | length' ai/plugins/installed.json 2>/dev/null || echo "0")
    if [ "$PLUGIN_COUNT" -gt 0 ]; then
      HOOK_STATUS="$PLUGIN_COUNT plugin(s) with enhancement hooks installed"
      INSTALLED_ENHANCEMENT_PLUGINS=$(jq -r '.plugins[].name' ai/plugins/installed.json 2>/dev/null | paste -sd ", " -)
    fi
  else
    # Python fallback
    PLUGIN_COUNT=$(python3 <<EOF 2>/dev/null
import json
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    print(len(data.get('plugins', [])))
except:
    print('0')
EOF
)
    if [ "$PLUGIN_COUNT" != "0" ] && [ -n "$PLUGIN_COUNT" ]; then
      HOOK_STATUS="$PLUGIN_COUNT plugin(s) with enhancement hooks installed"
      INSTALLED_ENHANCEMENT_PLUGINS=$(python3 <<EOF 2>/dev/null
import json
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    names = [p.get('name', 'unknown') for p in data.get('plugins', [])]
    print(', '.join(names))
except:
    pass
EOF
)
    fi
  fi
fi

# First pass: Replace simple variables
sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
    -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
    -e "s/{{HOOK_STATUS}}/$HOOK_STATUS/g" \
    -e "s/{{INSTALLED_ENHANCEMENT_PLUGINS}}/$INSTALLED_ENHANCEMENT_PLUGINS/g" \
    "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md.tmp

# Second pass: Replace persona injection using perl (handles newlines)
if [ -n "$PERSONA_INJECTION" ]; then
  # Escape special characters for perl regex
  ESCAPED_INJECTION=$(printf '%s\n' "$PERSONA_INJECTION" | perl -pe 's/([\\\/\$])/\\$1/g')
  perl -i -pe "s/\{\{PERSONA_INJECTION\}\}/$ESCAPED_INJECTION/g" CLAUDE.md.tmp
else
  # Remove the placeholder if no injection
  perl -i -pe 's/\{\{PERSONA_INJECTION\}\}//g' CLAUDE.md.tmp
fi

mv CLAUDE.md.tmp CLAUDE.md

# Copy core scripts
echo "🔧 Installing Igris AI scripts..."
cp "$IGRIS_DIR/scripts/plugin_install.sh" scripts/
cp "$IGRIS_DIR/scripts/plugin_uninstall.sh" scripts/
cp "$IGRIS_DIR/scripts/plugin_list.sh" scripts/
cp "$IGRIS_DIR/scripts/plugin_update.sh" scripts/
cp "$IGRIS_DIR/scripts/igris_update.sh" scripts/
cp "$IGRIS_DIR/scripts/install_shell_integration.sh" scripts/

# Copy persona management scripts (if they exist)
if [ -f "$IGRIS_DIR/scripts/persona_install.sh" ]; then
  cp "$IGRIS_DIR/scripts/persona_install.sh" scripts/
fi
if [ -f "$IGRIS_DIR/scripts/persona_mask.sh" ]; then
  cp "$IGRIS_DIR/scripts/persona_mask.sh" scripts/
fi
chmod +x scripts/*.sh

# Create archive README
cat > ai/session/archive/README.md <<'EOF'
# Session Archive

Completed sessions are archived here for reference.

## Naming Convention

`YYYY-MM-DD-NNN.md` where NNN is a session number for that day.

Example: `2025-10-13-001.md`
EOF

# Create version tracking file
echo "📌 Creating version tracking..."
cat > .igris_version <<EOF
{
  "igris_ai_version": "$IGRIS_VERSION",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "last_updated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "plugins": {}
}
EOF

echo ""
echo "✅ Igris AI initialized successfully!"
echo ""
echo "🤖 Claude Code Integration:"
echo "   ✓ Startup hook enabled (.claude/hooks/startup.sh)"
echo "   ✓ Context file created (CLAUDE.md)"
echo "   ✓ True zero-configuration - works immediately!"
echo ""
echo "📚 Getting Started:"
echo ""
echo "1. Launch Claude Code:"
echo "   $ claude"
echo ""
echo "   BEFORE YOU TYPE, you'll see:"
echo "   ⚔️  Welcome to Igris AI on Claude Code"
echo "   📊 Project Status: [briefs, status, blockers]"
echo "   💡 Recommended Next Task: [highest priority]"
echo "   Ready for your command!"
echo ""
echo "2. (Optional) Install shell integration for terminal notifications:"
echo "   $ ./scripts/install_shell_integration.sh"
echo "   This will show Igris AI version when entering the project"
echo ""
echo "📚 Next Steps:"
echo ""
echo "1. Generate coding guidelines (recommended first):"
echo "   'Please generate coding guidelines using ai/prompts/generate_coding_guidelines.md'"
echo ""
echo "2. Generate architecture documentation:"
echo "   'Please analyze this project using ai/prompts/generate_architecture_docs.md'"
echo ""
echo "3. Analyze your codebase for migration tasks:"
echo "   'Please analyze this codebase using ai/prompts/migration_analysis.md'"
echo ""
echo "4. Install plugins (optional):"
echo "   $ ./scripts/plugin_install.sh <plugin-repo-url>"
echo ""
echo "📖 Documentation: ai/CONTRIBUTING.md"
echo "🔗 More info: https://github.com/fiftynotai/igris-ai"
echo ""
