# BR-028: Brain Config Security

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-20
**Source:** v4.0 Process Audit

---

## Problem

**What's broken or missing?**

The brain configuration at `~/.igris/config.json` contains sensitive credentials in plaintext:

1. **Hardcoded API key** — `remote_brain.api_key` contains the full API key in plaintext. If the config template or brain directory is shared, it exposes full API access.

2. **VPS credentials exposed** — `vps.host` IP and `vps.user: "root"` are in the config. The `igris_brain_init.sh` script that generates this config writes these values directly.

While `~/.igris/` is outside git (safe from commit), the generation scripts and templates ARE in the repo and could guide attackers.

**Why does it matter?**

Plaintext credentials in config files is a security anti-pattern. For v4.0 publication, config templates should use environment variables or a separate secrets file.

---

## Goal

Config generation uses environment variables for sensitive values. Published templates contain placeholders, not real credentials. Existing configs continue to work.

---

## Context & Inputs

### Related Files
- `~/.igris/config.json` — runtime config with credentials
- `scripts/igris_brain_init.sh` — generates config
- `scripts/igris_brain_switch.sh` — reads/updates config
- `scripts/igris_brain_deploy.sh` — uses VPS credentials

---

## Tasks

### Completed
- [x] Update `igris_brain_init.sh` to read API key from `$IGRIS_BRAIN_API_KEY` env var
- [x] Update `igris_brain_init.sh` to read VPS credentials from env vars
- [x] Add `.env.example` with placeholder values for brain config
- [x] Update `igris_brain_switch.sh` to fall back to env vars when config missing
- [x] Ensure backward compatibility (existing plaintext configs still work)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

---

## Acceptance Criteria

1. [x] Config generation reads secrets from environment variables
2. [x] Published repo contains no plaintext API keys
3. [x] `.env.example` documents required environment variables
4. [x] Existing `~/.igris/config.json` files continue to work (backward compat)
5. [x] `igris_brain_switch.sh` handles both env var and plaintext config

---

## Notes

Audit finding: Process Audit Critical (PI-013 hardcoded API key).

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-20
**Brief Owner:** Crimson
