/**
 * Brain Engine v7.1 — Cognition backend: per-harness output → text blob.
 *
 * PORTED FROM FR-201 (COPY, don't import — R-PORT-DRIFT):
 *   - the per-harness output parsing (claude stream-json / codex JSONL / agy
 *     --print prose → one text blob)
 *       ← `~/StudioProjects/igris-os-eval/b5/judge.ts:626-682` (`parseJudgeOutput`).
 *
 * GENERALIZED: the judge then ran a grade regex on the blob; here the backend's
 * job ENDS at "stdout → text blob". The instance's `parseResponse` owns the
 * payload extraction (perception's `extractJsonArrayReply`, subconscious's JSON
 * validator) — so the backend stays instance-agnostic.
 *
 * Format-agnostic across the five harnesses:
 *   - claude `--output-format json`  → the `{type:"result", result}` text (or
 *                                       stream-json assistant text blocks);
 *   - codex JSONL                    → `{item:{type:"agent_message", text}}` texts;
 *   - gemini/antigravity `--print`   → raw prose lines ARE the text;
 *   - opencode `run`                 → raw prose lines (falls through to text).
 *
 * Also exports the failure detectors `runBackend` runs BEFORE `extractText`
 * (TD-447, BR-109; docs/COGNITION.md), so a CLI error is never "model text".
 *
 * @module engine/components/cognition/backend/parse-output
 * @author fifty.dev
 */

import type { ExtractorHarness } from '../types.js';
import type { ExecResult } from './exec.js';

/**
 * Reduce a harness's stdout to ONE text blob (the model's answer text). The
 * `harness` arg is accepted for symmetry + future per-harness tuning, but the
 * line-walking parser is format-agnostic (it recognises codex/claude JSON event
 * shapes and treats everything else as prose), so the same walk handles all five.
 *
 * Returns the concatenated text. An empty stdout yields `''`. When the INSTANCE
 * then parses the blob to zero candidates, the engine disambiguates via the
 * instance's `isMalformedResponse` hook (TD-294): a MALFORMED / non-array blob →
 * `parse_error`; a WELL-FORMED (possibly empty) array — a legitimate "nothing to
 * act on" answer — → a SUCCESSFUL run with zero candidates. A genuinely empty
 * blob (well-formed check fails) remains a `parse_error` signal.
 *
 * Ported from `judge.ts:parseJudgeOutput:626-666` (the text-collection half; the
 * grade-regex half is left to the instance).
 *
 * codex keeps only `agent_message` / `result` texts and prose (BR-109).
 *
 * @param harness the harness (codex narrows the walk; the rest share it)
 * @param stdout  the child's raw stdout
 */
export function extractText(harness: ExtractorHarness, stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('{')) {
      // Bare prose (gemini/antigravity --print, opencode, or any non-JSON line).
      texts.push(t);
      continue;
    }
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      // codex JSONL: {item:{type:"agent_message", text}}.
      const item = ev.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        texts.push(item.text);
        continue;
      }
      // claude stream-json / --output-format json: the final
      // {type:"result", result:"..."} carries the answer text.
      if (ev.type === 'result' && typeof ev.result === 'string') {
        texts.push(ev.result);
        continue;
      }
      if (harness === 'codex') continue;
      // claude assistant message events carry content blocks with text.
      const msg = ev.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? ev.content) as unknown;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        }
        continue;
      }
      // Valid JSON but not a recognised event (e.g. the model printed a bare JSON
      // array/object directly). Keep the raw line so the instance's parser can use it.
      texts.push(t);
    } catch {
      // Not JSON at all; treat the raw line as candidate text.
      texts.push(t);
    }
  }
  return texts.join('\n');
}

/** A named CLI failure (BR-109): a reason for `runBackend` and the CLI's own message. */
export interface CliFailure {
  kind: 'api_error' | 'auth_error' | 'model_unsupported' | 'cli_incompatible' | 'account_unsupported';
  /** The CLI's message, ANSI-stripped, first 200 chars, + ` (http N)` when a status is known. */
  detail: string;
}

/** A claude result envelope that reports a failure instead of an answer (TD-447). */
export interface ClaudeErrorEnvelope {
  /** `auth_error` when status / terminal_reason / message indicate authentication; else `api_error`. */
  kind: 'api_error' | 'auth_error';
  /** The CLI's own message (first 200 chars) + ` (http N)` when `api_error_status` is present. */
  detail: string;
}

