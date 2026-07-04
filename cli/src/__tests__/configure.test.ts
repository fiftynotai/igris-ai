/**
 * configure.test.ts — FR-122 `igris configure` onboarding verb.
 *
 * Real handlers against a sandboxed IGRIS_BRAIN_DIR + HOME. No mocks of the SUT
 * (L-159 / mistake #159): the verb, the prompt gatherer, the config writers, and
 * the persona applier all run for real. The interactive prompts are driven by an
 * injectable PromptFn queue (the `doctor.ts`/`prompts.ts` test seam), never by
 * monkey-patching the module under test.
 *
 * Coverage (plan §3):
 *   - round-trip + idempotence
 *   - VPS set by address / clear by blank / refuse non-local http
 *   - perception/subconscious toggles write the NESTED key (no top-level block)
 *   - --yes preserves current values (no-op)
 *   - persona selection (byte-for-byte copy + frontmatter present + bogus →
 *     template_missing), init --persona
 *   - no-config error, dry-run writes nothing
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
const envBackup: Record<string, string | undefined> = {};

const CHARACTER_SOUL = `---
layer: identity
tier: boot
scope: orchestrator
summary: The OS persona — name, voice, traits. Customizable; reskin freely.
---

# SOUL — Persona

## Persona

- **Name:** Igris
- **Voice:** battle-ready, evolution-style.
`;

const PROFESSIONAL_SOUL = `---
layer: identity
tier: boot
scope: orchestrator
summary: The OS persona — name, voice, traits. Customizable; reskin freely.
---

# SOUL — Persona

## Persona

- **Name:** Igris
- **Voice:** dry, neutral, professional.
`;

const FRONTMATTERLESS_SOUL = `# SOUL — Persona

No frontmatter here — this should be refused.
`;

/** Stage a runtime brain core with the two SOUL persona templates + active SOUL.md. */
function stageBrainCore(opts?: { soul?: string }): void {
  const core = join(brainRoot, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.character.md"), CHARACTER_SOUL);
  writeFileSync(join(core, "SOUL.professional.md"), PROFESSIONAL_SOUL);
  // Active SOUL.md defaults to the character template (the shipped default).
  writeFileSync(join(core, "SOUL.md"), opts?.soul ?? CHARACTER_SOUL);
}

/** Write a config.json with the given content. */
function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(brainRoot, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

/** Read config.json back. */
function readCfg(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(brainRoot, "config.json"), "utf-8"),
  ) as Record<string, unknown>;
}

/** A minimal baseline config.json (post-init shape). */
function baselineConfig(): Record<string, unknown> {
  return {
    version: "7.0.0",
    cognition: {
      perception: { enabled: false },
      subconscious: { enabled: false, llm_timeout_ms: 300000 },
    },
    remote_brain: null,
  };
}

/** Write a USER.md identity in the init-template shape. */
function writeUserMd(name: string, email: string): void {
  writeFileSync(
    join(brainRoot, "USER.md"),
    `# Igris USER\n\n## User identity\n\n- name: ${name}\n- email: ${email}\n`,
  );
}

/** Build a queue-backed PromptFn that returns the next answer per call. */
function queuePrompt(answers: string[]): (q: string) => Promise<string> {
  let i = 0;
  return (_q: string): Promise<string> => {
    const a = i < answers.length ? answers[i] : "";
    i += 1;
    return Promise.resolve(a);
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "igris-configure-test-"));
  brainRoot = join(workDir, "brain");
  homeOverride = join(workDir, "home");
  mkdirSync(brainRoot, { recursive: true });
  mkdirSync(homeOverride, { recursive: true });

  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.HOME = process.env.HOME;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  process.env.HOME = homeOverride;
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  process.env.HOME = envBackup.HOME;
  if (envBackup.IGRIS_ALLOW_INSECURE_SYNC === undefined) {
    delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  } else {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = envBackup.IGRIS_ALLOW_INSECURE_SYNC;
  }
});

describe("configure — preconditions", () => {
  it("errors when no config.json exists (run `igris init` first)", async () => {
    stageBrainCore();
    const { runConfigure } = await import("../verbs/configure.js");
    const code = await runConfigure({ yes: true });
    expect(code).toBe(1);
  });
});

