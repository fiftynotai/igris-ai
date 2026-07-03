#!/usr/bin/env bash
#
# FR-215 B4 — /boot ceremony-overhead benchmark (REPRODUCIBLE).
#
# Measures the token cost of a cold /boot in three components:
#   1. STATIC context  — the boot-tier module set (parsed from os/INDEX.md, NOT
#      hardcoded) + config.json + igris_tree.json + SOUL.md + boot & rest
#      SKILL.md. Deterministic: byte counts are identical across runs on the
#      same core/ tree. This is the apples-to-apples successor to the old B4.
#   2. VERB-DIGEST cost — a NEW line item the prose boot never had: the stdout
#      bytes of each boot verb's JSON digest. This is the ceremony the module
#      cut trades INTO.
#   3. WALL-CLOCK — median of N runs per verb (machine/network-dependent, so
#      directional only; boot-sync hits the VPS).
#
# SAFETY (hard requirements):
#   * Reads only. The STATIC pass never writes.
#   * READ-ONLY verbs (detect, session gather, assess, context-docs inventory,
#     doctor) run against the real project slug — their own docs guarantee they
#     mutate nothing (gather is an observer; assess/inventory/doctor are
#     read-only diagnostics).
#   * The MUTATING verb (boot-sync drains the queue + merges a VPS pull) is
#     NEVER run against the real brain: it runs with IGRIS_DB_PATH pointed at an
#     isolated throwaway DB under a temp scratch dir, and a scratch project slug.
#     Verified: the real ~/.igris/memory/knowledge.db is left byte-identical.
#   * Writes nothing under ~/.igris/core. The only filesystem writes are inside
#     the mktemp scratch dir, which is torn down on exit.
#
# Usage:
#   bash scripts/bench/ceremony_bench.sh [--project igris-ai] [--runs 5] [--no-wallclock]
#
# Token model (identical to the old B4): tokens = chars / 4, cross-checked
# against words * 1.33.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config / args
# ---------------------------------------------------------------------------

BRAIN="${IGRIS_BRAIN_ROOT:-$HOME/.igris}"
INDEX="$BRAIN/core/os/INDEX.md"
BASELINE_STATIC_TOKENS=53900          # recorded pre-FR-187 baseline (benchmarks.md B4)
PROJECT="igris-ai"
N_RUNS=5
DO_WALLCLOCK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --runs) N_RUNS="$2"; shift 2 ;;
    --no-wallclock) DO_WALLCLOCK=0; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v igris >/dev/null 2>&1 || { echo "igris CLI not found on PATH" >&2; exit 1; }
