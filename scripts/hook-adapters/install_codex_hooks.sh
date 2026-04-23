#!/bin/bash

# Description: Non-destructive install of the Igris bridge into Codex CLI's
#              ~/.codex/config.toml. Backs up the user's existing `notify` array
#              to ~/.igris/config.json -> cli_targets.codex.user_notify_backup on
#              first install, then rewrites `notify = [...]` to point at the
#              Igris wrapper. Idempotent on re-runs.
# Usage: install_codex_hooks.sh [--config-file=<path>] [--bridge=<path>]
#                                [--brain-config=<path>]
# Dependencies:
#   - python3 3.11+ (stdlib tomllib) OR 3.10 with `pip install --user tomli`.
#     Neither available -> hard abort with actionable message. No silent
#     data loss, no handwritten fallback parser.
#   - tomli_w (pure-Python writer) is VENDORED INLINE below; no pip install
#     at Igris install time.
# Exit codes:
#   0 - Success
#   1 - Runtime error (missing bridge, missing TOML parser, unparseable config,
#                      round-trip data-loss detected, invalid TOML output)
#   2 - Usage error
#
# Design notes (see TD-045 plan):
#   READ:   stdlib tomllib (3.11+) with tomli backport fallback for 3.10.
#   WRITE:  vendored tomli_w at bottom of the embedded Python — full TOML 1.0
#           support (nested tables, arrays-of-tables, inline tables, datetimes,
#           all string/number types).
#   VERIFY: re-parse the written text AND assert dict-equivalence against the
#           pre-write parsed dict (modulo the `notify` override). Catches any
#           silent key drop or mutation by the writer before clobbering the
#           user's file.
#   Comments, blank lines, and user formatting are NOT preserved — no Python
#   TOML library supports round-trip comment preservation. User data IS
#   preserved; that is the acceptance criterion.

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
from __future__ import annotations

import json
import os
import sys
import tempfile

# ===========================================================================
# region: vendored tomli_w   (Python does NOT hoist def statements — this
# block must appear BEFORE the code that calls `dumps()` below.)
# ---------------------------------------------------------------------------
# TOML writer vendored verbatim from https://github.com/hukkin/tomli-w.
#
# SOURCE:  github.com/hukkin/tomli-w @ tag 1.2.0
# COMMIT:  a8f80172ba16fe694e37f6e07e6352ecee384c58  (2025-01-15)
# FILE:    src/tomli_w/_writer.py
# SHA-1:   fc6fe651470ae65f5305a83c4cfb1daca36097cc  (of downloaded _writer.py)
#
# Why vendored: the Codex hook installer runs on every `igris install` and
# must work without `pip install` (which is not guaranteed on all platforms).
# The parser side is stdlib (tomllib) so only the writer needs vendoring.
# ~200 LOC, pure-Python, no runtime deps. Re-sync is a trivial `curl | diff`
# whenever tomli-w tags a new release.
#
# LICENSE (MIT):
#   Copyright (c) 2021 Taneli Hukkinen
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy
#   of this software and associated documentation files (the "Software"), to deal
#   in the Software without restriction, including without limitation the rights
#   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
#   copies of the Software, and to permit persons to whom the Software is
#   furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all
#   copies or substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
#   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.
# ===========================================================================

from collections.abc import Mapping
from datetime import date, datetime, time
from types import MappingProxyType

TYPE_CHECKING = False
if TYPE_CHECKING:
    from collections.abc import Generator
    from decimal import Decimal
    from typing import IO, Any, Final

ASCII_CTRL = frozenset(chr(i) for i in range(32)) | frozenset(chr(127))
ILLEGAL_BASIC_STR_CHARS = frozenset('"\\') | ASCII_CTRL - frozenset("\t")
BARE_KEY_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz" "ABCDEFGHIJKLMNOPQRSTUVWXYZ" "0123456789" "-_"
)
ARRAY_TYPES = (list, tuple)
MAX_LINE_LENGTH = 100

COMPACT_ESCAPES = MappingProxyType(
    {
        "\u0008": "\\b",  # backspace
        "\u000A": "\\n",  # linefeed
        "\u000C": "\\f",  # form feed
        "\u000D": "\\r",  # carriage return
        "\u0022": '\\"',  # quote
        "\u005C": "\\\\",  # backslash
    }
)


class Context:
    def __init__(self, allow_multiline: bool, indent: int):
        if indent < 0:
            raise ValueError("Indent width must be non-negative")
        self.allow_multiline: Final = allow_multiline
        # cache rendered inline tables (mapping from object id to rendered inline table)
        self.inline_table_cache: Final[dict[int, str]] = {}
        self.indent_str: Final = " " * indent


def dump(
    obj: Mapping[str, Any],
    fp: IO[bytes],
    /,
    *,
    multiline_strings: bool = False,
    indent: int = 4,
) -> None:
    ctx = Context(multiline_strings, indent)
    for chunk in gen_table_chunks(obj, ctx, name=""):
        fp.write(chunk.encode())