describe("configure — round-trip + idempotence", () => {
  it("applies queued inputs, then a same-input re-run is idempotent", async () => {
    stageBrainCore();
    writeConfig(baselineConfig());
    writeUserMd("you", "");

    const { runConfigure } = await import("../verbs/configure.js");

    // Queue: name, email, persona, url, apiKey, perception y/n, subconscious y/n.
    const code1 = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "Alice",
        "alice@example.com",
        "professional",
        "https://brain.example.com",
        "key-123",
        "y",
        "n",
      ]),
    });
    expect(code1).toBe(0);

    // USER.md reflects identity.
    const userMd = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    expect(userMd).toContain("Alice");
    expect(userMd).toContain("alice@example.com");

    // config.json reflects remote_brain + nested cognition toggles.
    const cfg = readCfg() as {
      remote_brain?: { url?: string; api_key?: string };
      cognition?: {
        perception?: { enabled?: boolean };
        subconscious?: { enabled?: boolean };
      };
    };
    expect(cfg.remote_brain?.url).toBe("https://brain.example.com");
    expect(cfg.remote_brain?.api_key).toBe("key-123");
    expect(cfg.cognition?.perception?.enabled).toBe(true);
    expect(cfg.cognition?.subconscious?.enabled).toBe(false);

    // SOUL.md is byte-for-byte the professional template.
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      PROFESSIONAL_SOUL,
    );

    // Snapshot, then re-run with the SAME inputs → idempotent.
    const before = readFileSync(join(brainRoot, "config.json"), "utf-8");
    const code2 = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "Alice",
        "alice@example.com",
        "professional",
        "https://brain.example.com",
        "key-123",
        "y",
        "n",
      ]),
    });
    expect(code2).toBe(0);
    expect(readFileSync(join(brainRoot, "config.json"), "utf-8")).toBe(before);
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      PROFESSIONAL_SOUL,
    );
  });
});

describe("configure — VPS by address", () => {
  it("set by non-blank URL writes remote_brain {url, api_key} at mode 600", async () => {
    stageBrainCore();
    writeConfig(baselineConfig());
    const { runConfigure } = await import("../verbs/configure.js");

    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "you", // name
        "", // email
        "character", // persona
        "https://vps.example.com", // url
        "secret-key", // apiKey
        "n", // perception
        "n", // subconscious
      ]),
    });
    expect(code).toBe(0);

    const cfg = readCfg() as {
      remote_brain?: { url?: string; api_key?: string };
    };
    expect(cfg.remote_brain?.url).toBe("https://vps.example.com");
    expect(cfg.remote_brain?.api_key).toBe("secret-key");

    if (process.platform !== "win32") {
      const mode = statSync(join(brainRoot, "config.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("clear by blank URL removes the remote_brain key (VPS disabled)", async () => {
    stageBrainCore();
    writeConfig({
      ...baselineConfig(),
      remote_brain: { url: "https://old.example.com", api_key: "old-key" },
    });
    const { runConfigure } = await import("../verbs/configure.js");

    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "you", // name
        "", // email
        "character", // persona
        "", // url BLANK → disable
        "n", // perception
        "n", // subconscious
      ]),
    });
    expect(code).toBe(0);

    const cfg = readCfg();
    expect(
      Object.prototype.hasOwnProperty.call(cfg, "remote_brain"),
    ).toBe(false);
  });

  it("refuses a non-local http:// URL (TD-252); remote_brain unchanged", async () => {
    stageBrainCore();
    writeConfig(baselineConfig());
    const { runConfigure } = await import("../verbs/configure.js");

    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "you", // name
        "", // email
        "character", // persona
        "http://1.2.3.4:3001", // url — insecure, no override
        "n", // perception
        "n", // subconscious
      ]),
    });
    expect(code).toBe(0);

    // The prompt layer refuses the insecure URL and returns the seed (null), so
    // remote_brain stays absent/null — never persisted in cleartext-prone form.
    const cfg = readCfg() as { remote_brain?: unknown };
    expect(cfg.remote_brain == null).toBe(true);
  });
});