[ -f "$INDEX" ] || { echo "INDEX not found: $INDEX" >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ceremony_bench.XXXXXX")"
SCRATCH_SLUG="fr215-bench-scratch-$$"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# chars/words of a file (0 if missing)
chars_of() { [ -f "$1" ] && wc -c < "$1" | tr -d ' ' || echo 0; }
words_of() { [ -f "$1" ] && wc -w < "$1" | tr -d ' ' || echo 0; }

# tokens = chars/4 (integer)
tok_chars() { echo $(( $1 / 4 )); }
# cross-check tokens = words * 1.33 (rounded)
tok_words() { awk "BEGIN{printf \"%.0f\", $1 * 1.33}"; }

# strip the Igris auto-init banner + drop empty lines from verb stdout
strip_banner() { grep -v "Igris AI detected\|auto-initialize"; }

# epoch milliseconds (macOS `date` lacks %N; perl Time::HiRes is portable)
now_ms() { perl -MTime::HiRes=time -e 'printf("%d", time()*1000)'; }

# median of newline-separated integers on stdin
median() {
  sort -n | awk '{a[NR]=$1} END{ if(NR==0){print 0; exit} m=int((NR+1)/2); if(NR%2){print a[m]} else {printf "%.0f", (a[m]+a[m+1])/2} }'
}
minmax() { sort -n | awk 'NR==1{min=$1} {max=$1} END{printf "%s/%s", min, max}'; }

# ---------------------------------------------------------------------------
# 1. STATIC CONTEXT — boot-tier module set (parsed from INDEX) + fixed files
# ---------------------------------------------------------------------------

echo "# FR-215 B4 — /boot ceremony overhead"
echo "generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')  |  brain: $BRAIN  |  project: $PROJECT"
echo "git: $(git -C "$(dirname "$0")" rev-parse --short HEAD 2>/dev/null || echo n/a)"
echo
echo "## 1. Static context (boot-tier, apples-to-apples with the old B4)"
echo
echo "| file | chars | ~tokens (c/4) |"
echo "|---|---|---|"

# Boot-tier modules from the INDEX table (tier==boot, exclude USER).
# Table columns: | module | layer | tier | scope | summary | consult_when |
BOOT_MODULES="$(awk -F'|' '
  /^\|/ {
    m=$2; t=$4;
    gsub(/^[ \t]+|[ \t]+$/, "", m);
    gsub(/^[ \t]+|[ \t]+$/, "", t);
    if (m=="module" || m ~ /^-+$/ || m=="") next;
    if (t=="boot" && m!="USER") print m;
  }' "$INDEX")"

STATIC_CHARS=0
STATIC_WORDS=0
SEEN_PATHS=""

add_static() {
  # $1 = path, $2 = label
  local p="$1" label="$2" c w
  case " $SEEN_PATHS " in *" $p "*) return 0 ;; esac   # dedupe
  SEEN_PATHS="$SEEN_PATHS $p"
  if [ ! -f "$p" ]; then
    echo "| $label | (missing) | 0 |"
    return 0
  fi
  c=$(chars_of "$p"); w=$(words_of "$p")
  STATIC_CHARS=$(( STATIC_CHARS + c ))
  STATIC_WORDS=$(( STATIC_WORDS + w ))
  echo "| $label | $c | $(tok_chars "$c") |"
}

for m in $BOOT_MODULES; do
  if [ "$m" = "SOUL" ]; then
    add_static "$BRAIN/core/SOUL.md" "SOUL (core/SOUL.md)"
  else
    add_static "$BRAIN/core/os/$m.md" "os/$m.md"
  fi
done

# Always-needed boot mechanics + the boot/rest skills (dedupe SOUL if repeated).
add_static "$BRAIN/config.json" "config.json"
add_static "$BRAIN/core/igris_tree.json" "igris_tree.json (retired by FR-187)"
add_static "$BRAIN/core/SOUL.md" "SOUL.md"
add_static "$BRAIN/core/skills/boot/SKILL.md" "skills/boot/SKILL.md"
add_static "$BRAIN/core/skills/rest/SKILL.md" "skills/rest/SKILL.md"

STATIC_TOK_C=$(tok_chars "$STATIC_CHARS")
STATIC_TOK_W=$(tok_words "$STATIC_WORDS")
echo "| **TOTAL static** | **$STATIC_CHARS** | **~$STATIC_TOK_C** |"
echo
echo "static tokens (chars/4): **~$STATIC_TOK_C**  ·  cross-check (words*1.33): ~$STATIC_TOK_W"

# % cut vs baseline
CUT_PCT=$(awk "BEGIN{printf \"%.1f\", (1 - $STATIC_TOK_C / $BASELINE_STATIC_TOKENS) * 100}")
echo
echo "baseline (pre-FR-187 static, recorded): **$BASELINE_STATIC_TOKENS tokens**"
echo "AFTER static: **~$STATIC_TOK_C tokens**  →  **cut: $CUT_PCT%**"

# ---------------------------------------------------------------------------
# 2. VERB-DIGEST COST — stdout bytes of each boot verb → tokens
# ---------------------------------------------------------------------------

echo
echo "## 2. Verb-digest cost (NEW line item — the ceremony the cut trades into)"
echo
echo "| verb | mutating? | slug | digest bytes | ~tokens (c/4) |"
echo "|---|---|---|---|---|"

DIGEST_BYTES_TOTAL=0

# run a command, capture banner-stripped stdout byte size.
# Failure-proof: verbs may exit non-zero (e.g. doctor on drift) and grep -v may
# empty the stream — neither must abort the harness under set -e/pipefail.
digest_bytes() {
  local out
  out="$( { "$@" 2>/dev/null || true; } | { strip_banner || true; } )"
  printf '%s' "$out" | wc -c | tr -d ' '
}

