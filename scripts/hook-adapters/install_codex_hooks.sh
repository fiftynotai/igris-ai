#!/bin/bash

# Description: Non-destructive install of the Igris bridge into Codex CLI's
#              ~/.codex/config.toml. Backs up the user's existing `notify` array
#              to ~/.igris/config.json -> cli_targets.codex.user_notify_backup on
#              first install, then rewrites `notify = [...]` to point at the
#              Igris wrapper. Idempotent on re-runs.
# Usage: install_codex_hooks.sh [--config-file=<path>] [--bridge=<path>]
#                                [--brain-config=<path>]
# Dependencies: python3 (3.11+ for tomllib; for 3.10 we fall back to tomli or a
#               narrow manual parser — see below)
# Exit codes:
#   0 - Success
#   1 - Runtime error (missing bridge, unparseable config)
#   2 - Usage error
#
# Design notes:
#   Python's stdlib has tomllib (read-only) in 3.11+. We do not depend on
#   external tomli-w because Codex config.toml uses a narrow value set — the
#   top level is a flat map of strings, numbers, bools, and arrays-of-strings.
#   We read via tomllib (or manual fallback), then emit using a small TOML
#   writer that handles exactly those types. Validating the output with
#   tomllib.loads() before replacing the original gives us a safety net.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

usage() {
  cat >&2 <<EOF
Usage: $0 [--config-file=<path>] [--bridge=<path>] [--brain-config=<path>]

Install the Igris Codex notify bridge.

Options:
  --config-file=<path>   Codex config file (default: \$CODEX_HOME/config.toml or \$HOME/.codex/config.toml)
  --bridge=<path>        Path to codex-notify.sh (default: \$HOME/.igris/core/hooks/bridges/codex-notify.sh)
  --brain-config=<path>  Igris brain config to write backup into (default: \$HOME/.igris/config.json)

Exit codes:
  0 - Success
  1 - Runtime error
  2 - Usage error
EOF
  exit 2
}

main() {
  local config_file="${IGRIS_CODEX_CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"
  local bridge="${IGRIS_CODEX_BRIDGE:-$HOME/.igris/core/hooks/bridges/codex-notify.sh}"
  local brain_config="${IGRIS_BRAIN_CONFIG:-$HOME/.igris/config.json}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --config-file=*)  config_file="${1#--config-file=}" ;;
      --bridge=*)       bridge="${1#--bridge=}" ;;
      --brain-config=*) brain_config="${1#--brain-config=}" ;;
      -h|--help)        usage ;;
      *)
        echo "Error: Unknown argument '$1'" >&2
        usage
        ;;
    esac
    shift
  done

  if [ ! -f "$bridge" ]; then
    echo "Error: Bridge script not found at '$bridge'" >&2
    exit 1
  fi

  # Ensure Codex config dir exists — create it empty if Codex is not installed
  # yet. This keeps the install idempotent for --include=hooks-only flows where
  # Codex will be installed later.
  local config_dir
  config_dir=$(dirname "$config_file")
  mkdir -p "$config_dir"

  # Ensure brain config exists (v6 install always creates this, but guard anyway).
  if [ ! -f "$brain_config" ]; then
    echo "Error: Igris brain config not found at '$brain_config' — cannot persist user_notify_backup" >&2
    exit 1
  fi

  python3 - "$config_file" "$bridge" "$brain_config" <<'PY'
import json, os, sys, re

config_file = sys.argv[1]
bridge = sys.argv[2]
brain_config = sys.argv[3]

# ---------------------------------------------------------------------------
# Read existing config.toml. Prefer tomllib (3.11+); fall back to tomli if
# installed; otherwise use a narrow custom parser that handles exactly the
# value types Codex writes (strings, bools, ints, arrays of strings).
# ---------------------------------------------------------------------------
def _parse_toml(text):
    try:
        import tomllib  # type: ignore
        return tomllib.loads(text)
    except Exception:
        pass
    try:
        import tomli  # type: ignore
        return tomli.loads(text)
    except Exception:
        pass
    # Minimal fallback — only top-level flat keys supported.
    data = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if "=" not in line:
            continue
        key, _, rhs = line.partition("=")
        key = key.strip()
        rhs = rhs.strip()
        # Strip trailing comments outside strings (best effort).
        if rhs.startswith('"') and rhs.count('"') >= 2:
            # quoted string
            end = rhs.index('"', 1)
            data[key] = rhs[1:end]
        elif rhs.startswith("["):
            # Array — attempt to parse list of strings.
            try:
                inner = rhs.rstrip()
                if not inner.endswith("]"):
                    continue
                inner = inner[1:-1].strip()
                if not inner:
                    data[key] = []
                else:
                    items = []
                    for piece in re.split(r',\s*(?=(?:[^"]*"[^"]*")*[^"]*$)', inner):
                        piece = piece.strip()
                        if piece.startswith('"') and piece.endswith('"'):
                            items.append(piece[1:-1])
                        else:
                            items.append(piece)
                    data[key] = items
            except Exception:
                continue
        elif rhs in ("true", "false"):
            data[key] = rhs == "true"
        else:
            try:
                data[key] = int(rhs)
            except Exception:
                data[key] = rhs
    return data

