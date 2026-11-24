#!/bin/bash

# Description: FR-277 model tiers — read the `model_tiers` map in
#   harness-manifest.json for one agent, or compare a brief's reviewer model
#   with its authors'. Both subcommands run the ONE python core in _common.sh
#   (igris_model_tier), so compile, the drift guard, /hunt and commit-msg §4
#   read the map and normalise model ids the same way.
#
# Usage:
#   model_tier.sh resolve --agent <name> [--size <S>] [--tier <T>]
#                         [--effort <E>] [--differ-from <model>]
#                         [--harness claude|codex|all] [--manifest <path>]
#     Prints agent=, tier=, effort= (the first printed column's), source=
#     (default | size:<S> | override | differ:<tier>), then <harness>.model=
#     and <harness>.effort= per column. --size reads a brief Effort such as
#     `L-Large`; an unknown size gives the default and a stderr NOTE.
#     --tier/--effort name a HEAVIER tier or effort for one run; one lighter
#     than the role's default is refused. --differ-from <model> steps one tier
#     heavier while the tier's model equals that model (DECISIONS row 25: a
#     change is reviewed by a model other than its author's).
#     The manifest is --manifest, else the canonical descriptor
#     (resolve_harness_descriptor_path: the repo root, else the runtime
#     ~/.igris/core/harness-manifest.json).
#   model_tier.sh review --brief-id <ID> --project <slug> --db <path>
#     One line: `REVIEW-MODEL <ID>: VERDICT=<v> reviewer=<raw> authors=<raw,...>`.
#     The reviewer is the latest warden stop/error row; the authors are every
#     forger and orchestrator row; each value is model_resolved, else
#     model_requested. The DB is opened read-only (sqlite3 URI mode=ro) and
#     every value is a bound parameter.
#
# Limits, named:
#   - Jev's one-step escalation rule is FR-281's, not this script's: an
#     override may name any heavier tier.
#   - Best-effort harnesses (OpenCode, Antigravity, Cursor, Gemini) have no
#     tier column: --harness <one of them> is a usage error (exit 2).
#
# Exit codes:
#   resolve: 0 ok; 1 REFUSED (stderr); 2 usage, or an unknown agent, tier,
#            effort or harness; 3 no map, or an invalid map.
#   review:  0 PASS; 1 EQUAL (on a provider whose tiers compile projects —
#            anthropic until TD-385); 2 usage; 3 UNKNOWN (never a pass);
#            4 NO_REVIEW; 5 unreadable DB; 6 EQUAL_UNPROJECTED.
#
# Dependencies: python3, _common.sh beside this file. bash 3.2 (commit-msg
#   runs it under /bin/bash).

set -euo pipefail

MT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# A fresh process: re-arm the double-source guard an exporting parent may
# have left set, or _common.sh would return before defining its helpers.
unset IGRIS_ADAPTER_COMMON_SOURCED
# shellcheck source=_common.sh
source "$MT_DIR/_common.sh"

usage() {
  sed -n '9,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
cmd="$1"
shift

case "$cmd" in
  resolve)
    agent="" harness="all" manifest=""
    extra=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --agent)        agent="${2:-}"; shift 2 || usage ;;
        --harness)      harness="${2:-}"; shift 2 || usage ;;
        --manifest)     manifest="${2:-}"; shift 2 || usage ;;
        --size|--tier|--effort|--differ-from)
          [ "$#" -ge 2 ] || usage
          extra+=("$1" "$2"); shift 2 ;;
        -h|--help)      usage ;;
        *) echo "model_tier.sh: unknown argument '$1'" >&2; usage ;;
      esac
    done
    [ -n "$agent" ] || usage
    if [ -z "$manifest" ]; then
      manifest="$(resolve_harness_descriptor_path 2>/dev/null)" || {
        echo "model_tier.sh: no harness-manifest.json beside this script (repo root or runtime core)" >&2
        exit 3
      }
    fi
    rc=0
    if [ "${#extra[@]}" -gt 0 ]; then
      igris_model_tier resolve "$manifest" "$agent" "$harness" "${extra[@]}" || rc=$?
    else
      igris_model_tier resolve "$manifest" "$agent" "$harness" || rc=$?
    fi
    exit "$rc"
    ;;
  review)
    brief="" project="" db=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --brief-id) brief="${2:-}"; shift 2 || usage ;;
        --project)  project="${2:-}"; shift 2 || usage ;;
        --db)       db="${2:-}"; shift 2 || usage ;;
        -h|--help)  usage ;;
        *) echo "model_tier.sh: unknown argument '$1'" >&2; usage ;;
      esac
    done
    [ -n "$brief" ] && [ -n "$project" ] && [ -n "$db" ] || usage
    rc=0
    igris_model_tier review "$db" "$brief" "$project" || rc=$?
    exit "$rc"
    ;;
  -h|--help) usage ;;
  *) echo "model_tier.sh: unknown subcommand '$cmd' (resolve, review)" >&2; usage ;;
esac
