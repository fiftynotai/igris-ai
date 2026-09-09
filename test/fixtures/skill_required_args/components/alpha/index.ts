// Fixture for validate_skill_required_args.py Pass A (tool -> required map).
// Reproduces the real components' indentation exactly: `name:` at 10 spaces,
// the tool's own `required:` at 12, a NESTED item-schema `required:` at 18.
export function createAlphaComponent() {
  return {
    tools() {
      return [
        {
          name: 'igris_memory_store',
          description: 'Nested-required trap: the edges[] item schema declares a required list BEFORE the real one.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              edges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    to_type: { type: 'string' },
                    to_id: { type: 'string' },
                    edge_type: { type: 'string' },
                  },
                  required: ['to_type', 'to_id', 'edge_type'],
                },
              },
            },
            required: ['project', 'category', 'title', 'content'],
          },
        },
        {
          name: 'igris_empty_required',
          description: 'Declares an empty required list — must be dropped from the map.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
          },
        },
        {
          name: 'igris_multiline_required',
          description: 'A required list spread over several lines must not parse as empty.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [
              'first_key',
              'second_key',
            ],
          },
        },
      ];
    },
  };
}
