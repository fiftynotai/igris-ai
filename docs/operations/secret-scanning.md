# Secret Scanning (gitleaks)

Igris AI runs automated, deterministic secret-scanning on every commit and every
push/PR. This page is the operator/contributor reference for the gate: what it
checks, how to allowlist a false positive, how to remediate a real leak, and how
to extend the ruleset.

> **Why this exists (TD-159).** The operator's VPS IP leaked into
> `core/prompts/brain_stewardship.md` and survived **five** prior hunts plus
> every existing quality gate — architect, forger, sentinel, warden, the
> brief-first hook, and the mirror invariant all missed it. It was caught only by
> the operator running `git grep` by hand before a release. The right primitive
> for "no secrets in committed code" is a deterministic scanner, not an LLM
> judgment call. `gitleaks` is that scanner. See **TD-157** (the incident) and
> **TD-159** (this prevention layer).

---

## The four-layer model

Secret-scanning is defense-in-depth, not a single gate:

| # | Layer | When it runs | Catches | Bypassable? |
|---|---|---|---|---|
| 1 | **Pre-commit hook** (`scripts/git-hooks/pre-commit` → `gitleaks protect --staged`) | Local, every `git commit` | Mechanical regex matches on the staged diff | `git commit --no-verify` (deliberate) |
| 2 | **CI workflow** (`.github/workflows/secrets-scan.yml` → `gitleaks/gitleaks-action@v2`) | Every push to `develop`/`main` + every PR | Same ruleset, server-side | No — make it a required check on `main` |
| 3 | **Warden checklist** (`core/agents/warden.md` → "Security Scan Checklist") | Per `/hunt` REVIEWING phase | Nuanced calls the curated rules don't cover (e.g. a project-specific internal subnet) | Yes (review can still err) |
| 4 | **CONTRIBUTING.md Documentation Invariant #9** | Read by the author before writing | Forward guidance: use placeholders, reference the config source-of-truth | Yes (norms only) |

Layers 1 + 2 are the load-bearing automated gates and share one config
(`.gitleaks.toml`). Layer 3 is context-aware backup. Layer 4 sets the norm so
authors don't try to commit literals in the first place.

