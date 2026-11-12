import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared/src', import.meta.url)),
    },
  },
  test: {
    include: ['shared/src/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'node',
  },
});
