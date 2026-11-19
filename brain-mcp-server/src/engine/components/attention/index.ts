/** FR-276 — local attention facade. It records evidence, never model reasoning. */
import type { BrainComponent, ComponentContext, ToolDefinition, ToolResult, EventPayload } from '../../types.js';
import { attentionMigrations } from './schema.js';
import { sessionAction, eventAction } from './actions.js';
import { callAttentionTool } from './capture.js';
const string = { type: 'string' };
const selection = {
    type: 'object', additionalProperties: false,
    properties: {
        category: { type: 'string', enum: ['boot', 'task', 'retrieval', 'user_request'] },
        reference: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$' },
    },
    required: ['category'],
};
const node = { type: 'object', additionalProperties: false, properties: { type: string, project: { type: ['string', 'null'] }, id: string }, required: ['type', 'project', 'id'] };
export function createAttentionComponent(): BrainComponent {
    let ctx: ComponentContext | null = null;
    let dispatch: ((name: string, args: Record<string, unknown>) => Promise<ToolResult>) | null = null;
    const onReady = (payload: EventPayload) => {
        const p = payload.data as {
            dispatch: typeof dispatch;
            tools?: {
                name: string;
            }[];
        };
        dispatch = p.dispatch;
        if (!ctx || !p.tools)
            return;
        const db = ctx.storage.rawConnection;
        db.transaction(() => {
            db.prepare('DELETE FROM attention_tool_inventory WHERE provider=?').run('igris-brain');
            const insert = db.prepare('INSERT INTO attention_tool_inventory(provider,name) VALUES(?,?)');
            for (const tool of p.tools ?? [])
                insert.run('igris-brain', tool.name);
        })();
    };
    const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    return {
        name: 'attention', version: '1.1.0', depends: [], schema: () => attentionMigrations,
        init(context) { ctx = context; context.bus.on('engine.ready', onReady); },
        destroy() { ctx?.bus.off('engine.ready', onReady); ctx = null; dispatch = null; },
        events: () => ({ emits: [], listens: [{ name: 'engine.ready', description: 'Capture local dispatcher and published tool inventory' }] }),
        tools(): ToolDefinition[] {
            return [
                {
                    name: 'igris_attention_session',
                    description: 'Begin, bind, advance an observed context epoch, or end a durable local attention session. Same-brain identity only; no cross-server fallback.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            action: { type: 'string', enum: ['begin', 'bind', 'epoch', 'end'] },
                            session_id: string,
                            project: string,
                            instance_id: string,
                            harness: string,
                            harness_session_id: string,
                            machine_id: string,
                            parent_session_id: string,
                            operation_id: string,
                            reason: string,
                            status: { type: 'string', enum: ['ended', 'interrupted'] },
                        },
                        required: ['action'],
                    },
                    handler: args => json(sessionAction(ctx!.storage.rawConnection, args)),
                },
                {
                    name: 'igris_attention_event',
                    description: 'Record explicitly self-reported external delivery, availability or invocation. This cannot assert observed provenance.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            session_id: string,
                            actor_id: string,
                            operation_id: string,
                            event_key: string,
                            kind: { type: 'string', enum: ['delivery', 'invocation', 'availability'] },
                            node,
                            selection,
                            outcome: { type: 'string', enum: ['started', 'succeeded', 'failed', 'unknown'] },
                            extent: { type: 'string', enum: ['preview', 'full', 'unknown'] },
                            source_revision: string,
                            bytes: { type: 'integer', minimum: 0 },
                            reason: string,
                        },
                        required: ['session_id', 'kind', 'node', 'outcome'],
                    },
                    handler: args => json(eventAction(ctx!.storage.rawConnection, args)),
                },
                {
                    name: 'igris_attention_call',
                    description: 'Call an existing tool through this SAME brain gateway with request-scoped attention evidence. Requires a session created on this brain. Preserves target response content.',
                    inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            session_id: string,
                            actor_id: string,
                            operation_id: string,
                            tool: string,
                            arguments: { type: 'object' },
                            selection,
                        },
                        required: ['session_id', 'tool', 'arguments'],
                    },
                    handler: args => dispatch
                        ? callAttentionTool(ctx!.storage.rawConnection, args, dispatch)
                        : json({ ok: false, reason: 'Local dispatcher unavailable' }),
                },
            ];
        },
    };
}
