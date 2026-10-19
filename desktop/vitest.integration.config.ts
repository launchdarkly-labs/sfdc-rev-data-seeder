import { defineConfig } from 'vitest/config'

// Integration lane: exercises the real better-sqlite3-backed Store (node ABI).
// Run with `npm run test:store` (rebuild:node first locally); CI runs it after
// the pure lane, where `npm ci` already provides the node-ABI prebuild.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts']
  }
})
