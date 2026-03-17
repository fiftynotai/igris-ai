/**
 * Brain Engine v5.0 — Metrics Component
 *
 * Wraps the existing metrics tool handlers as a BrainComponent.
 * Provides: igris_metrics_record, igris_metrics_query, igris_metrics_velocity
 *
 * @module engine/components/metrics
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import {
  handleMetricsRecord,
  handleMetricsQuery,
  handleMetricsVelocity,
} from '../../../tools/metrics.js';
import type {
  MetricsRecordInput,
  MetricsQueryInput,
  MetricsVelocityInput,
} from '../../../tools/metrics.js';

export function createMetricsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'metrics',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_metrics_record',
          description: 'Record an agent performance metric. Call this after each agent action to track success rates, durations, and retry counts.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              agent: {
                type: 'string',
                description: 'Agent name (e.g., "architect", "forger", "sentinel")',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID being worked on (e.g., "BR-008")',
              },
              action: {
                type: 'string',
                description: 'Action performed (e.g., "plan", "implement", "test", "review")',
              },
              result: {
                type: 'string',
                enum: ['success', 'failure', 'partial', 'blocked'],
                description: 'Outcome of the action',
              },
              duration_ms: {
                type: 'number',
                description: 'Duration of the action in milliseconds',
              },
              retry_count: {
                type: 'number',
                description: 'Number of retries before reaching this result',
              },
            },
            required: ['project', 'agent', 'action', 'result'],
          },
          handler: (args) => {
            const result = handleMetricsRecord(args as unknown as MetricsRecordInput);
            _ctx?.bus.emit('metrics.recorded', { project: (args as Record<string, unknown>).project });
            return result;
          },
        },
        {
          name: 'igris_metrics_query',
          description: 'Query agent performance metrics with summary statistics. Shows success rate by agent, average duration, and recent entries.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              agent: {
                type: 'string',
                description: 'Filter by agent name (optional)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of recent entries to return (default: 20)',
              },
            },
          },
          handler: (args) => handleMetricsQuery(args as unknown as MetricsQueryInput),
        },
        {
          name: 'igris_metrics_velocity',
          description: 'Generate a velocity dashboard showing brief completion rates per week, average completion time, agent utilization, and week-over-week trends.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (optional — omit for all projects)',
              },
              days: {
                type: 'number',
                description: 'Time window in days (default: 30)',
              },
            },
          },
          handler: (args) => handleMetricsVelocity(args as unknown as MetricsVelocityInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          // Orphan: sync auto-push extension point — will be consumed when sync auto-push is implemented
          { name: 'metrics.recorded', description: 'An agent metric was recorded' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Metrics component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
