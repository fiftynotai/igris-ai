---
name: node-stub --  separator for spawn tests
description: when stubbing claude-CLI-style spawns with `node -e <script>`, append `--` so the factory's appended args (e.g. `--system <prompt>`) become positional and node ignores them
type: feedback
---

When testing a factory that spawns a subprocess and APPENDS its own args
(like `--system <prompt>` on top of caller-supplied `args`), tests using
`node -e '<script>'` as the stub command will fail with `bad option:
--system` because node tries to interpret the trailing flag.

**Fix:** append `--` to the stub's args. Everything after `--` becomes
positional and node ignores it:

```ts
makeClaudeLlmExtractor({
  command: 'node',
  args: ['-e', `process.stdout.write(${JSON.stringify(canned)})`, '--'],
  timeoutMs: 5_000,
});
```

**Why:** `node -e <code>` consumes the next arg as code. `--` is the POSIX
end-of-options marker; subsequent args are treated as positional script
arguments and made available via `process.argv` rather than processed as
node CLI flags.

**How to apply:** any time a factory under test appends args after the
caller's array (FR-108 verifier was the precedent — verifier had no
appended args so this trick wasn't needed there; FR-109 LLM extractor
DOES append `--system <prompt>` so the trick is required). Search for
`spawn(command, [...args, '--system'` to find similar surfaces.
