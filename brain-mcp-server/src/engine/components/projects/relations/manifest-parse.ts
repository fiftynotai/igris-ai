// FR-273 D6 — NARROW manifest scanners (the brain ships no YAML/TOML parser):
// they find dependency names and their git/path entries, nothing else. A
// registry dependency is not a candidate; a git/path shape they cannot read is
// reported in `unparsed`, never guessed.

export interface ManifestDep {
  name: string;
  section: string;
  git?: { url: string; ref?: string; path?: string };
  path?: string;
}

export interface ManifestScan {
  deps: ManifestDep[];
  unparsed: { name: string; reason: string }[];
}

const NO_URL = 'git entry without a url';

function unquote(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

// `key: value` with a trailing ` # comment` removed (outside quotes).
function yamlLine(line: string): { indent: number; key: string; value: string } | null {
  const m = /^( *)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line.replace(/\s+#[^"']*$/, ''));
  return m === null ? null : { indent: m[1].length, key: m[2], value: (m[3] ?? '').trim() };
}

const PUBSPEC_SECTIONS = new Set(['dependencies', 'dev_dependencies', 'dependency_overrides']);

export function parsePubspecDeps(text: string): ManifestScan {
  const out: ManifestScan = { deps: [], unparsed: [] };
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  let section: string | null = null;
  let depIndent = -1;
  let cur: { name: string; lines: { indent: number; key: string; value: string }[] } | null = null;
  const flush = (): void => {
    if (cur === null || section === null) return;
    const body = cur.lines;
    const git = body.find((l) => l.key === 'git');
    const path = body.find((l) => l.key === 'path');
    if (git !== undefined) {
      const sub = (k: string): string | undefined => {
        const v = body.find((l) => l.indent > git.indent && l.key === k)?.value;
        return v === undefined || v === '' ? undefined : unquote(v);
      };
      const url = git.value !== '' ? unquote(git.value) : sub('url');
      if (url === undefined) {
        out.unparsed.push({ name: cur.name, reason: NO_URL });
      } else {
        const g: ManifestDep['git'] = { url };
        const ref = git.value !== '' ? undefined : sub('ref');
        const sp = git.value !== '' ? undefined : sub('path');
        if (ref !== undefined) g.ref = ref;
        if (sp !== undefined) g.path = sp;
        out.deps.push({ name: cur.name, section, git: g });
      }
    } else if (path !== undefined && path.value !== '') {
      out.deps.push({ name: cur.name, section, path: unquote(path.value) });
    }
    cur = null;
  };
  for (const raw of lines) {
    const l = yamlLine(raw);
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      flush();
      section = l !== null && PUBSPEC_SECTIONS.has(l.key) && l.value === '' ? l.key : null;
      depIndent = -1;
      continue;
    }
    if (section === null) continue;
    if (depIndent === -1) depIndent = indent;
    if (indent === depIndent) {
      flush();
      if (l === null) continue;
      if (l.value.startsWith('{')) {
        out.unparsed.push({ name: l.key, reason: 'inline map not supported' });
        continue;
      }
      if (l.value === '') cur = { name: l.key, lines: [] };
    } else if (cur !== null && l !== null) {
      cur.lines.push(l);
    }
  }
  flush();
  return out;
}

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export function parsePackageJsonDeps(text: string): ManifestScan {
  const out: ManifestScan = { deps: [], unparsed: [] };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { deps: [], unparsed: [{ name: 'package.json', reason: 'not valid JSON' }] };
  }
  if (j === null || typeof j !== 'object') return out;
  for (const section of NPM_SECTIONS) {
    const deps = (j as Record<string, unknown>)[section];
    if (deps === null || typeof deps !== 'object') continue;
    for (const [name, v] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      if (v.startsWith('file:')) {
        out.deps.push({ name, section, path: v.slice('file:'.length) });
        continue;
      }
      const isGit = /^(git\+[a-z]+:\/\/|git:\/\/|github:)/.test(v) || /^[\w.-]+\/[\w.-]+(#.+)?$/.test(v);
      if (!isGit) continue;
      const [url, ref] = v.split('#', 2);
      const g: ManifestDep['git'] = { url };
      if (ref) g.ref = ref;
      out.deps.push({ name, section, git: g });
    }
  }
  return out;
}

// PEP 508 `name @ git+URL[@ref][#subdirectory=path]`.
function pep508(spec: string): { name: string; git: NonNullable<ManifestDep['git']> } | null {
  const m = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*@\s*(git\+\S+)\s*$/.exec(spec);
  if (m === null) return null;
  let url = m[2];
  let path: string | undefined;
  const frag = /#.*subdirectory=([^&]+)/.exec(url);
  if (frag !== null) path = frag[1];
  url = url.replace(/#.*$/, '');
  let ref: string | undefined;
  const at = url.lastIndexOf('@');
  if (at > url.lastIndexOf('/')) {
    ref = url.slice(at + 1);
    url = url.slice(0, at);
  }
  const git: NonNullable<ManifestDep['git']> = { url };
  if (ref) git.ref = ref;
  if (path) git.path = path;
  return { name: m[1], git };
}

// `k = "v"` pairs inside a TOML inline table.
function inlineTable(v: string): Record<string, string> | null {
  const m = /^\{(.*)\}$/.exec(v.trim());
  if (m === null) return null;
  const out: Record<string, string> = {};
  for (const p of m[1].matchAll(/([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^,}]+)/g)) out[p[1]] = unquote(p[2]);
  return out;
}

export function parsePyprojectDeps(text: string): ManifestScan {
  const out: ManifestScan = { deps: [], unparsed: [] };
  let table = '';
  let arrayKey: string | null = null;
  const pepSection = (): string | null =>
    table === 'project' && arrayKey === 'dependencies' ? 'project.dependencies'
      : table === 'project.optional-dependencies' && arrayKey !== null ? 'project.optional-dependencies' : null;
  const poetry = (): boolean =>
    /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/.test(table);
  const takeStrings = (s: string): void => {
    const section = pepSection();
    if (section === null) return;
    for (const q of s.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const d = pep508(q[1] ?? q[2]);
      if (d !== null) out.deps.push({ name: d.name, section, git: d.git });
    }
  };
  const closes = (s: string): boolean => s.replace(/"[^"]*"|'[^']*'/g, '').includes(']');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '') continue;
    if (arrayKey !== null) {
      takeStrings(line);
      if (closes(line)) arrayKey = null;
      continue;
    }
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t !== null) {
      table = t[1].trim();
      arrayKey = null;
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const [, key, value] = kv;
    if (value.startsWith('[')) {
      arrayKey = key;
      takeStrings(value);
      if (closes(value.slice(1))) arrayKey = null;
      continue;
    }
    if (!poetry()) continue;
    const it = inlineTable(value);
    if (it === null) continue;
    if ('git' in it) {
      if (it.git === '') {
        out.unparsed.push({ name: key, reason: NO_URL });
        continue;
      }
      const g: ManifestDep['git'] = { url: it.git };
      const ref = it.rev ?? it.tag ?? it.branch;
      if (ref) g.ref = ref;
      if (it.subdirectory) g.path = it.subdirectory;
      out.deps.push({ name: key, section: table, git: g });
    } else if (it.path) {
      out.deps.push({ name: key, section: table, path: it.path });
    }
  }
  return out;
}
