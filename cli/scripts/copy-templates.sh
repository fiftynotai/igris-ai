#!/usr/bin/env bash
# copy-templates.sh — propagate non-TS assets from src/ into dist/
# after tsc builds. tsc only compiles .ts; .tmpl/.json fixtures
# don't get copied automatically.
#
# Run as the second step of `npm run build` from cli/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/lib/templates"
DEST="$ROOT/dist/lib/templates"

if [ ! -d "$SRC" ]; then
  echo "copy-templates: source dir missing: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
# Copy every .tmpl and .json under src/lib/templates/ to the same
# relative path under dist/lib/templates/.
find "$SRC" -type f \( -name '*.tmpl' -o -name '*.json' \) -print0 |
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  dest_file="$DEST/$rel"
  mkdir -p "$(dirname "$dest_file")"
  cp -p "$f" "$dest_file"
done

# --- Bundle the canonical harness descriptor (FR-217) ----------------
# cli/src/lib/harness-descriptor.ts resolves the canonical `harnesses` block from
# the repo-root harness-manifest.json. For GLOBAL ops (init/install/doctor on a
# consumer machine, which has no repo manifest) it falls back to a bundled copy
# staged next to the compiled module — the same package-relative idiom as
# bundledMcpEntryPath(). ROOT = cli/ ; the monorepo root is ROOT/.. . The
# repo-root file stays the SINGLE source of truth; this copy is a build artifact,
# never hand-edited.
HARNESS_MANIFEST_SRC="$ROOT/../harness-manifest.json"
HARNESS_MANIFEST_DEST="$ROOT/dist/lib/harness-manifest.json"
if [ ! -f "$HARNESS_MANIFEST_SRC" ]; then
  echo "copy-templates: harness manifest missing: $HARNESS_MANIFEST_SRC" >&2
  exit 1
fi
mkdir -p "$ROOT/dist/lib"
cp -p "$HARNESS_MANIFEST_SRC" "$HARNESS_MANIFEST_DEST"
echo "copy-templates: bundled harness descriptor -> $HARNESS_MANIFEST_DEST"

# --- Bundle brain-mcp-server (TD-168, BR-068) ------------------------
# Stage brain-mcp-server's compiled dist/ + package.json into
# cli/dist/brain-mcp-server/ so `npm install -g igris-ai` ships a working
# igris-brain MCP.
#
# BR-068: the bundle's runtime deps ARE vendored into the bundle. An
# earlier scheme assumed cli/'s node_modules would resolve upward for the
# bundled MCP — it does not (the published tarball has no cli/node_modules
# on the bundle's resolution chain), so the brain died on spawn with
# ERR_MODULE_NOT_FOUND. The fix: a production-only `npm ci` inside the
# staged bundle dir produces a self-contained node_modules. A final
# spawn smoke guard proves the dependency set is complete and bootable
# before the build can be packed.
#
# Native-module note: better-sqlite3 / sqlite-vec ship platform-specific
# .node addons. This build-time vendored install verifies completeness on
# the BUILD machine; the published tarball ships the bundle's
# package.json + package-lock.json and cli/package.json's `postinstall`
# re-runs the production install on the END USER's machine so native
# addons match their OS/arch.
#
# ROOT = cli/ ; the monorepo root is ROOT/.. ; brain-mcp-server is a sibling.
MCP_SRC="$ROOT/../brain-mcp-server"
MCP_DEST="$ROOT/dist/brain-mcp-server"

if [ ! -d "$MCP_SRC" ]; then
  echo "copy-templates: brain-mcp-server dir missing: $MCP_SRC" >&2
  exit 1
fi

# Build brain-mcp-server (tsc) when its dist/ is absent, when src/ is newer
# than the compiled entrypoint, OR when dist/ holds output for a source that no
# longer exists. On a clean publish machine the monorepo install brings
# brain-mcp-server's devDeps, so `tsc` is available.
#
# THE THIRD CONDITION IS NOT REDUNDANT (TD-373). An mtime comparison answers
# "is anything NEWER", and a DELETED source makes nothing newer — so the first
# two conditions pass, no rebuild runs, and `tsc` (which emits but never
# prunes) leaves the orphaned `.js`/`.d.ts`/`.map` in place forever. That is
# not hypothetical: `c6777bc` deleted the rule-detector engine and its 24
# artifacts kept shipping for months, until they pushed the packed tarball 3 B
# over TD-329's ceiling. Nothing failed, because nothing was asking.
#
# The orphan scan is the count-vs-identity lesson applied to a build: a guard
# that only ever looks at the files PRESENT cannot report one that should not
# be. Cost is a single `find` over dist/.
mcp_needs_build=0
mcp_build_reason=""
if [ ! -f "$MCP_SRC/dist/index.js" ]; then
  mcp_needs_build=1
  mcp_build_reason="dist/ absent"
