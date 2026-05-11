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
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  process.env.HOME = homeOverride;
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
});

function stageSourceRepo(root: string): void {
  const core = join(root, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.md"), "# soul (from-source)\n");
  mkdirSync(join(core, "agents"), { recursive: true });
  writeFileSync(join(core, "agents", "manifest.yaml"), "agents: []\n");
  mkdirSync(join(core, "rules"), { recursive: true });
  writeFileSync(
    join(core, "rules", "00-igris-universal.md"),
    "# universal\n",
  );
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
  mkdirSync(join(core, "templates"), { recursive: true });
  writeFileSync(
    join(core, "templates", "CLAUDE.md.tmpl"),
    "# CLAUDE template\n",
  );
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
      subconscious: { enabled: boolean };
      remote_brain: unknown;
    };
    expect(cfg.version).toBe("9.9.9");
    expect(cfg.subconscious.enabled).toBe(false);
    expect(cfg.remote_brain).toBe(null);
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
    expect(userMd).toContain("email: ");
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
});
