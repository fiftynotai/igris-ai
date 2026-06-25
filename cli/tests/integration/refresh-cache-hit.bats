#!/usr/bin/env bats

# refresh-cache-hit.bats — TD-113 integration test for the cache fast-path.
#
# Proves that a SECOND `igris refresh` at the same SHA serves the brain core
# from the local tarball cache (~/.igris/.cache/<sha>/) WITHOUT any network
# call. The proof is built from two process-boundary seams (both wired in
# tarball.ts#httpsGet):
#
#   IGRIS_TARBALL_FILE=<path>  — stream that local file instead of fetching
#       from GitHub. Lets `igris init` drive the GitHub code path hermetically
#       (no TLS, no live GitHub) so init SEEDS the cache from that fetch.
#   IGRIS_BLOCK_NETWORK=1       — make any real fetch throw immediately. On the
#       SECOND refresh we set this AND unset the fixture seam, so the ONLY way
#       the refresh can succeed is by hitting the cache. A cache miss would try
#       the (blocked) network and fail loud.
#
# Hermetic via IGRIS_BRAIN_DIR + --channel=main (resolveChannel short-circuits
# "main" with no releases-API call) + --skip-remote (skips the network HEAD
# pre-flight, but still routes through the GitHub branch because --from-source
# is absent).

load _helpers.bash

setup() {
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  # The committed clean fixture: <cli>/src/__tests__/fixtures/tarballs/.
  # CLI_DIST is <cli>/dist (set by _helpers.bash), so ../src/... reaches it.
  FIXTURE="$(cd "$CLI_DIST/.." && pwd)/src/__tests__/fixtures/tarballs/clean-core.tar.gz"
  [ -f "$FIXTURE" ]

  # Seed a github-style install via the fixture seam. init seeds the cache
  # from this fetch (the cache-sink TEE).
  IGRIS_TARBALL_FILE="$FIXTURE" run $CLI_BIN init --channel main --skip-remote --yes
  [ "$status" -eq 0 ]

  # Record the seeded SHA (also the cache key).
  SEED_SHA=$(python3 -c "import json; print(json.load(open('$IGRIS_BRAIN_DIR/.install-source.json'))['content_sha256'])")
}

@test "init seeded the tarball cache (tarball.tar.gz + meta.json present)" {
  [ -f "$IGRIS_BRAIN_DIR/.cache/$SEED_SHA/tarball.tar.gz" ]
  [ -f "$IGRIS_BRAIN_DIR/.cache/$SEED_SHA/meta.json" ]
  # The extracted tree was cached too.
  [ -f "$IGRIS_BRAIN_DIR/.cache/$SEED_SHA/extracted/core/SOUL.md" ]
  # source=github recorded.
  run python3 -c "import json; print(json.load(open('$IGRIS_BRAIN_DIR/.install-source.json'))['source'])"
  [ "$output" = "github" ]
}

@test "2nd refresh reports a cache hit and makes NO network call" {
  # Network HARD-blocked + fixture seam OFF: the refresh can only succeed via
  # the cache. If the cache path were skipped, httpsGet would throw and the
  # verb would exit non-zero.
  IGRIS_BLOCK_NETWORK=1 run env -u IGRIS_TARBALL_FILE $CLI_BIN refresh --channel main --no-propagate
  [ "$status" -eq 0 ]
  # The user-facing line names the cache hit with no network.
  [[ "$output" == *"cache hit, no network"* ]]
  # The recorded SHA is unchanged (brain already at this content; no swap).
  NEW_SHA=$(python3 -c "import json; print(json.load(open('$IGRIS_BRAIN_DIR/.install-source.json'))['content_sha256'])")
  [ "$SEED_SHA" = "$NEW_SHA" ]
}

@test "blocked network WITHOUT a cache entry fails (proves the seam bites)" {
  # Negative control: evict the cache entry, then block the network. With no
  # cache to serve and the network blocked, the refresh MUST fail — this proves
  # the IGRIS_BLOCK_NETWORK seam actually prevents the fetch (so the green
  # cache-hit test above is meaningful, not a no-op).
  rm -rf "$IGRIS_BRAIN_DIR/.cache/$SEED_SHA"
  IGRIS_BLOCK_NETWORK=1 run env -u IGRIS_TARBALL_FILE $CLI_BIN refresh --channel main --no-propagate
  [ "$status" -ne 0 ]
}