# read-only verbs against the REAL slug (safe — they mutate nothing)
D_DETECT=$(digest_bytes igris detect --json)
D_SYNC=$(IGRIS_DB_PATH="$SCRATCH/iso.db" digest_bytes igris boot-sync --project "$SCRATCH_SLUG")
D_GATHER=$(digest_bytes igris session gather --project "$PROJECT")
D_ASSESS=$(digest_bytes igris assess --project "$PROJECT")
D_CTXDOCS=$(digest_bytes igris context-docs inventory --project "$PROJECT" --json)
D_DOCTOR=$(digest_bytes timeout 8s igris doctor)

row_digest() { # name mutating slug bytes
  DIGEST_BYTES_TOTAL=$(( DIGEST_BYTES_TOTAL + $4 ))
  echo "| $1 | $2 | $3 | $4 | $(tok_chars "$4") |"
}
row_digest "detect"                 "no"  "$PROJECT"       "$D_DETECT"
row_digest "boot-sync"              "YES" "$SCRATCH_SLUG*" "$D_SYNC"
row_digest "session gather"         "no"  "$PROJECT"       "$D_GATHER"
row_digest "assess"                 "no"  "$PROJECT"       "$D_ASSESS"
row_digest "context-docs inventory" "no"  "$PROJECT"       "$D_CTXDOCS"
row_digest "doctor (timeout 8s)"    "no"  "$PROJECT"       "$D_DOCTOR"

DIGEST_TOK=$(tok_chars "$DIGEST_BYTES_TOTAL")
echo "| **TOTAL verb-digest** | | | **$DIGEST_BYTES_TOTAL** | **~$DIGEST_TOK** |"
echo
echo "> *boot-sync* runs with IGRIS_DB_PATH pointed at a throwaway DB ($SCRATCH_SLUG),"
echo "> so its VPS pull/queue-drain never touches the real brain. Its digest reflects"
echo "> a near-empty scratch corpus and is a floor, not the real-slug size."

ALLIN_TOK=$(( STATIC_TOK_C + DIGEST_TOK ))
echo
echo "## 3. Combined"
echo
echo "| component | ~tokens |"
echo "|---|---|"
echo "| static (boot-tier) | ~$STATIC_TOK_C |"
echo "| verb-digest (new) | ~$DIGEST_TOK |"
echo "| **all-in per cold /boot** | **~$ALLIN_TOK** |"
echo
echo "vs baseline $BASELINE_STATIC_TOKENS static → static cut **$CUT_PCT%**; the verb-digest"
echo "(~$DIGEST_TOK tok) is the small new overhead the module cut absorbs."

# ---------------------------------------------------------------------------
# 4. WALL-CLOCK — median of N runs per verb (directional; machine/network)
# ---------------------------------------------------------------------------

if [ "$DO_WALLCLOCK" -eq 1 ]; then
  echo
  echo "## 4. Wall-clock (median of $N_RUNS runs, ms — directional, machine/network-dependent)"
  echo
  echo "| verb | median ms | min/max ms |"
  echo "|---|---|---|"

  time_verb() { # label + command...
    local label="$1"; shift
    local f="$SCRATCH/wc.$$"
    : > "$f"
    local i s e
    for i in $(seq 1 "$N_RUNS"); do
      s=$(now_ms)
      "$@" >/dev/null 2>&1 || true
      e=$(now_ms)
      echo $(( e - s )) >> "$f"
    done
    echo "| $label | $(median < "$f") | $(minmax < "$f") |"
  }

  time_verb "detect"                 igris detect --json
  time_verb "boot-sync (isolated)"   env IGRIS_DB_PATH="$SCRATCH/iso.db" igris boot-sync --project "$SCRATCH_SLUG"
  time_verb "session gather"         igris session gather --project "$PROJECT"
  time_verb "assess"                 igris assess --project "$PROJECT"
  time_verb "context-docs inventory" igris context-docs inventory --project "$PROJECT" --json
  time_verb "doctor"                 timeout 8s igris doctor
fi

echo
echo "(scratch dir $SCRATCH torn down on exit; real brain untouched.)"
