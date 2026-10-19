/**
 * Golden-fixture loader for the E4X.3 replay suite. Reads every
 * `test/golden/<object>/*.json` fixture (produced by `npm run golden:capture`)
 * and parse-validates it. The replay suite feeds each fixture's `input` +
 * `context` through the TS transform port and asserts `compareOutcome` against
 * the captured `outcome`.
 *
 * Until a live capture has run, the golden tree holds only `.gitkeep` and this
 * returns `[]` — the replay suite skips rather than false-passes.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseFixture, type GoldenFixture } from '../../src/main/engine/deploy/golden/fixture'

// vitest runs with cwd = desktop/.
export const GOLDEN_ROOT = resolve(process.cwd(), 'test', 'golden')

export function loadGoldenFixtures(root: string = GOLDEN_ROOT): GoldenFixture[] {
  if (!existsSync(root)) return []
  const out: GoldenFixture[] = []
  for (const entry of readdirSync(root)) {
    const objDir = join(root, entry)
    if (!statSync(objDir).isDirectory()) continue
    for (const file of readdirSync(objDir)) {
      if (!file.endsWith('.json')) continue
      out.push(parseFixture(readFileSync(join(objDir, file), 'utf8')))
    }
  }
  return out
}
