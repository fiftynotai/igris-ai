# Plugin Development Guide

Guide for creating Blueprint AI plugins.

---

## What is a Plugin?

A Blueprint AI plugin extends functionality by adding:
- Platform-specific tools (Flutter, React Native, etc.)
- Distribution automation (build, version, deploy)
- CI/CD integration
- Custom workflows
- Third-party integrations

---

## Plugin Structure

### Minimum Required Files

```
your-plugin/
├── plugin.json              # Plugin metadata (REQUIRED)
├── install.sh               # Installation script (REQUIRED)
├── uninstall.sh             # Uninstallation script (OPTIONAL)
├── README.md                # Plugin documentation (REQUIRED)
└── [plugin files]           # Scripts, templates, configs
```

### Example: Full Plugin Structure

```
blueprint-ai-distribution-flutter/
├── plugin.json
├── install.sh
├── uninstall.sh
├── README.md
├── scripts/
│   ├── distribute.sh
│   ├── bump_version.sh
│   └── generate_release_notes.sh
├── templates/
│   ├── release_notes.md
│   └── changelog.md
├── docs/
│   ├── INSTALLATION.md
│   └── USAGE.md
└── examples/
    └── config.example.json
```

---

## plugin.json Specification

### Required Fields

```json
{
  "name": "blueprint-ai-your-plugin",
  "version": "1.0.0",
  "description": "Short description of what the plugin does",
  "capabilities": ["capability1", "capability2"],
  "platforms": ["flutter", "react-native", "web"]
}
```

### Full Example

```json
{
  "name": "blueprint-ai-distribution-flutter",
  "version": "1.0.0",
  "description": "Smart release automation for Flutter projects",
  "author": "Your Name",
  "repository": "https://github.com/yourorg/blueprint-ai-distribution-flutter",
  "homepage": "https://docs.yourorg.com/plugins/distribution-flutter",
  "license": "MIT",
  "blueprint_ai_version": ">=1.0.0",
  "capabilities": [
    "distribution",
    "versioning",
    "release_notes",
    "fastlane",
    "firebase"
  ],
  "platforms": [
    "flutter",
    "ios",
    "android"
  ],
  "dependencies": {
    "flutter": ">=3.0.0",
    "fastlane": ">=2.200.0",
    "firebase-tools": ">=11.0.0"
  }
}
```

---

## install.sh Contract

### Input Parameters

```bash
#!/bin/bash
# Your plugin installer

TEMP_DIR=$1      # Temporary directory where plugin is cloned
TARGET_DIR=$2    # Target project directory
```

### Required Checks

```bash
# 1. Check Blueprint AI is initialized
if [ ! -d "$TARGET_DIR/ai" ]; then
  echo "❌ Error: Blueprint AI not initialized"
  exit 1
fi

# 2. Check platform compatibility (if plugin is platform-specific)
if [ ! -f "$TARGET_DIR/pubspec.yaml" ]; then
  echo "❌ Error: Not a Flutter project"
  exit 1
fi
```

### Installation Steps

```bash
# 3. Copy scripts
cp scripts/* "$TARGET_DIR/scripts/"
chmod +x "$TARGET_DIR/scripts/"*.sh

# 4. Copy templates
mkdir -p "$TARGET_DIR/templates"
cp templates/* "$TARGET_DIR/templates/"

# 5. Copy configs (if any)
if [ -f "config.example.json" ]; then
  cp config.example.json "$TARGET_DIR/config.json"
fi

# 6. Interactive setup (optional)
read -p "Run setup wizard? [Y/n]: " RUN_SETUP
if [[ ! "$RUN_SETUP" =~ ^[Nn]$ ]]; then
  bash scripts/setup.sh "$TARGET_DIR"
fi
```

### Success Message

```bash
echo ""
echo "✅ Plugin installed successfully!"
echo ""
echo "📚 Next steps:"
echo "  1. Review configuration in config.json"
echo "  2. Run: ./scripts/your-plugin-command.sh"
echo ""
```

### Full Example

```bash
#!/bin/bash
# Blueprint AI Distribution Plugin Installer

set -e

TEMP_DIR=$1
TARGET_DIR=$2

if [ -z "$TARGET_DIR" ]; then
  TARGET_DIR=$(pwd)
fi

echo "📦 Installing Blueprint AI Distribution Plugin"
echo ""

# Check Blueprint AI initialized
if [ ! -d "$TARGET_DIR/ai" ]; then
  echo "❌ Error: Blueprint AI not initialized"
  exit 1
fi

# Check Flutter project
if [ ! -f "$TARGET_DIR/pubspec.yaml" ]; then
  echo "❌ Error: Not a Flutter project"
  exit 1
fi

# Copy scripts
echo "📄 Copying scripts..."
cp scripts/*.sh "$TARGET_DIR/scripts/"
chmod +x "$TARGET_DIR/scripts/"*.sh

# Copy templates
echo "📄 Copying templates..."
mkdir -p "$TARGET_DIR/templates"
cp templates/*.md "$TARGET_DIR/templates/"

# Interactive setup
echo ""
read -p "Generate Fastlane config? [Y/n]: " GEN_FASTLANE
if [[ ! "$GEN_FASTLANE" =~ ^[Nn]$ ]]; then
  bash "$TARGET_DIR/scripts/generate_fastlane.sh"
fi

echo ""
echo "✅ Plugin installed successfully!"
echo ""
echo "📚 Next steps:"
echo "  1. Test distribution: ./scripts/smart_distribute.sh staging"
echo "  2. Read docs: templates/release_notes_template.md"
echo ""
```

