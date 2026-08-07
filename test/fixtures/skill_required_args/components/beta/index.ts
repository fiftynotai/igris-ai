// Fixture for block bounding. igris_no_required declares NO required list; the
// next tool's list must NOT be attached back to it.
export function createBetaComponent() {
  return {
    tools() {
      return [
        {
          name: 'igris_no_required',
          description: 'No required array at all.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
        },
        {
          name: 'igris_after_no_required',
          description: 'Its required list must bind to THIS tool, not the one above.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
            required: ['beta_key'],
          },
        },
      ];
    },
  };
}
