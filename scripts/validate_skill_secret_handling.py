#!/usr/bin/env python3
"""
validate_skill_secret_handling.py

Recurrence net for SKILL TEXT that puts a secret into the transcript (TD-492).

WHY THIS EXISTS
---------------
Whatever a skill tells an agent to read or pass lands in the conversation
transcript. Two routes have already put the remote brain's API key there:
  - a skill step told the agent to pass `api_key` to an MCP tool (TD-350 and
    TD-489 removed the two /rest steps; L-1379);
  - /boot listed `<brain_root>/config.json - Remote brain URL and API key`
    under "Always-needed files", so every boot read the key (TD-492).
Nothing stopped either from coming back: `validate_skill_required_args.py`
sees tool call sites, but it is blind to an argument that carries a secret,
and no check read skill text for a config.json read at all.

RULE S - a secret named as an argument
--------------------------------------
  A SECRET-SHAPED name is judged by its LAST component(s), after generic
  suffixes (value, val, str, string, header, raw, env, b64, base64) are
  dropped: token, password, passwd, passphrase, passkey, secret, apikey,
  credential(s), authorization, bearer, jwt; or the last TWO: api key,
  private key, secret key, access key, signing key, auth key. Names may be
  snake, camel, kebab or spaced (`api_key`, `apiKey`, `api-key`, `API key`).
  So `access_token`, `client_secret` and `api_key_value` are secret;
  `input_tokens` (a count: plurals are not in the vocabulary), `token_count`,
  `cache_key` and `sort_key` are not.

  S1  STRONG forms - argument shapes by syntax alone, checked on EVERY line
      (outside the `allowed-tools:` block; bold or underline markers
      dropped first), with or without a tool nearby, so a blank line, a
      heading or a sibling step between a call and its arguments hides
      nothing:
        name: / name=      `api_key = ...`, `REMOTE_API_KEY=...`, `?api_key=`,
                           `-H "Authorization: Bearer $K"`
        `name`:            `` `api_key`: the remote key ``
        quoted key         `"api_key": "..."`
        spaced label       `API key: ...`
        hand-over verb     pass / supply / provide / send / give + a name in
                           backticks or quotes, or a bare name ending the
                           phrase ("pass the api_key as ...")
        list item          "- api_key (the remote key)", "- `api_key`"
        table cell         the first cell of a table row (not a header row)
        call signature     `igris_x(project, api_key)`, `mcp__x({ token })`
      A strong form does NOT count when: a negation governs it directly
      (an optional "ever", at most one verb and an optional "the" between,
      except for a hand-over verb, which must follow the negation itself:
      "never write `api_key=...`", "don't ever pass `api_key`", "avoid
      passing `api_key`"; "when it is not set pass api_key" still counts: a
      hand-over verb must follow the negation directly);
      the name follows an article ("the token: use the CLI"); the value is
      empty or a type (`credentials: none`, `token: string`); a quoted key's
      value is true, false, null or a number (`"secret": false`); or the
      name is a capitalised word heading its line with nothing after it or
      a colon and lowercase prose ("Token: a unit of text", "- Password";
      not `Authorization: Bearer $KEY`).
  S1  WEAK forms - prose, so they count only inside a tool site's window
      (a line naming `igris_*` or `mcp__*`; the window is the one
      `validate_skill_required_args.py` defines, IMPORTED, never copied) and
      only where the name closes an argument list: "with url and api_key."
      and "with { url, api_key }" yes, "with token usage summarised" no.
  S2  A command-line flag carrying a secret, by the same vocabulary over its
      `-`/`_` components: `--api-key`, `--access-token`, `--api_key`. Not
      `--no-token` (an absence), and not after a negation ("do not use the
      `--token` flag").
  Known over-reach (fails safe, costs a rewording or a ledger line): a
  pagination `page_token` argument; a code sample or sample result with a
  string value (`token = AppStorage.accessToken`, `{ "token": "abc" }`,
  `credentials: 'include'`); `with name, credentials: none` at a call site;
  a forbid with a clause between the negation and the hand-over ("do not,
  under any circumstances, pass `api_key`").
  Also gaps: a schema line `api_key: string` outside a call signature (a
  type value counts as empty), and a capitalised label heading its line
  with a lowercase value (`Password: hunter2` reads as a glossary entry).
  Known gaps: short flags (`-k`, `curl -u user:pw`); a long flag outside the
  vocabulary (`--key`, `--pass`); a hand-over by another verb ("include the
  token in the arguments") or by description ("the remote API key as the
  `key` argument"); an environment variable echoed into the chat; and a
  prose (weak) argument more than one paragraph away from its call.

RULE C - config.json named outside a recognised form (FAIL-CLOSED)
------------------------------------------------------------------
  A MENTION is `config.json` as a whole file name (case-insensitive; an
  escaped `config\\.json` too; not `tsconfig.json`, `my-config.json`,
  `config.jsonc` or `config.json.example`), or a secret key named by a
  dotted path ending in api_key, apikey, password or secret
  (`remote_brain.api_key`, a jq `.remote_brain.api_key`): reading the key by
  name is reading the file. Not a `.token` path: design-token paths such as
  `theme.token` are ordinary text here. Every SENTENCE that holds a mention
  must have EVERY mention covered, read after markdown emphasis is dropped
  (`do **not** read`):
    forbid    a negated verb that opens the file, directly governing the
              mention. Negations: "do not", "does not", "don't", "never",
              "must not", "should not", "avoid", "rather than", "instead of"
              (an "ever" may follow). Verbs: read, open, cat, load, parse,
              print, view, inspect, source, in their -s and -ing forms
              (reading, parsing, sourcing), re- forms of read, backticks
              allowed. Between the verb and the mention ONLY more negated
              verbs ("or edit", ", pass or print"), "the file", a quote and
              a path prefix (`~/.igris/`, `<detect.brain_root>/`). So "never
              read or open config.json" is a forbid; "do not read the log,
              then cat config.json", "do not read anything except
              config.json" and "rather than reading the DB, use config.json"
              are not. A condition before the negation in its clause ("if,
              unless, when, whenever, until, once, after, before": "if you
              do not read config.json first") voids it, as does an
              exception or condition after the mention in its clause
              ("unless, except, until, before, when, whenever, if, only,
              but, otherwise, instead") or opening the NEXT clause ("do not
              read config.json, unless the CLI fails"). A bare "not" is not a
              negation here ("not reading config.json first is a mistake").
    cli-self  a program reads the file itself: "it reads", "which reads",
              "that reads", "the CLI reads", "`verb` reads", or ", reading"
              in a sentence naming the CLI or a verb; then the mention, with
              no clause break, joined clause (", and", ", so") or second
              subject ("you") in between; then "itself" DIRECTLY after it.
    chained   a later mention joined to a covered one by "or", "and", a
              comma, a slash or a parenthesis ("`config.json`
              (`~/.igris/config.json`)").
    key path  a key path in a sentence whose config.json mentions are all
              covered (the /rest "it reads `remote_brain.api_key` from
              `~/.igris/config.json` itself" lines).
  or the whole sentence is a classified descriptive mention in LEDGER_C.
  Anything else FAILS. Rule C also reads the `allowed-tools:` block: a
  permission to Read(~/.igris/config.json) is a read route too.

  Why fail-closed rather than "flag a read verb": the very defect TD-492
  removes carried no read verb. It was a list entry under a heading two lines
  up. A verb detector passes it; only "every mention must be classified"
  catches it. The cost is that a NEW descriptive mention, or a forbid worded
  outside the templates, needs a rewording or a ledger line, which is the
  point: someone decides, in review, that it is not a read. Known over-reach
  of that kind: "never read the brain DB or config.json", "skills are not
  allowed to read config.json", "neither read nor print config.json", "do
  not read config.json when you boot", "`igris sync` reads config.json"
  without "itself", a table row "| config.json | never read it |", "do not
  read secrets, e.g. config.json", and a fixture writing a fake config.json.

  A sentence is found the way a reader finds one: the paragraph or list item
  holding the mention (lines joined, so a sentence wrapped across lines is
  one sentence), split at a `.`, `!` or `?` followed by whitespace. A fenced
  code line is its own sentence, as is a heading or a table row.

SCOPE - read this before trusting a green run
---------------------------------------------
Skill text only: every `.md` under `core/skills/`, recursive (the same root as
`validate_skill_required_args.py`). It does NOT see `core/os/`,
`core/prompts/`, `core/agents/`, the CLI, hooks or the brain. The CLI and the
brain read config.json by design. A clean run means "no unclassified secret
route in skill text", never "no secret reaches a transcript".

The recognised forms are for honest authors. Their shape came from a probe
run of 570 adversarial fixtures and a second round of 69 (TD-492; the
fixtures are not archived in the repo): 43 of the first run's 47 findings
close, and the rest are the over-reach and gaps listed above. A sentence
written to slip past the forms still can (a mention split across tokens, a
glob such as `config.j*`); the fail-closed rule does not claim to stop
deliberate evasion.

THE LEDGERS
-----------
Keyed on content, never on line numbers (see the long note on four recorded
line-number drifts in `validate_skill_required_args.py`):
  LEDGER_S: (relative_path, secret_name, needle) -> (reason, expected_count)
  LEDGER_C: (relative_path, needle)            -> (reason, expected_count)
A ledger_C needle is a substring of the classified sentence (whitespace
collapsed). On the real tree the observed count must EQUAL the expected count:
an excess is a new, unclassified mention, and a shortfall is a stale entry
(the sentence changed or left) - both fail, so the ledger shrinks with the
tree. Under a fixture root (SKILL_SECRETS_SCAN_ROOT) the subtraction still
applies but the stale check is skipped (a fixture holds only what it plants).

Usage:
    python3 scripts/validate_skill_secret_handling.py
    python3 scripts/validate_skill_secret_handling.py --list
    SKILL_SECRETS_SCAN_ROOT=/tmp/fx/core/skills \\
      python3 scripts/validate_skill_secret_handling.py

Flags:
    --list   Also print every ledger-subtracted and auto-recognised mention
             with its verdict. Diagnostic; does not change the exit code.

Exit codes:
    0 - no unclassified secret argument and no unclassified config.json mention
    1 - one or more violations, or a ledger count mismatch
    2 - setup error (missing root, no markdown, unreadable file, helper import)

See: TD-492, TD-489, TD-350, L-1379, validate_skill_required_args.py (TD-324),
     L-448 (validator + explicit ledger), L-400 (recurrence-net scope honesty).
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DEFAULT_SKILLS_ROOT = REPO_ROOT / "core" / "skills"
HELPERS_PATH = HERE / "validate_skill_required_args.py"


def load_helpers():
    """Import the window rule from the required-args validator (one rule, one
    home). Returns None when it cannot be loaded."""
    spec = importlib.util.spec_from_file_location(
        "validate_skill_required_args", HELPERS_PATH)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:  # noqa: BLE001 - any import failure is a setup error
        return None
    return mod


# --- The ledgers (explicit constants - L-448) --------------------------------
#
# Each entry states WHY the mention is not a read instruction (or why the
# argument is not a secret) as a fact about the text, not an opinion.

LEDGER_S: dict[tuple[str, str, str], tuple[str, int]] = {
    # (relative_path, secret_name, needle in the line) -> (reason, count).
    # No standing entries: on the tree as of TD-492 no skill line names a
    # secret-shaped argument.
}

LEDGER_C: dict[tuple[str, str], tuple[str, int]] = {
    ("igris-doctor/SKILL.md",
     "records the named harness in `config.json#cli_targets`"): (
        "describes what the doctor's own repair writes; no agent read", 1),
    ("onboard-harness/SKILL.md",
     "`cli_targets.<NEW>` in `~/.igris/config.json` is **DESCRIPTIVE-only**"): (
        "describes a key's meaning (labels the projection never reads)", 1),
    ("onboard-harness/SKILL.md",
     "(`config.json` `llm_extractor.harness` / `cognition`)"): (
        "names where a backend is configured; a pointer, no read step", 1),
    ("scan/SKILL.md",
     "report `enabled`, not your own reading of `config.json`"): (
        "a forbid phrased 'not your own reading of': a bare 'not' is not a"
        " recognised negation", 1),
}

# --- Rule S ------------------------------------------------------------------

RE_SITE_TOOL = re.compile(r"(?<![A-Za-z0-9_])(igris_[a-z0-9_]+|mcp__[A-Za-z0-9_-]+)")
# An argument name: snake, camel or kebab (`api-key: x` in a YAML body).
IDENT = r"[A-Za-z_][A-Za-z0-9_-]*"
NB = r"(?<![A-Za-z0-9_.-])"
NA = r"(?![A-Za-z0-9_-])"
# Where an argument name ends a list ("with url and api_key.", "with a, b").
END = r"(?=\s*(?:[,.;:)\]}]|$)|\s+(?:and|or)\s)"
END_PASS = (r"(?=\s*(?:[,.;:)\]]|$)|\s+(?:and|or|from|as|to|into|in|via|on"
            r"|through)\b)")
# A value that names no secret: `credentials: none`, or a type annotation in a
# code sample (`token: string`, `def f(token: str)`).
NOT_EMPTY = (r"(?!\s*(?:none|null|nil|false|n/a|-|string|str|number|int|bool"
             r"|boolean|any|unknown|Optional|bytes)(?![A-Za-z0-9_]))")
# A capitalised single word at the head of a line (after a list marker) is a
# label, not an argument: "Token: a unit of text", "- Password".
RE_LABEL_WORD = re.compile(r"^[A-Z][a-z]+$")
RE_LINE_HEAD = re.compile(r"^\s*(?:[-*+]|\d+[.)])?\s*$")
# ...and only when nothing follows it, or a colon and lowercase prose: a
# header line `Authorization: Bearer $KEY` or `Token: $T` is a value.
RE_LABEL_TAIL = re.compile(r"^\s*(?::\s+[a-z]|$)")
# A prose noun takes an article: "the token: use the CLI" is not an argument.
RE_ARTICLE_BEFORE = re.compile(
    r"\b(?:the|a|an|single|each|every|this|that|your|my|any|no|one|its|their"
    r"|our)\s+$", re.I)

# STRONG forms are argument shapes by syntax alone, matched on EVERY line
# (outside the `allowed-tools:` block), with or without a tool name nearby:
# a blank line, a heading or a sibling step between the call and its
# arguments does not hide them.
RE_STRONG = (
    ("name: / name=", re.compile(rf"{NB}({IDENT}){NA}\s*[:=](?![:=]){NOT_EMPTY}")),
    ("`name`:", re.compile(rf"`({IDENT})`\s*[:=](?![:=]){NOT_EMPTY}")),
    # The first cell of a table row: an argument table under a call.
    ("table cell", re.compile(rf"^\s*\|\s*`?({IDENT})`?\s*\|")),
    # A quoted JSON / dict key, unless its value is a boolean, number or null
    # (a sample result such as "secret": false names no secret).
    ("quoted key", re.compile(
        rf"[\"']({IDENT})[\"']\s*:(?!\s*(?:true|false|null|-?\d))", re.I)),
    ("spaced label", re.compile(
        r"\b((?:api|access|private|secret|signing|auth)\s+key)\s*[:=]", re.I)),
    # A verb handing over a value: "pass `api_key`", "supply the token as
    # ...", 'send "password"' (not directly after a negation: strong_args).
    ("pass", re.compile(
        r"\b(?:pass(?:es|ing)?|suppl(?:y|ies|ying)|provid(?:e|es|ing)"
        r"|send(?:s|ing)?|giv(?:e|es|ing))\s+"
        rf"(?:the\s+|in\s+)?(?:[`\"']({IDENT})[`\"']|({IDENT}){END_PASS})", re.I)),
    # A list item that is an argument name: "- api_key (the remote key)".
    ("list item", re.compile(
        rf"^\s*(?:[-*+]|\d+[.)])\s+(?:the\s+)?`?({IDENT})`?"
        r"(?=\s*(?:$|[(:=,])|\s[—–-]\s)")),
)
# A call signature: igris_x(project, api_key) or mcp__x({ project, token }).
RE_CALL_SIG = re.compile(
    r"(?<![A-Za-z0-9_])(?:igris_[a-z0-9_]+|mcp__[A-Za-z0-9_-]+)\s*\(([^()]*)\)")
RE_QUOTED_STR = re.compile(r"\"[^\"]*\"|'[^']*'")
# WEAK forms are prose; they count only inside a tool site's window, and only
# where the name closes an argument list ("with url and api_key." yes, "with
# token usage summarised" no).
RE_WEAK = (
    re.compile(rf"\b(?:with|and|or)\s+(?:the\s+)?`?({IDENT})`?{END}", re.I),
    re.compile(rf",\s*(?:the\s+)?`?({IDENT})`?{END}"),
)
# The secret vocabulary, by LAST name component(s) after generic suffixes
# (value, header, ...) are dropped. A bare `key` is not in it: `cache_key`,
# `sort_key` and `primary_key` are not secrets. Plurals are not in it either:
# `input_tokens` is a count.
SECRET_LAST = {"token", "password", "passwd", "passphrase", "passkey",
               "secret", "apikey", "credential", "credentials", "authorization",
               "bearer", "jwt"}
SECRET_LAST_TWO = {("api", "key"), ("private", "key"), ("secret", "key"),
                   ("access", "key"), ("signing", "key"), ("auth", "key")}
GENERIC_SUFFIX = {"value", "val", "str", "string", "header", "raw", "env",
                  "b64", "base64"}
RE_FLAG = re.compile(r"(?<![A-Za-z0-9_-])--([A-Za-z0-9][A-Za-z0-9_-]*)")
# A flag or a handed-over name that is only being forbidden: "do not use the
# `--token` flag", "don't ever pass `api_key`", "avoid passing the token".
# The negation must govern the form directly: an optional "ever", at most
# one verb and an optional "the" between ("when it is not set pass
# `api_key`" is NOT negated: two words, the second not "the").
RE_NEGATED_BEFORE = re.compile(
    r"(?:\b(?:never|not|avoid|without)|n['’]t)\s+(?:ever\s+)?(?:[\w-]+\s+)?"
    r"(?:the\s+)?`?$", re.I)
RE_NEGATED_DIRECT = re.compile(
    r"(?:\b(?:never|not|avoid|without)|n['’]t)\s+(?:ever\s+)?$", re.I)


def _is_secret_parts(parts: list[str]) -> bool:
    while len(parts) > 1 and parts[-1] in GENERIC_SUFFIX:
        parts = parts[:-1]
    if not parts:
        return False
    if len(parts) >= 2 and tuple(parts[-2:]) in SECRET_LAST_TWO:
        return True
    return parts[-1] in SECRET_LAST


def is_secret_name(name: str) -> bool:
    """Last snake/camel/kebab/spaced component(s) name a secret."""
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name).lower()
    return _is_secret_parts([p for p in re.split(r"[_\-\s]+", snake) if p])


def is_secret_flag(flag: str) -> bool:
    low = flag.lower()
    if low.startswith("no-") or low.startswith("no_"):
        return False                     # --no-token names an absence
    return _is_secret_parts([p for p in re.split(r"[-_]+", low) if p])


RE_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{3,}")


def strong_args(line: str, next_line: str = "") -> list[tuple[str, str]]:
    """(name, form) for every secret name in a strong form on this line.
    `next_line` tells a table HEADER row (`| Token | Hex |` above `|---|`),
    whose cells are column titles, from an argument row."""
    found: list[tuple[str, str]] = []
    for form, rx in RE_STRONG:
        for m in rx.finditer(line):
            name = next(g for g in m.groups() if g)
            if form == "name: / name=" and RE_ARTICLE_BEFORE.search(line[:m.start(1)]):
                continue
            if form == "table cell" and RE_TABLE_SEP.match(next_line):
                continue
            if form == "pass":
                # The hand-over verb IS the governed verb: the negation must
                # sit directly before it ("never pass", "don't ever pass").
                if RE_NEGATED_DIRECT.search(line[:m.start()]):
                    continue
            elif form not in ("list item", "table cell") and \
                    RE_NEGATED_BEFORE.search(line[:m.start(1)]):
                continue                 # "never write `api_key=...`" forbids it
            if form in ("name: / name=", "list item") and RE_LABEL_WORD.match(name) \
                    and RE_LINE_HEAD.match(line[:m.start(1)]) \
                    and RE_LABEL_TAIL.match(line[m.end(1):]):
                continue                 # a glossary label: "Token: a unit of text"
            if is_secret_name(name) and all(n != name for n, _ in found):
                found.append((name, form))
    for m in RE_CALL_SIG.finditer(line):
        args = RE_QUOTED_STR.sub(" ", m.group(1))
        for name in re.findall(IDENT, args):
            if is_secret_name(name) and all(n != name for n, _ in found):
                found.append((name, "call signature"))
    return found


def unbold(text: str) -> str:
    return text.replace("**", "").replace("__", "")


def weak_args(window: str) -> list[str]:
    found: list[str] = []
    for rx in RE_WEAK:
        for m in rx.finditer(window):
            name = m.group(1)
            if is_secret_name(name) and name not in found:
                found.append(name)
    return found


# --- Rule C ------------------------------------------------------------------

# The file name as a whole word: `tsconfig.json`, `my-config.json`,
# `config.jsonc` and `config.json.example` are other files. A markdown-escaped
# dot (`config\.json`) is the same file.
RE_CONFIG = re.compile(r"(?<![A-Za-z0-9_.-])config\\?\.json(?!\.?[A-Za-z0-9_])", re.I)
# A secret key named by a dotted path ending in api_key, apikey, password or
# secret (`remote_brain.api_key`, a jq `.remote_brain.api_key`,
# `a.b.password`): reading it by name is reading the file. Not `token`:
# design-token paths (`theme.token`) are ordinary text here.
RE_KEYPATH = re.compile(
    r"(?<![A-Za-z0-9_-])\.?[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*"
    r"\.(?:api_key|apikey|password|secret)(?![A-Za-z0-9_])", re.I)
NEG = (r"(?:(?:do|does|must|should)\s+not|(?:do|does|must|should)n['’]t"
       r"|never|rather\s+than|instead\s+of|avoid)(?:\s+ever)?")
# The negated verb: read or another verb that opens the file ("do not open",
# "never `cat`"), optionally in backticks.
RE_FORBID = re.compile(
    rf"\b{NEG}\s+`?(?:re-?)?(?:read(?:s|ing)?|open(?:s|ing)?|cat(?:s|ting)?"
    r"|load(?:s|ing)?|pars(?:e|es|ing)|print(?:s|ing)?|view(?:s|ing)?"
    r"|inspect(?:s|ing)?|sourc(?:e|es|ing))`?(?![A-Za-z0-9_])", re.I)
PATH_PREFIX = r"(?:~/\.igris/|<[^<>\s]+>/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/)?"
# Between a negated read and the mention, ONLY: more negated verbs ("or
# edit", ", pass or print"), "the file", a quote and a path prefix. Anything
# else means the negation governs something other than the file.
RE_FORBID_GAP = re.compile(
    rf"^(?:\s*,?\s*(?:or|and|nor)\s+[A-Za-z-]+|\s*,\s*[A-Za-z-]+)*"
    rf"\s+(?:the\s+(?:file\s+)?)?[`'\"]?{PATH_PREFIX}$", re.I)
# Between two mentions covered by the same verb: "`config.json` or
# `~/.igris/config.json`", "`config.json` (`~/.igris/config.json`)".
RE_CHAIN_GAP = re.compile(
    rf"^[`'\"]?\s*(?:,|or|and|nor|/|\()?\s*(?:the\s+)?[`'\"]?{PATH_PREFIX}$", re.I)
# A clause boundary; a conditional before the negation, or an exception or
# condition after the mention, turns a forbid into a permission.
RE_CLAUSE = re.compile(r"[,;:—–(]|\s-{1,2}\s")
RE_COND_BEFORE = re.compile(
    r"\b(?:if|unless|when|whenever|until|once|after|before)\b", re.I)
RE_COND_AFTER = re.compile(
    r"\b(?:unless|except|until|before|when|whenever|if|only|but|otherwise"
    r"|instead)\b", re.I)
# cli-self: a program subject reads the file, and "itself" follows the
# mention directly ("It reads ... from `~/.igris/config.json` itself").
RE_SELF_SUBJ = re.compile(
    r"\b(?:it|which|that)\s+reads\b|\bthe\s+(?:CLI|verb)\s+reads\b"
    r"|`[^`]+`\s+reads\b|,\s*reading\b", re.I)
# What ends the program's reach before the mention: a clause break, a joined
# clause (", and", ", so"), or a second subject ("you read ...").
RE_SELF_BREAK = re.compile(
    r"[;:—–]|\s-{1,2}\s|,\s*(?:and|or|so|then|but)\b"
    r"|\b(?:then|but|instead|you)\b", re.I)
RE_ITSELF_NEXT = re.compile(r"^[`'\"]?\s+itself\b", re.I)
RE_CLI_WORD = re.compile(r"\b(?:CLI|verb)\b", re.I)
RE_TABLE_ROW = re.compile(r"^\s*\|")
RE_QUOTE = re.compile(r"^\s*>\s?")
RE_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def normalize(sentence: str) -> str:
    """Drop markdown emphasis so `do **not** read` reads as `do not read`."""
    s = re.sub(r"\*\*|__", "", sentence)
    s = re.sub(r"(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])", "", s)
    s = re.sub(r"(?<![A-Za-z0-9])_(?=[^_\s])([^_]*?[^_\s])_(?![A-Za-z0-9])", r"\1", s)
    return " ".join(s.split())


def _clause_start(s: str, pos: int) -> int:
    last = 0
    for b in RE_CLAUSE.finditer(s, 0, pos):
        last = b.end()
    return last


def _clause_tail(s: str, pos: int) -> str:
    b = RE_CLAUSE.search(s, pos)
    stop = b.start() if b else len(s)
    dot = s.find(".", pos)
    if dot != -1 and dot < stop and (dot + 1 == len(s) or s[dot + 1].isspace()):
        stop = dot
    return s[pos:stop]


# A condition that opens the NEXT clause still qualifies the forbid: "do not
# read config.json, unless the CLI fails", "(unless ...)", "- except ...".
RE_COND_NEXT = re.compile(
    r"^\s*(?:unless|except|until|before|when|whenever|if)\b", re.I)


def _voided_after(s: str, pos: int) -> bool:
    tail = _clause_tail(s, pos)
    if RE_COND_AFTER.search(tail):
        return True
    rest = s[pos + len(tail):]
    b = RE_CLAUSE.match(rest)
    return bool(b) and bool(RE_COND_NEXT.match(rest[b.end():]))


def _forbid_covers(s: str, m: re.Match) -> bool:
    for f in RE_FORBID.finditer(s, 0, m.start()):
        if not RE_FORBID_GAP.match(s[f.end():m.start()]):
            continue
        if RE_COND_BEFORE.search(s[_clause_start(s, f.start()):f.start()]):
            continue
        if _voided_after(s, m.end()):
            continue
        return True
    return False


def _cli_self_covers(s: str, m: re.Match) -> bool:
    if not RE_ITSELF_NEXT.match(s[m.end():]):
        return False
    for v in RE_SELF_SUBJ.finditer(s, 0, m.start()):
        if RE_SELF_BREAK.search(s[v.end():m.start()]):
            continue
        if v.group(0).lstrip().startswith(",") and not RE_CLI_WORD.search(s):
            continue
        return True
    return False


def classify(sentence: str) -> str | None:
    """`forbid` / `cli-self` when EVERY mention in the sentence is covered,
    else None (the ledger decides). A config-path key (`remote_brain.api_key`)
    is covered by its own forbid, or when the sentence names config.json and
    every config.json mention in it is covered."""
    s = normalize(sentence)
    files = list(RE_CONFIG.finditer(s))
    keys = list(RE_KEYPATH.finditer(s))
    if not files and not keys:
        return None
    verdicts: list[str] = []
    prev = None                          # last covered mention, for chains
    for m in files:
        if _forbid_covers(s, m):
            verdicts.append("forbid")
        elif _cli_self_covers(s, m):
            verdicts.append("cli-self")
        elif (prev is not None and RE_CHAIN_GAP.match(s[prev.end():m.start()])
              and not _voided_after(s, m.end())):
            verdicts.append(verdicts[-1])
        else:
            return None
        prev = m
    for k in keys:
        if _forbid_covers(s, k):
            verdicts.append("forbid")
        elif not files:
            return None
    return verdicts[0]


def unit_bounds(lines, idx, spans, h) -> tuple[int, int]:
    """[start, end) of the paragraph / list item / single line holding idx."""
    line = lines[idx]
    if idx in spans and not h.RE_FENCE.match(line):
        return idx, idx + 1                  # a fenced line is its own unit

    def starter(s: str) -> bool:
        return bool(h.RE_BULLET.match(s) or h.RE_HEADING.match(s)
                    or RE_TABLE_ROW.match(s))

    if h.RE_HEADING.match(line) or RE_TABLE_ROW.match(line):
        return idx, idx + 1
    start = idx
    while start > 0 and not starter(lines[start]):
        prev = lines[start - 1]
        if (not prev.strip() or h.RE_FENCE.match(prev) or (start - 1) in spans
                or h.RE_HEADING.match(prev) or RE_TABLE_ROW.match(prev)):
            break
        start -= 1
    end = idx + 1
    while end < len(lines):
        nxt = lines[end]
        if not nxt.strip() or h.RE_FENCE.match(nxt) or starter(nxt) or end in spans:
            break
        end += 1
    return start, end


def sentences_with_lines(lines, start, end):
    """Yield (sentence, first_line_no) for each sentence of the unit."""
    text = ""
    marks: list[tuple[int, int]] = []        # (char offset, 1-based line no)
    for k in range(start, end):
        seg = RE_QUOTE.sub("", lines[k]).strip()
        if text:
            text += " "
        marks.append((len(text), k + 1))
        text += seg
    pos = 0
    for part in RE_SENTENCE_END.split(text):
        at = text.find(part, pos)
        if at < 0:
            at = pos
        line_no = marks[0][1]
        for off, ln in marks:
            if off <= at:
                line_no = ln
        pos = at + len(part)
        yield part, line_no


# --- scan --------------------------------------------------------------------

def snippet_of(s: str) -> str:
    s = " ".join(s.split())
    return s if len(s) <= 110 else s[:107] + "..."


def scan_file(path, rel, h):
    lines = path.read_text().splitlines()
    dropped = h.excluded_frontmatter_lines(lines)
    spans = h.fence_spans(lines)
    s_hits = []     # (rel, line_no, name, where, line text)
    f_hits = []     # (rel, line_no, flag, snippet)
    c_hits = []     # (rel, line_no, sentence, verdict)
    seen_s: set[tuple[int, str]] = set()

    def add_s(ln: int, name: str, where: str, text: str) -> None:
        if (ln, name) not in seen_s:
            seen_s.add((ln, name))
            s_hits.append((rel, ln, name, where, " ".join(text.split())))

    for idx, line in enumerate(lines):
        if idx in dropped:
            continue
        nxt = lines[idx + 1] if idx + 1 < len(lines) else ""
        # Bold or underline emphasis never hides a name: `- **api_key**: x`.
        for name, form in strong_args(unbold(line), nxt):
            add_s(idx + 1, name, f"({form})", line)
        tools = []
        for m in RE_SITE_TOOL.finditer(line):
            if m.group(1) not in tools:
                tools.append(m.group(1))
        if tools:
            window = unbold(h.strip_path_tokens(h.site_window(lines, idx, spans)))
            for name in weak_args(window):
                add_s(idx + 1, name, f"at a {tools[0]} site", line)
        for m in RE_FLAG.finditer(line):
            if is_secret_flag(m.group(1)) and not RE_NEGATED_BEFORE.search(line[:m.start()]):
                f_hits.append((rel, idx + 1, "--" + m.group(1), snippet_of(line)))

    # Rule C reads EVERY line, the `allowed-tools:` block included: a
    # permission to Read(~/.igris/config.json) is a read route too.
    seen_units: set[tuple[int, int]] = set()
    for idx, line in enumerate(lines):
        if not (RE_CONFIG.search(line) or RE_KEYPATH.search(line)):
            continue
        bounds = unit_bounds(lines, idx, spans, h)
        if bounds in seen_units:
            continue
        seen_units.add(bounds)
        for sentence, line_no in sentences_with_lines(lines, *bounds):
            if RE_CONFIG.search(sentence) or RE_KEYPATH.search(sentence):
                c_hits.append((rel, line_no, " ".join(sentence.split()),
                               classify(sentence)))
    return s_hits, f_hits, c_hits


def main(argv: list[str]) -> int:
    show_list = "--list" in argv
    override = os.environ.get("SKILL_SECRETS_SCAN_ROOT")
    skills_root = pathlib.Path(override or str(DEFAULT_SKILLS_ROOT))
    real_tree = override is None

    if not skills_root.is_dir():
        print(f"Error: skills root not found: {skills_root}")
        return 2
    h = load_helpers()
    if h is None:
        print(f"Error: cannot import the window helpers from {HELPERS_PATH}")
        return 2
    files = sorted(skills_root.rglob("*.md"))
    if not files:
        print(f"Error: no markdown found under {skills_root}")
        return 2

    s_all, f_all, c_all = [], [], []
    for path in files:
        rel = path.relative_to(skills_root).as_posix()
        try:
            s, f, c = scan_file(path, rel, h)
        except (OSError, UnicodeDecodeError) as exc:
            print(f"Error: cannot read {path}: {exc}")
            return 2
        s_all += s
        f_all += f
        c_all += c

    problems: list[str] = []
    listed: list[str] = []

    s_seen: dict[tuple[str, str, str], int] = {}
    for rel, ln, name, where, text in s_all:
        hit = None
        for key in LEDGER_S:
            if key[0] == rel and key[1] == name and key[2] in text:
                hit = key
                break
        label = f"  {rel}:{ln}  secret argument `{name}` {where}"
        if hit is None:
            problems.append(f"{label}  [no ledger entry]\n      {snippet_of(text)}")
            continue
        s_seen[hit] = s_seen.get(hit, 0) + 1
        if s_seen[hit] > LEDGER_S[hit][1]:
            problems.append(f"{label}  [ledger count exceeded]\n      {snippet_of(text)}")
        else:
            listed.append(f"  {rel}:{ln}  ledgered S ({LEDGER_S[hit][0]})")

    for rel, ln, flag, snip in f_all:
        problems.append(f"  {rel}:{ln}  secret-carrying flag `{flag}`\n      {snip}")

    c_seen: dict[tuple[str, str], int] = {}
    for rel, ln, sentence, verdict in c_all:
        if verdict is not None:
            listed.append(f"  {rel}:{ln}  {verdict}")
            continue
        hit = None
        for (lrel, needle) in LEDGER_C:
            if lrel == rel and needle in sentence:
                hit = (lrel, needle)
                break
        if hit is None:
            problems.append(f"  {rel}:{ln}  config.json named outside a recognised"
                            f" form  [no ledger entry]\n      {snippet_of(sentence)}")
            continue
        c_seen[hit] = c_seen.get(hit, 0) + 1
        if c_seen[hit] > LEDGER_C[hit][1]:
            problems.append(f"  {rel}:{ln}  config.json mention  [ledger count"
                            f" exceeded]\n      {snippet_of(sentence)}")
        else:
            listed.append(f"  {rel}:{ln}  ledgered C ({LEDGER_C[hit][0]})")

    if real_tree:
        for key, (reason, expected) in LEDGER_C.items():
            got = c_seen.get(key, 0)
            if got < expected:
                problems.append(f"  {key[0]}  stale LEDGER_C entry (seen {got} of"
                                f" {expected}): {key[1]!r}")
        for key, (reason, expected) in LEDGER_S.items():
            got = s_seen.get(key, 0)
            if got < expected:
                problems.append(f"  {key[0]}  stale LEDGER_S entry (seen {got} of"
                                f" {expected}): {key[1]} / {key[2]!r}")

    if show_list and listed:
        print("Recognised or ledgered:")
        print("\n".join(listed))

    if problems:
        print(f"FAIL: {len(problems)} secret-handling problem(s) in skill text:")
        print("\n".join(problems))
        print(
            "\nA skill must never tell an agent to read ~/.igris/config.json (it\n"
            "holds the remote brain's API key) or to pass a secret as a tool\n"
            "argument or flag: both land in the transcript (TD-492, L-1379).\n"
            "Use a CLI verb that reads the config itself. If a mention is truly\n"
            "descriptive, add it to LEDGER_C in\n"
            "scripts/validate_skill_secret_handling.py with the reason it is not\n"
            "a read. Never ledger a real read instruction to get a commit through."
        )
        return 1

    print(f"OK: no secret argument and no unclassified config.json mention in "
          f"{len(files)} skill file(s) ({len(c_all)} config sentence(s) "
          f"classified, {len(s_all) + len(f_all)} secret site(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