---

## Capabilities

### Standard Capabilities

Declare what your plugin provides:

- `distribution` - Handles app distribution (TestFlight, Play Store, Firebase)
- `versioning` - Manages version numbers
- `release_notes` - Generates release notes
- `ci_cd` - CI/CD integration
- `testing` - Testing tools
- `linting` - Code quality tools
- `fastlane` - Fastlane integration
- `firebase` - Firebase integration
- `analytics` - Analytics integration
- `monitoring` - Error monitoring (Sentry, etc.)

### Custom Capabilities

You can define custom capabilities:

```json
{
  "capabilities": [
    "distribution",
    "my-custom-workflow",
    "special-integration"
  ]
}
```

---

## Platform Support

### Platform Values

Declare supported platforms:

- `flutter` - Flutter framework
- `react-native` - React Native
- `ios` - iOS native
- `android` - Android native
- `web` - Web applications
- `backend` - Backend services
- `any` - Platform-agnostic

### Example

```json
{
  "platforms": ["flutter", "ios", "android"]
}
```

---

## Testing Your Plugin

### Local Testing

```bash
# 1. Create test project
mkdir test-project
cd test-project

# 2. Initialize Blueprint AI
../../blueprint-ai/scripts/blueprint_init.sh

# 3. Install your plugin locally
./scripts/plugin_install.sh /path/to/your-plugin

# 4. Test plugin functionality
./scripts/your-plugin-command.sh
```

### Test Checklist

- [ ] Plugin installs without errors
- [ ] All scripts copied correctly
- [ ] Scripts are executable
- [ ] Plugin registered in `ai/plugins/installed.json`
- [ ] Plugin functionality works end-to-end
- [ ] Uninstall works correctly
- [ ] Works on fresh project
- [ ] Works with existing Blueprint AI setup

---

## Publishing Your Plugin

### 1. Create GitHub Repository

```bash
# Initialize git
cd your-plugin
git init
git add .
git commit -m "Initial release: v1.0.0"

# Create repo on GitHub, then:
git remote add origin https://github.com/yourorg/your-plugin
git push -u origin main
```

### 2. Create Release

```bash
# Tag version
git tag v1.0.0
git push origin v1.0.0

# Create GitHub Release with notes
```

### 3. Documentation

Include in README.md:
- What the plugin does
- Installation instructions
- Usage examples
- Configuration options
- Troubleshooting

### 4. Submit to Registry (Future)

```bash
# Submit to Blueprint AI plugin registry
blueprint-ai plugin submit https://github.com/yourorg/your-plugin
```

---

## Example Plugin: Hello World

### Minimal Plugin Example

**plugin.json:**
```json
{
  "name": "blueprint-ai-hello",
  "version": "1.0.0",
  "description": "Simple hello world plugin",
  "capabilities": ["greeting"],
  "platforms": ["any"]
}
```

**install.sh:**
```bash
#!/bin/bash
TARGET_DIR=${2:-.}

# Create hello script
cat > "$TARGET_DIR/scripts/hello.sh" <<'EOF'
#!/bin/bash
echo "👋 Hello from Blueprint AI plugin!"
EOF

chmod +x "$TARGET_DIR/scripts/hello.sh"

echo "✅ Hello plugin installed!"
echo "Run: ./scripts/hello.sh"
```

**README.md:**
```markdown
# Blueprint AI Hello Plugin

Simple example plugin.

## Installation

./scripts/plugin_install.sh https://github.com/yourorg/blueprint-ai-hello

## Usage

./scripts/hello.sh
```

---

## Best Practices

### Do's

✅ **Check prerequisites** - Verify Blueprint AI initialized
✅ **Validate compatibility** - Check platform before installing
✅ **Make scripts executable** - `chmod +x` after copying
✅ **Provide examples** - Include example configs
✅ **Document thoroughly** - Clear README and usage docs
✅ **Version properly** - Follow semantic versioning
✅ **Test extensively** - Test on fresh projects
✅ **Handle errors** - Exit with clear error messages

### Don'ts

❌ **Don't assume paths** - Always use parameters passed to install.sh
❌ **Don't overwrite without asking** - Check if files exist first
❌ **Don't hardcode values** - Use configs or prompts
❌ **Don't skip validation** - Always check prerequisites
❌ **Don't leave broken state** - Clean up on errors
❌ **Don't forget uninstall** - Provide way to remove plugin

---

## Plugin Ideas

### Distribution & Deployment
- Flutter distribution (Firebase, TestFlight, Play Store)
- React Native distribution (App Center, CodePush)
- Web deployment (Vercel, Netlify, S3)
- Backend deployment (Docker, Kubernetes)

### Testing & Quality
- E2E testing framework setup
- Visual regression testing
- Performance testing
- Accessibility testing

### CI/CD
- GitHub Actions workflows
- GitLab CI templates
- CircleCI config
- Jenkins pipeline

### Integrations
- Sentry error tracking
- Analytics (Mixpanel, Amplitude)
- Feature flags (LaunchDarkly)
- A/B testing

### Development Tools
- Code generation
- API client generation
- Database migrations
- Localization management

---

## Getting Help

- **Examples:** See [blueprint-ai-distribution-flutter](https://github.com/yourorg/blueprint-ai-distribution-flutter)
- **Issues:** https://github.com/yourorg/blueprint-ai/issues
- **Discussions:** https://github.com/yourorg/blueprint-ai/discussions

---

**Ready to build your plugin? Start with the minimal example above! 🚀**
