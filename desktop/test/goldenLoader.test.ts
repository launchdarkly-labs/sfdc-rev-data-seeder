import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGoldenFixtures } from './golden/loader'
import { serializeFixture, type GoldenFixture } from '../src/main/engine/deploy/golden/fixture'

function fixture(object: string, sourceId: string): GoldenFixture {
  return {
    object,
    sourceId,
    captureId: 'gc-test',
    input: { Id: sourceId, Name: 'X' },
    context: {
      objectName: object,
      fields: [],
      deferredFields: [],
      mappings: {},
      nameMatchMaps: {},
      useBulkFormat: false,
      targetUserId: null,
      inactiveUserIds: [],
      targetFieldsByName: {},
      targetPicklistAllowedValues: {},
      inactivePbeIds: [],
      pbeSubstitutes: {}
    },
    outcome: { payload: { Name: 'X' }, skipped: false, skipReason: null, droppedPicklistValues: {} }
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rds-golden-loader-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadGoldenFixtures', () => {
  it('returns [] for a non-existent root', () => {
    expect(loadGoldenFixtures(join(dir, 'nope'))).toEqual([])
  })

  it('returns [] when only non-fixture files are present (empty golden tree)', () => {
    writeFileSync(join(dir, '.gitkeep'), '')
    writeFileSync(join(dir, 'README.md'), '# x')
    expect(loadGoldenFixtures(dir)).toEqual([])
  })

  it('loads and parse-validates every <object>/*.json fixture', () => {
    mkdirSync(join(dir, 'Account'))
    mkdirSync(join(dir, 'Contact'))
    writeFileSync(join(dir, 'Account', 'a.json'), serializeFixture(fixture('Account', '001a')))
    writeFileSync(join(dir, 'Account', 'notjson.txt'), 'ignored')
    writeFileSync(join(dir, 'Contact', 'c.json'), serializeFixture(fixture('Contact', '003c')))

    const loaded = loadGoldenFixtures(dir)
    expect(loaded).toHaveLength(2)
    expect(loaded.map((f) => f.object).sort()).toEqual(['Account', 'Contact'])
  })

  it('throws on a corrupt fixture (no silent skip)', () => {
    mkdirSync(join(dir, 'Account'))
    writeFileSync(join(dir, 'Account', 'bad.json'), '{"object":"Account"}')
    expect(() => loadGoldenFixtures(dir)).toThrow(/malformed/)
  })
})