def dumps(
    obj: Mapping[str, Any], /, *, multiline_strings: bool = False, indent: int = 4
) -> str:
    ctx = Context(multiline_strings, indent)
    return "".join(gen_table_chunks(obj, ctx, name=""))


def gen_table_chunks(
    table: Mapping[str, Any],
    ctx: Context,
    *,
    name: str,
    inside_aot: bool = False,
) -> Generator[str, None, None]:
    yielded = False
    literals = []
    tables: list[tuple[str, Any, bool]] = []  # => [(key, value, inside_aot)]
    for k, v in table.items():
        if isinstance(v, Mapping):
            tables.append((k, v, False))
        elif is_aot(v) and not all(is_suitable_inline_table(t, ctx) for t in v):
            tables.extend((k, t, True) for t in v)
        else:
            literals.append((k, v))

    if inside_aot or name and (literals or not tables):
        yielded = True
        yield f"[[{name}]]\n" if inside_aot else f"[{name}]\n"

    if literals:
        yielded = True
        for k, v in literals:
            yield f"{format_key_part(k)} = {format_literal(v, ctx)}\n"

    for k, v, in_aot in tables:
        if yielded:
            yield "\n"
        else:
            yielded = True
        key_part = format_key_part(k)
        display_name = f"{name}.{key_part}" if name else key_part
        yield from gen_table_chunks(v, ctx, name=display_name, inside_aot=in_aot)


def format_literal(obj: object, ctx: Context, *, nest_level: int = 0) -> str:
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float, date, datetime)):
        return str(obj)
    if isinstance(obj, time):
        if obj.tzinfo:
            raise ValueError("TOML does not support offset times")
        return str(obj)
    if isinstance(obj, str):
        return format_string(obj, allow_multiline=ctx.allow_multiline)
    if isinstance(obj, ARRAY_TYPES):
        return format_inline_array(obj, ctx, nest_level)
    if isinstance(obj, Mapping):
        return format_inline_table(obj, ctx)

    # Lazy import to improve module import time
    from decimal import Decimal

    if isinstance(obj, Decimal):
        return format_decimal(obj)
    raise TypeError(
        f"Object of type '{type(obj).__qualname__}' is not TOML serializable"
    )


def format_decimal(obj: Decimal) -> str:
    if obj.is_nan():
        return "nan"
    if obj.is_infinite():
        return "-inf" if obj.is_signed() else "inf"
    dec_str = str(obj).lower()
    return dec_str if "." in dec_str or "e" in dec_str else dec_str + ".0"


def format_inline_table(obj: Mapping, ctx: Context) -> str:
    # check cache first
    obj_id = id(obj)
    if obj_id in ctx.inline_table_cache:
        return ctx.inline_table_cache[obj_id]

    if not obj:
        rendered = "{}"
    else:
        rendered = (
            "{ "
            + ", ".join(
                f"{format_key_part(k)} = {format_literal(v, ctx)}"
                for k, v in obj.items()
            )
            + " }"
        )
    ctx.inline_table_cache[obj_id] = rendered
    return rendered


def format_inline_array(obj: tuple | list, ctx: Context, nest_level: int) -> str:
    if not obj:
        return "[]"
    item_indent = ctx.indent_str * (1 + nest_level)
    closing_bracket_indent = ctx.indent_str * nest_level
    return (
        "[\n"
        + ",\n".join(
            item_indent + format_literal(item, ctx, nest_level=nest_level + 1)
            for item in obj
        )
        + f",\n{closing_bracket_indent}]"
    )


def format_key_part(part: str) -> str:
    try:
        only_bare_key_chars = BARE_KEY_CHARS.issuperset(part)
    except TypeError:
        raise TypeError(
            f"Invalid mapping key '{part}' of type '{type(part).__qualname__}'."
            " A string is required."
        ) from None

    if part and only_bare_key_chars:
        return part
    return format_string(part, allow_multiline=False)


def format_string(s: str, *, allow_multiline: bool) -> str:
    do_multiline = allow_multiline and "\n" in s
    if do_multiline:
        result = '"""\n'
        s = s.replace("\r\n", "\n")
    else:
        result = '"'

    pos = seq_start = 0
    while True:
        try:
            char = s[pos]
        except IndexError:
            result += s[seq_start:pos]
            if do_multiline:
                return result + '"""'
            return result + '"'
        if char in ILLEGAL_BASIC_STR_CHARS:
            result += s[seq_start:pos]
            if char in COMPACT_ESCAPES:
                if do_multiline and char == "\n":
                    result += "\n"
                else:
                    result += COMPACT_ESCAPES[char]
            else:
                result += "\\u" + hex(ord(char))[2:].rjust(4, "0")
            seq_start = pos + 1
        pos += 1


