#!/usr/bin/env bats

# secrets_scan.test.bash - Tests for the TD-159 gitleaks secret-scanning gate.
#
# Verifies that .gitleaks.toml (the curated ruleset + Igris custom rules +
# allowlist) catches the secret shapes it must catch and passes the benign
# shapes it must pass. The 8 cases (a-h) come directly from the TD-159 brief.
#
# These exercise the CONFIG against synthetic content via
# `gitleaks detect --source <tmpdir> --no-git --config .gitleaks.toml`. That is
# the same ruleset the pre-commit hook (`gitleaks protect --staged`) and CI
# (`gitleaks/gitleaks-action@v2`) consume — testing the rules here proves the
# behavior of all three layers without manipulating the real git index.
#
# gitleaks is run for REAL when installed; the suite skips gracefully if it is
# absent (CI installs it — see .github/workflows/secrets-scan.yml).

load test_helper

setup() {
  GITLEAKS_CONFIG_FILE="$IGRIS_ROOT/.gitleaks.toml"

  command -v gitleaks >/dev/null 2>&1 || skip "gitleaks not installed"
  [ -f "$GITLEAKS_CONFIG_FILE" ] || skip ".gitleaks.toml missing at $GITLEAKS_CONFIG_FILE"

  # Per-test scratch dir (isolated from other tests).
  SCAN_DIR="$TEST_TEMP_DIR/secrets_scan_$BATS_TEST_NUMBER"
  mkdir -p "$SCAN_DIR"
  SCAN_REPORT="$SCAN_DIR/report.json"
}

teardown() {
  [ -d "$SCAN_DIR" ] && rm -rf "$SCAN_DIR"
}

# scan_dir — runs gitleaks against $SCAN_DIR with the repo config.
# Populates $status (gitleaks exit: 0 = clean, 1 = leaks found) and $output.
# Writes a JSON report to $SCAN_REPORT for finding-level assertions.
scan_dir() {
  run gitleaks detect \
    --source "$SCAN_DIR" \
    --no-git \
    --config "$GITLEAKS_CONFIG_FILE" \
    --no-banner \
    --report-format json \
    --report-path "$SCAN_REPORT"
}