elif [ -n "$(find "$MCP_SRC/src" -type f -newer "$MCP_SRC/dist/index.js" -print -quit 2>/dev/null)" ]; then
  mcp_needs_build=1
  mcp_build_reason="src/ newer than dist/index.js"
else
  # Orphan scan: every emitted `.js` / `.d.ts` under dist/ must trace back to a
  # `.ts` (or `.tsx`) under src/. Longest suffix first, so `foo.d.ts` strips to
  # `foo` rather than being tested against a source literally named `foo.d.ts`
  # — otherwise every declaration file in the tree reads as an orphan.
  #
  # The `find` deliberately does NOT list `.map` files. A `.js.map` cannot
  # exist without its `.js`, so scanning maps would only ever re-report a
  # sibling this loop has already caught, and one hit is enough — the loop
  # breaks on the first. Maps are still DELETED, because the fix is a rebuild
  # that clears the whole directory; they simply are not how it is detected.
  # (The `*.map` arms below are kept as a guard for the day someone widens the
  # `find`, not because they fire today.)
  #
  # `__tests__` needs no exclusion here, unlike the vitest guard's mtime walk:
  # `tsconfig.json` scopes emit to `src/**/*` with `rootDir: ./src`, and test
  # files are excluded from the program, so no emitted file traces to one.
  mcp_orphan=""
  while IFS= read -r emitted; do
    rel="${emitted#"$MCP_SRC/dist/"}"
    stem="$rel"
    case "$stem" in
      *.d.ts.map) stem="${stem%.d.ts.map}" ;;
      *.js.map)   stem="${stem%.js.map}" ;;
      *.d.ts)     stem="${stem%.d.ts}" ;;
      *.js)       stem="${stem%.js}" ;;
      *) continue ;;
    esac
    if [ ! -f "$MCP_SRC/src/$stem.ts" ] && [ ! -f "$MCP_SRC/src/$stem.tsx" ]; then
      mcp_orphan="$rel"
      break
    fi
  done <<EOF
$(find "$MCP_SRC/dist" -type f \( -name '*.js' -o -name '*.d.ts' \) 2>/dev/null)
EOF
  if [ -n "$mcp_orphan" ]; then
    mcp_needs_build=1
    mcp_build_reason="dist/ holds output for a deleted source ($mcp_orphan)"
  fi
fi

if [ "$mcp_needs_build" -eq 1 ]; then
  echo "copy-templates: building brain-mcp-server ($mcp_build_reason)..."
  # Its `build` script BUILDS TO `dist.tmp` AND SWAPS (TD-373), rather than
  # cleaning `dist/` in place the way `cli`'s does. The clean is what actually
  # removes an orphan — tsc alone only re-emits alongside one — but the two
  # packages earn different shapes because they have different callers:
  #
  #   brain-mcp-server  `igris sync code` and `scripts/igris_brain_deploy.sh`
  #                     run this ON THE VPS while PM2 `igris-brain` is STILL
  #                     SERVING; the restart is a later step, gated on a smoke
  #                     check whose whole documented purpose is "fail loud
  #                     BEFORE we tear down the running brain". An in-place
  #                     `rm -rf dist` would delete the last-good artifact
  #                     before knowing the new one compiles, so a failed build
  #                     plus any later PM2 restart finds no dist/index.js.
  #                     Build-then-swap keeps that invariant: on failure dist/
  #                     is byte-identical and the old brain keeps serving.
  #   cli               local + CI only (`prepublishOnly`, the workflows,
  #                     CONTRIBUTING). No live consumer reads cli/dist mid-build
  #                     on a server, so the simpler in-place clean is fine.
  (cd "$MCP_SRC" && npm run build)
fi

# Stage compiled output + package.json + package-lock.json + scripts/. package.json
# is copied so the bundled MCP advertises "type":"module" to Node's module
# resolver and carries its version for doctor checks. The lockfile seeds
# the vendored install below; that install regenerates it to match the
# pruned manifest, and the regenerated lockfile is what ships — so the
# user-side postinstall can `npm ci` reproducibly.
rm -rf "$MCP_DEST"
mkdir -p "$MCP_DEST/dist"
cp -R "$MCP_SRC/dist/." "$MCP_DEST/dist/"
cp -p "$MCP_SRC/package.json" "$MCP_DEST/package.json"
if [ -f "$MCP_SRC/package-lock.json" ]; then
  cp -p "$MCP_SRC/package-lock.json" "$MCP_DEST/package-lock.json"