def is_aot(obj: Any) -> bool:
    """Decides if an object behaves as an array of tables (i.e. a nonempty list
    of dicts)."""
    return bool(
        isinstance(obj, ARRAY_TYPES)
        and obj
        and all(isinstance(v, Mapping) for v in obj)
    )


def is_suitable_inline_table(obj: Mapping, ctx: Context) -> bool:
    """Use heuristics to decide if the inline-style representation is a good
    choice for a given table."""
    rendered_inline = f"{ctx.indent_str}{format_inline_table(obj, ctx)},"
    return len(rendered_inline) <= MAX_LINE_LENGTH and "\n" not in rendered_inline

# endregion: vendored tomli_w


# ===========================================================================
# Main install flow begins here. Uses `dumps` (defined above).
# ===========================================================================

config_file = sys.argv[1]
bridge = sys.argv[2]
brain_config = sys.argv[3]

# ---------------------------------------------------------------------------
# TOML reader: stdlib tomllib (3.11+) preferred; tomli backport accepted for
# 3.10. Neither -> hard abort with actionable message. NO handwritten fallback:
# the old narrow parser silently flattened [section.sub] into top-level keys,
# which is the exact data-loss bug TD-045 fixes.
# ---------------------------------------------------------------------------
try:
    import tomllib as _toml_read  # type: ignore[import-not-found]
except ImportError:
    try:
        import tomli as _toml_read  # type: ignore[import-not-found]
    except ImportError:
        sys.stderr.write(
            "[codex-hooks] error: no TOML parser available.\n"
            "  Python 3.11+ required (for stdlib tomllib),\n"
            "  or run: python3 -m pip install --user tomli\n"
            f"  Current Python: {sys.version.split()[0]}\n"
        )
        sys.exit(1)


def _parse_toml(text: str) -> dict:
    try:
        return _toml_read.loads(text)
    except Exception as exc:
        sys.stderr.write(f"[codex-hooks] error: failed to parse {config_file}: {exc}\n")
        sys.exit(1)


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
    print(
        f"[codex-hooks] backed up user notify to {brain_config} -> cli_targets.codex.user_notify_backup",
        file=sys.stderr,
    )
elif not existing_backup:
    # Ensure the field exists even when there's nothing to capture.
    codex_entry.setdefault("user_notify_backup", [])
    with open(brain_config, "w", encoding="utf-8") as fh:
        json.dump(brain, fh, indent=2)
        fh.write("\n")

# ---------------------------------------------------------------------------
# Override the notify value BEFORE emission. Keys preserved byte-for-data-value;
# formatting (inline-vs-standard tables, key order within a table, multi-line
# strings) is normalized by tomli_w. User data is preserved — format is not.
# ---------------------------------------------------------------------------
parsed["notify"] = [bridge]

# ---------------------------------------------------------------------------
# Emit TOML via vendored tomli_w (defined at top of this script).
# multiline_strings=True preserves readability when users had them; tomli_w
# otherwise emits basic strings with \n escapes.
# ---------------------------------------------------------------------------
output_text = dumps(parsed, multiline_strings=True)
if not output_text.endswith("\n"):
    output_text += "\n"

# ---------------------------------------------------------------------------
# Sanity check (widened per TD-045 D4):
#   1. Re-parse output to ensure it's valid TOML (catches writer bugs).
#   2. Assert dict equivalence vs the pre-write `parsed` dict. If the writer
#      silently drops or mutates a key, catch it BEFORE clobbering the user's
#      file. _toml_read is already proven importable above.
# ---------------------------------------------------------------------------
try:
    reparsed = _toml_read.loads(output_text)
except Exception as exc:
    sys.stderr.write(f"[codex-hooks] refused to write invalid TOML: {exc}\n")
    sys.exit(1)


def _deep_equal(a: object, b: object) -> bool:
    """Structural dict/list equivalence. Bool/int kept distinct (TOML-correct)."""
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, dict):
        if not isinstance(b, dict) or set(a.keys()) != set(b.keys()):
            return False
        return all(_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        if not isinstance(b, list) or len(a) != len(b):
            return False
        return all(_deep_equal(x, y) for x, y in zip(a, b))
    return a == b


if not _deep_equal(parsed, reparsed):
    sys.stderr.write(
        "[codex-hooks] refused to write: round-trip lost data.\n"
        f"  before keys: {sorted(parsed.keys())}\n"
        f"  after keys:  {sorted(reparsed.keys())}\n"
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Atomic write via tempfile in the same directory (ensures os.replace is atomic
# on all POSIX platforms by staying on the same filesystem).
# ---------------------------------------------------------------------------
parent = os.path.dirname(os.path.abspath(config_file))
os.makedirs(parent, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=parent, suffix=".tmp", prefix=".igris-codex-config-")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(output_text)
os.replace(tmp, config_file)

print(f"[codex-hooks] wrote Igris notify bridge into {config_file}")
sys.exit(0)
PY
}

main "$@"
