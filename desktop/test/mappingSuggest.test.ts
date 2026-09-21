import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROBES,
  STABLE_PROBES,
  sampleIdOverlap,
  suggestMappings,
  type QueryFn
} from '../src/main/services/mappingSuggest'

// Faithful port of NameMatchResolver.sampleIdOverlap + generateMappingSuggestions.
// Inject fake query fns keyed by the object name parsed from the SOQL.

interface ProbeScenario {
  srcIds?: string[]
  found?: number
  srcThrows?: boolean
  tgtThrows?: boolean
}

function objOf(soql: string): string {
  return soql.match(/FROM (\S+)/)![1]!
}

function makeQueries(scenario: Record<string, ProbeScenario>): {
  querySource: QueryFn
  queryTarget: QueryFn
  sourceSoqls: string[]
} {
  const sourceSoqls: string[] = []
  const querySource: QueryFn = async (soql) => {
    sourceSoqls.push(soql)
    const s = scenario[objOf(soql)]
    if (s?.srcThrows) throw new Error('source query failed')
    return { records: (s?.srcIds ?? []).map((Id) => ({ Id })) }
  }
  const queryTarget: QueryFn = async (soql) => {
    const s = scenario[objOf(soql)]
    if (s?.tgtThrows) throw new Error('target query failed')
    return { totalSize: s?.found ?? 0 }
  }
  return { querySource, queryTarget, sourceSoqls }
}

const ID = (n: number): string[] => Array.from({ length: n }, (_, i) => `001x${i}`)

describe('sampleIdOverlap', () => {
  it('samples source Ids and counts target existence', async () => {
    const { querySource, queryTarget } = makeQueries({ Account: { srcIds: ID(5), found: 5 } })
    const r = await sampleIdOverlap(querySource, queryTarget, 'Account', 5)
    expect(r).toEqual({ sampled: 5, found: 5 })
  })

  it('filters User to IsActive=true in the source query', async () => {
    const { querySource, queryTarget, sourceSoqls } = makeQueries({ User: { srcIds: ID(3), found: 3 } })
    await sampleIdOverlap(querySource, queryTarget, 'User', 5)
    expect(sourceSoqls[0]).toContain('WHERE IsActive = true')
    expect(sourceSoqls[0]).toContain('LIMIT 5')
  })

  it('returns sampled 0 when the source has no records (probe omitted upstream)', async () => {
    const { querySource, queryTarget } = makeQueries({ Product2: { srcIds: [], found: 0 } })
    expect(await sampleIdOverlap(querySource, queryTarget, 'Product2')).toEqual({ sampled: 0, found: 0 })
  })

  it('fails soft: source error → sampled 0', async () => {
    const { querySource, queryTarget } = makeQueries({ User: { srcThrows: true } })
    expect(await sampleIdOverlap(querySource, queryTarget, 'User')).toEqual({ sampled: 0, found: 0 })
  })

  it('fails soft: target error → found 0 (divergent)', async () => {
    const { querySource, queryTarget } = makeQueries({ User: { srcIds: ID(4), tgtThrows: true } })
    expect(await sampleIdOverlap(querySource, queryTarget, 'User')).toEqual({ sampled: 4, found: 0 })
  })
})

describe('suggestMappings', () => {
  const allShared = (): Record<string, ProbeScenario> => {
    const scen: Record<string, ProbeScenario> = {}
    for (const p of [...STABLE_PROBES, ...CATALOG_PROBES]) scen[p] = { srcIds: ID(5), found: 5 }
    return scen
  }

  it('all Ids shared → org-wide directId + every probe directId', async () => {
    const { querySource, queryTarget } = makeQueries(allShared())
    const s = await suggestMappings(querySource, queryTarget)
    expect(s.idsMatch).toBe(true)
    expect(s.recommendation).toBe('directId')
    for (const p of [...STABLE_PROBES, ...CATALOG_PROBES]) {
      expect(s.recommendationByObject[p]).toBe('directId')
    }
  })

  it('a divergent STABLE probe flips the org-wide verdict to nameMatch', async () => {
    const scen = allShared()
    scen.User = { srcIds: ID(5), found: 2 } // 2 of 5 exist on target
    const { querySource, queryTarget } = makeQueries(scen)
    const s = await suggestMappings(querySource, queryTarget)
    expect(s.idsMatch).toBe(false)
    expect(s.recommendation).toBe('nameMatch')
    expect(s.recommendationByObject.User).toBe('nameMatch')
    expect(s.recommendationByObject.RecordType).toBe('directId')
  })

  it('a divergent CATALOG probe does NOT flip the org-wide verdict (stable refs stay directId)', async () => {
    const scen = allShared()
    scen['SBQQ__Dimension__c'] = { srcIds: ID(5), found: 0 }
    const { querySource, queryTarget } = makeQueries(scen)
    const s = await suggestMappings(querySource, queryTarget)
    expect(s.idsMatch).toBe(true) // stable probes all matched
    expect(s.recommendation).toBe('directId')
    expect(s.recommendationByObject['SBQQ__Dimension__c']).toBe('nameMatch')
    expect(s.recommendationByObject.User).toBe('directId')
  })

  it('objects with 0 samples are omitted from recommendationByObject', async () => {
    const scen = allShared()
    scen['SBQQ__Cost__c'] = { srcIds: [], found: 0 }
    const { querySource, queryTarget } = makeQueries(scen)
    const s = await suggestMappings(querySource, queryTarget)
    expect(s.recommendationByObject['SBQQ__Cost__c']).toBeUndefined()
    expect(s.checked['SBQQ__Cost__c']).toEqual({ sampled: 0, found: 0 })
  })

  it('nothing sampled anywhere → nameMatch (default) + idsMatch false', async () => {
    const { querySource, queryTarget } = makeQueries({}) // every probe empty
    const s = await suggestMappings(querySource, queryTarget)
    expect(s.idsMatch).toBe(false)
    expect(s.recommendation).toBe('nameMatch')
    expect(Object.keys(s.recommendationByObject)).toHaveLength(0)
  })
})