# finding_count — echoes the number of findings in the report (0 if no report).
finding_count() {
  if [ -s "$SCAN_REPORT" ]; then
    python3 -c "import json,sys; print(len(json.load(open('$SCAN_REPORT'))))" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# report_has_rule <rule_id> — succeeds if any finding has the given RuleID.
report_has_rule() {
  local rule="$1"
  [ -s "$SCAN_REPORT" ] || return 1
  python3 -c "
import json,sys
d=json.load(open('$SCAN_REPORT'))
sys.exit(0 if any(f.get('RuleID')=='$rule' for f in d) else 1)
" 2>/dev/null
}

# ---------------------------------------------------------------------------
# (a) Operator's VPS IP family 76.13.180.X -> HIGH severity + commit refused
# ---------------------------------------------------------------------------
@test "a: operator VPS IP family (76.13.180.X) is caught and refuses" {
  printf 'remote_brain:\n  url: https://76.13.180.42:3001\n' > "$SCAN_DIR/config.yaml"
  scan_dir
  [ "$status" -eq 1 ]                       # gitleaks exits 1 on findings
  report_has_rule "igris-operator-vps-ip"   # the HIGH custom rule fired
}

# ---------------------------------------------------------------------------
# (b) Loopback 127.0.0.1 -> PASS (allowlisted)
# ---------------------------------------------------------------------------
@test "b: loopback 127.0.0.1 passes (allowlisted)" {
  printf 'host: 127.0.0.1\nport: 3001\n' > "$SCAN_DIR/config.yaml"
  scan_dir
  [ "$status" -eq 0 ]
  [ "$(finding_count)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (c) RFC-1918 192.168.1.1 -> PASS (allowlisted)
# ---------------------------------------------------------------------------
@test "c: RFC-1918 192.168.1.1 passes (allowlisted)" {
  printf 'gateway: 192.168.1.1\n' > "$SCAN_DIR/config.yaml"
  scan_dir
  [ "$status" -eq 0 ]
  [ "$(finding_count)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (d) Fake AWS access key AKIA... -> HIGH + refused
# ---------------------------------------------------------------------------
@test "d: AWS access key shape (AKIA...) is caught and refuses" {
  # NOTE: gitleaks allowlists its own canonical doc example AKIAIOSFODNN7EXAMPLE,
  # so we use a distinct AKIA-shaped key to exercise the real detection path.
  printf 'const awsKey = "AKIA1234567890ABCDEF";\n' > "$SCAN_DIR/prod.ts"
  scan_dir
  [ "$status" -eq 1 ]
  [ "$(finding_count)" -ge 1 ]
}

# ---------------------------------------------------------------------------
# (e) Long base64-ish string in an api_key assignment context -> MEDIUM/HIGH
# ---------------------------------------------------------------------------
@test "e: long secret in an api_key assignment is caught" {
  printf 'api_key: aB3xZ9kLmN2pQ7rS4tU8vW1yX0zC5dE6\n' > "$SCAN_DIR/config.yaml"
  scan_dir
  [ "$status" -eq 1 ]
  [ "$(finding_count)" -ge 1 ]
}

# ---------------------------------------------------------------------------
# (f) Same string but with an inline `# gitleaks:allow` marker -> PASS
# ---------------------------------------------------------------------------
@test "f: api_key assignment with inline gitleaks:allow marker passes" {
  printf 'api_key: aB3xZ9kLmN2pQ7rS4tU8vW1yX0zC5dE6 # gitleaks:allow\n' > "$SCAN_DIR/config.yaml"
  scan_dir
  [ "$status" -eq 0 ]
  [ "$(finding_count)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (g) Private SSH key block -----BEGIN... -> HIGH + refused
# ---------------------------------------------------------------------------
@test "g: private SSH key block is caught and refuses" {
  # gitleaks' private-key rule scores entropy on the key body — a readable
  # placeholder body (e.g. "FakeKeyDataForTesting...") scores too low and is
  # rejected as a non-secret. Generate a deterministic HIGH-entropy base64
  # body (sha256 hash-chain) so the rule fires without needing a real key or
  # an `openssl` dependency. This is a throwaway fixture, not a real key.
  python3 - "$SCAN_DIR/id_rsa" <<'PYEOF'
import base64, hashlib, sys
blob, seed = b"", b"td159-fixture-seed"
for _ in range(8):
    seed = hashlib.sha256(seed).digest()
    blob += seed
body = base64.b64encode(blob).decode()
lines = [body[i:i+64] for i in range(0, len(body), 64)]
with open(sys.argv[1], "w") as fh:
    fh.write("-----BEGIN RSA PRIVATE KEY-----\n")
    fh.write("\n".join(lines) + "\n")
    fh.write("-----END RSA PRIVATE KEY-----\n")
PYEOF
  scan_dir
  [ "$status" -eq 1 ]
  report_has_rule "private-key"
}

# ---------------------------------------------------------------------------
# (h) Negative control: no secret content -> PASS, no spurious findings
# ---------------------------------------------------------------------------
@test "h: clean content with no secrets passes (no spurious findings)" {
  cat > "$SCAN_DIR/clean.md" <<'CLEANEOF'
# Example config

Set your host with a placeholder, never a literal:

    remote_brain:
      url: https://<your-vps-host>
      api_key: ${IGRIS_API_KEY}

Loopback for local dev is 127.0.0.1 and the doc-section ref is 3.6.1.1.
See https://example.com for details.
CLEANEOF
  scan_dir
  [ "$status" -eq 0 ]
  [ "$(finding_count)" -eq 0 ]
}
