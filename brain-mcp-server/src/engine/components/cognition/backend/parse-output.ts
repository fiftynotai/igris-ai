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
 * Also exports `detectClaudeErrorEnvelope` (TD-447): the claude-only inspection
 * `runBackend` runs BEFORE `extractText`, so an `is_error:true` result envelope
 * is a typed backend failure and never becomes "model text".
 *
 * @module engine/components/cognition/backend/parse-output
 * @author fifty.dev
 */

import type { ExtractorHarness } from '../types.js';

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
 * @param _harness the harness (reserved for per-harness tuning; the walk is generic)
 * @param stdout   the child's raw stdout
 */
export function extractText(_harness: ExtractorHarness, stdout: string): string {
  void _harness; // reserved for future per-harness tuning; the walk below is generic
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

/** A claude result envelope that reports a failure instead of an answer (TD-447). */
export interface ClaudeErrorEnvelope {
  /** `auth_error` when status / terminal_reason / message indicate authentication; else `api_error`. */
  kind: 'api_error' | 'auth_error';
  /** The CLI's own message (first 200 chars) + ` (http N)` when `api_error_status` is present. */
  detail: string;
}

/** The auth arm of the classifier: 401/403 are matched by status, the rest by this text signal. */
const AUTH_SIGNAL = /authenticat|oauth|\/login|unauthori[sz]ed|not logged in/i;

/**
 * Find the first `{type:"result", is_error:true}` line in claude stdout, or `null`.
 * Claude only — `runBackend` calls it under the harness guard BEFORE
 * `extractText`, so an API/auth failure surfaces WITH its message (TD-447, L-232).
 *
 * @param stdout the child's raw stdout (`--output-format json` or stream-json)
 */
export function detectClaudeErrorEnvelope(stdout: string): ClaudeErrorEnvelope | null {
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
    const terminal = typeof ev.terminal_reason === 'string' ? ev.terminal_reason : '';
    const isAuth = status === 401 || status === 403 || AUTH_SIGNAL.test(`${terminal} ${message}`);
    return {
      kind: isAuth ? 'auth_error' : 'api_error',
      // Message FIRST (the health surface renders its first sentence), status
      // appended so it survives the 200-char cut.
      detail: message.slice(0, 200) + (status === undefined ? '' : ` (http ${status})`),
    };
  }
  return null;
}