fi
cp -R "$MCP_SRC/scripts" "$MCP_DEST/"
# TD-298: prune vendored test source from the staged bundle. The wholesale
# scripts/ copy drags in scripts/__tests__/ (8 *.test.ts) and scripts/fixtures/
# (~150KB), which must never ship in the published tarball — and which vitest
# globs out of dist/, producing phantom suite-collection failures.
rm -rf "$MCP_DEST/scripts/__tests__" "$MCP_DEST/scripts/fixtures"

# TD-299: prune DEV-ONLY benchmark/eval/labeling scripts. These are never
# invoked by the MCP server, a shipped hook, a skill, or a package.json script —
# they are one-off developer tooling that only makes sense inside the source
# repo (against dev fixtures + a labeled corpus). Shipping them is at best dead
# weight and at worst broken: recall_bench.ts DEFAULTS --queryset to the
# scripts/fixtures/ path pruned just above, so it throws immediately from the
# published package. KEEP (runtime/ops, deliberately NOT listed here):
#   - perception_extract_cli.ts     — invoked by core/hooks/shared/
#                                      perception_extract_and_persist.sh
#   - render_brief_graph.{ts,template.html} — the standalone CLI the `visualize`
#                                      skill points users at. The .template.html
#                                      is the ONE file the shipped package itself
#                                      reads (dist/engine/components/edges/
#                                      visualization-tool.js ascends to it).
#   - gen-egress-manifest.ts, backfill_brief_edges.ts — package.json scripts
#   - fr219_embed_null_learnings.ts, reap-stale-instances.ts
#                                   — operational one-off migrations/ops CLIs
# td286_renormalize_backfill.ts stood in this KEEP list from TD-299 until
# BR-101 superseded that entry: it is a brief-numbered one-off with no shipped
# consumer, so it now falls to the PATTERN prune below. Do not restore it here.
for dev_script in \
  recall_bench.ts \
  dedup_corpus_eval.ts \
  td087_check_pair.ts \
  td087_e2e_deterministic.ts \
  td087_label_pairs.py \
  td087_corpus_pairs_labeled.csv \
  td285_dedup_recall_audit.ts; do
  rm -f "$MCP_DEST/scripts/$dev_script"
done