const AUTH_SIGNAL = /authenticat|oauth|\/login|unauthori[sz]ed|not logged in|token refresh|refresh token|expired token/i;
const MODEL_SIGNAL =
  /\bmodels?\b[^.]{0,120}\b(requires a newer version|not supported|unsupported|does not exist|not found|not available|is unknown)\b/i;
const UNKNOWN_ARG = /unknown (argument|option)s?|unexpected argument|unrecognized (argument|option)/i;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g');

/** Remove ANSI CSI / OSC sequences. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

// Credential shapes (D2): each is replaced by its prefix + `…`.
const SECRET_SHAPES: RegExp[] = [
  /\b(sk-)[A-Za-z0-9_-]{6,}/g,
  /\b(eyJ)[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
  /\b(Bearer\s+)\S+/gi,
  /\b(ya29\.)[A-Za-z0-9._-]+/g,
  /\b(1\/\/)[A-Za-z0-9_-]{20,}/g,
  /\b(AIza)[0-9A-Za-z_-]{30,}/g,
];

/** Mask credential-shaped substrings (`runBackend` applies it to every `detail`). */
export function scrubSecrets(s: string): string {
  return SECRET_SHAPES.reduce((acc, re) => acc.replace(re, '$1…'), s);
}

/**
 * Name a CLI error: 401/403 or an auth phrase (or a bare 401/403 in a one-line
 * message with no status) → `auth_error`; else a model code or a model +
 * unsupported phrase → `model_unsupported`; else `api_error`.
 */
export function classifyCliError(e: { status?: number; code?: string; message: string }): CliFailure & {
  kind: 'api_error' | 'auth_error' | 'model_unsupported';
} {
  const message = stripAnsi(e.message);
  const code = e.code ?? '';
  const auth =
    e.status === 401 ||
    e.status === 403 ||
    AUTH_SIGNAL.test(`${code} ${message}`) ||
    (e.status === undefined && !message.includes('\n') && /\b40[13]\b/.test(message));
  const model = !auth && (/model/i.test(code) || MODEL_SIGNAL.test(message));
  return {
    kind: auth ? 'auth_error' : model ? 'model_unsupported' : 'api_error',
    // Message FIRST (the health surface renders its first sentence); the status survives the cut.
    detail: message.slice(0, 200) + (e.status === undefined ? '' : ` (http ${e.status})`),
  };
}

/**
 * TD-447's two classes for claude's first `is_error:true` result line (read by
 * the probe and the TD-471 watcher); `runBackend` uses `detectHarnessFailure`.
 *
 * @param stdout the child's raw stdout (`--output-format json` or stream-json)
 */
export function detectClaudeErrorEnvelope(stdout: string): ClaudeErrorEnvelope | null {
  const f = claudeEnvelopeFailure(stdout);
  return f === null ? null : { kind: f.kind === 'auth_error' ? 'auth_error' : 'api_error', detail: f.detail };
}

function claudeEnvelopeFailure(stdout: string): CliFailure | null {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type !== 'result' || ev.is_error !== true) continue;
    const message =
      typeof ev.result === 'string' ? ev.result : 'claude result envelope is_error=true (no result text)';
    const status = typeof ev.api_error_status === 'number' ? ev.api_error_status : undefined;
    const terminal = typeof ev.terminal_reason === 'string' ? ev.terminal_reason : undefined;
    return classifyCliError({ status, code: terminal, message });
  }
  return null;
}

