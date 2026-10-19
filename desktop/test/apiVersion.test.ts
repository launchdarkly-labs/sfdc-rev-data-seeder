/**
 * S64 P6 (6.2): one Salesforce API version for the whole app.
 *
 * Before this, `v66.0` was spelled out in nine engine files (REST root, Tooling
 * root, Tooling query / sobject prefixes, the UI-API picklist endpoint and a
 * Tooling ApiVersion fallback). The constants live in shared/apiVersion.ts; this
 * suite checks the derived paths and walks `src/` to make sure no literal
 * version path or bare version string reappears outside that file — comments
 * stripped first, so documentation may still mention a version by name.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  API_VERSION,
  API_VERSION_NUMBER,
  DATA_API_PATH,
  TOOLING_API_PATH,
  TOOLING_QUERY_PATH,
  TOOLING_SOBJECTS_PATH
} from '../src/shared/apiVersion'
import { API_VERSION as SERVICE_API_VERSION } from '../src/main/services/salesforce'

const SRC = join(__dirname, '..', 'src')
const HOME = join('shared', 'apiVersion.ts')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

/** Drop `//` line comments and `/* … *\/` blocks so prose mentions do not count. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

describe('API_VERSION', () => {
  it('is a Salesforce-shaped version and every path derives from it', () => {
    expect(API_VERSION).toMatch(/^\d{2}\.0$/)
    expect(API_VERSION_NUMBER).toBe(Number(API_VERSION))
    expect(Number.isInteger(API_VERSION_NUMBER)).toBe(true)
    expect(DATA_API_PATH).toBe(`/services/data/v${API_VERSION}`)
    expect(TOOLING_API_PATH).toBe(`${DATA_API_PATH}/tooling`)
    expect(TOOLING_QUERY_PATH).toBe(`${TOOLING_API_PATH}/query/?q=`)
    expect(TOOLING_SOBJECTS_PATH).toBe(`${TOOLING_API_PATH}/sobjects/`)
  })

  it('the transport re-exports the same constant', () => {
    expect(SERVICE_API_VERSION).toBe(API_VERSION)
  })

  it('no other source file spells out a versioned API path or a bare version string', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file)
      if (rel === HOME) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      const lines = code.split('\n')
      lines.forEach((line, i) => {
        if (/\/services\/data\/v\d{2}\.\d/.test(line) || /['"`]\d{2}\.0['"`]/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders, `use shared/apiVersion.ts instead:\n${offenders.join('\n')}`).toEqual([])
  })
})