The local hook **degrades gracefully** if `gitleaks` is not installed (it warns
and skips, so a contributor without the tool isn't hard-blocked). CI is the
non-bypassable net — a `--no-verify` commit still hits the server-side scan.

---

## What gitleaks checks

The config (`.gitleaks.toml`) **extends the gitleaks default ruleset** rather than
replacing it (`[extend] useDefault = true`). So every commit is scanned against:

**Curated defaults (gitleaks built-in):**
- AWS access keys (`AKIA…`), GCP / Azure service credentials
- Stripe live keys (`sk_live_…`), Slack tokens (`xoxb-`/`xoxp-`)
- GitHub personal-access tokens, GitLab tokens
- Private keys (`-----BEGIN … PRIVATE KEY-----`, entropy-scored)
- Generic high-entropy strings on the right of `api_key=` / `token=` / `secret=`
- …and the rest of the gitleaks default rule pack.

**Igris-specific custom rules (added on top):**

| Rule ID | Severity | Pattern | Why |
|---|---|---|---|
| `igris-operator-vps-ip` | HIGH (always fails) | `76\.13\.180\.\d{1,3}` | The exact IP family that leaked in TD-157. Its reappearance anywhere in a future commit is a hard leak. |
| `igris-api-key-assignment` | HIGH (always fails) | long base64/hex value assigned to `api_key`/`API_KEY`/`apiKey`/`api-key` | Catches an Igris brain key committed as a literal. `${VAR}` indirection and `<placeholder>` forms are carved out. |
| `igris-public-ipv4-in-config` | MEDIUM (allowlistable inline) | public IPv4 in `*.json`/`*.yaml`/`*.md` | Catches a stray internet-routable IP before it becomes the next `76.13.180.x`. RFC-1918 / loopback / link-local / broadcast / RFC-5737 doc ranges are excluded. |

> **Known trade-off (`igris-public-ipv4-in-config`).** Markdown section numbers
> and semver-with-build strings (`### 2.6.4.5.`, `§3.6.1.1`, `v1.2.3.4`) are
> syntactically valid dotted quads. To keep this markdown-heavy repo's gate
> quiet, the rule allowlists quads where **every** octet is a single digit
> (`\d\.\d\.\d\.\d`). The side effect is that an all-single-digit *public* IP
> (e.g. `8.8.8.8`) is not flagged by this MEDIUM rule. This is intentional: the
> operator-IP threat (`76.13.180.x`) has octets ≥ 100 and is caught by the HIGH
> rule regardless, and doc-section false positives are far more common here than
> someone hardcoding `8.8.8.8`. If you need to catch all-single-digit public IPs,
> tighten the allowlist regex in `.gitleaks.toml`.

---

## How to allowlist a true false positive

There are two mechanisms. Prefer the **inline marker** for a single line; use a
**path allowlist** only for a whole fixture file.

### Inline `# gitleaks:allow` marker (preferred)

Add the marker on the **same line** as the flagged value, with a one-line
rationale:

```ts
// Test fixture: asserts the loader REJECTS a literal key. Not a real secret.
env: ["API_KEY=sk-live-abc123"], // gitleaks:allow
```

```yaml
# Public address shown in user-facing docs (not a secret).
endpoint: https://203.0.113.9 # gitleaks:allow  (RFC-5737 doc IP example)
```

Use this when:
- The value is a **test fixture** that intentionally pins a fake/example secret.
- The value is a **public, non-secret literal** that genuinely must appear
  (e.g. a public example address in user-facing documentation).

Do **not** use it to silence a real secret. If it's a credential, remediate it
(below) — don't allowlist it.

### Path allowlist (whole-file)

For a fixture file where many lines carry secret-shaped strings, add a path
regex to the `[allowlist] paths` array in `.gitleaks.toml`:

```toml
[allowlist]
paths = [
  '''cli/src/__tests__/.*\.(ts|js)$''',   # CLI test fixtures
  '''test/.*\.(bash|sh)$''',              # bats fixtures
  # ...
]
```

The repo already path-allowlists `cli/src/__tests__/`, `test/`, `test/fixtures/`,
`CHANGELOG.md` (historical entries), `scripts/archive/`, `docs/archive/`, this
doc, and `.gitleaks.toml` itself. Gitignored carried-not-committed state
(`.claude/agent-memory/`, `.claude/settings.local.json`) is also allowlisted so
the ad-hoc `--no-git` scan stays clean; those paths never enter a commit anyway.

---

## How to remediate a real leak

This is the decision tree worked out for TD-157. Follow it in order.

**Step 1 — Scrub from current source (mandatory).**
Remove the secret from the working tree. Replace it with a placeholder
(`<your-vps-host>`, `${SECRET_NAME}`) and reference the config source-of-truth
(`~/.igris/config.json`, an env var) instead of a literal. Re-stage; gitleaks
must now pass.

**Step 2 — Decide on history rewrite (usually NO).**
If the secret was already pushed, it's in git history. **Do not rewrite history
by default.** The TD-157 reasoning: if it was public for any length of time it
must be assumed scraped, so rewriting doesn't "unleak" it — it only breaks every
clone and invalidates CHANGELOG SHA references. Rewrite history *only* if the
leak is fresh, un-pushed, or the credential is catastrophic and un-rotatable.

**Step 3 — Rotate the leaked credential (if it was a credential).**
If the leaked value was an actual secret (API key, token, password) — not just
an IP — **rotate it now**. A scrubbed-but-not-rotated credential is still
compromised. For the brain API key: regenerate it on the VPS and update
`~/.igris/config.json` → `remote_brain.api_key`. (An IP address is not a
credential and does not need rotation — scrubbing + the new scanner rule is the
remediation.)

**Step 4 — Document in CHANGELOG `### Security`.**
Record the leak + remediation under a `### Security` heading
(Keep-a-Changelog convention), so the audit trail is durable.

---

## How to add a new custom rule

When a new pattern needs catching (e.g. an Igris Teams customer-specific token
shape later), add a `[[rules]]` block to `.gitleaks.toml`:

```toml
[[rules]]
id = "my-new-rule"
description = "What this catches and why (cite the brief/incident)."
regex = '''<your-pattern>'''
# Optional: restrict to certain file types.
path = '''.*\.(json|ya?ml)$'''
tags = ["igris", "high-severity"]
# Optional: carve out placeholder/fixture shapes so legit examples pass.
[rules.allowlist]
regexTarget = "match"
regexes = [ '''\$\{[A-Za-z0-9_]+\}''' ]
```

Then, in the **same commit**:
1. Add a bats case to `test/secrets_scan.test.bash` proving the rule fires on a
   leak and passes on the benign/allowlisted shape (model it on cases a–h).
2. Re-run the retroactive scan to confirm no new false positives on the live
   tree:
   ```bash
   gitleaks detect --source . --no-git --config .gitleaks.toml
   # Must report: no leaks found.
   ```
3. Author the rule regex from the **actual** pattern (ground truth), not from
   memory of what it looked like (memory ID 383).

Re-derive the rationale to brain memory if it's more than a sentence (L-518);
the rule's `description` should cite the brief/incident ID.

---

## Running it manually

```bash
# Scan the whole working tree (what the GATE checks; should be 0 findings):
gitleaks detect --source . --no-git --config .gitleaks.toml

# Scan only the staged diff (what the pre-commit hook runs):
gitleaks protect --staged --config .gitleaks.toml

# Time a staged scan (performance budget: <1s on a typical 10-file diff):
time gitleaks protect --staged --config .gitleaks.toml
```

Install gitleaks locally with `brew install gitleaks` (macOS) or see the
[gitleaks releases](https://github.com/gitleaks/gitleaks/releases).

---

## See also

- `CONTRIBUTING.md` → **Documentation Invariants #9** (placeholders-not-literals).
- `docs/architecture/SYSTEM.md` → **§9 Invariants** (#9 secret-scanning gate).
- `core/agents/warden.md` → **Security Scan Checklist** (the layer-3 review step).
- **TD-157** — the incident this gate prevents recurring.
- **TD-158** — the server-side counterpart (VPS network/SSH hardening).
