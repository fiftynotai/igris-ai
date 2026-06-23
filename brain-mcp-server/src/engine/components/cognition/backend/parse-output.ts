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
 * Returns the concatenated text. An empty stdout yields `''` — the engine maps a
 * non-empty stdout that the INSTANCE then parses to `[]` as `parse_error`, while
 * a genuinely empty blob is a separate (empty-response) signal.
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