# BR-101: prune RESEARCH ARTIFACTS by PATTERN. TD-445 landed a sweep script and
# two labelled CSVs (479 KB unpacked, +77_529 packed B) that matched neither
# TD-298's directory rule nor TD-299's named list above, and the pack ledger's
# staging method could not see them (it stages COMPILED artifacts and never
# runs this script — copying is not compiling). Two classes, one rule, tested
# on the BASENAME of each top-level file (TD-298 already removed the only
# subdirectories):
#   *.csv        — a labelled corpus is never runtime
#   ^td[0-9]+_   — a brief-numbered research or one-off script: `td`, one or
#                  MORE digits, then `_` IMMEDIATELY. `td9legacy_notes.ts` is
#                  NOT in the class (the digits are not followed by `_`).
# The prefix is therefore a NAMING CONTRACT (MAINTAINING.md, the BR-101 row):
# a script the shipped package must reach may NOT take a td<N>_ name, and a
# research artifact MUST take it (or join TD-299's list). THIS BLOCK IS THE
# AUTHORITATIVE SPELLING of the contract; the JS regex in
# cli/src/__tests__/tarball.test.ts ("BR-101 — no research artifact ships")
# is PINNED to agree with it on named boundary cases, so widening or
# narrowing this block reds that pin until the regex moves with it.
# A bash loop, not `find`: round 1's `-name 'td[0-9]*_*'` (td, ONE digit, ANY
# run up to a `_`) was broader than the contract; `find -regex` / `-E` diverge
# between BSD (macOS) and GNU (CI's Linux); and `[[ =~ ]]` with the pattern in
# a VARIABLE is what bash 3.2 (/bin/bash here) treats as a regex.
research_prefix='^td[0-9]+_'
for f in "$MCP_DEST/scripts"/*; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  if [[ "$base" =~ $research_prefix ]] || [[ "$base" == *.csv ]]; then
    echo "$base"
    rm -f -- "$f"
  fi
done

# Fail loud if the staged entrypoint is missing — a publish with a broken
# bundle must abort rather than ship a half-package.
if [ ! -f "$MCP_DEST/dist/index.js" ]; then
  echo "copy-templates: bundled MCP entrypoint missing: $MCP_DEST/dist/index.js" >&2
  exit 1
fi

# Prune the staged package.json down to the production runtime surface
# the bundled MCP actually needs:
#   - devDependencies / optionalDependencies: dropped (build-only / not
#     required at runtime).
#   - @huggingface/transformers: KEPT (BR-070). It is the embeddings
#     backend that powers semantic/vector search (igris_brief_similar,
#     memory recall's vector channel). An earlier scheme deleted it here
#     to keep the bundle lean (~162 vs ~236 packages) on a "vector search
#     degrades gracefully when transformers is absent" premise — but that
#     premise was FALSE for the dynamic import itself: the first
#     `await import('@huggingface/transformers')` threw ERR_MODULE_NOT_FOUND
#     on the public `npm install -g igris-ai` path, silently disabling
#     semantic search (the headline feature of a memory tool). We now
#     vendor it. Cross-platform native deps (onnxruntime-node, host sharp)
#     are resolved per-platform by npm's os/cpu gating during the
#     user-side postinstall (BR-068), and node_modules is excluded from
#     the published tarball via cli/package.json `files`, so the TARBALL
#     size is unaffected — only the per-machine INSTALLED footprint grows
#     (~150-250MB), an accepted trade for working semantic memory. The
#     residual offline/native-load failure modes are handled by the
#     embeddings module's hybrid graceful-degrade guard (BR-070), which
#     latches one boot-time warning instead of a per-call throw storm.
#   - sqlite-vec's own nested platform binaries (sqlite-vec-<os>-<arch>)
#     are NOT touched — they are required for vector search, so this
#     deliberately does NOT pass `npm --omit=optional` (that global flag
#     would strip those transitive platform packages too).
# Node is always present in this build context, so use `node -e` rather
# than adding a `jq` dependency.
node -e 'const fs=require("fs");const p=process.argv[1];
  const j=JSON.parse(fs.readFileSync(p,"utf-8"));
  delete j.devDependencies;delete j.optionalDependencies;
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$MCP_DEST/package.json"

# Vendor a production node_modules into the staged bundle. `npm install`
# (not `npm ci`) is used because the staged package.json was just pruned
# and no longer matches the staged lockfile — install reconciles and
# regenerates the lockfile from the pruned manifest. --ignore-scripts is
# left enabled (the default) so native modules (better-sqlite3,
# sqlite-vec) run their install scripts and produce their .node binaries.
echo "copy-templates: vendoring brain-mcp-server production node_modules..."
(cd "$MCP_DEST" && npm install --omit=dev --no-audit --no-fund)

# Fail loud if the vendored install is incomplete — a representative
# runtime dep MUST be present or the bundled MCP cannot spawn.
if [ ! -d "$MCP_DEST/node_modules/@modelcontextprotocol/sdk" ]; then
  echo "copy-templates: bundled MCP node_modules incomplete — @modelcontextprotocol/sdk missing" >&2
  exit 1
fi

# BR-070: assert the embeddings backend RESOLVES in the vendored bundle.
# This guards against a regression of the BR-070 prune (deleting
# @huggingface/transformers from the staged manifest). It uses
# `import.meta.resolve` of the bare specifier — exactly the resolution the
# runtime dynamic `import('@huggingface/transformers')` performs, but
# WITHOUT executing the module (so no onnxruntime native load and no
# ~23MB MiniLM weight fetch from the HF Hub — that would slow/flake the
# build). NB: the package's `exports` map does not expose ./package.json,
# so a require.resolve of the manifest path would false-fail; resolving
# the bare specifier is the correct, faithful check.
if ! ( cd "$MCP_DEST" && node --input-type=module -e 'import.meta.resolve("@huggingface/transformers")' ) 2>/dev/null; then
  echo "copy-templates: bundled MCP embeddings backend missing — @huggingface/transformers did not resolve (BR-070)" >&2
  exit 1
fi
echo "copy-templates: bundled brain-mcp-server -> $MCP_DEST"

# --- Post-build spawn smoke guard (BR-068 acceptance criterion) ------
# Spawn the bundled entrypoint in a throwaway sandbox and assert it boots
# without a module-resolution error AND opened its DB inside that sandbox —
# never the operator's live ~/.igris/memory/knowledge.db. The guard lives in
# scripts/smoke-bundled-mcp.sh (TD-426; also run by .github/workflows/
# npm-publish.yml; twin: tests/integration/build-smoke-sandbox.bats).
echo "copy-templates: smoke-testing bundled MCP spawn..."
bash "$ROOT/scripts/smoke-bundled-mcp.sh" "$MCP_DEST/dist/index.js"
