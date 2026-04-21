#!/bin/bash
# Test fixture: nested script that should be ignored by CLI converters.
# The presence of this file verifies that only SKILL.md is read per skill.
set -euo pipefail
echo "helper invoked"
