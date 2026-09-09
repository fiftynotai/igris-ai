#!/bin/bash
set -e

# Description: Installs Igris git hooks by symlinking committed hook
#   scripts from scripts/git-hooks/ into .git/hooks/. Idempotent.
#
# FR-243: this is the CONTRIBUTOR path for the igris-ai checkout only. The
#   canonical hooks live at core/git-hooks/ (scripts/git-hooks/* are tracked
#   symlinks to them — `[ -f "$hook" ]` below follows the link, and the
#   installed .git/hooks/<name> chains through it). A CONSUMER project gets the
#   same gates with `igris install <path>` (step 7b), which symlinks
#   .git/hooks/<name> -> ~/.igris/core/git-hooks/<name>; `igris doctor --fix`
#   repairs a project registered without them (`git-hooks-missing`).
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

# FR-243: with core.hooksPath set (husky / lefthook), git never reads
# .git/hooks/ — a hook installed there is a hook that silently never runs,
# the exact class the git-level gates exist to close. Refuse rather than
# install a decoy. bash 3.2.
# A hooksPath that RESOLVES to .git/hooks itself (this checkout spells the
# default out: `core.hooksPath=<repo>/.git/hooks`) is not a bypass.
HOOKS_PATH="$(git config --get core.hooksPath 2>/dev/null || true)"
HOOKS_PATH_RESOLVED=""
if [ -n "$HOOKS_PATH" ]; then
  case "$HOOKS_PATH" in
    /*) HOOKS_PATH_RESOLVED="$(cd "$HOOKS_PATH" 2>/dev/null && pwd -P || echo "$HOOKS_PATH")" ;;
    *)  HOOKS_PATH_RESOLVED="$(cd "$REPO_ROOT/$HOOKS_PATH" 2>/dev/null && pwd -P || echo "$REPO_ROOT/$HOOKS_PATH")" ;;
  esac
fi
if [ -n "$HOOKS_PATH" ] && [ "$HOOKS_PATH_RESOLVED" != "$(cd "$TARGET_DIR" && pwd -P)" ]; then
  echo "Error: core.hooksPath=$HOOKS_PATH is set, so .git/hooks/ is never read."
  echo "  Add $SOURCE_DIR/{pre-commit,commit-msg} to that pipeline instead,"
  echo "  or unset it: git config --unset core.hooksPath"
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
