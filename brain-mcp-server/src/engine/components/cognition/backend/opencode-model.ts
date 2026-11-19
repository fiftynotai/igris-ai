/**
 * Brain Engine v7.1 — Cognition backend: opencode's explicit model resolver (BR-110).
 *
 * opencode has no headless-safe default: with no `--model` it falls back to its
 * own built-in choice, which can be a METERED provider (a stored api-key entry
 * in `~/.local/share/opencode/auth.json` routes there — measured, BR-110). This
 * module is the SINGLE resolver that decides which `provider/model` string the
 * extractor spawn passes on `--model` — used by the builder
 * (`spawn-map.ts#buildOpencodeSpawn`), the selection preflight
 * (`preflight.ts#runPreflight`) and the TD-472 probe, so all three agree by
 * construction.
 *
 * NAMES ONLY (D6). `auth.json` is read for provider KEYS and their `.type`
 * field only — never opened for a token value. `model.json` is read for its
 * `recent`/`favorite` provider+model id pairs — public model identifiers, not a
 * credential shape.
 *
 * The HOME both files are read under is INJECTABLE (defaults to `homedir()`),
 * following the convention `isolation.ts`'s `makeIsolatedHome` and
 * `preflight.ts` already use for the operator home — so a test can pass a
 * fenced or fixture directory without touching `process.env.HOME`.
 *
 * @module engine/components/cognition/backend/opencode-model
 * @author fifty.dev
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const AUTH_STORE_REL = '.local/share/opencode/auth.json';
const MODEL_STATE_REL = '.local/state/opencode/model.json';

/** A resolved, oauth-backed `provider/model` string, ready for `--model`. */
export interface OpencodeModelUsable {
  usable: true;
  /** `<providerID>/<modelID>`. */
  model: string;
}

/** No oauth-backed model could be resolved. */
export interface OpencodeModelRefused {
  usable: false;
  reason: 'no_subscription_model';
  detail: string;
}

export type OpencodeModelResolution = OpencodeModelUsable | OpencodeModelRefused;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null; // absent, unreadable or malformed — the caller treats this as "nothing here"
  }
}

/**
 * Provider ids whose `~/.local/share/opencode/auth.json` entry has
 * `type === 'oauth'` (names + `.type` only — D6; no other field is ever read).
 * Sorted for a deterministic `enabled_providers` allowlist.
 */
export function oauthProviders(home: string = homedir()): string[] {
  const j = readJson(resolve(home, AUTH_STORE_REL));
  if (!isObj(j)) return [];
  const out: string[] = [];
  for (const [id, entry] of Object.entries(j)) {
    if (isObj(entry) && entry.type === 'oauth') out.push(id);
  }
  return out.sort();
}

interface ModelRef {
  providerID: string;
  modelID: string;
}

function isModelRef(v: unknown): v is ModelRef {
  return isObj(v) && typeof v.providerID === 'string' && typeof v.modelID === 'string';
}

/** `recent` entries, then `favorite` entries, in file order — the resolver's candidate order. */
function modelCandidates(home: string): ModelRef[] {
  const j = readJson(resolve(home, MODEL_STATE_REL));
  if (!isObj(j)) return [];
  const list = (v: unknown): ModelRef[] => (Array.isArray(v) ? v.filter(isModelRef) : []);
  return [...list(j.recent), ...list(j.favorite)];
}

/**
 * Resolve the `provider/model` opencode's `--model` flag will carry.
 *
 * - A `configuredModel` (a future `opts.model` caller, or the TD-472 probe) is
 *   honoured ONLY when its provider (the text before the first `/`) has an
 *   `oauth` entry in `auth.json`; otherwise it is REFUSED — a configured model
 *   never silently falls back to a different one.
 * - With no `configuredModel`, the first `~/.local/state/opencode/model.json`
 *   `recent` entry (then the first `favorite` entry) whose provider is oauth
 *   wins. An entry naming an api-typed or unknown provider is skipped, not
 *   refused — a later oauth-backed entry can still resolve.
 * - `no_subscription_model` when nothing resolves: no oauth provider at all,
 *   or no candidate names one.
 *
 * @param configuredModel an explicit `provider/model` (optional)
 * @param home            the HOME to read `auth.json` / `model.json` under (tests inject a fixture dir)
 */
export function resolveOpencodeModel(configuredModel?: string, home: string = homedir()): OpencodeModelResolution {
  const oauth = new Set(oauthProviders(home));

  if (configuredModel) {
    const provider = configuredModel.split('/')[0];
    if (oauth.has(provider)) return { usable: true, model: configuredModel };
    return {
      usable: false,
      reason: 'no_subscription_model',
      detail: `configured model "${configuredModel}" names provider "${provider}", which has no oauth entry in ~/${AUTH_STORE_REL}`,
    };
  }

  for (const cand of modelCandidates(home)) {
    if (oauth.has(cand.providerID)) return { usable: true, model: `${cand.providerID}/${cand.modelID}` };
  }

  return {
    usable: false,
    reason: 'no_subscription_model',
    detail: `no oauth-backed model in ~/${MODEL_STATE_REL} (recent, then favorite) matching an oauth provider in ~/${AUTH_STORE_REL}`,
  };
}
