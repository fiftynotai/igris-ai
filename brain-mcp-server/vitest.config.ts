import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts',
      'eval/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    // TS-002: the tier-wide HOME belt (see vitest.setup.ts). The `include`
    // array above is unchanged — a narrowed include is how a config edit
    // silently drops test files (the BR-106 abort check).
    setupFiles: ['./vitest.setup.ts'],
  },
});
