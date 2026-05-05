#!/bin/bash
set -e

# Description: Installs Igris git hooks by symlinking committed hook
#   scripts from scripts/git-hooks/ into .git/hooks/. Idempotent.
#
# Usage: scripts/install_git_hooks.sh

REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_DIR="$REPO_ROOT/scripts/git-hooks"
TARGET_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: source dir not found: $SOURCE_DIR"
  exit 1
fi
if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: .git/hooks not found (is this a git repo?): $TARGET_DIR"
  exit 1
fi

installed=0
for hook in "$SOURCE_DIR"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  target="$TARGET_DIR/$name"

  # Make committed hook executable (in case file mode wasn't preserved).
  chmod +x "$hook"

  # Replace any existing hook (file or symlink) with a symlink to ours.
  # TD-072 F3: if the target is a real file (not a symlink), it predates
  # this installer — most likely a hand-rolled hook a developer wrote
  # before adopting Igris. Back it up before clobbering so their work is
  # not silently lost. Existing symlinks (the steady state for an Igris
  # install) are replaced silently.
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    backup="$target.pre-igris.bak.$(date +%s)"
    echo "WARNING: backing up existing non-symlink hook at $target -> $backup" >&2
    cp -p "$target" "$backup"
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    rm -f "$target"
  fi

  ln -s "$hook" "$target"
  echo "Installed: $name -> $hook"
  installed=$((installed + 1))
done

echo ""
echo "Installed $installed hook(s)."
echo "To bypass on a single commit: git commit --no-verify"
