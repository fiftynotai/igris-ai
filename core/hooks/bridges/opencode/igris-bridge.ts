/**
 * Igris AI — OpenCode Plugin Bridge
 *
 * Subscribes to OpenCode's native events and routes each one into the corresponding
 * shared bash hook at `~/.igris/core/hooks/shared/`. This keeps OpenCode, Claude Code,
 * and Codex all driving the same single-source-of-truth hook implementations.
 *
 * Install location (per OpenCode docs):
 *   `~/.config/opencode/plugins/igris-bridge.ts` (global)  OR
 *   `.opencode/plugins/igris-bridge.ts`              (project-local)
 *
 * Registration:
 *   Auto-discovered at OpenCode startup. No manifest or config entry required for
 *   local .ts files. Bun runs TypeScript natively, so no build step is needed.
 *
 * Event coverage (FR-104 portable 6):
 *   session.created                  -> session_start
 *   session.idle | session.deleted   -> session_end
 *   tool.execute.before              -> pre_tool_use
 *   tool.execute.after               -> post_tool_use
 *   experimental.session.compacting  -> pre_compact
 *   session.compacted                -> post_compact
 *
 * Input contract the shared scripts expect on stdin:
 *   { source, event, project_dir, payload }
 *
 * Reference: https://opencode.ai/docs/plugins/
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHARED_DIR = join(homedir(), ".igris", "core", "hooks", "shared");
const HANDLER_TIMEOUT_MS = 15_000;
const TRACE_PATH = process.env.IGRIS_BRIDGE_TRACE;
const seenSessions = new Set<string>();
const endedSessions = new Set<string>();
// Dedupe: session.idle may re-fire during the same logical session (e.g. mid-stream
// status flips). We only want one session_end dispatch per session id.

function trace(line: string): void {
  if (!TRACE_PATH) return;
  try {
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Trace is debug-only; never let it break the hook flow.
  }
}

type UnknownCtx = unknown;

/**
 * Resolve the project directory for the current OpenCode session. Prefers the
 * plugin-ctx `directory`/`worktree` fields (documented in OpenCode's plugin API),
 * falling back to process.cwd() when neither is present.
 */
function resolveProjectDir(pluginCtx: Record<string, unknown> | undefined): string {
  if (pluginCtx) {
    const dir = pluginCtx["directory"];
    if (typeof dir === "string" && dir) return dir;
    const wt = pluginCtx["worktree"];
    if (typeof wt === "string" && wt) return wt;
  }
  return process.cwd();
}

/**
 * Dispatch a single event to the matching shared bash script. Hooks MUST NEVER
 * throw — any failure is logged and swallowed so OpenCode's main flow continues.
 */