// BR-109 — per-harness failure detection (docs/COGNITION.md)

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function jsonLine(line: string): Json | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const CODEX_STATUS = /\bstatus[":\s]+(\d{3})\b|\b(\d{3}) (?:Bad Request|Unauthorized|Forbidden|Not Found)\b/;

/** codex's error `message` is JSON (`{status, error:{type, code, message}}`) or plain text. */
function codexErrorFields(raw: string): { status?: number; code?: string; message: string } {
  const j = jsonLine(raw);
  if (j) {
    const err = isObj(j.error) ? j.error : {};
    return {
      status: typeof j.status === 'number' ? j.status : undefined,
      code: str(err.code) ?? str(err.type),
      message: str(err.message) ?? str(j.message) ?? raw,
    };
  }
  const m = CODEX_STATUS.exec(raw);
  return { status: m ? Number(m[1] ?? m[2]) : undefined, message: raw };
}

/** A `turn.failed` event, or an `error` event with no `agent_message` answer. */
function detectCodexFailure(stdout: string): CliFailure | null {
  let failed: string | undefined;
  let errored: string | undefined;
  let answered = false;
  for (const line of stdout.split('\n')) {
    const ev = jsonLine(line);
    if (!ev) continue;
    if (isObj(ev.item) && ev.item.type === 'agent_message') answered = true;
    if (ev.type === 'turn.failed' && failed === undefined) {
      failed = str(isObj(ev.error) ? ev.error.message : undefined) ?? 'codex turn.failed (no message)';
    }
    if (ev.type === 'error' && errored === undefined) errored = str(ev.message) ?? 'codex error event (no message)';
  }
  const raw = failed ?? (answered ? undefined : errored);
  return raw === undefined ? null : classifyCliError(codexErrorFields(raw));
}

/** Empty stdout plus an `Error:` line on stderr (the last one), at any exit code. */
function detectOpencodeFailure(stdout: string, stderr: string): CliFailure | null {
  if (stdout.trim()) return null;
  let message: string | undefined;
  for (const line of stripAnsi(stderr).split('\n')) {
    const m = /^\s*Error:\s*(.+?)\s*$/.exec(line);
    if (m) message = m[1];
  }
  return message === undefined ? null : classifyCliError({ message });
}

const GEMINI_TIER = /\bIneligibleTierError\b|\bineligibleTiers:/;
const GEMINI_TIER_MESSAGE = /reasonMessage:\s*(['"`])(.+?)\1|IneligibleTierError:\s*(.+)/;
const GEMINI_UNTRUSTED = /not running in a trusted directory/;

/**
 * gemini-cli, only when the run gave no answer, first match wins: the vendor's tier refusal
 * (any exit) → `account_unsupported`; exit 55 or the untrusted-folder line, or exit 42/52 →
 * `cli_incompatible`; exit 41 → `auth_error`.
 */
function detectGeminiFailure(code: number | null, stdout: string, stderr: string): CliFailure | null {
  if (code === 0 && stdout.trim()) return null;
  const lines = stripAnsi(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const text = lines.join('\n');
  if (GEMINI_TIER.test(text)) {
    const m = GEMINI_TIER_MESSAGE.exec(text);
    return { kind: 'account_unsupported', detail: (m?.[2] ?? m?.[3] ?? 'gemini: account tier ineligible').slice(0, 200) };
  }
  const untrusted = lines.find((l) => GEMINI_UNTRUSTED.test(l));
  if (code === 55 || (code !== 0 && untrusted !== undefined)) {
    return { kind: 'cli_incompatible', detail: (untrusted ?? lines[lines.length - 1] ?? 'gemini exit 55').slice(0, 200) };
  }
  if (code !== 41 && code !== 42 && code !== 52) return null;
  return {
    kind: code === 41 ? 'auth_error' : 'cli_incompatible',
    detail: (lines[lines.length - 1] ?? `gemini exit ${code}`).slice(0, 200),
  };
}

/** The harness-specific failure in `res`, or `null` (runs regardless of exit code). */
export function detectHarnessFailure(
  harness: ExtractorHarness,
  res: Pick<ExecResult, 'stdout' | 'stderr' | 'code'>,
): CliFailure | null {
  switch (harness) {
    case 'claude':
      return claudeEnvelopeFailure(res.stdout);
    case 'codex':
      return detectCodexFailure(res.stdout);
    case 'opencode':
      return detectOpencodeFailure(res.stdout, res.stderr);
    case 'gemini':
      return detectGeminiFailure(res.code, res.stdout, res.stderr);
    case 'antigravity':
      return null;
  }
}

/** Any harness: non-zero exit, empty stdout, a stderr line rejecting an argument → that line. */
export function detectUnknownArgument(res: Pick<ExecResult, 'stdout' | 'stderr' | 'code'>): string | null {
  if (res.code === 0 || res.stdout.trim()) return null;
  const line = stripAnsi(res.stderr)
    .split('\n')
    .find((l) => UNKNOWN_ARG.test(l));
  return line === undefined ? null : line.trim().slice(0, 200);
}
