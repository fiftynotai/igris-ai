/**
 * FR-273 D6 — the narrow manifest scanners (plan §4.2 D9): each finds dependency
 * names plus their git / path entries and nothing else. A registry (version)
 * dependency is not a candidate; a git/path shape the scanner cannot read is
 * reported in `unparsed[]`, never guessed.
 *
 * @module engine/components/projects/__tests__/manifest-parse.test
 */

import { describe, it, expect } from 'vitest';
import { parsePubspecDeps, parsePackageJsonDeps, parsePyprojectDeps } from '../relations/manifest-parse.js';

describe('parsePubspecDeps', () => {
  it('reads git maps, scalar git urls and path deps from the three dependency blocks', () => {
    const r = parsePubspecDeps(`name: moca_agent_web
version: 1.0.0+1
environment:
  sdk: ">=3.0.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0 # a registry dep
  moca_agent_client_ui:
    git:
      url: git@github.com:KalvadTech/moca-agent-flutter-client.git
      ref: v2.0.0
      path: moca_agent_client_ui
  shared_ui:
    path: ../shared_ui

dev_dependencies:
  lints:
    git: "https://github.com/acme/lints.git"

dependency_overrides:
  weird:
    git:
      ref: main

flutter:
  uses-material-design: true
`);
    expect(r.deps).toEqual([
      { name: 'moca_agent_client_ui', section: 'dependencies', git: { url: 'git@github.com:KalvadTech/moca-agent-flutter-client.git', ref: 'v2.0.0', path: 'moca_agent_client_ui' } },
      { name: 'shared_ui', section: 'dependencies', path: '../shared_ui' },
      { name: 'lints', section: 'dev_dependencies', git: { url: 'https://github.com/acme/lints.git' } },
    ]);
    expect(r.unparsed).toEqual([{ name: 'weird', reason: 'git entry without a url' }]);
  });

  it('an inline flow map is unparsed, not guessed', () => {
    const r = parsePubspecDeps('dependencies:\n  x: {git: {url: "https://github.com/a/b"}}\n');
    expect(r.deps).toEqual([]);
    expect(r.unparsed).toEqual([{ name: 'x', reason: 'inline map not supported' }]);
  });
});

describe('parsePackageJsonDeps', () => {
  it('reads git+https, git+ssh, github:, o/r shorthand and file: from every dependency section', () => {
    const r = parsePackageJsonDeps(JSON.stringify({
      name: 'web',
      dependencies: {
        react: '^18.0.0',
        a: 'git+https://github.com/acme/a.git#v1.2.0',
        b: 'git+ssh://git@github.com/acme/b.git',
        c: 'github:acme/c#main',
        d: 'acme/d',
        e: 'file:../e',
        f: 'workspace:*',
      },
      devDependencies: { g: 'git://github.com/acme/g.git' },
    }));
    expect(r.deps).toEqual([
      { name: 'a', section: 'dependencies', git: { url: 'git+https://github.com/acme/a.git', ref: 'v1.2.0' } },
      { name: 'b', section: 'dependencies', git: { url: 'git+ssh://git@github.com/acme/b.git' } },
      { name: 'c', section: 'dependencies', git: { url: 'github:acme/c', ref: 'main' } },
      { name: 'd', section: 'dependencies', git: { url: 'acme/d' } },
      { name: 'e', section: 'dependencies', path: '../e' },
      { name: 'g', section: 'devDependencies', git: { url: 'git://github.com/acme/g.git' } },
    ]);
    expect(r.unparsed).toEqual([]);
  });

  it('malformed JSON is one unparsed entry', () => {
    expect(parsePackageJsonDeps('{ nope').unparsed).toEqual([{ name: 'package.json', reason: 'not valid JSON' }]);
  });
});

describe('parsePyprojectDeps', () => {
  it('reads PEP 621 direct references and Poetry git/path tables', () => {
    const r = parsePyprojectDeps(`[project]
name = "svc"
dependencies = [
  "requests>=2",
  "client @ git+https://github.com/acme/client.git@v3.1",
  'sdk @ git+ssh://git@github.com/acme/sdk.git',
]

[project.optional-dependencies]
dev = ["tool @ git+https://github.com/acme/tool@main"]

[tool.poetry.dependencies]
python = "^3.11"
lib = { git = "https://github.com/acme/lib.git", tag = "v1" }
local = { path = "../local", develop = true }
odd = { git = "https://github.com/acme/odd.git", rev = "abc", subdirectory = 'pkg' }

[tool.poetry.group.dev.dependencies]
devlib = { git = "git@github.com:acme/devlib.git", branch = "dev" }
`);
    expect(r.deps).toEqual([
      { name: 'client', section: 'project.dependencies', git: { url: 'git+https://github.com/acme/client.git', ref: 'v3.1' } },
      { name: 'sdk', section: 'project.dependencies', git: { url: 'git+ssh://git@github.com/acme/sdk.git' } },
      { name: 'tool', section: 'project.optional-dependencies', git: { url: 'git+https://github.com/acme/tool', ref: 'main' } },
      { name: 'lib', section: 'tool.poetry.dependencies', git: { url: 'https://github.com/acme/lib.git', ref: 'v1' } },
      { name: 'local', section: 'tool.poetry.dependencies', path: '../local' },
      { name: 'odd', section: 'tool.poetry.dependencies', git: { url: 'https://github.com/acme/odd.git', ref: 'abc', path: 'pkg' } },
      { name: 'devlib', section: 'tool.poetry.group.dev.dependencies', git: { url: 'git@github.com:acme/devlib.git', ref: 'dev' } },
    ]);
    expect(r.unparsed).toEqual([]);
  });

  it('a git table without a url is unparsed', () => {
    const r = parsePyprojectDeps('[tool.poetry.dependencies]\nx = { git = "" }\n');
    expect(r.unparsed).toEqual([{ name: 'x', reason: 'git entry without a url' }]);
  });
});