function dispatch(
  event: string,
  payload: UnknownCtx,
  pluginCtx: Record<string, unknown> | undefined,
): void {
  const unified = {
    source: "opencode",
    event,
    project_dir: resolveProjectDir(pluginCtx),
    payload,
  };

  trace(`dispatch event=${event} project_dir=${unified.project_dir}`);

  try {
    const result = spawnSync("bash", [join(SHARED_DIR, `${event}.sh`)], {
      input: JSON.stringify(unified),
      timeout: HANDLER_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });

    trace(`dispatch-exit event=${event} status=${result.status ?? "null"}`);

    if (result.status !== 0 && result.status !== null) {
      // Non-zero exit — log but do not throw. Shared scripts already exit 0 by
      // contract, so this path should be rare.
      // eslint-disable-next-line no-console
      console.error(
        `[igris-bridge] ${event} handler exited with ${result.status}: ${result.stderr ?? ""}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[igris-bridge] ${event} dispatch failed:`, err);
  }
}

/**
 * Plugin entry point. OpenCode loads this file at startup, invokes the exported
 * async function with a context object, and reads the returned hook map.
 *
 * Events map:
 *   - `event` is the generic catch-all for session lifecycle events
 *     (session.created, session.idle, session.deleted, session.compacted).
 *   - `tool.execute.before` / `.after` fire for every tool call — we gate on
 *     write-like tools to mirror Claude's Write|Edit matcher.
 *   - `experimental.session.compacting` fires before the LLM generates a
 *     compaction summary; we translate that to pre_compact.
 */
export const IgrisBridge = async (ctx: Record<string, unknown>) => {
  const pluginCtx = ctx;

  return {
    // Generic event subscription — dispatches session lifecycle events.
    event: async ({ event }: { event: { type: string; [k: string]: unknown } }) => {
      if (!event || typeof event.type !== "string") return;

      trace(`event-seen type=${event.type}`);

      switch (event.type) {
        case "session.created":
          dispatch("session_start", event, pluginCtx);
          markSessionSeen(event);
          break;
        case "session.updated":
        case "session.status": {
          // Fallback: `opencode run` mode does not fire `session.created`
          // (empirically verified 2026-04-24 against opencode 1.14.22).
          // Synthesize session_start on first-seen session id from these events.
          const sid = extractSessionId(event);
          if (sid && !seenSessions.has(sid)) {
            seenSessions.add(sid);
            dispatch("session_start", event, pluginCtx);
          }
          break;
        }
        case "session.idle":
        case "session.deleted": {
          const sid = extractSessionId(event);
          const key = sid || "__unknown__";
          if (!endedSessions.has(key)) {
            endedSessions.add(key);
            dispatch("session_end", event, pluginCtx);
          }
          break;
        }
        case "session.compacted":
          dispatch("post_compact", event, pluginCtx);
          break;
        default:
          // Silently ignore unrelated events.
          break;
      }
    },

    // Pre-tool-use gate — mirrors Claude's Write|Edit matcher.
    "tool.execute.before": async (input: unknown, _output: unknown) => {
      const toolName = readToolName(input);
      trace(`tool-before name=${toolName}`);
      if (!isWriteLikeTool(toolName)) return;
      dispatch("pre_tool_use", { input, tool_name: toolName, tool_input: readToolInput(input) }, pluginCtx);
    },

    // Post-tool-use dispatcher — same gating as pre_tool_use.
    "tool.execute.after": async (input: unknown, output: unknown) => {
      const toolName = readToolName(input);
      trace(`tool-after name=${toolName}`);
      if (!isWriteLikeTool(toolName)) return;
      dispatch(
        "post_tool_use",
        { input, output, tool_name: toolName, tool_input: readToolInput(input) },
        pluginCtx,
      );
    },

    // Pre-compact hook — OpenCode fires this before the compaction LLM call.
    "experimental.session.compacting": async (input: unknown, _output: unknown) => {
      dispatch("pre_compact", input, pluginCtx);
    },
  };
};

/**
 * Best-effort tool-name extraction. OpenCode's tool.execute.before/.after input
 * has a `.tool` string (per docs) — we tolerate variations defensively.
 */
function readToolName(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.tool === "string") return obj.tool;
    if (typeof obj.name === "string") return obj.name;
  }
  return "";
}

function extractSessionId(event: Record<string, unknown>): string | undefined {
  const direct = event["sessionID"];
  if (typeof direct === "string" && direct) return direct;
  const props = event["properties"];
  if (props && typeof props === "object") {
    const info = (props as Record<string, unknown>)["info"];
    if (info && typeof info === "object") {
      const id = (info as Record<string, unknown>)["id"];
      if (typeof id === "string" && id) return id;
    }
    const sid = (props as Record<string, unknown>)["sessionID"];
    if (typeof sid === "string" && sid) return sid;
  }
  return undefined;
}

function markSessionSeen(event: Record<string, unknown>): void {
  const sid = extractSessionId(event);
  if (sid) seenSessions.add(sid);
}

function readToolInput(input: unknown): unknown {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.args && typeof obj.args === "object") return obj.args;
    if (obj.input && typeof obj.input === "object") return obj.input;
  }
  return {};
}

/**
 * Match tools that mutate files. Claude uses `Write|Edit` matcher; OpenCode tool
 * names aren't formally documented here so we keep a conservative allowlist that
 * matches the common built-ins (`write`, `edit`) and leaves room to extend.
 */
function isWriteLikeTool(name: string): boolean {
  const normalized = (name || "").toLowerCase();
  return (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit" ||
    normalized === "multi_edit" ||
    normalized.startsWith("file.")
  );
}

export default IgrisBridge;