describe("configure — cognition toggles (nested keys only)", () => {
  it("perception ON writes cognition.perception.enabled=true and NO top-level block", async () => {
    stageBrainCore();
    writeConfig(baselineConfig());
    const { runConfigure } = await import("../verbs/configure.js");

    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "you",
        "",
        "character",
        "", // url blank → no VPS
        "y", // perception ON
        "n", // subconscious
      ]),
    });
    expect(code).toBe(0);

    const cfg = readCfg() as {
      perception?: unknown;
      cognition?: { perception?: { enabled?: boolean } };
    };
    expect(cfg.cognition?.perception?.enabled).toBe(true);
    expect(cfg.perception).toBeUndefined();
  });

  it("subconscious ON writes cognition.subconscious.enabled=true, preserves siblings, NO top-level block", async () => {
    stageBrainCore();
    writeConfig(baselineConfig());
    const { runConfigure } = await import("../verbs/configure.js");

    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "you",
        "",
        "character",
        "",
        "n", // perception
        "y", // subconscious ON
      ]),
    });
    expect(code).toBe(0);

    const cfg = readCfg() as {
      subconscious?: unknown;
      cognition?: {
        subconscious?: { enabled?: boolean; llm_timeout_ms?: number };
      };
    };
    expect(cfg.cognition?.subconscious?.enabled).toBe(true);
    // Sibling key preserved across the explicit toggle.
    expect(cfg.cognition?.subconscious?.llm_timeout_ms).toBe(300000);
    expect(cfg.subconscious).toBeUndefined();
  });

  it("perception OFF (from ON) writes cognition.perception.enabled=false", async () => {
    stageBrainCore();
    writeConfig({
      ...baselineConfig(),
      cognition: {
        perception: { enabled: true },
        subconscious: { enabled: false },
      },
    });
    const { runConfigure } = await import("../verbs/configure.js");

    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt(["you", "", "character", "", "n", "n"]),
    });
    expect(code).toBe(0);

    const cfg = readCfg() as {
      cognition?: { perception?: { enabled?: boolean } };
    };
    expect(cfg.cognition?.perception?.enabled).toBe(false);
  });
});

describe("configure — --yes preserves current values (no-op)", () => {
  it("seeds from live state and changes nothing", async () => {
    stageBrainCore({ soul: PROFESSIONAL_SOUL }); // active persona = professional
    writeConfig({
      ...baselineConfig(),
      cognition: {
        perception: { enabled: true },
        subconscious: { enabled: false },
      },
      remote_brain: { url: "https://kept.example.com", api_key: "kept-key" },
    });
    writeUserMd("Bob", "bob@example.com");

    const { runConfigure } = await import("../verbs/configure.js");
    const before = readFileSync(join(brainRoot, "config.json"), "utf-8");

    const code = await runConfigure({ yes: true });
    expect(code).toBe(0);

    // Nothing reset to a default.
    const cfg = readCfg() as {
      remote_brain?: { url?: string; api_key?: string };
      cognition?: { perception?: { enabled?: boolean } };
    };
    expect(cfg.remote_brain?.url).toBe("https://kept.example.com");
    expect(cfg.remote_brain?.api_key).toBe("kept-key");
    expect(cfg.cognition?.perception?.enabled).toBe(true);

    // SOUL.md still the professional template (the active persona was seeded).
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      PROFESSIONAL_SOUL,
    );
    // USER.md identity preserved.
    const userMd = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    expect(userMd).toContain("Bob");
    expect(userMd).toContain("bob@example.com");
    // remote_brain block byte-stable (no value churn).
    expect(cfg.remote_brain?.url).toBe(
      (JSON.parse(before) as { remote_brain: { url: string } }).remote_brain.url,
    );
  });
});

describe("configure — persona selection", () => {
  it("--persona professional copies the template byte-for-byte with frontmatter", async () => {
    stageBrainCore(); // active = character
    writeConfig(baselineConfig());

    const { runConfigure } = await import("../verbs/configure.js");
    const code = await runConfigure({ yes: true, persona: "professional" });
    expect(code).toBe(0);

    const soul = readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8");
    expect(soul).toBe(PROFESSIONAL_SOUL);
    // Frontmatter present (so gen_os_index.sh stays valid).
    expect(soul.startsWith("---\n")).toBe(true);
    expect(soul).toContain("layer: identity");
    expect(soul).toContain("summary:");
  });

  it("--persona character switches back to the character template", async () => {
    stageBrainCore({ soul: PROFESSIONAL_SOUL }); // start on professional
    writeConfig(baselineConfig());

    const { runConfigure } = await import("../verbs/configure.js");
    const code = await runConfigure({ yes: true, persona: "character" });
    expect(code).toBe(0);

    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      CHARACTER_SOUL,
    );
  });

  it("--persona bogus → error, SOUL.md untouched (template_missing)", async () => {
    stageBrainCore({ soul: CHARACTER_SOUL });
    writeConfig(baselineConfig());

    const { runConfigure } = await import("../verbs/configure.js");
    const code = await runConfigure({ yes: true, persona: "bogus" });
    expect(code).toBe(1);

    // SOUL.md unchanged.
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      CHARACTER_SOUL,
    );
  });
});

