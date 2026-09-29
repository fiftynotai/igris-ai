// FR-273 — thin MCP wrappers: getDb() → action → envelope (isError = !ok);
// onChanged fires only when a write changed a row. No logic (relations-tools T5).

import { getDb } from '../../../../db.js';
import type { ToolResult } from '../../../types.js';
import {
  deriveAction,
  kindsAction,
  lookupAction,
  relateAction,
  relationChanged,
  type RelationActionResult,
} from './actions.js';

// Payload of `project.relation_changed`.
export interface RelationChangedPayload {
  [key: string]: unknown;
  action: string;
}

function envelope(r: RelationActionResult): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !r.ok };
}

// `igris_project_relations` — the lookup. Reads only; emits nothing.
export async function handleProjectRelations(args: Record<string, unknown>): Promise<ToolResult> {
  return envelope(await lookupAction(getDb(), args));
}

// `igris_project_relate` — declare / remove one edge.
export async function handleProjectRelate(
  args: Record<string, unknown>,
  onChanged: (payload: RelationChangedPayload) => void,
): Promise<ToolResult> {
  const r = await relateAction(getDb(), args);
  if (relationChanged(r)) onChanged({ action: r.action });
  return envelope(r);
}

// `igris_project_relation_kinds` — list / add / alias / merge.
export async function handleProjectRelationKinds(
  args: Record<string, unknown>,
  onChanged: (payload: RelationChangedPayload) => void,
): Promise<ToolResult> {
  const r = await kindsAction(getDb(), args);
  if (relationChanged(r)) onChanged({ action: r.action });
  return envelope(r);
}

// `igris_project_relations_derive` — writes pending suggestions only; emits nothing.
export async function handleProjectRelationsDerive(args: Record<string, unknown>): Promise<ToolResult> {
  return envelope(await deriveAction(getDb(), args));
}
