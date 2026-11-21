#!/bin/bash
# agent_memory_export.sh — TD-496: export agent-memory lessons into the brain.
#
# The model proposes; the operator approves; this script and `igris lessons
# ingest` do the writing. The script reads agent-memory files and NEVER writes,
# moves or deletes one of them (AC3): every write goes through two helpers that
# refuse a path outside --run-dir (and never write through a symlink or a hard
# link), and a run dir inside a source root is refused. The walk records a file
# symlink as excluded and never reads through it.
# test/agent_memory_export.test.bash pins both (an a-w corpus manifest compared
# before and after every action, plus a static scan of this file).
#
# Actions (each takes --run-dir R except roots):
#   roots    --project-root DIR... [--user-root DIR|auto] [--extra-root DIR...]
#            [--include-worktrees] [--json]
#            List agent-memory roots. Labels: main, nested:<relpath>, user,
#            extra:<path>. Extra roots are reported, never processed by default.
#   scan     --root LABEL=PATH:PROJECT... [--only-role R...] [--rescan]
#            [--import-decisions DIR]
#            Walk the roots, build candidates.jsonl and manifest.jsonl.
#   next     [--size 25] [--allow-no-dedup]
#            Open the next batch (one role group) and dry-run it through
#            `$IGRIS_CLI lessons ingest --in <batch> --dry-run --json`.
#   propose  --batch N [--keep K[:why]] [--drop K:why] [--global K]
#            [--project K=SLUG] [--cat K=CATEGORY]
#            Record the model's proposal for `judge` rows (reasons <= 6 words).
#   sheet    --batch N [--json]      The per-batch approval sheet.
#   show     --batch N --row K       The full rendered lesson.
#   decide   --batch N [--accept [--commit]] [--keep K] [--drop K:why]
#            [--tag K] [--new K] [--flip K] [--cat K=C] [--global K]
#            [--project K=SLUG] [--title K=TEXT] [--secret-override K:why] [--json]
#            Without --commit it writes nothing. With --commit it writes
#            batches/NNNN.approved.jsonl and sends exactly that file to
#            `$IGRIS_CLI lessons ingest --in <file> --ledger <run>/stored.jsonl --json`.
#   report   (--md|--json) [--verify-sources]
#            Per-root and per-source-set tables; exit 1 when they do not close.
#
# Run dir: run.json, manifest.jsonl, candidates.jsonl, decisions.jsonl
# (append-only, last decision wins), stored.jsonl (the ledger `igris lessons
# ingest` writes), batches/NNNN.{candidates,dedup,sheet,approved}.jsonl.
#
# Candidate id: cid = the first 12 hex of sha256("<label>\0<role>/<relpath>");
# a lesson's store key is `amx:<cid>`.
#
# IGRIS_CLI: the CLI command (whitespace-split, the compile_harnesses.sh seam);
# defaults to `igris`.
#
# Exit: 0 ok, 1 refused or a check failed, 2 usage, 3 brain or CLI unavailable.
#
# PORTABILITY: the outer shell is bash 3.2 (macOS /bin/bash); the logic is one
# python3 block, stdlib only, Python 3.9-safe, no PyYAML.

if ! command -v python3 >/dev/null 2>&1; then
  echo "agent_memory_export: python3 is required" >&2
  exit 2
fi

exec python3 -I - "$@" <<'PY'
from __future__ import annotations

import datetime
import errno
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

PROG = "agent_memory_export"
EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_UNAVAILABLE = 0, 1, 2, 3

# The igris_memory_store arguments a rendered row may carry:
# brain-mcp-server/src/engine/components/memory/index.ts:75-157 minus
# review_status and edges; never `confidence` (TD-128, TD-364). The same set is
# INGEST_STORE_KEYS in cli/src/lib/lessons-ingest.ts.
STORE_ARGS = ("project", "category", "title", "content", "tags", "tech_stack",
              "source_brief", "scope", "provenance", "source_extractor")
CATEGORIES = ("pattern", "decision", "discovery", "mistake", "optimization")
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
ROLE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")  # = ROLE_TAG_RE in lessons.ts
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
TITLE_MAX = 200
REASON_MAX_WORDS = 6
DEFAULT_SIZE = 25
INDEX_NAME = "MEMORY.md"
PRUNE_DIRS = ("node_modules", ".git", "dist")
# Small roles first calibrate the curation bar; later roles de-duplicate
# against earlier stores (TD-496 plan, Phase 5 step 4).
GROUP_ORDER = ("aegis", "scribe", "seeker", "@nested", "@user",
               "architect", "sentinel", "warden", "forger")
TYPE_PREFIX_RE = re.compile(r"^(?:feedback|project|reference|user)[_-]")
SECRET_PATTERNS = (
    ("key-prefix", re.compile(
        r"(?<![A-Za-z0-9])(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}"
        r"|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}"
        r"|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})")),
    ("pem", re.compile(r"-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----")),
    ("assignment", re.compile(
        r"(?i)(?:token|key|secret|password|passwd)\s*=\s*[\"']?[A-Za-z0-9_\-./+=]{16,}")),
    # The same key names and value rule, written `key: value` (YAML, prose)
    # or as a quoted field (`"token": "..."`, JSON or a dict literal).
    ("colon-assignment", re.compile(
        r"(?i)(?:token|key|secret|password|passwd)\s*:\s*[\"']?[A-Za-z0-9_\-./+=]{16,}")),
    ("quoted-field", re.compile(
        r"(?i)(?:token|key|secret|password|passwd)[\"']\s*:\s*[\"'][A-Za-z0-9_\-./+=]{16,}")),
    ("url-credentials", re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@[^\s/@]")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9_\-.=+/]{20,}")),
)
STORE_DISPS = ("KEEP", "NEW", "RETITLE", "ALREADY")


class Usage(Exception):
    pass


class Refused(Exception):
    pass