describe("persona applier — frontmatter assertion", () => {
  it("refuses a frontmatter-less template (invalid_template), SOUL.md untouched", async () => {
    const core = join(brainRoot, "core");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, "SOUL.md"), CHARACTER_SOUL);
    writeFileSync(join(core, "SOUL.broken.md"), FRONTMATTERLESS_SOUL);

    const { applyPersona } = await import("../lib/persona.js");
    const result = applyPersona("broken", workDir);
    expect(result.outcome).toBe("invalid_template");
    // SOUL.md untouched.
    expect(readFileSync(join(core, "SOUL.md"), "utf-8")).toBe(CHARACTER_SOUL);
  });

  it("listPersonas enumerates templates but not the active SOUL.md", async () => {
    stageBrainCore();
    const { listPersonas } = await import("../lib/persona.js");
    expect(listPersonas().sort()).toEqual(["character", "professional"]);
  });
});

describe("configure — dry-run writes nothing", () => {
  it("prints the plan and performs no writes", async () => {
    stageBrainCore({ soul: CHARACTER_SOUL });
    writeConfig(baselineConfig());
    writeUserMd("you", "");

    const cfgBefore = readFileSync(join(brainRoot, "config.json"), "utf-8");
    const soulBefore = readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8");
    const userBefore = readFileSync(join(brainRoot, "USER.md"), "utf-8");

    const { runConfigure } = await import("../verbs/configure.js");
    const code = await runConfigure({
      dryRun: true,
      isTTY: true,
      prompt: queuePrompt([
        "Changed",
        "changed@example.com",
        "professional",
        "https://new.example.com",
        "new-key",
        "y",
        "y",
      ]),
    });
    expect(code).toBe(0);

    // Nothing changed on disk.
    expect(readFileSync(join(brainRoot, "config.json"), "utf-8")).toBe(
      cfgBefore,
    );
    expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
      soulBefore,
    );
    expect(readFileSync(join(brainRoot, "USER.md"), "utf-8")).toBe(userBefore);
  });
});

describe("USER.md prefs helpers (FR-235) — in-place parse + rewrite", () => {
  it("rewrites the 3 managed fields in place, preserving every other line + round-trips", async () => {
    // Rich, hand-authored USER.md with the shipped bold pref lines + unrelated
    // content that MUST survive the field rewrite.
    writeFileSync(
      join(brainRoot, "USER.md"),
      [
        "# Igris AI — User Configuration",
        "",
        "## Identity",
        "",
        "- **Name:** Fifty.ai",
        "- **Default Addressing:** Partner",
        "",
        "## Preferences",
        "",
        "- **Default Mask:** full",
        "- **Notification Style:** concise",
        "- **Auto-approve Plans:** S and M effort only (L/XL require approval)",
        "",
        "## Notes",
        "",
        "keep me verbatim",
        "",
      ].join("\n"),
    );

    const { readUserMdPrefs, writeUserMdPrefs } = await import(
      "../lib/user-md.js"
    );
    // Read parses the current values (tolerant of the bold markup).
    expect(readUserMdPrefs()).toEqual({
      addressing: "Partner",
      notificationStyle: "concise",
      autoApprove: "S and M effort only (L/XL require approval)",
    });

    writeUserMdPrefs({
      addressing: "Boss",
      notificationStyle: "verbose",
      autoApprove: "everything",
    });

    const md = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    // Managed fields rewritten (bold prefix preserved).
    expect(md).toContain("- **Default Addressing:** Boss");
    expect(md).toContain("- **Notification Style:** verbose");
    expect(md).toContain("- **Auto-approve Plans:** everything");
    // Unrelated lines preserved verbatim.
    expect(md).toContain("- **Name:** Fifty.ai");
    expect(md).toContain("- **Default Mask:** full");
    expect(md).toContain("keep me verbatim");
    // Round-trip read reflects the new values.
    expect(readUserMdPrefs()).toEqual({
      addressing: "Boss",
      notificationStyle: "verbose",
      autoApprove: "everything",
    });
  });

  it("absent file → defaults; write appends the managed lines under ## Preferences", async () => {
    const { readUserMdPrefs, writeUserMdPrefs } = await import(
      "../lib/user-md.js"
    );
    // No USER.md → the shipped defaults.
    expect(readUserMdPrefs().addressing).toBe("Partner");

    writeUserMdPrefs({
      addressing: "Chief",
      notificationStyle: "terse",
      autoApprove: "S only",
    });
    const md = readFileSync(join(brainRoot, "USER.md"), "utf-8");
    expect(md).toContain("## Preferences");
    expect(md).toContain("- **Default Addressing:** Chief");
    expect(readUserMdPrefs()).toEqual({
      addressing: "Chief",
      notificationStyle: "terse",
      autoApprove: "S only",
    });
  });
});

