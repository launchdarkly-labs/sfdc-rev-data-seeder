import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Default lane: pure-logic engine/service/UI suites. Kept free of the
// better-sqlite3 native import so `npm test` works in either ABI state.
// Engine suites run in node; renderer suites in test/ui/** run in jsdom.
// The sqlite integration lane lives in test/integration/** (vitest.integration.config.ts).
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    environmentMatchGlobs: [['test/ui/**', 'jsdom']]
  }
})
