---
obligation: "Skill text must never route a secret into the transcript: no read of ~/.igris/config.json, no secret as a tool argument or CLI flag"
mechanism: gate
status: shipped
lives_in: "scripts/validate_skill_secret_handling.py"
summary: "TD-492 pre-commit validator over core/skills/**/*.md, HARD-FAIL. Rule S flags a secret-shaped name (by last component token, password, passphrase, passkey, secret, apikey, credential(s), authorization, bearer, jwt, or last two api/private/secret/access/signing/auth key; snake, camel, kebab or spaced; not input_tokens, cache_key or a dotted config key) in a strong argument form on ANY line (name: / name=, `name`:, a quoted key, a spaced label, a hand-over verb such as pass or supply, a list item, a table cell, a call signature; not after a negation, an article or a glossary label, and not with an empty, type, boolean or number value) or in a weak prose form (with / and / comma lists) inside a tool site's window, and any secret-carrying CLI flag (--api-key, --access-token; not --no-token, not after a negation). Rule C is fail-closed: every mention of config.json (whole file name) or of a dotted secret key path (remote_brain.api_key) must be governed by a negated read/open/cat verb with only more negated verbs, the file or a path prefix in between and no condition or exception, covered by a program reading it itself, chained to a covered mention, or sit in a ledgered descriptive sentence; it also reads the allowed-tools block. The window rule is imported from validate_skill_required_args.py, never copied. The forms were shaped by 639 adversarial probes (fixtures not archived); the validator header lists the over-reach and gaps they left. Does NOT cover: core/os, core/prompts, core/agents, the CLI, hooks or the brain (they read config.json by design); short flags; a hand-over by description; deliberate evasion; --no-verify or a checkout without hooks."
---

# Skill secret handling (TD-492)

Whatever a skill tells an agent to read or pass lands in the transcript. Two
routes have already put the remote brain's API key there: a `/rest` step that
passed `api_key` to an MCP tool (removed by TD-350 and TD-489, L-1379), and
`/boot`'s "Always-needed files" entry for `config.json` (removed by TD-492).

The pre-commit validator scans every `.md` under `core/skills/` and hard-fails
on either route:

- **Rule S** — a secret named as an argument (in a syntactic argument form
  on any line, or in prose at a tool call site), or a secret-carrying
  command-line flag.
- **Rule C** — a mention of `config.json` (or of a config-path key such as
  `remote_brain.api_key`) that no negated read governs, that is not a program
  reading the file itself, and whose sentence is not ledgered.

Rule C is fail-closed because the defect it was built for had no read verb:
it was a list entry under a heading. Only "every mention is classified"
catches that shape.

## Ledger

The validator's `LEDGER_C` and `LEDGER_S` constants hold classified
exceptions, keyed on content (never line numbers), each with the reason it is
not a read or not a secret. On the real tree the observed count must equal the
ledgered count, so a stale entry fails too. Never ledger a real read
instruction to get a commit through.

Remote-brain presence comes from `igris detect`'s `remote_brain` boolean; the
verbs that talk to the remote read the URL and key themselves.
