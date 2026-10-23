import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { INTERVEIL_LOG_LEVEL: 'error' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/ui/**'],
      reporter: ['text-summary', 'text', 'json-summary'],
    },
  },
});
