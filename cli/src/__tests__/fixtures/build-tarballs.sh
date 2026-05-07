#!/usr/bin/env bash
# build-tarballs.sh — generate test fixtures for the tarball fetcher.
#
# Produces (in cli/src/__tests__/fixtures/tarballs/):
#   - clean-core.tar.gz — a synthetic Igris release tarball containing
#     core/{agents,skills,rules,prompts,hooks,scripts,templates}/ +
#     core/SOUL.md + core/igris_tree.json. GitHub's standard tarball
#     format wraps the repo in a top-level prefix dir like
#     `igris-ai-<sha>/` so we mirror that.
#   - zip-slip.tar.gz — a malicious tarball whose entries try to
#     escape the extraction root via `../etc/passwd` AND an absolute
#     path entry. M1.2's zip-slip test asserts BOTH are rejected.
#
# Run from any cwd; the script computes its own location and writes
# fixtures relative to that. Idempotent — overwrites existing files.
#
# These fixtures are committed; do NOT regenerate in CI. They were
# regenerated 2026-05-07 for MG-014 M1.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/tarballs"
mkdir -p "$OUT"

# --- clean-core.tar.gz -------------------------------------------------
WORK_CLEAN="$(mktemp -d)"
trap 'rm -rf "$WORK_CLEAN"' EXIT

PREFIX="igris-ai-fixturesha"
CORE="$WORK_CLEAN/$PREFIX/core"
mkdir -p "$CORE/agents" "$CORE/skills/demo" "$CORE/rules" \
         "$CORE/prompts" "$CORE/hooks" "$CORE/scripts" "$CORE/templates"

cat > "$CORE/SOUL.md" <<'EOF'
# Igris Soul (fixture)
EOF

cat > "$CORE/igris_tree.json" <<'EOF'
{ "version": "fixture", "agents": {}, "tasks": {} }
EOF

cat > "$CORE/agents/manifest.yaml" <<'EOF'
agents: []
EOF

cat > "$CORE/skills/demo/SKILL.md" <<'EOF'
# demo skill (fixture)
EOF

cat > "$CORE/rules/00-igris-universal.md" <<'EOF'
# universal (fixture)
EOF

cat > "$CORE/prompts/igris_os.md" <<'EOF'
# igris_os (fixture)
EOF

cat > "$CORE/hooks/canonical-settings.json" <<'EOF'
{ "hooks": {} }
EOF

cat > "$CORE/scripts/verify_mirror.sh" <<'EOF'
#!/usr/bin/env bash
echo "verify_mirror (fixture)"
EOF
chmod +x "$CORE/scripts/verify_mirror.sh"

cat > "$CORE/templates/CLAUDE.md.tmpl" <<'EOF'
# CLAUDE.md (fixture template) version: {{IGRIS_VERSION}}
EOF

(
  cd "$WORK_CLEAN"
  tar -czf "$OUT/clean-core.tar.gz" "$PREFIX"
)
echo "wrote $OUT/clean-core.tar.gz"

# --- zip-slip.tar.gz ---------------------------------------------------
# We CRAFT a tarball whose internal entries include "../etc/passwd"
# and "/etc/passwd". GNU tar refuses to write absolute paths or paths
# with "../" by default — so we use Node to write the tarball with the
# unsafe entry names verbatim. The Node script lives next to this one.
node "$HERE/_build_zipslip.mjs" "$OUT/zip-slip.tar.gz"
echo "wrote $OUT/zip-slip.tar.gz"
