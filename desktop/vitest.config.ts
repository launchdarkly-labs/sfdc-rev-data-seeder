import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Default lane: pure-logic engine/service/UI suites. Kept free of the
// better-sqlite3 native import so `npm test` works in either ABI state.
// Two projects (vitest ≥4 replaced environmentMatchGlobs with projects):
// engine suites run in node; renderer suites in test/ui/** run in jsdom.
// The sqlite integration lane lives in test/integration/** (vitest.integration.config.ts).
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'test/integration/**', 'test/ui/**']
        }
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['test/ui/**/*.test.{ts,tsx}']
        }
      }
    ]
  }
})