describe("configure — the 3 USER.md prefs round-trip through the verb (FR-235)", () => {
  it("prompts for + persists the prefs, and a --yes re-run preserves them", async () => {
    stageBrainCore();
    writeConfig(baselineConfig());
    writeUserMd("you", "");

    const { runConfigure } = await import("../verbs/configure.js");
    const { readUserMdPrefs } = await import("../lib/user-md.js");

    // Queue (blank URL → no apiKey prompt): name, email, persona, url,
    // perception, subconscious, addressing, notification, autoApprove.
    const code = await runConfigure({
      isTTY: true,
      prompt: queuePrompt([
        "you",
        "",
        "character",
        "", // url blank → no VPS (skips apiKey)
        "n",
        "n",
        "Captain",
        "loud",
        "M and below",
      ]),
    });
    expect(code).toBe(0);
    expect(readUserMdPrefs()).toEqual({
      addressing: "Captain",
      notificationStyle: "loud",
      autoApprove: "M and below",
    });

    // --yes seeds from USER.md and preserves the prefs (no-op round-trip).
    const code2 = await runConfigure({ yes: true });
    expect(code2).toBe(0);
    expect(readUserMdPrefs()).toEqual({
      addressing: "Captain",
      notificationStyle: "loud",
      autoApprove: "M and below",
    });
  });
});

describe("init --persona", () => {
  it("from-source init applies the professional persona to the runtime SOUL.md", async () => {
    // Stage a from-source repo with a core/ tree carrying the persona templates.
    const sourceRepo = join(workDir, "source-repo");
    const srcCore = join(sourceRepo, "core");
    mkdirSync(srcCore, { recursive: true });
    writeFileSync(join(srcCore, "SOUL.md"), CHARACTER_SOUL);
    writeFileSync(join(srcCore, "SOUL.character.md"), CHARACTER_SOUL);
    writeFileSync(join(srcCore, "SOUL.professional.md"), PROFESSIONAL_SOUL);
    mkdirSync(join(srcCore, "agents"), { recursive: true });
    writeFileSync(join(srcCore, "agents", "manifest.yaml"), "agents: []\n");
    mkdirSync(join(srcCore, "os"), { recursive: true });
    writeFileSync(join(srcCore, "os", "INDEX.md"), "# Index\n");
    mkdirSync(join(srcCore, "skills", "demo"), { recursive: true });
    writeFileSync(join(srcCore, "skills", "demo", "SKILL.md"), "# demo\n");
    mkdirSync(join(srcCore, "hooks"), { recursive: true });
    writeFileSync(
      join(srcCore, "hooks", "canonical-settings.json"),
      JSON.stringify({ hooks: {} }, null, 2) + "\n",
    );
    mkdirSync(join(srcCore, "scripts"), { recursive: true });
    writeFileSync(
      join(srcCore, "scripts", "verify_mirror.sh"),
      "#!/bin/sh\necho noop\n",
    );
    mkdirSync(join(srcCore, "templates"), { recursive: true });

    // Empty PATH so no bridges materialize.
    const prevPath = process.env.PATH;
    process.env.PATH = join(workDir, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });

    try {
      const reg = await import("../lib/registry.js");
      reg.closeDb();
      const { runInit } = await import("../verbs/init.js");
      const code = await runInit({
        fromSource: sourceRepo,
        cliVersion: "7.0.0",
        yes: true,
        persona: "professional",
      });
      reg.closeDb();
      expect(code).toBe(0);

      // Runtime SOUL.md is the professional template.
      expect(readFileSync(join(brainRoot, "core", "SOUL.md"), "utf-8")).toBe(
        PROFESSIONAL_SOUL,
      );
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
