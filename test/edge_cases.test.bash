#!/usr/bin/env bats

# Test suite for edge cases across Igris AI scripts
#
# Tests edge cases:
# - Special characters in paths and names
# - Whitespace handling
# - Unusual but valid inputs
#
# NOTE: the path-with-special-chars cases that lived here exercised the
# v3-era `igris_init.sh` shim, which was removed in TD-148. Slug-validation
# edge cases are now covered by cli/src/__tests__/install.test.ts. Add new
# top-level-script edge-case tests here as they arise.

load test_helper
