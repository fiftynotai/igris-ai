/**
 * init verb tests — M1.13.
 *
 * Uses --from-source exclusively for hermetic runs (no network, no
 * mocks needed at the verb level). Real fs against tmp; real
 * better-sqlite3; HOME + IGRIS_BRAIN_DIR overrides isolate the brain.
 *
 * The "byte-for-byte preservation" test (M1.10 critical gate) lives
 * here. It stages a v7 install, modifies USER.md / config.json /
 * knowledge.db with deterministic bytes, runs --upgrade, and asserts
 * the bytes are identical post-swap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let brainRoot: string;
let homeOverride: string;
let pathOverride: string;
let sourceRepo: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "igris-init-test-"));
  brainRoot = join(workDir, "brain");
  homeOverride = join(workDir, "home");
  pathOverride = join(workDir, "bin");
  sourceRepo = join(workDir, "source-repo");
  mkdirSync(homeOverride, { recursive: true });
  mkdirSync(pathOverride, { recursive: true });
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.HOME = process.env.HOME;
  envBackup.PATH = process.env.PATH;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  process.env.HOME = homeOverride;
  // TD-252: start from the refuse-default so a host-env override can't leak in.
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  // Empty PATH so cli-detect finds nothing (no bridges to materialize).
  process.env.PATH = pathOverride;
  // Stage a from-source repo with a minimal core/.
  stageSourceRepo(sourceRepo);
  // Reset registry handle so previous test's brainRoot doesn't leak.
  const reg = await import("../lib/registry.js");
  reg.closeDb();
});

afterEach(async () => {
  const reg = await import("../lib/registry.js");
  reg.closeDb();
  rmSync(workDir, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  process.env.HOME = envBackup.HOME;
  process.env.PATH = envBackup.PATH;
  if (envBackup.IGRIS_ALLOW_INSECURE_SYNC === undefined) {
    delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  } else {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = envBackup.IGRIS_ALLOW_INSECURE_SYNC;
  }
});

function stageSourceRepo(root: string): void {
  const core = join(root, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.md"), "# soul (from-source)\n");
  mkdirSync(join(core, "agents"), { recursive: true });
  writeFileSync(join(core, "agents", "manifest.yaml"), "agents: []\n");
  // FR-187: the layered core/os/ set replaces the retired universal rule.
  mkdirSync(join(core, "os"), { recursive: true });
  writeFileSync(join(core, "os", "INDEX.md"), "# Igris OS — Module Index\n");
  writeFileSync(join(core, "os", "standards.md"), "# Universal Standards\n");
  mkdirSync(join(core, "skills", "demo"), { recursive: true });
  writeFileSync(join(core, "skills", "demo", "SKILL.md"), "# demo\n");
  mkdirSync(join(core, "hooks"), { recursive: true });
  writeFileSync(
    join(core, "hooks", "canonical-settings.json"),
    JSON.stringify({ hooks: {} }, null, 2) + "\n",
  );
  mkdirSync(join(core, "scripts"), { recursive: true });
  writeFileSync(
    join(core, "scripts", "verify_mirror.sh"),
    "#!/bin/sh\necho noop\n",
  );
  chmodSync(join(core, "scripts", "verify_mirror.sh"), 0o755);
}

describe("init — fresh install via --from-source", () => {
  it("creates brain dir tree, core/, knowledge.db, USER.md, config.json, .install-source.json", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({ fromSource: sourceRepo, cliVersion: "7.0.0" });
    expect(code).toBe(0);

    // Directory tree
    expect(existsSync(join(brainRoot, "memory"))).toBe(true);
    expect(existsSync(join(brainRoot, "projects"))).toBe(true);
    expect(existsSync(join(brainRoot, "logs"))).toBe(true);
    expect(existsSync(join(brainRoot, ".cache"))).toBe(true);

    // Core content arrived
    expect(existsSync(join(brainRoot, "core", "SOUL.md"))).toBe(true);
    expect(
      readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8"),
    ).toBe("# soul (from-source)\n");
    expect(
      existsSync(
        join(brainRoot, "core", "skills", "demo", "SKILL.md"),
      ),
    ).toBe(true);

    // DB created
    expect(existsSync(join(brainRoot, "memory", "knowledge.db"))).toBe(true);

    // Templates
    expect(existsSync(join(brainRoot, "USER.md"))).toBe(true);
    expect(existsSync(join(brainRoot, "config.json"))).toBe(true);

    // Install source
    expect(existsSync(join(brainRoot, ".install-source.json"))).toBe(true);
    const isj = JSON.parse(
      readFileSync(join(brainRoot, ".install-source.json"), "utf-8"),
    ) as { source: string; ref: string };
    expect(isj.source).toBe("from-source");
  });

  it("config.json substitutes IGRIS_VERSION + INSTALL_DATE; remote_brain is null when prompts are skipped (TD-144)", async () => {
    const { runInit } = await import("../verbs/init.js");
    // Post-TD-144: with no TTY and no flags, the prompt module auto-skips
    // and remote_brain is null (the legacy placeholder shape is gone —
    // a fresh install either has user-supplied values or null, never an
    // unresolved placeholder).
    await runInit({ fromSource: sourceRepo, cliVersion: "9.9.9", yes: true });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as {
      version: string;
      subconscious?: unknown;
      cognition: { subconscious: { enabled: boolean } };
      remote_brain: unknown;
    };
    expect(cfg.version).toBe("9.9.9");
    // FR-191: the legacy top-level `subconscious` block is GONE — the canonical
    // key is nested under `cognition.subconscious`.
    expect(cfg.subconscious).toBeUndefined();
    expect(cfg.cognition.subconscious.enabled).toBe(false);
    expect(cfg.remote_brain).toBe(null);
  });

  it("config.json renders the FR-118 llm_extractor + cognition.{perception,subconscious} sections (FR-191: both OFF, no top-level subconscious)", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo, cliVersion: "9.9.9", yes: true });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as {
      subconscious?: unknown;
      llm_extractor: { harness: string; fallback_order: string[] };
      cognition: {
        perception: { enabled: boolean };
        subconscious: {
          enabled: boolean;
          llm_timeout_ms: number;
          llm_daily_budget: number;
          min_digest_bytes: number;
          harness: string | null;
        };
      };
    };
    // FR-191: the legacy top-level `subconscious` block was removed from the
    // template; the canonical key lives under `cognition.subconscious`.
    expect(cfg.subconscious).toBeUndefined();
    // Global llm_extractor harness default + fallback order.
    expect(cfg.llm_extractor.harness).toBe("claude");
    expect(cfg.llm_extractor.fallback_order).toEqual(["claude", "codex", "gemini"]);
    // cognition.subconscious mirrors the resolver's pick() keys; stays disabled.
    expect(cfg.cognition.subconscious.enabled).toBe(false);
    expect(cfg.cognition.subconscious.llm_daily_budget).toBe(8);
    expect(cfg.cognition.subconscious.harness).toBe(null);
    // FR-191 door: perception defaults OFF (was true).
    expect(cfg.cognition.perception.enabled).toBe(false);
  });

  it("writes NO global ~/.claude/CLAUDE.md (FR-191 — global render retired)", async () => {
    const { runInit } = await import("../verbs/init.js");
    expect(
      await runInit({ fromSource: sourceRepo, cliVersion: "7.0.0", yes: true }),
    ).toBe(0);
    // HOME is sandboxed to homeOverride; the global render step (9b) was
    // removed, so no global CLAUDE.md should be materialized.
    expect(existsSync(join(homeOverride, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("--skip-remote sets config.remote_brain to null", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo, skipRemote: true });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("--cli-bridge=none keeps cli_targets empty even if detection had hits", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo, cliBridge: "none" });
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { cli_targets: Record<string, true> };
    expect(Object.keys(cfg.cli_targets).length).toBe(0);
  });

  // FR-169: init wires igris-brain into ALL harness configs (not just Claude).
  // FR-179 added antigravity as the 5th (~/.gemini/config/mcp_config.json).
  it("registers igris-brain into all 5 harness configs (FR-169 + FR-179)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { bundledMcpEntryPath } = await import("../lib/paths.js");
    const code = await runInit({ fromSource: sourceRepo });
    expect(code).toBe(0);

    const bundled = bundledMcpEntryPath();

    // Claude — ~/.claude.json mcpServers.igris-brain.
    const claude = JSON.parse(
      readFileSync(join(homeOverride, ".claude.json"), "utf-8"),
    ) as { mcpServers: Record<string, { args: string[] }> };
    expect(claude.mcpServers["igris-brain"]).toBeDefined();
    expect(claude.mcpServers["igris-brain"].args[0]).toBe(bundled);
    // The projected path must NOT be a hardcoded checkout-literal — it is
    // resolved per-machine from bundledMcpEntryPath() (bundled layout).
    expect(claude.mcpServers["igris-brain"].args[0]).toContain(
      join("dist", "brain-mcp-server", "dist", "index.js"),
    );

    // Gemini — ~/.gemini/settings.json mcpServers.igris-brain.
    const gemini = JSON.parse(
      readFileSync(join(homeOverride, ".gemini", "settings.json"), "utf-8"),
    ) as { mcpServers: Record<string, { args: string[] }> };
    expect(gemini.mcpServers["igris-brain"]).toBeDefined();
    expect(gemini.mcpServers["igris-brain"].args[0]).toBe(bundled);

    // OpenCode — ~/.config/opencode/opencode.json mcp.igris-brain.
    const opencode = JSON.parse(
      readFileSync(
        join(homeOverride, ".config", "opencode", "opencode.json"),
        "utf-8",
      ),
    ) as { mcp: Record<string, { command: string[] }> };
    expect(opencode.mcp["igris-brain"]).toBeDefined();
    expect(opencode.mcp["igris-brain"].command[1]).toBe(bundled);

    // Codex — ~/.codex/config.toml [mcp_servers.igris-brain].
    const codexText = readFileSync(
      join(homeOverride, ".codex", "config.toml"),
      "utf-8",
    );
    expect(codexText).toContain("[mcp_servers.igris-brain]");
    expect(codexText).toContain(bundled);

    // FR-179: Antigravity — ~/.gemini/config/mcp_config.json mcpServers.igris-brain.
    // DISTINCT file from gemini's settings.json; gemini-IDENTICAL entry shape.
    const antigravity = JSON.parse(
      readFileSync(
        join(homeOverride, ".gemini", "config", "mcp_config.json"),
        "utf-8",
      ),
    ) as { mcpServers: Record<string, { args: string[] }> };
    expect(antigravity.mcpServers["igris-brain"]).toBeDefined();
    expect(antigravity.mcpServers["igris-brain"].args[0]).toBe(bundled);
    // Same bytes as gemini's entry (only the file differs).
    expect(antigravity.mcpServers["igris-brain"]).toEqual(
      gemini.mcpServers["igris-brain"],
    );
  });
});

// TD-220: init hardens the Igris-owned secret files to mode 600. config.json
// is always tightened (created-or-preserved); secrets.env is tightened ONLY
// if it already exists (never fabricated — Decision 3). Real fs + real chmod;
// `statSync(p).mode & 0o777` is the assertion idiom.
describe("init — secret-file perms hardening (TD-220)", () => {
  it("T6: fresh --from-source init writes config.json at mode 600", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { configJsonPath } = await import("../lib/paths.js");
    const code = await runInit({ fromSource: sourceRepo, cliVersion: "7.0.0" });
    expect(code).toBe(0);
    expect(statSync(configJsonPath()).mode & 0o777).toBe(0o600);
  });

  it("T7: pre-existing config.json at 644 is tightened to 600 on --upgrade AND preserved byte-for-byte", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { configJsonPath } = await import("../lib/paths.js");
    // Fresh init, then loosen config.json to 644 with deterministic bytes.
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);
    const cfg = configJsonPath();
    const cfgBytes = Buffer.from(
      JSON.stringify(
        {
          version: "7.0.0",
          subconscious: { enabled: true },
          remote_brain: { url: "https://example.com", api_key: "secret" },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(cfg, cfgBytes);
    chmodSync(cfg, 0o644);
    expect(statSync(cfg).mode & 0o777).toBe(0o644);

    // --upgrade: chmod is a metadata change → does NOT trip verifyPreservation.
    const code = await runInit({ fromSource: sourceRepo, upgrade: true });
    expect(code).toBe(0);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    // Content preserved byte-for-byte (chmod is metadata-only).
    expect(readFileSync(cfg).equals(cfgBytes)).toBe(true);
  });

  it("T8: a pre-existing secrets.env at 644 is tightened to 600", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { secretsEnvPath } = await import("../lib/paths.js");
    // The brain root must exist for secrets.env to be staged at the right path.
    // Run a fresh init first, then stage secrets.env loose and re-run --upgrade.
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);
    const sec = secretsEnvPath();
    writeFileSync(sec, "export FOO=bar\n");
    chmodSync(sec, 0o644);
    expect(statSync(sec).mode & 0o777).toBe(0o644);

    const code = await runInit({ fromSource: sourceRepo, upgrade: true });
    expect(code).toBe(0);
    expect(statSync(sec).mode & 0o777).toBe(0o600);
  });

  it("T9: secrets.env is NOT fabricated when absent (Decision 3)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { secretsEnvPath } = await import("../lib/paths.js");
    const code = await runInit({ fromSource: sourceRepo });
    expect(code).toBe(0);
    expect(existsSync(secretsEnvPath())).toBe(false);
  });
});

describe("init — --upgrade preservation (CRITICAL gate for M1.10)", () => {
  it("preserves knowledge.db, USER.md, config.json byte-for-byte across upgrade", async () => {
    const { runInit } = await import("../verbs/init.js");
    // First, do a fresh init to set up brain.
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);

    // Replace USER.md and config.json with deterministic test content.
    const userBytes = Buffer.from("user-md test content\nline 2\n");
    const cfgBytes = Buffer.from(
      JSON.stringify(
        {
          version: "7.0.0",
          installed_at: "2026-01-01T00:00:00Z",
          subconscious: { enabled: true }, // user changed default
          cli_targets: { claude: true, codex: true },
          remote_brain: { url: "https://example.com", api_key: "secret" },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(brainRoot, "USER.md"), userBytes);
    writeFileSync(join(brainRoot, "config.json"), cfgBytes);

    // Mutate the DB (insert a row to give it non-trivial bytes).
    const reg = await import("../lib/registry.js");
    reg.upsertProject({
      slug: "test-project",
      name: "test-project",
      path: "/tmp/foo",
      tech_stack: "go",
      igris_version: "7.0.0",
    });
    reg.closeDb();
    const dbBytes = readFileSync(join(brainRoot, "memory", "knowledge.db"));

    // Modify source to ensure the swap is non-trivial.
    writeFileSync(
      join(sourceRepo, "core", "SOUL.md"),
      "# soul (upgraded version)\n",
    );

    // Run --upgrade.
    const code = await runInit({
      fromSource: sourceRepo,
      upgrade: true,
    });
    expect(code).toBe(0);

    // Verify all three user-state files are byte-identical.
    expect(readFileSync(join(brainRoot, "USER.md")).equals(userBytes)).toBe(
      true,
    );
    expect(readFileSync(join(brainRoot, "config.json")).equals(cfgBytes)).toBe(
      true,
    );
    expect(readFileSync(join(brainRoot, "memory", "knowledge.db")).equals(dbBytes)).toBe(
      true,
    );

    // Core itself was upgraded.
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      "# soul (upgraded version)\n",
    );
  });

  it("--upgrade also creates a core.bak.<ts>/ next to core/", async () => {
    const { runInit } = await import("../verbs/init.js");
    await runInit({ fromSource: sourceRepo });
    await runInit({ fromSource: sourceRepo, upgrade: true });
    const baks = require("node:fs")
      .readdirSync(brainRoot)
      .filter((e: string) => e.startsWith("core.bak."));
    expect(baks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("init — error paths", () => {
  it("errors when --upgrade is passed but no existing install", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({ fromSource: sourceRepo, upgrade: true });
    expect(code).toBe(1);
  });

  it("errors when an existing v7 install is present without --upgrade", async () => {
    const { runInit } = await import("../verbs/init.js");
    expect(await runInit({ fromSource: sourceRepo })).toBe(0);
    expect(await runInit({ fromSource: sourceRepo })).toBe(1);
  });

  it("errors when --from-source path's core/ is missing", async () => {
    const { runInit } = await import("../verbs/init.js");
    const empty = join(workDir, "empty-repo");
    mkdirSync(empty, { recursive: true });
    const code = await runInit({ fromSource: empty });
    expect(code).toBe(1);
  });
});

describe("init — interactive prompts (TD-144)", () => {
  // All cases use the injectable PromptFn seam plus the isTTY override
  // (both exposed via InitOptions). No process.stdin monkey-patching.
  //
  // Helper to build a queue-backed fake prompt. Throws if the queue is
  // exhausted — that's a test-side bug (prompts asked more questions
  // than the test was prepared for) and we want it loud, not silent.
  function queuedPrompt(
    answers: string[],
  ): { ask: (q: string) => Promise<string>; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      ask: async (q: string): Promise<string> => {
        calls.push(q);
        if (i >= answers.length) {
          throw new Error(
            `queuedPrompt exhausted at question ${i}: ${q}`,
          );
        }
        return answers[i++]!;
      },
    };
  }

  it("captures name + email and writes them into USER.md (remote skipped)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt(["Alice", "alice@example.com", ""]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    // Three prompts fired: name, email, remote URL (which was empty).
    expect(calls.length).toBe(3);
    const userMd = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    expect(userMd).toContain("name: Alice");
    expect(userMd).toContain("email: alice@example.com");
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("captures remote_brain URL + api_key into config.json", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt([
      "Alice",
      "alice@example.com",
      "https://brain.example/",
      "secret-key",
    ]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(4);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: { url: string; api_key: string } | null };
    expect(cfg.remote_brain).toEqual({
      url: "https://brain.example/",
      api_key: "secret-key",
    });
  });

  it("TD-252: remote-http URL, no override → NOT persisted (remote_brain: null), api_key never asked", async () => {
    const { runInit } = await import("../verbs/init.js");
    // name, email, remote-http URL. The api_key prompt must NEVER fire because
    // the URL is rejected before it is reached (the queue has only 3 answers,
    // so a 4th prompt would throw "queuedPrompt exhausted").
    const { ask, calls } = queuedPrompt([
      "Dan",
      "dan@example.com",
      "http://vps.example.invalid:3001",
    ]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    // Exactly 3 prompts: name, email, URL. No api_key prompt.
    expect(calls.length).toBe(3);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    // The insecure URL was NOT saved.
    expect(cfg.remote_brain).toBe(null);
  });

  it("TD-252: remote-http URL WITH override → persisted (api_key asked)", async () => {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = "1";
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt([
      "Eve",
      "eve@example.com",
      "http://vps.example.invalid:3001",
      "secret-key",
    ]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    // 4 prompts: the override allows the insecure URL → api_key is asked.
    expect(calls.length).toBe(4);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: { url: string; api_key: string } | null };
    expect(cfg.remote_brain).toEqual({
      url: "http://vps.example.invalid:3001",
      api_key: "secret-key",
    });
  });

  it("TD-252: localhost-http URL is accepted (saved) with no override", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt([
      "Fay",
      "fay@example.com",
      "http://127.0.0.1:3001",
      "secret-key",
    ]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(4);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: { url: string; api_key: string } | null };
    expect(cfg.remote_brain).toEqual({
      url: "http://127.0.0.1:3001",
      api_key: "secret-key",
    });
  });

  // B2 (TD-153): the remote-brain URL prompt validates with `new URL()` and
  // re-prompts (bounded) on a non-URL. A valid URL is accepted; a bad-then-good
  // sequence re-prompts; blank still skips; exhausting the budget bails cleanly
  // and never persists a non-URL into config.json.
  it("B2: a valid https URL is accepted on the first try", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt([
      "Gus",
      "gus@example.com",
      "https://brain.valid.example/",
      "key-x",
    ]);
    const code = await runInit({ fromSource: sourceRepo, isTTY: true, prompt: ask });
    expect(code).toBe(0);
    // name, email, URL (valid first try), api_key — exactly 4 prompts.
    expect(calls.length).toBe(4);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: { url: string; api_key: string } | null };
    expect(cfg.remote_brain).toEqual({
      url: "https://brain.valid.example/",
      api_key: "key-x",
    });
  });

  it("B2: an invalid URL re-prompts, then accepts the valid retry", async () => {
    const { runInit } = await import("../verbs/init.js");
    // name, email, BAD url, GOOD url, api_key. The URL prompt fires TWICE.
    const { ask, calls } = queuedPrompt([
      "Hank",
      "hank@example.com",
      "not a url",
      "https://brain.retry.example/",
      "key-y",
    ]);
    const code = await runInit({ fromSource: sourceRepo, isTTY: true, prompt: ask });
    expect(code).toBe(0);
    // 5 prompts total: the URL label was asked twice (re-prompt on the bad one).
    expect(calls.length).toBe(5);
    const urlPrompts = calls.filter((q) => q.includes("Remote brain URL"));
    expect(urlPrompts.length).toBe(2);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: { url: string; api_key: string } | null };
    expect(cfg.remote_brain).toEqual({
      url: "https://brain.retry.example/",
      api_key: "key-y",
    });
  });

  it("B2: a blank URL still skips remote (no validation, remote_brain: null)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt(["Ida", "ida@example.com", ""]);
    const code = await runInit({ fromSource: sourceRepo, isTTY: true, prompt: ask });
    expect(code).toBe(0);
    // name, email, blank URL — 3 prompts, NO api_key (blank short-circuits).
    expect(calls.length).toBe(3);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("B2: invalid URL past max attempts bails cleanly (remote_brain: null, api_key never asked)", async () => {
    const { runInit } = await import("../verbs/init.js");
    // name, email, then 3 bad URLs (the max). After the budget is exhausted the
    // api_key is NEVER asked — the queue has exactly 5 answers, so a 6th prompt
    // would throw "queuedPrompt exhausted".
    const { ask, calls } = queuedPrompt([
      "Jay",
      "jay@example.com",
      "bad-1",
      "://still-bad",
      "nope nope",
    ]);
    const code = await runInit({ fromSource: sourceRepo, isTTY: true, prompt: ask });
    expect(code).toBe(0);
    // 5 prompts: name, email, and the URL asked 3 times. No api_key prompt.
    expect(calls.length).toBe(5);
    const urlPrompts = calls.filter((q) => q.includes("Remote brain URL"));
    expect(urlPrompts.length).toBe(3);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    // Bailed with the brain unchanged → still null (the fresh-install seed).
    expect(cfg.remote_brain).toBe(null);
  });

  // B1 (TD-153): the api_key read is masked on a real interactive TTY. When the
  // terminal reports NON-TTY (the injected `isTTY: false` seam), the masked
  // reader falls back to the visible path with NO crash. Here we keep isTTY
  // false but still inject a prompt; gatherInitInputs short-circuits to defaults
  // on non-TTY (remote_brain: null) and never touches real raw-mode — proving
  // the masking path is inert under non-TTY.
  it("B1: non-TTY terminal falls back to the visible path without crashing", async () => {
    const { runInit } = await import("../verbs/init.js");
    const sentinel = async (_q: string): Promise<string> => {
      throw new Error("prompt should not have been called under non-TTY");
    };
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: false,
      prompt: sentinel,
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("URL provided, empty api_key → api_key: null (warns but proceeds)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask } = queuedPrompt([
      "Bob",
      "bob@example.com",
      "https://brain.example/",
      "",
    ]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: { url: string; api_key: string | null } | null };
    expect(cfg.remote_brain).toEqual({
      url: "https://brain.example/",
      api_key: null,
    });
  });

  it("--yes skips ALL prompts even with TTY (no prompt fn ever called)", async () => {
    const { runInit } = await import("../verbs/init.js");
    // Sentinel that throws if called — proves --yes short-circuits before
    // the prompt loop.
    const sentinel = async (_q: string): Promise<string> => {
      throw new Error("prompt should not have been called under --yes");
    };
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      yes: true,
      prompt: sentinel,
    });
    expect(code).toBe(0);
    const userMd = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    // Default identity baked in.
    expect(userMd).toContain("name: you");
    // B4 (TD-153): prove the email line was actually SUBSTITUTED, not just that
    // the bare `email:` label (which ships in the template) survived. The old
    // `toContain("email: ")` passed even on a broken substitution. Under --yes
    // the default email is "" so the substituted line is exactly `- email: `
    // with NOTHING after — assert that exact line AND that the placeholder is
    // gone (a broken substitution would leave `{{USER_EMAIL}}`).
    expect(userMd).toMatch(/^- email: *$/m);
    expect(userMd).not.toContain("{{USER_EMAIL}}");
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("--skip-remote prompts identity only, never asks about remote", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { ask, calls } = queuedPrompt(["Carol", "carol@example.com"]);
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      skipRemote: true,
      prompt: ask,
    });
    expect(code).toBe(0);
    // Exactly 2 prompts: name + email. The remote URL prompt never fires.
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("name");
    expect(calls[1]).toContain("email");
    const userMd = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    expect(userMd).toContain("name: Carol");
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("non-TTY auto-skips prompts (curl|bash installer flow)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const sentinel = async (_q: string): Promise<string> => {
      throw new Error("prompt should not have been called under non-TTY");
    };
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: false,
      prompt: sentinel,
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(
      readFileSync(join(brainRoot, "config.json"), "utf-8"),
    ) as { remote_brain: unknown };
    expect(cfg.remote_brain).toBe(null);
  });

  it("--upgrade skips prompts even with TTY (preservation contract)", async () => {
    const { runInit } = await import("../verbs/init.js");
    // First, a fresh install with --yes to seed brain.
    expect(
      await runInit({ fromSource: sourceRepo, yes: true }),
    ).toBe(0);
    // Now upgrade with TTY=true and a throwing sentinel — must not prompt.
    const sentinel = async (_q: string): Promise<string> => {
      throw new Error("prompt should not have been called under --upgrade");
    };
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      upgrade: true,
      prompt: sentinel,
    });
    expect(code).toBe(0);
  });

  it("--dry-run skips prompts (side-effect-free contract)", async () => {
    const { runInit } = await import("../verbs/init.js");
    const sentinel = async (_q: string): Promise<string> => {
      throw new Error("prompt should not have been called under --dry-run");
    };
    const code = await runInit({
      fromSource: sourceRepo,
      isTTY: true,
      dryRun: true,
      prompt: sentinel,
    });
    expect(code).toBe(0);
    // No writes happened.
    expect(existsSync(join(brainRoot, "USER.md"))).toBe(false);
    expect(existsSync(join(brainRoot, "config.json"))).toBe(false);
  });
});

describe("init — --dry-run", () => {
  it("--dry-run on fresh init prints plan and writes nothing", async () => {
    const { runInit } = await import("../verbs/init.js");
    const code = await runInit({
      fromSource: sourceRepo,
      dryRun: true,
    });
    expect(code).toBe(0);
    // Brain root should NOT be populated (dry-run wrote nothing).
    expect(existsSync(join(brainRoot, "core"))).toBe(false);
    expect(existsSync(join(brainRoot, "USER.md"))).toBe(false);
    expect(existsSync(join(brainRoot, "config.json"))).toBe(false);
    expect(existsSync(join(brainRoot, ".install-source.json"))).toBe(false);
  });

  it("TD-142: --dry-run with --from-source shows 'copy:' not 'rename:' for core/ deposit", async () => {
    // The non-dry path uses copyFromSource(...) — a recursive copy that
    // preserves the source tree. The dry-run plan must render this as
    // `copy:` (TD-142 primitive), not the misleading `rename:` header
    // that was previously emitted by wouldRename.
    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runInit } = await import("../verbs/init.js");
      const code = await runInit({
        fromSource: sourceRepo,
        dryRun: true,
      });
      expect(code).toBe(0);
      const stdout = stdoutBuf.join("");
      // `copy:` block emitted with the from-source reason.
      expect(stdout).toContain("copy:");
      expect(stdout).toContain("from-source copy");
      // The core/ -> core/ line itself must appear under `copy:` (i.e.
      // the source path is the from-source repo's core/).
      expect(stdout).toContain(join(sourceRepo, "core"));
      // Misleading "rename:" header for the core deposit should NOT
      // appear with the from-source reason. (rename: as a header may
      // still appear elsewhere for upgrade promotions — we don't ban
      // the header globally, only the misleading core-from-source line.)
      const renameWithFromSource = stdout.match(
        /rename:[\s\S]*from-source copy/,
      );
      expect(renameWithFromSource).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // FR-179: the dry-run MCP-write list now has 5 entries (antigravity added).
  // The antigravity skills-symlink line appears ONLY when `agy` is detected as
  // a bridge target.
  it("FR-179: --dry-run lists the antigravity MCP write + skills symlink when agy is detected", async () => {
    // Stage `agy` on PATH + ~/.gemini so antigravity is an effective bridge.
    const agy = join(pathOverride, "agy");
    writeFileSync(agy, "#!/bin/sh\necho fake\n");
    chmodSync(agy, 0o755);
    mkdirSync(join(homeOverride, ".gemini"), { recursive: true });

    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    try {
      const { runInit } = await import("../verbs/init.js");
      const code = await runInit({ fromSource: sourceRepo, dryRun: true });
      expect(code).toBe(0);
      const stdout = stdoutBuf.join("");
      // 5th MCP write — antigravity's distinct config file.
      expect(stdout).toContain("register igris-brain MCP (Antigravity)");
      expect(stdout).toContain(
        join(".gemini", "config", "mcp_config.json"),
      );
      // The skills parent-symlink create line (gated on antigravity detection).
      expect(stdout).toContain("link antigravity skills -> ~/.agents/skills");
      expect(stdout).toContain(
        join(".gemini", "antigravity-cli", "skills"),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("FR-179: --dry-run does NOT list the skills symlink when agy is absent", async () => {
    // Default sandbox PATH is empty → antigravity not detected → no skills line.
    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    try {
      const { runInit } = await import("../verbs/init.js");
      const code = await runInit({ fromSource: sourceRepo, dryRun: true });
      expect(code).toBe(0);
      const stdout = stdoutBuf.join("");
      // The MCP write is UNCONDITIONAL (igris-brain is a core default).
      expect(stdout).toContain("register igris-brain MCP (Antigravity)");
      // The skills symlink line is gated on detection — absent here.
      expect(stdout).not.toContain("link antigravity skills");
    } finally {
      spy.mockRestore();
    }
  });
});

// FR-179 Phase C: a real install where `agy` is detected lands the skills
// parent symlink ~/.gemini/antigravity-cli/skills -> ~/.agents/skills.
describe("init — antigravity skills symlink (FR-179 Phase C)", () => {
  it("creates the skills parent symlink when agy is a bridge target", async () => {
    const { runInit } = await import("../verbs/init.js");
    const { lstatSync, readlinkSync } = await import("node:fs");

    // Stage `agy` on PATH + ~/.gemini so antigravity is detected.
    const agy = join(pathOverride, "agy");
    writeFileSync(agy, "#!/bin/sh\necho fake\n");
    chmodSync(agy, 0o755);
    mkdirSync(join(homeOverride, ".gemini"), { recursive: true });

    const code = await runInit({ fromSource: sourceRepo });
    expect(code).toBe(0);

    const linkPath = join(
      homeOverride,
      ".gemini",
      "antigravity-cli",
      "skills",
    );
    const target = join(homeOverride, ".agents", "skills");
    // The link exists, is a symlink, and points at the shared dir.
    const lst = lstatSync(linkPath);
    expect(lst.isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(target);
    // The target dir was created (mkdir -p) so the link is not dangling.
    expect(existsSync(target)).toBe(true);
  });

  it("does NOT create the skills symlink when agy is not detected", async () => {
    const { runInit } = await import("../verbs/init.js");
    // Default empty PATH → antigravity not a bridge target.
    const code = await runInit({ fromSource: sourceRepo });
    expect(code).toBe(0);
    const linkPath = join(
      homeOverride,
      ".gemini",
      "antigravity-cli",
      "skills",
    );
    expect(existsSync(linkPath)).toBe(false);
  });
});

// B1 (TD-153): the masked api_key reader must degrade gracefully. On a stream
// that is NOT a TTY (isTTY !== true) — CI, piped stdin, dumb terminals — it
// resolves via the supplied visible fallback rather than calling setRawMode
// (which would throw or corrupt a non-interactive shell). We drive
// `maskedSecretRead` directly with a fake stream so no real terminal is needed.
describe("maskedSecretRead — non-TTY fallback (B1)", () => {
  it("routes to the visible fallback (no raw-mode) when input is non-TTY", async () => {
    const { maskedSecretRead } = await import("../lib/init/prompts.js");

    let fallbackCalled = false;
    const visibleFallback = async (q: string): Promise<string> => {
      fallbackCalled = true;
      expect(q).toContain("API key");
      return "typed-key";
    };

    // A bare object standing in for a non-TTY stream: isTTY is undefined, and
    // setRawMode is present as a spy we assert is NEVER called on this path.
    let rawModeCalls = 0;
    const fakeIn = {
      isTTY: undefined,
      setRawMode: (_on: boolean): void => {
        rawModeCalls += 1;
      },
    } as unknown as NodeJS.ReadStream;
    const writes: string[] = [];
    const fakeOut = {
      write: (s: string): boolean => {
        writes.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const value = await maskedSecretRead(
      "Remote brain API key []: ",
      fakeIn,
      fakeOut,
      visibleFallback,
    );

    expect(value).toBe("typed-key");
    expect(fallbackCalled).toBe(true);
    // The masking path was never engaged — no raw-mode toggling, nothing painted.
    expect(rawModeCalls).toBe(0);
    expect(writes.length).toBe(0);
  });

  it("falls back when setRawMode throws even though isTTY is true", async () => {
    const { maskedSecretRead } = await import("../lib/init/prompts.js");

    let fallbackCalled = false;
    const visibleFallback = async (_q: string): Promise<string> => {
      fallbackCalled = true;
      return "fallback-key";
    };

    // isTTY=true but setRawMode throws (exotic/unsupported terminal).
    // `emitKeypressEvents` (called before the raw-mode try) probes
    // `listenerCount`, so the fake provides it.
    const fakeIn = {
      isTTY: true,
      setRawMode: (_on: boolean): void => {
        throw new Error("ENOTTY: cannot set raw mode");
      },
      isPaused: (): boolean => false,
      resume: (): void => {},
      pause: (): void => {},
      on: (): void => {},
      once: (): void => {},
      removeListener: (): void => {},
      listenerCount: (): number => 0,
    } as unknown as NodeJS.ReadStream;
    const fakeOut = {
      write: (_s: string): boolean => true,
    } as unknown as NodeJS.WriteStream;

    const value = await maskedSecretRead(
      "Remote brain API key []: ",
      fakeIn,
      fakeOut,
      visibleFallback,
    );

    expect(value).toBe("fallback-key");
    expect(fallbackCalled).toBe(true);
  });
});
