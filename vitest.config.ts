import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // The three unit-testable core modules the phase targets. provider-mcp
      // and the tool registrations are integration-level (live sidecar / tool
      // executor) and are exercised by the smoke test, not this denominator.
      include: [
        'src/definition/**/*.ts',
        'src/security/**/*.ts',
        'src/vision/**/*.ts',
      ],
      reporter: ['text', 'text-summary'],
    },
  },
})