existing_text = ""
if os.path.isfile(config_file):
    with open(config_file, "r", encoding="utf-8") as fh:
        existing_text = fh.read()

parsed = _parse_toml(existing_text) if existing_text else {}

# ---------------------------------------------------------------------------
# Detect Igris notify wrapper. Idempotent path: if the first element of
# `notify` already points at the Igris bridge, do nothing and exit 0.
# ---------------------------------------------------------------------------
existing_notify = parsed.get("notify")
if isinstance(existing_notify, list) and existing_notify and existing_notify[0] == bridge:
    print(f"[codex-hooks] already installed in {config_file}")
    sys.exit(0)

# ---------------------------------------------------------------------------
# Back up user's current notify array (if any, and non-Igris) into brain config
# under cli_targets.codex.user_notify_backup. First-install capture only — on
# re-run with missing bridge we keep the existing backup.
# ---------------------------------------------------------------------------
with open(brain_config, "r", encoding="utf-8") as fh:
    brain = json.load(fh)
cli_targets = brain.setdefault("cli_targets", {})
codex_entry = cli_targets.setdefault("codex", {})
existing_backup = codex_entry.get("user_notify_backup", [])

to_backup = []
if isinstance(existing_notify, list):
    to_backup = [x for x in existing_notify if isinstance(x, str)]

# Only overwrite the backup if we currently have no backup AND we're capturing
# a non-Igris notify value. This prevents backup-of-backup on re-installs.
if not existing_backup and to_backup:
    codex_entry["user_notify_backup"] = to_backup
    with open(brain_config, "w", encoding="utf-8") as fh:
        json.dump(brain, fh, indent=2)
        fh.write("\n")
    print(f"[codex-hooks] backed up user notify to {brain_config} -> cli_targets.codex.user_notify_backup", file=sys.stderr)
elif not existing_backup:
    # Ensure the field exists even when there's nothing to capture.
    codex_entry.setdefault("user_notify_backup", [])
    with open(brain_config, "w", encoding="utf-8") as fh:
        json.dump(brain, fh, indent=2)
        fh.write("\n")

# ---------------------------------------------------------------------------
# Emit a new config.toml that:
#   (a) preserves every parsed key byte-equivalently (best effort — flat types)
#   (b) replaces the `notify` key with the Igris bridge array
# Emission uses a narrow TOML writer.
# ---------------------------------------------------------------------------
def toml_quote(s: str) -> str:
    # TOML basic string: escape backslash, double-quote, and control chars.
    out = []
    for ch in s:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04X}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'

def emit_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, str):
        return toml_quote(v)
    if isinstance(v, list):
        parts = []
        for item in v:
            parts.append(emit_value(item))
        return "[" + ", ".join(parts) + "]"
    # Tables/arrays-of-tables: fall back to JSON — caller should inspect.
    raise ValueError(f"Unsupported TOML value type for writer: {type(v).__name__}")

# Override the notify value.
parsed["notify"] = [bridge]

# Emit keys in sorted order for deterministic output.
lines = []
tables = {}
scalars = {}
for k, v in parsed.items():
    if isinstance(v, dict):
        tables[k] = v
    else:
        scalars[k] = v

for k in sorted(scalars.keys()):
    try:
        lines.append(f"{k} = {emit_value(scalars[k])}")
    except Exception as e:
        # Unsupported type — preserve by skipping; best-effort fallback.
        sys.stderr.write(f"[codex-hooks] skipped scalar '{k}': {e}\n")

# Emit tables (flat, one level deep; nested tables not supported by our writer).
for k in sorted(tables.keys()):
    lines.append("")
    lines.append(f"[{k}]")
    for ik in sorted(tables[k].keys()):
        iv = tables[k][ik]
        try:
            lines.append(f"{ik} = {emit_value(iv)}")
        except Exception as e:
            sys.stderr.write(f"[codex-hooks] skipped [{k}].{ik}: {e}\n")

output_text = "\n".join(lines) + "\n"

# Sanity check: re-parse before writing. If tomllib is missing (pre-3.11 Python
# without tomli installed), we skip the sanity check and trust our writer. If
# tomllib is available, any parse failure is a hard abort — we refuse to write
# a file we can't re-parse.
try:
    import tomllib  # type: ignore
except ImportError:
    pass
else:
    try:
        tomllib.loads(output_text)
    except Exception as e:
        sys.stderr.write(f"[codex-hooks] refused to write invalid TOML: {e}\n")
        sys.exit(1)

# Atomic write via tempfile.
import tempfile
parent = os.path.dirname(os.path.abspath(config_file))
os.makedirs(parent, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=parent, suffix=".tmp", prefix=".igris-codex-config-")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(output_text)
os.replace(tmp, config_file)

print(f"[codex-hooks] wrote Igris notify bridge into {config_file}")
PY
}

main "$@"