class Unavailable(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def cid_for(label, role, relpath, salt=""):
    s = label + "\0" + role + "/" + relpath + (("\0" + salt) if salt else "")
    return sha256(s)[:12]


def jdump(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def tag_tokens(tags):
    return [t.strip() for t in (tags or "").split(",") if t.strip()]


def real(p):
    return os.path.realpath(os.path.expanduser(p))


def inside(p, root):
    root = root.rstrip(os.sep) or os.sep
    return p == root or p.startswith(root + os.sep)


def say(msg=""):
    sys.stdout.write(msg + "\n")


# --- the only write paths (guarded: run dir only) -----------------------------

_RUN_DIR = None


def _guard_write(path):
    if _RUN_DIR is None:
        raise RuntimeError("internal: no run dir armed before a write")
    rp = os.path.realpath(path)
    if not inside(rp, _RUN_DIR):
        raise RuntimeError("internal: refusing to write outside the run dir: " + path)
    return rp


def _ensure_dir(path):
    rp = _guard_write(path)
    os.makedirs(rp, exist_ok=True)
    return rp


def _open_run_file(path, flags):
    """A write fd for a run-dir file. Never follows a symlink at `path`
    (O_NOFOLLOW) and refuses anything but a single-link regular file, so a
    planted symlink or hard link cannot redirect the write outside the run dir."""
    try:
        fd = os.open(path, flags | os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise Refused("refusing to write through a symlink: " + path)
        raise
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        os.close(fd)
        raise Refused("refusing to write a non-regular or hard-linked file: " + path)
    return fd


def _write_text(path, text):
    rp = _guard_write(path)
    _ensure_dir(os.path.dirname(rp))
    tmp = rp + ".part"
    fd = _open_run_file(tmp, 0)
    os.ftruncate(fd, 0)  # after the link check, so a hard link is never truncated
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, rp)


def _append_line(path, obj):
    rp = _guard_write(path)
    _ensure_dir(os.path.dirname(rp))
    fd = _open_run_file(rp, os.O_APPEND)
    with os.fdopen(fd, "a", encoding="utf-8", newline="\n") as f:
        f.write(jdump(obj) + "\n")


def arm_run_dir(path, source_roots):
    global _RUN_DIR
    rd = real(path)
    for s in source_roots:
        sr = real(s)
        if inside(rd, sr) or inside(sr, rd):
            raise Usage("run dir %s is inside a source root (%s) or contains one; "
                        "choose a run dir outside every agent-memory root" % (rd, sr))
    _RUN_DIR = rd
    return rd


# --- reading -------------------------------------------------------------------


def read_text(path):
    with open(path, "rb") as f:
        return f.read().decode("utf-8")


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    for n, line in enumerate(read_text(path).split("\n"), 1):
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                raise Refused("%s: line %d is not JSON" % (path, n))
    return out


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    try:
        return json.loads(read_text(path))
    except ValueError:
        raise Refused("%s is not JSON" % path)


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
        if v and "''" in v:
            v = v.replace("''", "'")
    return v


def parse_frontmatter(text):
    """(fields, body). Flat `key: value` plus one level of nesting (metadata.type),
    folded continuation lines and `>`/`|` block scalars. No PyYAML."""
    t = text[1:] if text.startswith("﻿") else text
    lines = t.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, t
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            end = i
            break
    if end is None:
        return None, t
    fm = {}
    parent = None
    last = None
    for ln in lines[1:end]:
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        top = not ln[:1].isspace()
        m = re.match(r"^\s*([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|\s*)$", ln)
        if top and m:
            key, val = m.group(1), (m.group(2) or "").strip()
            if val in ("", ">", "|", ">-", "|-", ">+", "|+"):
                fm[key] = {} if val == "" else ""
                parent, last = key, key
            else:
                fm[key] = unquote(val)
                parent, last = None, key
            continue
        if not top and m and parent is not None and isinstance(fm.get(parent), dict):
            fm[parent][m.group(1)] = unquote(m.group(2) or "")
            continue
        if not top and last is not None:
            cur = fm.get(last)
            if isinstance(cur, dict) and not cur:
                fm[last] = ln.strip()
            elif isinstance(cur, str):
                fm[last] = (cur + " " + ln.strip()).strip()
    return fm, "\n".join(lines[end + 1:])


def fm_str(fm, key):
    v = fm.get(key) if fm else None
    return v if isinstance(v, str) and v else None


def fm_type(fm):
    if not fm:
        return None
    meta = fm.get("metadata")
    if isinstance(meta, dict) and isinstance(meta.get("type"), str) and meta["type"]:
        return meta["type"].strip().lower()
    t = fm.get("type")
    return t.strip().lower() if isinstance(t, str) and t else None


def clean_body(body):
    lines = body.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    return "\n".join(lines).rstrip()


def norm_ws(s):
    return " ".join(s.split())


def secrets_in(text):
    return [name for name, rx in SECRET_PATTERNS if rx.search(text)]


def classify(ap, role, relp):
    """(manifest row, parsed or None). Reads the file; never writes it."""
    rec = {"role": role, "relpath": relp, "status": "content", "reason": "",
           "size": 0, "sha256": ""}
    try:
        with open(ap, "rb") as f:
            data = f.read()
    except OSError:
        rec.update(status="excluded", reason="unreadable")
        return rec, None
    rec["size"] = len(data)
    rec["sha256"] = sha256(data)
    segs = ([role] if role else []) + relp.split("/")
    if any(s.startswith(".") for s in segs):
        rec.update(status="excluded", reason="hidden")
        return rec, None
    if role is None:
        rec.update(status="excluded", reason="no-role")
        return rec, None
    if not ROLE_RE.match(role):
        rec.update(status="excluded", reason="bad-role")
        return rec, None
    if not data.strip():
        rec.update(status="excluded", reason="empty")
        return rec, None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        rec.update(status="excluded", reason="non-utf8")
        return rec, None
    if relp == INDEX_NAME:
        rec["status"] = "index"
        return rec, {"text": text}
    fm, body = parse_frontmatter(text)
    body = clean_body(body)
    if not body.strip():
        rec.update(status="excluded", reason="empty")
        return rec, None
    return rec, {"text": text, "fm": fm, "body": body}


def walk_root(path, only_roles):
    """[(manifest row, parsed)] for every file under one root (a symlink is
    recorded, never read). Read-only."""
    out = []
    for dp, dns, fns in os.walk(path):
        dns.sort()
        for fn in sorted(fns):
            ap = os.path.join(dp, fn)
            link = os.path.islink(ap)
            if not link and not os.path.isfile(ap):
                continue
            rel = os.path.relpath(ap, path).replace(os.sep, "/")
            parts = rel.split("/")
            role, relp = (None, rel) if len(parts) == 1 else (parts[0], "/".join(parts[1:]))
            if only_roles and role not in only_roles:
                continue
            if link:
                # Never read through a symlink: its target may sit outside
                # the corpus. (os.walk already skips directory symlinks.)
                out.append(({"role": role, "relpath": relp, "status": "excluded",
                             "reason": "symlink", "size": 0, "sha256": ""}, None))
                continue
            rec, parsed = classify(ap, role, relp)
            out.append((rec, parsed))
    return out


LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
CANON_RE = re.compile(r"^\s*[-*+]\s+\[[^\]\n]+\]\([^)\s]+\)\s*(?:—|–|--|-|:)\s*(\S.*?)\s*$")


def is_local(target):
    return "://" not in target and not target.startswith(("#", "mailto:"))


def parse_index(text, known, present):
    """joins {relpath: (title, hook)}, inline [lines], dangling [(target, line)].
    `known` is the role's content files; `present` every file in the role dir."""
    joins, inline, dangling = {}, [], []
    for n, line in enumerate(text.split("\n"), 1):
        links = [(m.group(1), m.group(2)) for m in LINK_RE.finditer(line) if is_local(m.group(2))]
        if not links:
            if line.strip():
                inline.append(line.rstrip())
            continue
        canon = CANON_RE.match(line) if len(links) == 1 else None
        for txt, target in links:
            t = target.split("#", 1)[0]
            rel = os.path.normpath(t).replace(os.sep, "/") if t else ""
            if rel in known:
                if rel not in joins:
                    joins[rel] = (" ".join(txt.split()), canon.group(1) if canon else None)
            elif rel not in present:
                dangling.append((t or target, n))
    if not any(not l.lstrip().startswith("#") for l in inline):
        inline = []
    return joins, inline, dangling


def humanise(s):
    s = s.strip()
    if s and re.fullmatch(r"[A-Za-z0-9_.-]+", s):
        s = re.sub(r"[-_]+", " ", s).strip()
    return (s[:1].upper() + s[1:]) if s else s


def title_base(join_title, fm_name, relpath):
    if join_title:
        t = join_title
    elif fm_name:
        t = humanise(fm_name)
    else:
        stem = relpath.rsplit("/", 1)[-1]
        if stem.lower().endswith(".md"):
            stem = stem[:-3]
        stem = TYPE_PREFIX_RE.sub("", stem) or stem
        t = humanise(stem)
    return norm_ws(t)[:TITLE_MAX] or "Untitled"


def with_suffix(base, suffix):
    return base[:TITLE_MAX - len(suffix)] + suffix


def source_set(label):
    head = label.split(":", 1)[0]
    return head if head in ("main", "nested", "user") else "extra"


def group_of(label, role):
    s = source_set(label)
    if s == "main":
        return role
    if s in ("nested", "user"):
        return s
    return label


def group_rank(group, label):
    s = source_set(label)
    if s == "nested":
        return GROUP_ORDER.index("@nested")
    if s == "user":
        return GROUP_ORDER.index("@user")
    if s == "main":
        return GROUP_ORDER.index(group) if group in GROUP_ORDER else len(GROUP_ORDER)
    return len(GROUP_ORDER) + 1


def order_key(m):
    return (m["label"], m["role"], m["relpath"])


def human_bytes(n):
    return "%.1fK" % (n / 1024.0)


# --- run state -----------------------------------------------------------------


class Run(object):
    def __init__(self, rd):
        self.dir = rd
        self.meta = read_json(self.p("run.json"))
        self.cands = read_jsonl(self.p("candidates.jsonl"))
        self.by_cid = dict((c["cid"], c) for c in self.cands)
        self.manifest = read_jsonl(self.p("manifest.jsonl"))
        self.decisions = read_jsonl(self.p("decisions.jsonl"))

    def p(self, *parts):
        return os.path.join(self.dir, *parts)

    def save_meta(self):
        self.meta["updated"] = now()
        _write_text(self.p("run.json"), json.dumps(self.meta, indent=2, sort_keys=True, ensure_ascii=False) + "\n")

    def committed(self):
        last = {}
        for d in self.decisions:
            if d.get("kind") == "decision" and d.get("committed"):
                last[d["cid"]] = d
        return last

    def proposals(self):
        out = {}
        for d in self.decisions:
            if d.get("kind") == "proposal":
                out.setdefault(d["cid"], {})[d["field"]] = d
        return out

    def state(self, c, committed=None):
        """(bucket, detail): pending | new | tag | discarded."""
        d = (committed if committed is not None else self.committed()).get(c["cid"])
        if d is None:
            return "pending", None
        if d["disp"] == "DROP":
            return "discarded", d.get("reason_key") or "dropped"
        s = (d.get("result") or {}).get("status")
        if s not in ("stored", "tagged", "already-present"):
            return "pending", "error"
        return ("tag" if d["disp"] == "TAG" else "new"), s

    def batch(self, bno):
        b = self.meta.get("batches", {}).get(bno)
        if b is None:
            raise Usage("no batch %s in %s" % (bno, self.dir))
        return b


def load_run(o):
    rd = o.get("--run-dir")
    if not rd:
        raise Usage("--run-dir is required")
    rd = real(rd)
    meta = read_json(os.path.join(rd, "run.json"))
    if meta is None:
        raise Usage("%s has no run.json — run `scan` first" % rd)
    arm_run_dir(rd, [r["path"] for r in meta.get("roots", [])])
    return Run(rd)


def batch_no(o):
    v = o.get("--batch")
    if not v or not v.isdigit():
        raise Usage("--batch N is required")
    return "%04d" % int(v)


# --- roots -----------------------------------------------------------------------


def find_agent_memory(top):
    """(agent-memory dirs under top, nested checkouts under top). Prunes
    node_modules, .git and dist; a subdirectory carrying its own .git is a
    separate checkout and is returned for the caller to report as extra."""
    found, checkouts = [], []
    top = real(top)
    for dp, dns, fns in os.walk(top):
        if dp != top and (".git" in dns or ".git" in fns):
            checkouts.append(dp)
            dns[:] = []
            continue
        if os.path.basename(dp) == "agent-memory" and os.path.basename(os.path.dirname(dp)) == ".claude":
            found.append(dp)
            dns[:] = []
            continue
        dns[:] = sorted(d for d in dns if d not in PRUNE_DIRS)
    return found, checkouts


def root_counts(path):
    files, roles = 0, {}
    for dp, _dirs, fns in os.walk(path):
        for fn in fns:
            ap = os.path.join(dp, fn)
            if not os.path.isfile(ap):
                continue
            files += 1
            rel = os.path.relpath(ap, path).replace(os.sep, "/").split("/")
            if len(rel) > 1:
                roles[rel[0]] = roles.get(rel[0], 0) + 1
    return files, roles


def act_roots(o):
    proots = [real(p) for p in o.get("--project-root", [])]
    if not proots:
        raise Usage("roots: at least one --project-root is required")
    for p in proots:
        if not os.path.isdir(p):
            raise Usage("roots: not a directory: " + p)
    multi = len(proots) > 1
    rows, extra_dirs = [], []
    for p in proots:
        project = os.path.basename(p)
        base = os.path.basename(p)
        found, checkouts = find_agent_memory(p)
        for d in found:
            parent = os.path.dirname(os.path.dirname(d))
            if parent == p:
                label = "main:" + base if multi else "main"
            else:
                rel = os.path.relpath(parent, p).replace(os.sep, "/")
                label = "nested:" + ((base + "/" + rel) if multi else rel)
            rows.append({"label": label, "path": d, "project": project})
        extra_dirs.extend(checkouts)
        if o.get("--include-worktrees"):
            try:
                out = subprocess.run(["git", "-C", p, "worktree", "list", "--porcelain"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, timeout=60)
                for ln in out.stdout.decode("utf-8", "replace").split("\n"):
                    if ln.startswith("worktree "):
                        wt = real(ln[len("worktree "):].strip())
                        if wt not in proots:
                            extra_dirs.append(wt)
            except (OSError, subprocess.SubprocessError):
                pass
    extra_dirs.extend(real(x) for x in o.get("--extra-root", []))
    seen = set(r["path"] for r in rows)
    for x in extra_dirs:
        if not os.path.isdir(x):
            continue
        if os.path.basename(x) == "agent-memory":
            cands = [x]
        else:
            cands, _ = find_agent_memory(x)
        for d in cands:
            if d not in seen:
                seen.add(d)
                rows.append({"label": "extra:" + d, "path": d, "project": None})
    ur = o.get("--user-root")
    if ur:
        upath = real(os.path.join(os.path.expanduser("~"), ".claude", "agent-memory") if ur == "auto" else ur)
        if os.path.isdir(upath):
            if upath not in seen:
                rows.append({"label": "user", "path": upath, "project": os.path.basename(proots[0])})
        else:
            sys.stderr.write("%s: user root not found: %s\n" % (PROG, upath))
    out = []
    for r in rows:
        files, roles = root_counts(r["path"])
        s = source_set(r["label"])
        spec = None if s == "extra" else "%s=%s:%s" % (r["label"], r["path"], r["project"])
        out.append({"set": s, "label": r["label"], "path": r["path"], "files": files,
                    "roles": roles, "spec": spec})
    if o.get("--json"):
        say(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False))
        return EXIT_OK
    say("%-7s %-34s %6s  %s" % ("set", "label", "files", "path"))
    for r in out:
        say("%-7s %-34s %6d  %s" % (r["set"], r["label"], r["files"], r["path"]))
        say("        roles: " + (", ".join("%s %d" % kv for kv in sorted(r["roles"].items())) or "none"))
    say("")
    say("Scan roots (the three sets; extra roots are reported, not processed):")
    for r in out:
        if r["spec"]:
            say("  --root " + r["spec"])
    return EXIT_OK


# --- scan ------------------------------------------------------------------------


def parse_root_spec(spec):
    label, eq, rest = spec.partition("=")
    if not eq or not label or ":" not in rest:
        raise Usage("--root wants LABEL=PATH:PROJECT, got %r" % spec)
    path, _, project = rest.rpartition(":")
    if not LABEL_RE.match(label) or label.startswith(("/", "~")) or "/../" in "/" + label + "/":
        raise Usage("--root label must be relative and path-free (main, nested:<rel>, user), got %r" % label)
    if not SLUG_RE.match(project):
        raise Usage("--root project %r is not a valid slug" % project)
    p = real(path)
    if not os.path.isdir(p):
        raise Usage("--root path is not a directory: %s" % p)
    return {"label": label, "path": p, "project": project}


def collect(roots, only_roles):
    """Walk every root: manifest rows, parsed content items, inline items, dangling."""
    manifest, items, dangling = [], [], []
    for root in roots:
        recs = walk_root(root["path"], only_roles)
        known, present = {}, {}
        for rec, parsed in recs:
            rec["label"] = root["label"]
            manifest.append(rec)
            present.setdefault(rec["role"], set()).add(rec["relpath"])
            if rec["status"] == "content":
                known.setdefault(rec["role"], {})[rec["relpath"]] = (rec, parsed)
        for rec, parsed in recs:
            if rec["status"] != "index":
                continue
            role = rec["role"]
            joins, inline, dang = parse_index(parsed["text"], known.get(role, {}), present.get(role, set()))
            for rel, (t, h) in joins.items():
                known[role][rel][1]["join"] = (t, h)
            for t, n in dang:
                dangling.append({"label": root["label"], "role": role, "index": INDEX_NAME,
                                 "target": t, "line": n})
            if inline:
                body = clean_body("\n".join(inline))
                items.append({"kind": "inline", "label": root["label"], "role": role,
                              "relpath": INDEX_NAME, "sha256": rec["sha256"],
                              "body": body, "body_sha": sha256(norm_ws(body)), "text": body,
                              "fm": None, "join": None, "project": root["project"]})
        for role in sorted(known):
            for rel in sorted(known[role]):
                rec, parsed = known[role][rel]
                items.append({"kind": "file", "label": root["label"], "role": role,
                              "relpath": rel, "sha256": rec["sha256"],
                              "body": parsed["body"], "body_sha": sha256(norm_ws(parsed["body"])),
                              "text": parsed["text"], "fm": parsed["fm"],
                              "join": parsed.get("join"), "project": root["project"]})
    return manifest, items, dangling


def render(cid, members, flags=None):
    """A candidate from its member items (sorted; the first is the primary)."""
    p = members[0]
    roles = sorted(set(m["role"] for m in members))
    joined = next((m["join"] for m in members if m.get("join")), None)
    if p["kind"] == "inline":
        cls, typ = "index-inline", None
        base = "%s memory index notes" % p["role"].capitalize()
        hook = None
        name = None
    else:
        typ = fm_type(p["fm"])
        cls = typ if typ in ("feedback", "reference", "project", "user") else ("none" if p["fm"] is None else (typ or "untyped"))
        name = fm_str(p["fm"], "name")
        base = title_base(joined[0] if joined else None, name, p["relpath"])
        hook = (joined[1] if joined and joined[1] else None) or fm_str(p["fm"], "description")
    flags = list(flags or [])
    body = p["body"]
    if "\x00" in body or (hook and "\x00" in hook):
        # A literal NUL in a UTF-8 lesson is a typo for an escape; render it
        # as the visible two characters \0 and say so.
        body = body.replace("\x00", "\\0")
        hook = hook.replace("\x00", "\\0") if hook else hook
        if "nul-escaped" not in flags:
            flags.append("nul-escaped")
    lines = []
    if hook:
        lines += [norm_ws(hook), ""]
    lines += [body, ""]
    for m in members:
        lines.append("Source: agent-memory %s/%s/%s (sha256 %s)" % (m["label"], m["role"], m["relpath"], m["sha256"][:12]))
    content = "\n".join(lines)
    secret = []
    for m in members:
        for s in secrets_in(m["text"]):
            if s not in secret:
                secret.append(s)
    args = {"project": p["project"], "category": "pattern" if cls == "feedback" else "discovery",
            "title": base, "content": content,
            "tags": ",".join(["amx:" + cid, "agent-memory"] + ["role:" + r for r in roles]),
            "source_extractor": "distill", "provenance": "observed", "scope": "local"}
    return {"cid": cid, "key": "amx:" + cid, "class": cls, "type": typ,
            "label": p["label"], "role": p["role"], "roles": roles,
            "group": group_of(p["label"], p["role"]), "project": p["project"],
            "members": [{"label": m["label"], "role": m["role"], "relpath": m["relpath"],
                         "sha256": m["sha256"]} for m in members],
            "name": name, "title_base": base, "title": base, "hook": hook,
            "body_sha": p["body_sha"], "secret": secret, "flags": flags,
            "args": args, "bytes": len(content.encode("utf-8")),
            "order": list(order_key(p)), "superseded": False}


def mpath(m):
    return (m["label"], m["role"], m["relpath"])


def build(items, old, committed):
    """Assign candidates. Old candidates keep their cid; a committed one is never
    re-rendered (a changed source becomes a new, flagged revision)."""
    groups = {}
    for it in items:
        k = ("inline", it["label"], it["role"], it["body_sha"]) if it["kind"] == "inline" else ("body", it["body_sha"])
        groups.setdefault(k, []).append(it)
    glist = sorted((sorted(g, key=order_key) for g in groups.values()), key=lambda g: order_key(g[0]))
    cands = list(old)
    by_cid = dict((c["cid"], i) for i, c in enumerate(cands))
    used = set(by_cid)
    live_by_body = {}
    old_paths = {}
    for c in old:
        if not c.get("superseded"):
            live_by_body.setdefault((c["class"] == "index-inline", c["body_sha"]), []).append(c)
            for m in c["members"]:
                old_paths.setdefault(mpath(m), []).append(c["cid"])
    claimed = set()
    touched = []
    for g in glist:
        inline = g[0]["kind"] == "inline"
        paths = set(mpath(m) for m in g)
        match = None
        for c in live_by_body.get((inline, g[0]["body_sha"]), []):
            if c["cid"] in claimed:
                continue
            if match is None or paths & set(mpath(m) for m in c["members"]):
                match = c
        if match is None:
            for cid in old_paths.get(mpath(g[0]), []):
                c = cands[by_cid[cid]]
                if cid not in claimed and cid not in committed and not c.get("superseded"):
                    match = c
                    break
        if match is not None and match["cid"] not in committed:
            claimed.add(match["cid"])
            changed = match["body_sha"] != g[0]["body_sha"]
            flags = [f for f in match["flags"] if not f.startswith("same-name")]
            if changed and "source-changed" not in flags:
                flags.append("source-changed")
            fresh = render(match["cid"], g, flags)
            cands[by_cid[match["cid"]]] = fresh
            touched.append(fresh["cid"])
            continue
        if match is not None:
            claimed.add(match["cid"])
            have = set(mpath(m) for m in match["members"])
            g = [m for m in g if mpath(m) not in have]
            if not g:
                continue
        flags = ["source-changed"] if any(mpath(m) in old_paths for m in g) else []
        cid = cid_for(g[0]["label"], g[0]["role"], g[0]["relpath"])
        if cid in used:
            cid = cid_for(g[0]["label"], g[0]["role"], g[0]["relpath"], g[0]["sha256"])
        used.add(cid)
        cand = render(cid, g, flags)
        by_cid[cid] = len(cands)
        cands.append(cand)
        touched.append(cid)
    superseded = []
    old_cids = set(x["cid"] for x in old)
    touched_set = set(touched)
    for c in cands:
        if c["cid"] in old_cids and c["cid"] not in claimed and c["cid"] not in touched_set \
                and c["cid"] not in committed and not c.get("superseded"):
            c["superseded"] = True
            superseded.append(c)
    # titles: committed and untouched keep theirs; touched are made unique
    taken = set()
    for c in cands:
        if c["cid"] not in touched:
            taken.add(c["title"].casefold())
    for c in sorted((c for c in cands if c["cid"] in touched), key=lambda c: c["order"]):
        base = c["title_base"]
        options = [base, with_suffix(base, " (%s)" % c["role"]), with_suffix(base, " (%s, %s)" % (c["role"], c["label"]))]
        chosen = next((t for t in options if t.casefold() not in taken), None)
        k = 2
        while chosen is None:
            t = with_suffix(base, " (%s #%d)" % (c["role"], k))
            chosen = t if t.casefold() not in taken else None
            k += 1
        c["title"] = chosen
        c["args"]["title"] = chosen
        taken.add(chosen.casefold())
    # same-name flags across live candidates
    names = {}
    for c in cands:
        if not c.get("superseded") and c.get("name"):
            names.setdefault(c["name"].casefold(), []).append(c)
    for c in cands:
        c["flags"] = [f for f in c["flags"] if not f.startswith("same-name")]
    for group in names.values():
        if len(set(c["body_sha"] for c in group)) > 1:
            for k, c in enumerate(sorted(group, key=lambda c: c["order"]), 1):
                c["flags"].append("same-name #%d" % k)
    return cands, superseded


def act_scan(o):
    specs = [parse_root_spec(s) for s in o.get("--root", [])]
    rd = o.get("--run-dir")
    if not rd:
        raise Usage("--run-dir is required")
    rd = real(rd)
    meta = read_json(os.path.join(rd, "run.json"))
    rescan = bool(o.get("--rescan"))
    if meta is not None and not rescan:
        raise Usage("%s already holds a scan; pass --rescan to add new or changed files" % rd)
    if meta is None and rescan:
        raise Usage("--rescan needs an earlier scan in %s" % rd)
    roots = list(meta["roots"]) if meta else []
    for s in specs:
        prev = next((r for r in roots if r["label"] == s["label"]), None)
        if prev is None:
            if any(r["path"] == s["path"] for r in roots):
                raise Usage("path %s is already scanned under another label" % s["path"])
            roots.append(s)
        elif prev != s:
            raise Usage("root %s was scanned as %s:%s" % (s["label"], prev["path"], prev["project"]))
    if not roots:
        raise Usage("scan: at least one --root LABEL=PATH:PROJECT is required")
    if len(set(r["label"] for r in roots)) != len(roots):
        raise Usage("scan: duplicate --root label")
    only = sorted(set(o.get("--only-role", []))) or None
    if meta is not None:
        if only is not None and only != meta.get("only_role"):
            raise Usage("--only-role must match the first scan (%s)" % meta.get("only_role"))
        only = meta.get("only_role")
    arm_run_dir(rd, [r["path"] for r in roots])
    _ensure_dir(rd)
    st = Run(rd)
    if meta is not None:
        openb = [b for b, v in sorted(meta.get("batches", {}).items()) if v["state"] != "committed"]
        if openb:
            raise Refused("batch %s is open; decide it (decide --accept --commit) before a rescan" % openb[0])
    else:
        st.meta = {"version": 1, "created": now(), "roots": [], "only_role": only,
                   "batches": {}, "allow_no_dedup": [], "dangling": [], "size": DEFAULT_SIZE}
    st.meta["roots"] = roots
    st.meta["only_role"] = only
    manifest, items, dangling = collect(roots, set(only) if only else None)
    committed = st.committed()
    cands, superseded = build(items, st.cands, committed)
    live = dict((mpath(m), c["cid"]) for c in cands if not c.get("superseded") for m in c["members"])
    seen_now = set()
    for rec in manifest:
        seen_now.add((rec["label"], rec["role"], rec["relpath"]))
        rec["cid"] = live.get((rec["label"], rec["role"], rec["relpath"]))
        rec["scanned_at"] = now()
    for old in st.manifest:
        k = (old["label"], old["role"], old["relpath"])
        if k not in seen_now and old["status"] in ("content", "index", "vanished"):
            v = dict(old)
            if v["status"] != "vanished":
                v["status"], v["vanished_at"] = "vanished", now()
            manifest.append(v)
    for c in superseded:
        gone = all((m["label"], m["role"], m["relpath"]) not in seen_now for m in c["members"])
        reason = "source-missing" if gone else "source-changed"
        _append_line(st.p("decisions.jsonl"), {
            "kind": "decision", "committed": True, "by": "rescan", "batch": None, "row": None,
            "cid": c["cid"], "key": c["key"], "disp": "DROP", "reason": reason, "reason_key": reason,
            "source": "rescan", "at": now(), "result": {"status": "dropped"}})
    if o.get("--import-decisions"):
        src = real(o["--import-decisions"])
        n = 0
        known = set(c["cid"] for c in cands)
        for d in read_jsonl(os.path.join(src, "decisions.jsonl")):
            if d.get("kind") == "proposal" and d.get("cid") in known:
                d = dict(d)
                d["imported_from"] = src
                d["batch"] = None
                d["row"] = None
                _append_line(st.p("decisions.jsonl"), d)
                n += 1
        st.meta["imported_from"] = src
        say("imported %d proposal(s) from %s" % (n, src))
    st.meta["dangling"] = dangling
    _write_text(st.p("manifest.jsonl"), "".join(jdump(r) + "\n" for r in manifest))
    _write_text(st.p("candidates.jsonl"), "".join(jdump(c) + "\n" for c in cands))
    st.meta["scanned_at"] = now()
    st.save_meta()
    report_scan(roots, manifest, cands, dangling, superseded, st.meta.get("size", DEFAULT_SIZE))
    return EXIT_OK


def report_scan(roots, manifest, cands, dangling, superseded, size):
    live = [c for c in cands if not c.get("superseded")]
    files = [m for m in manifest if m["status"] != "vanished"]
    say("scan: %d root(s), %d file(s) (index %d, excluded %d, read %d), %d candidate(s)" % (
        len(roots), len(files), sum(1 for m in files if m["status"] == "index"),
        sum(1 for m in files if m["status"] == "excluded"),
        sum(1 for m in files if m["status"] == "content"), len(live)))
    say("%-24s %-10s %5s %5s %5s %5s %5s" % ("root", "role", "files", "index", "excl", "read", "cands"))
    keys = sorted(set((m["label"], m["role"] or "-") for m in files))
    for label, role in keys:
        fs = [m for m in files if m["label"] == label and (m["role"] or "-") == role]
        cs = [c for c in live if c["label"] == label and c["role"] == role]
        say("%-24s %-10s %5d %5d %5d %5d %5d" % (label, role, len(fs),
            sum(1 for m in fs if m["status"] == "index"), sum(1 for m in fs if m["status"] == "excluded"),
            sum(1 for m in fs if m["status"] == "content"), len(cs)))
    groups = {}
    for c in live:
        groups.setdefault(c["group"], []).append(c)
    est = sum((len(v) + size - 1) // size for v in groups.values())
    say("batches at --size %d: about %d (%s)" % (size, est, ", ".join(
        "%s %d" % (g, len(v)) for g, v in sorted(groups.items(), key=lambda kv: (group_rank(kv[0], kv[1][0]["label"]), kv[0])))))
    if superseded:
        say("superseded on rescan: %d" % len(superseded))
    say("dangling links: %d" % len(dangling))
    for d in dangling:
        say("  %s/%s/%s -> %s (line %d)" % (d["label"], d["role"], d["index"], d["target"], d["line"]))


# --- next: open a batch and dry-run it --------------------------------------------


def cli_cmd():
    raw = os.environ.get("IGRIS_CLI", "").strip()
    return raw.split() if raw else ["igris"]


def run_ingest(in_path, dry, ledger=None):
    cmd = cli_cmd() + ["lessons", "ingest", "--in", in_path]
    if dry:
        cmd.append("--dry-run")
    if ledger:
        cmd += ["--ledger", ledger]
    cmd.append("--json")
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=3600)
    except FileNotFoundError:
        raise Unavailable("the igris CLI was not found (%s); nothing was written" % cmd[0])
    except subprocess.TimeoutExpired:
        raise Unavailable("`igris lessons ingest` timed out")
    err = p.stderr.decode("utf-8", "replace").strip()
    out = p.stdout.decode("utf-8", "replace")
    if p.returncode == 3:
        raise Unavailable("brain unavailable (igris lessons ingest exit 3): %s" % (err or out.strip()))
    if p.returncode == 2:
        raise Usage("igris lessons ingest rejected %s (exit 2): %s" % (in_path, err or out.strip()))
    data = None
    try:
        data = json.loads(out) if out.strip() else None
    except ValueError:
        data = None
    rows = result_rows(data)
    if p.returncode not in (0, 1) or rows is None:
        raise Unavailable("igris lessons ingest exited %d without a JSON result; nothing recorded: %s"
                          % (p.returncode, err or out.strip()[:300]))
    return p.returncode, data, rows


def result_rows(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in ("results", "items", "rows"):
            if isinstance(data.get(k), list):
                return data[k]
    return None


def as_id(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, int):
        return v if v > 0 else None
    if isinstance(v, str):
        m = re.search(r"(\d+)\s*$", v)
        return int(m.group(1)) if m else None
    if isinstance(v, dict):
        return as_id(v.get("id"))
    return None


def vector_state(data, rows):
    top = data.get("vector_available") if isinstance(data, dict) else None
    flags = [r.get("vector_available") for r in rows if isinstance(r, dict) and isinstance(r.get("vector_available"), bool)]
    reason = next((str(r["vector_reason"]) for r in rows if isinstance(r, dict) and r.get("vector_reason")), None)
    if top is False or False in flags:
        return False, reason or "vector dedup unavailable"
    if top is True or (flags and all(flags)):
        return True, None
    return False, "the dry run did not report vector_available"


def D(disp, reason="", **kw):
    d = {"disp": disp, "reason": reason}
    d.update(kw)
    return d


def content_default(c, it, vec):
    if c["class"] == "user":
        return D("DROP", "user-profile")
    if c["class"] == "none":
        return D("DROP", "no-frontmatter")
    n = it.get("nearest") if vec else None
    if isinstance(n, dict) and not n.get("advisory") and n.get("counts", True) is not False:
        nid = as_id(n.get("id"))
        if nid:
            have = set(tag_tokens(n.get("tags")))
            missing = [r for r in c["roles"] if "role:" + r not in have]
            sim = n.get("similarity")
            simt = (" %.2f" % sim) if isinstance(sim, (int, float)) else ""
            if not missing:
                return D("DROP", "dup-in-brain L-%d%s" % (nid, simt), id=nid, reason_key="dup-in-brain")
            return D("TAG", "L-%d%s (no role)" % (nid, simt), id=nid, missing=missing)
    coll = it.get("collision")
    if it.get("status") == "title-collision" or coll not in (None, False):
        cid_ = as_id(coll)
        t = with_suffix(c["title"], " [amx %s]" % c["cid"][:6])
        return D("RETITLE", "title-collision" + (" L-%d" % cid_ if cid_ else ""), title=t)
    if c["class"] in ("feedback", "reference"):
        return D("KEEP", "")
    return D("JUDGE", "")


def mechanical_default(c, it, vec):
    if not isinstance(it, dict):
        return D("BLOCK", "no dry-run result")
    if it.get("key_present") is True or it.get("status") == "already-present":
        rid = as_id(it.get("id"))
        return D("ALREADY", "L-%d" % rid if rid else "key present", id=rid)
    collided = it.get("status") == "title-collision" or it.get("collision") not in (None, False)
    err = it.get("error")
    under = None
    if it.get("project_registered") is False or (isinstance(err, str) and err.startswith("unregistered-project:")):
        under = D("BLOCK", "unregistered:" + c["args"]["project"])
    elif not collided and (it.get("status") == "error" or err):
        return D("BLOCK", "refused: " + norm_ws(str(err or "error"))[:80])
    elif not collided and it.get("project_registered") is not True:
        under = D("BLOCK", "project-unconfirmed:" + c["args"]["project"])
    base = content_default(c, it, vec)
    if c["secret"]:
        base = D("DROP", "secret?", then=base, reason_key="secret?")
    if under is not None:
        under["then"] = base
        return under
    return base


def act_next(o):
    st = load_run(o)
    size = o.get("--size", str(st.meta.get("size", DEFAULT_SIZE)))
    if not size.isdigit() or not 1 <= int(size) <= 500:
        raise Usage("--size wants 1..500")
    size = int(size)
    batches = st.meta.setdefault("batches", {})
    openb = [b for b, v in sorted(batches.items()) if v["state"] != "committed"]
    committed = st.committed()
    if openb:
        bno = openb[0]
        cids = batches[bno]["cids"]
    else:
        pend = [c for c in st.cands if not c.get("superseded") and st.state(c, committed)[0] == "pending"]
        if not pend:
            say("nothing pending — every candidate has a committed decision")
            return EXIT_OK
        pend.sort(key=lambda c: (group_rank(c["group"], c["label"]), c["group"], c["order"]))
        g = pend[0]["group"]
        cids = [c["cid"] for c in pend if c["group"] == g][:size]
        bno = "%04d" % (max([int(b) for b in batches] or [0]) + 1)
        batches[bno] = {"group": g, "cids": cids, "state": "open", "created": now(), "size": size}
        st.meta["size"] = size
    path = st.p("batches", bno + ".candidates.jsonl")
    _write_text(path, "".join(jdump({"key": st.by_cid[c]["key"], "op": "store", "args": st.by_cid[c]["args"]}) + "\n" for c in cids))
    st.save_meta()
    _, data, rows = run_ingest(path, dry=True)
    vec, why = vector_state(data, rows)
    b = batches[bno]
    if not vec and not o.get("--allow-no-dedup"):
        b["state"], b["vector_reason"] = "refused", why
        st.save_meta()
        raise Refused("vector dedup is unavailable (%s). Nothing was approved. Fix the brain's vectors, "
                      "or re-run `next --allow-no-dedup` to proceed without near-duplicate checks "
                      "(recorded in run.json)." % why)
    if not vec:
        rec = st.meta.setdefault("allow_no_dedup", [])
        if not any(x.get("batch") == bno for x in rec):
            rec.append({"batch": bno, "at": now(), "reason": why})
    b["state"], b["dedup"] = "open", ("vector" if vec else "none")
    by_key = dict((r["key"], r) for r in rows if isinstance(r, dict) and isinstance(r.get("key"), str))
    out = []
    for i, cid in enumerate(cids, 1):
        c = st.by_cid[cid]
        it = by_key.get(c["key"])
        out.append({"row": i, "cid": cid, "key": c["key"], "default": mechanical_default(c, it, vec),
                    "dry": it})
    _write_text(st.p("batches", bno + ".dedup.jsonl"), "".join(jdump(r) + "\n" for r in out))
    st.save_meta()
    counts = {}
    for r in out:
        counts[r["default"]["disp"]] = counts.get(r["default"]["disp"], 0) + 1
    say("batch %s · %s · %d row(s) · dedup: %s" % (bno, b["group"], len(out), b["dedup"]))
    say("defaults: " + ", ".join("%s %d" % kv for kv in sorted(counts.items())))
    judge = [r for r in out if r["default"]["disp"] == "JUDGE"]
    if judge:
        say("judge rows (propose keep or drop, a reason of six words or fewer):")
        for r in judge:
            c = st.by_cid[r["cid"]]
            say("  %2d  %-9s %5s  %s — %s" % (r["row"], c["class"], human_bytes(c["bytes"]), c["title"], c["hook"] or ""))
    say("next: propose (judge rows), then sheet --batch %d" % int(bno))
    return EXIT_OK


# --- proposals, resolution, sheet --------------------------------------------------


def parse_rows(spec, n):
    rows = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if not m:
            raise Usage("bad row list %r" % spec)
        a = int(m.group(1))
        z = int(m.group(2) or a)
        for k in range(a, z + 1):
            if not 1 <= k <= n:
                raise Usage("row %d is outside the batch (1..%d)" % (k, n))
            rows.append(k)
    if not rows:
        raise Usage("empty row list %r" % spec)
    return rows


def split_reason(spec, need):
    rows, _, why = spec.partition(":")
    why = norm_ws(why)
    if need and not why:
        raise Usage("%r needs a reason: K:<reason>" % spec)
    if why and len(why.split()) > REASON_MAX_WORDS:
        raise Usage("reason %r is longer than six words; keep it to six words or fewer" % why)
    return rows, why


def split_assign(spec):
    rows, eq, val = spec.partition("=")
    if not eq or not val.strip():
        raise Usage("%r wants K=<value>" % spec)
    return rows, val.strip()


def batch_rows(st, bno):
    b = st.batch(bno)
    rows = read_jsonl(st.p("batches", bno + ".dedup.jsonl"))
    if b["state"] == "refused" or not rows:
        raise Refused("batch %s has no dry-run result; run `next` first" % bno)
    return b, rows


def act_propose(o):
    st = load_run(o)
    bno = batch_no(o)
    b, rows = batch_rows(st, bno)
    if b["state"] == "committed":
        raise Refused("batch %s is already committed" % bno)
    n = len(rows)
    recs = []

    def judge_only(k):
        d = rows[k - 1]["default"]
        if d["disp"] != "JUDGE":
            raise Usage("row %d is %s, not a judge row; only judge rows take a keep/drop proposal" % (k, d["disp"]))

    for spec in o.get("--keep", []):
        r, why = split_reason(spec, False)
        for k in parse_rows(r, n):
            judge_only(k)
            recs.append((k, "decision", "keep", why))
    for spec in o.get("--drop", []):
        r, why = split_reason(spec, True)
        for k in parse_rows(r, n):
            judge_only(k)
            recs.append((k, "decision", "drop", why))
    for spec in o.get("--global", []):
        for k in parse_rows(spec, n):
            recs.append((k, "scope", "global", ""))
    for spec in o.get("--project", []):
        r, val = split_assign(spec)
        if not SLUG_RE.match(val):
            raise Usage("project %r is not a valid slug" % val)
        for k in parse_rows(r, n):
            recs.append((k, "project", val, ""))
    for spec in o.get("--cat", []):
        r, val = split_assign(spec)
        if val not in CATEGORIES:
            raise Usage("category must be one of %s" % ", ".join(CATEGORIES))
        for k in parse_rows(r, n):
            recs.append((k, "category", val, ""))
    if not recs:
        raise Usage("propose: nothing to record (--keep, --drop, --global, --project, --cat)")
    for k, field, value, why in recs:
        r = rows[k - 1]
        _append_line(st.p("decisions.jsonl"), {"kind": "proposal", "batch": bno, "row": k, "cid": r["cid"],
                                               "field": field, "value": value, "reason": why, "at": now()})
    say("recorded %d proposal(s) for batch %s" % (len(recs), bno))
    return EXIT_OK


def resolve(st, bno, ov=None):
    b, rows = batch_rows(st, bno)
    props = st.proposals()
    out = []
    for r in rows:
        c = st.by_cid[r["cid"]]
        d = r["default"]
        args = dict(c["args"])
        if d.get("title"):
            args["title"] = d["title"]
        x = {"row": r["row"], "cid": c["cid"], "key": c["key"], "disp": d["disp"],
             "reason": d.get("reason", ""), "reason_key": d.get("reason_key"), "source": "default",
             "id": d.get("id"), "class": c["class"], "bytes": c["bytes"], "hook": c["hook"],
             "flags": c["flags"], "secret": bool(c["secret"]), "default": d, "args": args,
             "verify": False}
        p = props.get(c["cid"], {})
        pd = p.get("decision")
        if d["disp"] == "JUDGE" and pd is not None:
            why = pd.get("reason") or ""
            if pd["value"] == "keep":
                x.update(disp="KEEP", reason=(why + " (model)").strip(), source="model")
            else:
                x.update(disp="DROP", reason=(why + " (model)").strip(), reason_key="model", source="model")
        if "scope" in p:
            args["scope"] = p["scope"]["value"]
        if "category" in p:
            args["category"] = p["category"]["value"]
        if "project" in p and p["project"]["value"] != args["project"]:
            args["project"] = p["project"]["value"]
            x["verify"] = True
            if x["disp"] == "BLOCK" and d.get("then"):
                t = d["then"]
                x.update(disp=t["disp"], reason=t.get("reason", ""), id=t.get("id"), reason_key=t.get("reason_key"))
        out.append(x)
    if ov:
        apply_overrides(out, ov)
    for x in out:
        x["title"] = x["args"]["title"]
        x["category"] = x["args"]["category"]
        x["project"] = x["args"]["project"]
        x["scope"] = x["args"]["scope"]
    return b, out


OVERRIDES = ("--secret-override", "--flip", "--keep", "--drop", "--tag", "--new",
             "--cat", "--global", "--project", "--title")


def apply_overrides(rows, ov):
    n = len(rows)

    def row(k):
        return rows[k - 1]

    def secret_locked(x):
        return x["disp"] == "DROP" and x["reason"] == "secret?" and x["source"] != "operator"

    def op(x, **kw):
        x.update(source="operator", **kw)

    for spec in ov.get("--secret-override", []):
        r, why = split_reason(spec, True)
        for k in parse_rows(r, n):
            x = row(k)
            if not secret_locked(x):
                raise Usage("row %d is not flagged secret?" % k)
            t = x["default"].get("then") or D("KEEP")
            op(x, disp=t["disp"], reason="secret override: " + why, id=t.get("id"), reason_key=t.get("reason_key"))
    for name in ("--flip", "--keep", "--new", "--tag"):
        for spec in ov.get(name, []):
            for k in parse_rows(spec, n):
                x = row(k)
                if secret_locked(x) and name != "--flip":
                    raise Usage("row %d is flagged secret?; keeping it needs --secret-override %d:<reason>" % (k, k))
                if x["disp"] == "BLOCK":
                    raise Usage("row %d is blocked (%s); give it a registered project with --project %d=<slug>" % (k, x["reason"], k))
                if x["disp"] == "JUDGE" and name in ("--flip",):
                    raise Usage("row %d has no proposal to flip" % k)
                d = x["default"]
                near = d.get("id") if d["disp"] in ("TAG", "DROP") and d.get("id") else None
                if name == "--keep":
                    if x["disp"] in ("DROP", "JUDGE"):
                        op(x, disp="KEEP", reason="kept (operator)", reason_key=None)
                elif name == "--new":
                    op(x, disp="NEW", reason="new despite a near match (operator)", reason_key=None, id=None)
                elif name == "--tag":
                    if not near:
                        raise Usage("row %d has no near match to tag" % k)
                    op(x, disp="TAG", reason="tag L-%d (operator)" % near, id=near, reason_key=None)
                else:
                    if x["disp"] == "DROP":
                        if secret_locked(x):
                            raise Usage("row %d is flagged secret?; keeping it needs --secret-override %d:<reason>" % (k, k))
                        if near and d["disp"] == "TAG":
                            op(x, disp="TAG", reason="flipped (operator)", id=near, reason_key=None)
                        else:
                            op(x, disp="KEEP", reason="flipped (operator)", reason_key=None)
                    else:
                        op(x, disp="DROP", reason="flipped (operator)", reason_key="operator")
    for spec in ov.get("--drop", []):
        r, why = split_reason(spec, True)
        for k in parse_rows(r, n):
            op(row(k), disp="DROP", reason=why + " (operator)", reason_key="operator")
    for spec in ov.get("--cat", []):
        r, val = split_assign(spec)
        if val not in CATEGORIES:
            raise Usage("category must be one of %s" % ", ".join(CATEGORIES))
        for k in parse_rows(r, n):
            row(k)["args"]["category"] = val
            row(k)["source"] = "operator"
    for spec in ov.get("--global", []):
        for k in parse_rows(spec, n):
            row(k)["args"]["scope"] = "global"
            row(k)["source"] = "operator"
    for spec in ov.get("--project", []):
        r, val = split_assign(spec)
        if not SLUG_RE.match(val):
            raise Usage("project %r is not a valid slug" % val)
        for k in parse_rows(r, n):
            x = row(k)
            x["args"]["project"] = val
            x["verify"] = True
            x["source"] = "operator"
            if x["disp"] == "BLOCK" and x["default"].get("then"):
                t = x["default"]["then"]
                x.update(disp=t["disp"], reason=t.get("reason", ""), id=t.get("id"), reason_key=t.get("reason_key"))
    for spec in ov.get("--title", []):
        r, val = split_assign(spec)
        val = norm_ws(val)
        if len(val) > TITLE_MAX:
            raise Usage("a title is at most %d characters" % TITLE_MAX)
        for k in parse_rows(r, n):
            row(k)["args"]["title"] = val
            row(k)["source"] = "operator"


def fingerprint(rows):
    return [[x["row"], x["cid"], x["disp"], x["id"], x["args"]] for x in rows]


def dedup_col(x):
    if x["disp"] in ("KEEP",) and x["source"] == "default":
        return "—"
    return x["reason"] or "—"


def act_sheet(o):
    st = load_run(o)
    bno = batch_no(o)
    b, rows = resolve(st, bno)
    _write_text(st.p("batches", bno + ".sheet.jsonl"), "".join(jdump(r) + "\n" for r in fingerprint(rows)))
    group = [c for c in st.cands if c["group"] == b["group"] and not c.get("superseded")]
    group.sort(key=lambda c: c["order"])
    pos = [i for i, c in enumerate(group, 1) if c["cid"] in set(b["cids"])]
    size = int(b.get("size", st.meta.get("size", DEFAULT_SIZE)))
    committed = st.committed()
    rest = {}
    for c in st.cands:
        if not c.get("superseded") and st.state(c, committed)[0] == "pending" and c["cid"] not in set(b["cids"]):
            rest[c["group"]] = rest.get(c["group"], 0) + 1
    total = len(st.meta["batches"]) + sum((v + size - 1) // size for v in rest.values())
    if o.get("--json"):
        say(json.dumps({"batch": bno, "group": b["group"], "dedup": b.get("dedup", "vector"),
                        "rows": [dict((k, x[k]) for k in ("row", "cid", "key", "disp", "reason", "source", "id",
                                                          "class", "category", "bytes", "title", "hook",
                                                          "project", "scope", "flags", "secret")) for x in rows]},
                       indent=2, sort_keys=True, ensure_ascii=False))
        return EXIT_OK
    say("%s · batch %d/%d · rows %d-%d of %d · dedup: %s" % (
        b["group"], int(bno), total, min(pos) if pos else 0, max(pos) if pos else 0, len(group), b.get("dedup", "vector")))
    say(" #  %-7s %-12s %-12s %5s  %-26s %s" % ("prop", "type", "cat", "size", "dedup", "title — hook"))
    for x in rows:
        th = x["title"] + ((" — " + x["hook"]) if x["hook"] else "")
        marks = []
        c = st.by_cid[x["cid"]]
        if x["scope"] == "global":
            marks.append("[global]")
        if x["project"] != c["project"]:
            marks.append("[project=%s]" % x["project"])
        marks += ["[%s]" % f for f in x["flags"]]
        if len(th) > 72:
            th = th[:71] + "…"
        say("%2d  %-7s %-12s %-12s %5s  %-26s %s %s" % (x["row"], x["disp"], x["class"], x["category"],
            human_bytes(x["bytes"]), dedup_col(x)[:26], th, " ".join(marks)))
    judge = [str(x["row"]) for x in rows if x["disp"] == "JUDGE"]
    if judge:
        say("unresolved judge rows: %s (propose keep or drop first)" % ", ".join(judge))
    return EXIT_OK


def act_show(o):
    st = load_run(o)
    bno = batch_no(o)
    _, rows = resolve(st, bno)
    k = o.get("--row", "")
    if not k.isdigit() or not 1 <= int(k) <= len(rows):
        raise Usage("--row wants 1..%d" % len(rows))
    x = rows[int(k) - 1]
    a = x["args"]
    say("row %s · %s · %s %s" % (k, x["key"], x["disp"], x["reason"]))
    say("title: " + a["title"])
    say("project: %s · category: %s · scope: %s" % (a["project"], a["category"], a["scope"]))
    say("tags: " + a["tags"])
    say("---")
    say(a["content"])
    return EXIT_OK


# --- decide ------------------------------------------------------------------------


def norm_status(res):
    s = res.get("status") if isinstance(res, dict) else None
    return s if s in ("stored", "tagged", "already-present") else "error"


def act_decide(o):
    st = load_run(o)
    bno = batch_no(o)
    b = st.batch(bno)
    if b["state"] == "committed":
        raise Refused("batch %s is already committed" % bno)
    ov = dict((k, o[k]) for k in OVERRIDES if k in o)
    _, rows = resolve(st, bno, ov)
    accept, commit = bool(o.get("--accept")), bool(o.get("--commit"))
    if commit and not accept:
        raise Usage("--commit needs --accept")
    if accept:
        judge = [str(x["row"]) for x in rows if x["disp"] == "JUDGE"]
        if judge:
            raise Refused("row(s) %s have no proposal; run propose (keep or drop) first" % ", ".join(judge))
        shown = read_jsonl(st.p("batches", bno + ".sheet.jsonl"))
        if not shown:
            raise Refused("no sheet was shown for batch %s; run sheet first" % bno)
        _, base = resolve(st, bno)
        if json.loads(jdump(fingerprint(base))) != shown:
            raise Refused("the resolution of batch %s no longer matches the sheet shown; run sheet again" % bno)
    if o.get("--json") and not commit:
        say(json.dumps({"batch": bno, "commit": False, "rows": [dict((k, x[k]) for k in (
            "row", "cid", "key", "disp", "reason", "source", "id", "title", "category", "project", "scope"))
            for x in rows]}, indent=2, sort_keys=True, ensure_ascii=False))
    elif not commit:
        say("batch %s — resolved dispositions (nothing written):" % bno)
        for x in rows:
            say("%3d  %-7s %-40s %s" % (x["row"], x["disp"], x["title"][:40], x["reason"]))
    if not commit:
        return EXIT_OK
    ops = []
    for x in rows:
        if x["disp"] in STORE_DISPS:
            ops.append({"key": x["key"], "op": "store", "args": x["args"]})
        elif x["disp"] == "TAG":
            c = st.by_cid[x["cid"]]
            ops.append({"key": x["key"], "op": "add_tags", "id": x["id"],
                        "tags": ",".join(["amx:" + c["cid"], "agent-memory"] + ["role:" + r for r in c["roles"]])})
    approved = st.p("batches", bno + ".approved.jsonl")
    _write_text(approved, "".join(jdump(op) + "\n" for op in ops))
    results = {}
    if ops:
        if any(x["verify"] and x["disp"] in STORE_DISPS for x in rows):
            _, _, vrows = run_ingest(approved, dry=True)
            vby = dict((r.get("key"), r) for r in vrows if isinstance(r, dict))
            bad = [x for x in rows if x["verify"] and x["disp"] in STORE_DISPS and (
                (vby.get(x["key"]) or {}).get("project_registered") is False
                or str((vby.get(x["key"]) or {}).get("error") or "").startswith("unregistered-project:"))]
            if bad:
                raise Refused("project not registered for row(s) %s; nothing committed" % ", ".join(
                    "%d (%s)" % (x["row"], x["project"]) for x in bad))
        _, _, out = run_ingest(approved, dry=False, ledger=st.p("stored.jsonl"))
        results = dict((r.get("key"), r) for r in out if isinstance(r, dict))
    tally = {"stored": [], "tagged": 0, "dropped": 0, "already-present": 0, "errors": []}
    for x in rows:
        if x["disp"] == "BLOCK":
            continue
        rec = {"kind": "decision", "committed": True, "batch": bno, "row": x["row"], "cid": x["cid"],
               "key": x["key"], "disp": x["disp"], "reason": x["reason"],
               "reason_key": x.get("reason_key") or (x["reason"].split()[0] if x["disp"] == "DROP" and x["reason"] else None),
               "source": x["source"], "id": x["id"], "title": x["title"], "project": x["project"],
               "category": x["category"], "scope": x["scope"], "at": now()}
        if x["disp"] == "DROP":
            rec["result"] = {"status": "dropped"}
            tally["dropped"] += 1
        else:
            res = results.get(x["key"])
            s = norm_status(res)
            rec["result"] = {"status": s, "id": as_id((res or {}).get("id")),
                             "error": (res or {}).get("error") if s == "error" else None}
            if s == "error":
                tally["errors"].append((x["row"], rec["result"]["error"] or "no result returned"))
            elif s == "already-present":
                tally["already-present"] += 1
            elif s == "tagged":
                tally["tagged"] += 1
            else:
                tally["stored"].append(rec["result"]["id"])
        _append_line(st.p("decisions.jsonl"), rec)
    b["state"], b["committed_at"] = "committed", now()
    st.save_meta()
    blocked = [str(x["row"]) for x in rows if x["disp"] == "BLOCK"]
    say("stored %d (%s), tagged %d, dropped %d, already-present %d, errors %d" % (
        len(tally["stored"]), ", ".join("L-%s" % i for i in tally["stored"]) or "none",
        tally["tagged"], tally["dropped"], tally["already-present"], len(tally["errors"])))
    for k, e in tally["errors"]:
        say("  row %d: %s (stays pending)" % (k, e))
    if blocked:
        say("  blocked, still pending: row(s) %s" % ", ".join(blocked))
    return EXIT_FAIL if tally["errors"] else EXIT_OK


# --- report ------------------------------------------------------------------------


def zero_files():
    return {"found": 0, "index": 0, "excluded": 0, "read": 0, "in_candidates": 0, "unscanned": 0, "pending": 0}


def zero_learnings():
    return {"proposed": 0, "approved_new": 0, "stored": 0, "already": 0, "approved_tag": 0,
            "tags_added": 0, "discarded": {}, "pending": 0}


def add_into(dst, src):
    for k, v in src.items():
        if isinstance(v, dict):
            for kk, vv in v.items():
                dst[k][kk] = dst[k].get(kk, 0) + vv
        else:
            dst[k] += v


def act_report(o):
    st = load_run(o)
    if not (o.get("--md") or o.get("--json")):
        raise Usage("report wants --md or --json")
    only = set(st.meta["only_role"]) if st.meta.get("only_role") else None
    committed = st.committed()
    live = [c for c in st.cands if not c.get("superseded")]
    state = dict((c["cid"], st.state(c, committed)) for c in st.cands)
    member_of = {}
    for c in live:
        for m in c["members"]:
            member_of.setdefault(mpath(m), []).append(c["cid"])
    failures = []
    roots_out = []
    for root in st.meta["roots"]:
        f = zero_files()
        for rec, _ in walk_root(root["path"], only):
            f["found"] += 1
            if rec["status"] == "index":
                f["index"] += 1
                continue
            if rec["status"] == "excluded":
                f["excluded"] += 1
                continue
            f["read"] += 1
            cids = member_of.get((root["label"], rec["role"], rec["relpath"]))
            if cids:
                f["in_candidates"] += 1
                if all(state[c][0] == "pending" for c in cids):
                    f["pending"] += 1
            else:
                f["unscanned"] += 1
                f["pending"] += 1
        lr = zero_learnings()
        for c in st.cands:
            if c["label"] != root["label"]:
                continue
            lr["proposed"] += 1
            bucket, detail = state[c["cid"]]
            if bucket == "pending":
                lr["pending"] += 1
            elif bucket == "discarded":
                lr["discarded"][detail] = lr["discarded"].get(detail, 0) + 1
            elif bucket == "tag":
                lr["approved_tag"] += 1
                if detail == "tagged":
                    lr["tags_added"] += 1
            else:
                lr["approved_new"] += 1
                if detail == "stored":
                    lr["stored"] += 1
                else:
                    lr["already"] += 1
        roots_out.append({"label": root["label"], "set": source_set(root["label"]), "path": root["path"],
                          "project": root["project"], "files": f, "learnings": lr})
    sets_out = []
    for s in ("main", "nested", "user", "extra"):
        rs = [r for r in roots_out if r["set"] == s]
        if not rs:
            continue
        agg = {"set": s, "files": zero_files(), "learnings": zero_learnings()}
        for r in rs:
            add_into(agg["files"], r["files"])
            add_into(agg["learnings"], r["learnings"])
        sets_out.append(agg)
    total = {"files": zero_files(), "learnings": zero_learnings()}
    for r in roots_out:
        add_into(total["files"], r["files"])
        add_into(total["learnings"], r["learnings"])
    for x in roots_out + sets_out:
        name = x.get("label") or ("set " + x["set"])
        f, lr = x["files"], x["learnings"]
        if f["found"] != f["index"] + f["excluded"] + f["read"]:
            failures.append("%s: files found %d != index + excluded + read" % (name, f["found"]))
        if f["read"] != f["in_candidates"] + f["unscanned"]:
            failures.append("%s: files read %d != in candidates + unscanned" % (name, f["read"]))
        disc = sum(lr["discarded"].values())
        if lr["proposed"] != lr["approved_new"] + lr["approved_tag"] + disc + lr["pending"]:
            failures.append("%s: learnings proposed %d != approved-new + approved-tag + discarded + pending" % (name, lr["proposed"]))
        if lr["approved_new"] != lr["stored"] + lr["already"]:
            failures.append("%s: approved-new %d != stored + already-present" % (name, lr["approved_new"]))
    # the ledger `igris lessons ingest` wrote is the evidence for every store
    ledger = {}
    lpath = st.p("stored.jsonl")
    lines = read_text(lpath).split("\n") if os.path.exists(lpath) else []
    nrows = 0
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        nrows += 1
        try:
            row = json.loads(line)
            key, rid, opn = row["key"], row["id"], row["op"]
            if not isinstance(key, str) or not isinstance(rid, int) or opn not in ("store", "add_tags"):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            failures.append("ledger line %d is malformed" % n)
            continue
        ids = ledger.setdefault((key, opn), set())
        ids.add(rid)
    keys = dict((c["key"], c) for c in st.cands)
    for (key, opn), ids in sorted(ledger.items()):
        c = keys.get(key)
        if c is None:
            failures.append("ledger key %s is not a candidate of this run" % key)
            continue
        if len(ids) > 1:
            failures.append("ledger key %s carries %d ids" % (key, len(ids)))
        bucket = state[c["cid"]][0]
        want = "tag" if opn == "add_tags" else "new"
        if bucket != want:
            failures.append("ledger row %s (%s) has no committed %s decision — re-run decide for its batch" % (key, opn, want))
    for c in st.cands:
        bucket, _ = state[c["cid"]]
        if bucket not in ("new", "tag"):
            continue
        d = committed[c["cid"]]
        rid = (d.get("result") or {}).get("id")
        opn = "add_tags" if bucket == "tag" else "store"
        if rid not in ledger.get((c["key"], opn), set()):
            failures.append("%s is recorded %s as L-%s but the ledger has no matching %s row" % (
                c["key"], d["result"]["status"], rid, opn))
    # The two per-key loops above make the counts agree by construction:
    # store keys = stored + already-present, add_tags keys = approved-tag.
    led_store = len(set(k for k, opn in ledger if opn == "store"))
    led_tags = len(set(k for k, opn in ledger if opn == "add_tags"))
    verify = None
    if o.get("--verify-sources"):
        roots = dict((r["label"], r["path"]) for r in st.meta["roots"])
        verify = {"checked": 0, "missing": [], "changed": [], "vanished_acknowledged": 0}
        for m in st.manifest:
            if m["status"] == "vanished":
                verify["vanished_acknowledged"] += 1
                continue
            if m["status"] not in ("content", "index") or m["label"] not in roots:
                continue
            verify["checked"] += 1
            rel = "%s/%s/%s" % (m["label"], m["role"], m["relpath"])
            ap = os.path.join(roots[m["label"]], m["role"], *m["relpath"].split("/"))
            if not os.path.isfile(ap):
                verify["missing"].append(rel)
                continue
            with open(ap, "rb") as f:
                if sha256(f.read()) != m["sha256"]:
                    verify["changed"].append(rel)
        for rel in verify["missing"]:
            failures.append("source missing: " + rel)
        for rel in verify["changed"]:
            failures.append("source changed since the scan: " + rel)
    ok = not failures
    data = {"ok": ok, "failures": failures, "roots": roots_out, "sets": sets_out, "total": total,
            "ledger": {"rows": nrows, "store_keys": led_store, "add_tags_keys": led_tags}, "verify": verify,
            "run_dir": st.dir}
    if o.get("--json"):
        say(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False))
    else:
        report_md(data)
    return EXIT_OK if ok else EXIT_FAIL


def report_md(r):
    say("## Agent-memory export report")
    say("")
    say("Run dir: `%s`" % r["run_dir"])
    say("")
    say("### Files per root (unit: files)")
    say("")
    hdr = ("found", "index", "excluded", "read", "in_candidates", "unscanned", "pending")
    say("| root | set | " + " | ".join(h.replace("_", " ") for h in hdr) + " |")
    say("|---|---|" + "---:|" * len(hdr))
    for x in r["roots"]:
        say("| %s | %s | %s |" % (x["label"], x["set"], " | ".join(str(x["files"][h]) for h in hdr)))
    for x in r["sets"]:
        say("| *set %s* | %s | %s |" % (x["set"], x["set"], " | ".join(str(x["files"][h]) for h in hdr)))
    say("| **total** | | %s |" % " | ".join(str(r["total"]["files"][h]) for h in hdr))
    say("")
    say("### Learnings per root (unit: learnings)")
    say("")
    lh = ("proposed", "approved_new", "stored", "already", "approved_tag", "tags_added", "discarded", "pending")
    names = {"approved_new": "approved-new", "stored": "stored (new rows)", "already": "already-present",
             "approved_tag": "approved-tag", "tags_added": "tags added"}

    def cell(lr, h):
        return str(sum(lr["discarded"].values())) if h == "discarded" else str(lr[h])
    say("| root | set | " + " | ".join(names.get(h, h) for h in lh) + " |")
    say("|---|---|" + "---:|" * len(lh))
    for x in r["roots"]:
        say("| %s | %s | %s |" % (x["label"], x["set"], " | ".join(cell(x["learnings"], h) for h in lh)))
    for x in r["sets"]:
        say("| *set %s* | %s | %s |" % (x["set"], x["set"], " | ".join(cell(x["learnings"], h) for h in lh)))
    say("| **total** | | %s |" % " | ".join(cell(r["total"]["learnings"], h) for h in lh))
    say("")
    say("### Discarded by reason (unit: learnings)")
    say("")
    disc = r["total"]["learnings"]["discarded"]
    if disc:
        say("| reason | learnings |")
        say("|---|---:|")
        for k, v in sorted(disc.items()):
            say("| %s | %d |" % (k, v))
    else:
        say("none")
    say("")
    lg = r["ledger"]
    say("Ledger: %d row(s) — %d store key(s), %d add_tags key(s)." % (lg["rows"], lg["store_keys"], lg["add_tags_keys"]))
    if r["verify"] is not None:
        v = r["verify"]
        say("Sources: %d checked, %d missing, %d changed, %d vanished before the last rescan." % (
            v["checked"], len(v["missing"]), len(v["changed"]), v["vanished_acknowledged"]))
        for rel in v["missing"]:
            say("  missing  " + rel)
        for rel in v["changed"]:
            say("  changed  " + rel + "  (run scan --rescan)")
    say("")
    if r["ok"]:
        say("Verdict: OK — every table closes and the ledger matches the decisions.")
    else:
        say("Verdict: FAIL — %d problem(s):" % len(r["failures"]))
        for f in r["failures"]:
            say("- " + f)


# --- entry -------------------------------------------------------------------------

SPECS = {
    "roots": {"--project-root": "multi", "--user-root": "one", "--extra-root": "multi",
              "--include-worktrees": "flag", "--json": "flag"},
    "scan": {"--run-dir": "one", "--root": "multi", "--rescan": "flag", "--only-role": "multi",
             "--import-decisions": "one"},
    "next": {"--run-dir": "one", "--size": "one", "--allow-no-dedup": "flag"},
    "propose": {"--run-dir": "one", "--batch": "one", "--keep": "multi", "--drop": "multi",
                "--global": "multi", "--project": "multi", "--cat": "multi"},
    "sheet": {"--run-dir": "one", "--batch": "one", "--json": "flag"},
    "show": {"--run-dir": "one", "--batch": "one", "--row": "one"},
    "decide": dict([("--run-dir", "one"), ("--batch", "one"), ("--accept", "flag"), ("--commit", "flag"),
                    ("--json", "flag")] + [(k, "multi") for k in OVERRIDES]),
    "report": {"--run-dir": "one", "--md": "flag", "--json": "flag", "--verify-sources": "flag"},
}
ACTIONS = {"roots": act_roots, "scan": act_scan, "next": act_next, "propose": act_propose,
           "sheet": act_sheet, "show": act_show, "decide": act_decide, "report": act_report}
USAGE = ("usage: agent_memory_export.sh <roots|scan|next|propose|sheet|show|decide|report> [options]\n"
         "       (see the header of core/scripts/agent_memory_export.sh)")


def parse_opts(action, args):
    spec = SPECS[action]
    o = {}
    i = 0
    while i < len(args):
        a = args[i]
        if not a.startswith("--"):
            raise Usage("%s: unexpected argument %r" % (action, a))
        name, eq, val = a.partition("=")
        kind = spec.get(name)
        if kind is None:
            raise Usage("%s: unknown option %s" % (action, name))
        if kind == "flag":
            if eq:
                raise Usage("%s: %s takes no value" % (action, name))
            o[name] = True
        else:
            if not eq:
                i += 1
                if i >= len(args):
                    raise Usage("%s: %s needs a value" % (action, name))
                val = args[i]
            if kind == "one":
                if name in o:
                    raise Usage("%s: %s given twice" % (action, name))
                o[name] = val
            else:
                o.setdefault(name, []).append(val)
        i += 1
    return o


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    if not argv or argv[0] in ("-h", "--help", "help"):
        say(USAGE)
        return EXIT_OK if argv else EXIT_USAGE
    action = argv[0]
    try:
        if action not in ACTIONS:
            raise Usage("unknown action %r\n%s" % (action, USAGE))
        return ACTIONS[action](parse_opts(action, argv[1:]))
    except Usage as e:
        sys.stderr.write("%s: %s\n" % (PROG, e))
        return EXIT_USAGE
    except Refused as e:
        sys.stderr.write("%s: %s\n" % (PROG, e))
        return EXIT_FAIL
    except Unavailable as e:
        sys.stderr.write("%s: %s\n" % (PROG, e))
        return EXIT_UNAVAILABLE


sys.exit(main(sys.argv[1:]))
PY
