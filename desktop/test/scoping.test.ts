/**
 * Tests for engine/scoping.ts — the scoping/materialization half of
 * DeploymentAnalysisQueueable.cls. String helpers are pinned to the exact Apex
 * regex/prefix semantics; buildScopedFilterForObject is pinned to the Apex
 * priority order; chunking behavior covers the deliberate no-cap deviation.
 */
import { describe, it, expect } from 'vitest'
import {
  IN_CLAUSE_MAX_IDS,
  maxIdsForSoql,
  IN_ORG_MATERIALIZED_ID_CAP,
  isBlank,
  apexTrim,
  escapeSingleQuotes,
  stripToConditions,
  extractLimitClause,
  applyFilterToSoql,
  buildInClause,
  chunkIds,
  buildParentLookupMap,
  buildScopedFilterForObject,
  queriesForScope,
  countQueriesForScope,
  scopedFilterDisplay,
  type ScopedFilter,
  type ScopingContext
} from '../src/main/engine/scoping'
import type { FieldInfo } from '../src/shared/types'

function field(apiName: string, overrides: Partial<FieldInfo> = {}): FieldInfo {
  return {
    apiName,
    label: apiName,
    type: 'reference',
    isReference: true,
    referenceTo: [],
    isCreateable: true,
    isUpdateable: true,
    isNillable: true,
    isExternalId: false,
    isAutoNumber: false,
    isCalculated: false,
    isRestrictedPicklist: false,
    picklistValues: [],
    length: null,
    ...overrides
  }
}

function ids(n: number, prefix = '001'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(15, '0')}`)
}

describe('string helpers (Apex parity)', () => {
  it('isBlank matches Apex String.isBlank', () => {
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank('x')).toBe(false)
  })

  it('escapeSingleQuotes backslash-escapes every quote', () => {
    expect(escapeSingleQuotes("O'Brien's")).toBe("O\\'Brien\\'s")
    expect(escapeSingleQuotes('plain')).toBe('plain')
  })

  describe('stripToConditions', () => {
    it('strips a leading WHERE', () => {
      expect(stripToConditions("WHERE Type = 'Customer'")).toBe("Type = 'Customer'")
    })
    it('is case-insensitive on the WHERE prefix', () => {
      expect(stripToConditions('where X = 1')).toBe('X = 1')
    })
    it('removes ORDER BY with direction', () => {
      expect(stripToConditions('WHERE X = 1 ORDER BY Name DESC')).toBe('X = 1')
    })
    it('removes ORDER BY without direction', () => {
      expect(stripToConditions('WHERE X = 1 ORDER BY CreatedDate')).toBe('X = 1')
    })
    it('removes LIMIT', () => {
      expect(stripToConditions('WHERE X = 1 LIMIT 50')).toBe('X = 1')
    })
    it('removes ORDER BY and LIMIT together', () => {
      expect(stripToConditions('WHERE A = 1 ORDER BY Name ASC LIMIT 5')).toBe('A = 1')
    })
    it('handles bare conditions with no WHERE', () => {
      expect(stripToConditions('A = 1 LIMIT 3')).toBe('A = 1')
    })
    it('returns empty for blank / filter-only clauses', () => {
      expect(stripToConditions(null)).toBe('')
      expect(stripToConditions('   ')).toBe('')
      expect(stripToConditions('LIMIT 10')).toBe('')
      expect(stripToConditions('ORDER BY Name')).toBe('')
    })
  })

  describe('extractLimitClause', () => {
    it('extracts the first LIMIT with a leading space', () => {
      expect(extractLimitClause('WHERE X = 1 LIMIT 25')).toBe(' LIMIT 25')
    })
    it('is case-insensitive', () => {
      expect(extractLimitClause('where x = 1 limit 7')).toBe(' limit 7')
    })
    it('returns empty when no LIMIT', () => {
      expect(extractLimitClause('WHERE X = 1')).toBe('')
      expect(extractLimitClause(null)).toBe('')
    })
  })

  describe('applyFilterToSoql (materializeIds prefix logic)', () => {
    const base = 'SELECT Id FROM Account'
    it('appends a WHERE clause as-is', () => {
      expect(applyFilterToSoql(base, 'WHERE X = 1')).toBe('SELECT Id FROM Account WHERE X = 1')
    })
    it('appends LIMIT-leading clauses as-is', () => {
      expect(applyFilterToSoql(base, 'LIMIT 5')).toBe('SELECT Id FROM Account LIMIT 5')
    })
    it('appends ORDER-leading clauses as-is', () => {
      expect(applyFilterToSoql(base, 'ORDER BY Name')).toBe('SELECT Id FROM Account ORDER BY Name')
    })
    it('prefixes bare conditions with WHERE', () => {
      expect(applyFilterToSoql(base, "Type = 'Customer'")).toBe(
        "SELECT Id FROM Account WHERE Type = 'Customer'"
      )
    })
    it('leaves the SOQL untouched for blank clauses', () => {
      expect(applyFilterToSoql(base, null)).toBe(base)
      expect(applyFilterToSoql(base, '  ')).toBe(base)
    })
    it('trims the clause before prefix detection', () => {
      expect(applyFilterToSoql(base, '  WHERE X = 1 ')).toBe('SELECT Id FROM Account WHERE X = 1')
    })
    it('prefix detection is case-insensitive (lowercase where/limit/order)', () => {
      expect(applyFilterToSoql(base, 'where X = 1')).toBe('SELECT Id FROM Account where X = 1')
      expect(applyFilterToSoql(base, 'limit 5')).toBe('SELECT Id FROM Account limit 5')
      expect(applyFilterToSoql(base, 'order by Name')).toBe('SELECT Id FROM Account order by Name')
    })
  })

  describe('Apex/Java-exact whitespace (deviation 5)', () => {
    const NBSP = '\u00A0'
    const soqlBase = 'SELECT Id FROM Account'

    it('isBlank treats NBSP/figure/narrow-NBSP/BOM as NON-blank (Java Character.isWhitespace)', () => {
      expect(isBlank('\u00A0')).toBe(false)
      expect(isBlank('\u2007')).toBe(false)
      expect(isBlank('\u202F')).toBe(false)
      expect(isBlank('\uFEFF')).toBe(false)
      expect(isBlank(' \t\n\u2028\u2029 ')).toBe(true) // real Java whitespace incl. Zl/Zp
    })

    it('apexTrim strips only chars <= U+0020 (NBSP survives, like Java String.trim)', () => {
      expect(apexTrim('  x  ')).toBe('x')
      expect(apexTrim(NBSP + 'x' + NBSP)).toBe(NBSP + 'x' + NBSP)
      expect(apexTrim('\t\nx\r ')).toBe('x')
    })

    it('stripToConditions does NOT strip ORDER BY / LIMIT written with NBSP (Java \\s is ASCII-only)', () => {
      expect(stripToConditions('WHERE X = 1 ORDER' + NBSP + 'BY Name')).toBe(
        'X = 1 ORDER' + NBSP + 'BY Name'
      )
      expect(stripToConditions('WHERE X = 1 LIMIT' + NBSP + '5')).toBe('X = 1 LIMIT' + NBSP + '5')
      // ASCII whitespace still strips as before
      expect(stripToConditions('WHERE X = 1 ORDER BY Name LIMIT 5')).toBe('X = 1')
    })

    it('extractLimitClause ignores a LIMIT separated by NBSP', () => {
      expect(extractLimitClause('WHERE X = 1 LIMIT' + NBSP + '5')).toBe('')
      expect(extractLimitClause('WHERE X = 1 LIMIT\t5')).toBe(' LIMIT\t5')
    })

    it('an NBSP-prefixed WHERE clause is treated as bare conditions (Java trim leaves the NBSP)', () => {
      expect(applyFilterToSoql(soqlBase, NBSP + 'WHERE X = 1')).toBe(
        'SELECT Id FROM Account WHERE ' + NBSP + 'WHERE X = 1'
      )
    })
  })
})

describe('buildInClause / chunkIds', () => {
  it('quotes and comma-joins ids', () => {
    expect(buildInClause(['a', 'b'])).toBe("'a','b'")
  })

  it('escapes single quotes inside ids', () => {
    expect(buildInClause(["a'b"])).toBe("'a\\'b'")
  })

  it(`throws over the ${IN_CLAUSE_MAX_IDS}-id ceiling (per-chunk invariant)`, () => {
    expect(() => buildInClause(ids(IN_CLAUSE_MAX_IDS + 1))).toThrow(/4000-Id SOQL ceiling/)
    expect(buildInClause(ids(3)).split(',')).toHaveLength(3)
  })

  it('chunks at exactly IN_CLAUSE_MAX_IDS', () => {
    expect(chunkIds(ids(IN_CLAUSE_MAX_IDS)).map((c) => c.length)).toEqual([4000])
    expect(chunkIds(ids(IN_CLAUSE_MAX_IDS + 1)).map((c) => c.length)).toEqual([4000, 1])
    expect(chunkIds(ids(2 * IN_CLAUSE_MAX_IDS)).map((c) => c.length)).toEqual([4000, 4000])
    expect(chunkIds([])).toEqual([])
  })

  it('chunking preserves order and partitions without loss', () => {
    const all = ids(IN_CLAUSE_MAX_IDS + 5)
    const chunks = chunkIds(all)
    expect(chunks.flat()).toEqual(all)
  })
})

describe('buildParentLookupMap (Apex quirks pinned)', () => {
  const scope = new Set(['Account', 'Contact', 'Opportunity'])

  it('maps createable reference fields to in-scope parents', () => {
    const meta = new Map<string, FieldInfo[]>([
      ['Contact', [field('AccountId', { referenceTo: ['Account'] })]],
      ['Account', []],
      ['Opportunity', []]
    ])
    const m = buildParentLookupMap(scope, meta)
    expect(m.get('Contact')!.get('Account')).toBe('AccountId')
    expect(m.get('Account')!.size).toBe(0)
  })

  it('skips non-createable fields, self-references, and out-of-scope targets', () => {
    const meta = new Map<string, FieldInfo[]>([
      [
        'Account',
        [
          field('ParentId', { referenceTo: ['Account'] }), // self → skip
          field('OwnerId', { referenceTo: ['User'] }), // out of scope → skip
          field('Hidden__c', { referenceTo: ['Contact'], isCreateable: false }) // → skip
        ]
      ],
      ['Contact', []],
      ['Opportunity', []]
    ])
    const m = buildParentLookupMap(scope, meta)
    expect(m.get('Account')!.size).toBe(0)
  })

  it('scope membership is case-SENSITIVE (Apex Set<String>): a case-mismatched target falls out', () => {
    const s = new Set(['Custom__c'])
    const meta = new Map<string, FieldInfo[]>([
      ['Custom__c', [field('Parent__c', { referenceTo: ['CUSTOM__C'] })]]
    ])
    expect(buildParentLookupMap(s, meta).get('Custom__c')!.size).toBe(0)
  })

  it('self-reference skip is case-INSENSITIVE (Apex ==): two case-variant scope members treat each other as self', () => {
    // Both names are in scope, so the case-sensitive membership check passes
    // and the apexStringEquals self-check is what rejects the mapping.
    const s = new Set(['Custom__c', 'CUSTOM__C'])
    const meta = new Map<string, FieldInfo[]>([
      ['Custom__c', []],
      ['CUSTOM__C', [field('Parent__c', { referenceTo: ['Custom__c'] })]]
    ])
    expect(buildParentLookupMap(s, meta).get('CUSTOM__C')!.size).toBe(0)
  })

  it('first field wins unless a later field is non-nillable (Apex put rule)', () => {
    const meta = new Map<string, FieldInfo[]>([
      [
        'Opportunity',
        [
          field('Soft1__c', { referenceTo: ['Account'], isNillable: true }),
          field('Soft2__c', { referenceTo: ['Account'], isNillable: true })
        ]
      ],
      ['Account', []],
      ['Contact', []]
    ])
    expect(buildParentLookupMap(scope, meta).get('Opportunity')!.get('Account')).toBe('Soft1__c')

    const meta2 = new Map<string, FieldInfo[]>([
      [
        'Opportunity',
        [
          field('Soft__c', { referenceTo: ['Account'], isNillable: true }),
          field('Hard__c', { referenceTo: ['Account'], isNillable: false })
        ]
      ],
      ['Account', []],
      ['Contact', []]
    ])
    expect(buildParentLookupMap(scope, meta2).get('Opportunity')!.get('Account')).toBe('Hard__c')
  })

  it('a later non-nillable overwrites an earlier non-nillable (Apex !isNillable puts unconditionally)', () => {
    const meta = new Map<string, FieldInfo[]>([
      [
        'Opportunity',
        [
          field('Hard1__c', { referenceTo: ['Account'], isNillable: false }),
          field('Hard2__c', { referenceTo: ['Account'], isNillable: false })
        ]
      ],
      ['Account', []],
      ['Contact', []]
    ])
    expect(buildParentLookupMap(scope, meta).get('Opportunity')!.get('Account')).toBe('Hard2__c')
  })
})

// ─────────────────────── buildScopedFilterForObject ──────────────────────────

interface CtxOptions {
  userFilters?: Record<string, string>
  parentLookups?: Record<string, Record<string, string>>
  materializedIds?: Record<string, string[]>
  objectsWithChildren?: string[]
}

function makeCtx(opts: CtxOptions = {}): ScopingContext & {
  materializeCalls: Array<{ objName: string; scope: ScopedFilter }>
  warnings: string[]
} {
  const materializedIds = new Map(Object.entries(opts.materializedIds ?? {}))
  const materializeCalls: Array<{ objName: string; scope: ScopedFilter }> = []
  const warnings: string[] = []
  return {
    userFilters: new Map(Object.entries(opts.userFilters ?? {})),
    parentLookups: new Map(
      Object.entries(opts.parentLookups ?? {}).map(
        ([k, v]) => [k, new Map(Object.entries(v))] as const
      )
    ),
    materializedIds,
    objectsWithChildren: new Set(opts.objectsWithChildren ?? []),
    async materialize(objName: string, scope: ScopedFilter): Promise<void> {
      materializeCalls.push({ objName, scope })
      if (!materializedIds.has(objName)) materializedIds.set(objName, ['MOCK_ID'])
    },
    warn(message: string): void {
      warnings.push(message)
    },
    materializeCalls,
    warnings
  }
}

describe('buildScopedFilterForObject', () => {
  it('Priority 1: user filter wins verbatim and materializes when the object has children', async () => {
    const ctx = makeCtx({
      userFilters: { Account: "WHERE Type = 'Customer'" },
      parentLookups: { Account: {} },
      objectsWithChildren: ['Account']
    })
    const scope = await buildScopedFilterForObject('Account', ctx)
    expect(scope).toEqual({ kind: 'raw', where: "WHERE Type = 'Customer'" })
    expect(ctx.materializeCalls).toEqual([{ objName: 'Account', scope }])
  })

  it('Priority 1: no materialization when the object has no children', async () => {
    const ctx = makeCtx({ userFilters: { Account: 'WHERE X = 1' } })
    await buildScopedFilterForObject('Account', ctx)
    expect(ctx.materializeCalls).toHaveLength(0)
  })

  it('Priority 1 beats Priority 2 even when a parent has materialized ids', async () => {
    const ctx = makeCtx({
      userFilters: { Contract: "WHERE Status = 'Draft'" },
      parentLookups: { Contract: { Opportunity: 'Recent_Amendment__c' } },
      materializedIds: { Opportunity: ids(3) }
    })
    const scope = await buildScopedFilterForObject('Contract', ctx)
    expect(scope.kind).toBe('raw')
  })

  it('Priority 2: builds a parentIn scope from the first parent with non-empty ids', async () => {
    const parentIds = ids(3)
    const ctx = makeCtx({
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: parentIds }
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope).toEqual({
      kind: 'parentIn',
      lookupField: 'AccountId',
      parentObject: 'Account',
      idChunks: [parentIds]
    })
    expect(ctx.warnings).toHaveLength(0)
  })

  it('Priority 2: skips a parent whose materialized list is EMPTY (Apex !isEmpty)', async () => {
    const oppIds = ids(2, '006')
    const ctx = makeCtx({
      parentLookups: { CustomChild__c: { Account: 'Account__c', Opportunity: 'Opportunity__c' } },
      materializedIds: { Account: [], Opportunity: oppIds }
    })
    const scope = await buildScopedFilterForObject('CustomChild__c', ctx)
    expect(scope).toEqual({
      kind: 'parentIn',
      lookupField: 'Opportunity__c',
      parentObject: 'Opportunity',
      idChunks: [oppIds]
    })
  })

  it('Priority 2: materializes the child itself when it has children', async () => {
    const ctx = makeCtx({
      parentLookups: { Opportunity: { Account: 'AccountId' } },
      materializedIds: { Account: ids(2) },
      objectsWithChildren: ['Opportunity']
    })
    const scope = await buildScopedFilterForObject('Opportunity', ctx)
    expect(ctx.materializeCalls).toEqual([{ objName: 'Opportunity', scope }])
  })

  it(`Priority 2: an over-cap parent (> ${IN_ORG_MATERIALIZED_ID_CAP} ids) is SKIPPED so the next parent scopes — Apex parity`, async () => {
    const big = ids(IN_ORG_MATERIALIZED_ID_CAP + 500)
    const small = ids(300, '006')
    const ctx = makeCtx({
      parentLookups: { CustomChild__c: { Account: 'Account__c', Opportunity: 'Opportunity__c' } },
      materializedIds: { Account: big, Opportunity: small }
    })
    const scope = await buildScopedFilterForObject('CustomChild__c', ctx)
    expect(scope).toEqual({
      kind: 'parentIn',
      lookupField: 'Opportunity__c',
      parentObject: 'Opportunity',
      idChunks: [small]
    })
    expect(ctx.warnings).toHaveLength(0)
  })

  it('over-cap parent with a non-LIMIT user filter falls to the Priority-3 subquery — Apex parity', async () => {
    const big = ids(IN_ORG_MATERIALIZED_ID_CAP + 1)
    const ctx = makeCtx({
      userFilters: { Account: "WHERE Type = 'Customer'" },
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: big }
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope).toEqual({
      kind: 'parentSubquery',
      lookupField: 'AccountId',
      parentObject: 'Account',
      conditions: "Type = 'Customer'"
    })
    expect(ctx.warnings).toHaveLength(0)
  })

  it('over-cap parent with a LIMIT-carrying filter is skipped in Priority 3 (subquery would over-match) → chunked fallback', async () => {
    const big = ids(IN_CLAUSE_MAX_IDS + 10)
    const ctx = makeCtx({
      userFilters: { Account: "WHERE Type = 'Customer' LIMIT 5000" },
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: big }
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope.kind).toBe('parentIn')
    if (scope.kind === 'parentIn') {
      expect(scope.idChunks.map((c) => c.length)).toEqual([4000, 10])
    }
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toMatch(/in-org engine would fail here with "cannot be scoped/)
    expect(ctx.warnings[0]).toMatch(/2 chunked queries/)
  })

  it('deviation 1: where Apex throws "cannot be scoped" (only over-cap parents), the desktop scopes chunked + warns', async () => {
    const big = ids(IN_ORG_MATERIALIZED_ID_CAP + 200)
    const ctx = makeCtx({
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: big },
      objectsWithChildren: ['Contact']
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope).toEqual({
      kind: 'parentIn',
      lookupField: 'AccountId',
      parentObject: 'Account',
      idChunks: [big]
    })
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toMatch(/1200 in-scope ids/)
    // the fallback still materializes the object itself when it has children
    expect(ctx.materializeCalls).toEqual([{ objName: 'Contact', scope }])
  })

  it('Priority 3: subquery fallback from the parent user filter when the parent materialized empty', async () => {
    const ctx = makeCtx({
      userFilters: { Account: "WHERE Type = 'Customer' LIMIT 50" },
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: [] }
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope).toEqual({
      kind: 'parentSubquery',
      lookupField: 'AccountId',
      parentObject: 'Account',
      conditions: "Type = 'Customer'"
    })
  })

  it('Priority 3: materializes the subquery-scoped object itself when it has children — Apex parity', async () => {
    const ctx = makeCtx({
      userFilters: { Account: "WHERE Type = 'Customer'" },
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: [] },
      objectsWithChildren: ['Contact']
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope.kind).toBe('parentSubquery')
    expect(ctx.materializeCalls).toEqual([{ objName: 'Contact', scope }])
  })

  it('Priority 3: skipped when stripToConditions leaves nothing (filter was LIMIT-only)', async () => {
    const ctx = makeCtx({
      userFilters: { Account: 'LIMIT 10' },
      parentLookups: { Contact: { Account: 'AccountId' } },
      materializedIds: { Account: [] }
    })
    const scope = await buildScopedFilterForObject('Contact', ctx)
    expect(scope).toEqual({ kind: 'all' })
    // Same warning on the more dangerous route: the parent WAS in scope, its
    // materialized id list just came back empty, so the child silently widened
    // from "this account's contacts" to "every contact in the org".
    expect(ctx.warnings.some((w) => w.includes('EVERY Contact record'))).toBe(true)
  })

  it('Priority 4: no user filter, no parents → all', async () => {
    const ctx = makeCtx({ parentLookups: { Account: {} } })
    expect(await buildScopedFilterForObject('Account', ctx)).toEqual({ kind: 'all' })

    // S50 (A4): falling through to 'all' means EVERY record of the object in
    // the source org. Legitimate for a small reference table, and the easiest
    // way there is to turn a 400-record account deploy into a 300,000-record
    // one. Until now it happened silently — the only warning in this module
    // was the over-cap one. The risk grows with multi-account scope: more
    // objects in play, likelier one has no path back to the filtered root.
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('Account')
    expect(ctx.warnings[0]).toContain('EVERY Account record')
  })
})

// ───────────────────── SOQL statement ceiling (S50 B2) ──────────────────────

describe('maxIdsForSoql', () => {
  it('allows the full 4,000 for a narrow SELECT', () => {
    // `SELECT Id FROM Account` — what IN_CLAUSE_MAX_IDS was calibrated for.
    expect(maxIdsForSoql(30)).toBe(IN_CLAUSE_MAX_IDS)
  })

  it("cuts below 4,000 once the SELECT is wide — Opportunity's REAL plan", () => {
    // MEASURED 2026-09-07 against the live frozen plan: Opportunity selects 590
    // fields = 13,835 chars, leaving room for 4,007 ids against a 4,000-id
    // chunk. SEVEN ids of headroom. This pins the margin so that adding fields
    // to Opportunity surfaces here rather than as a MALFORMED_QUERY mid-run.
    expect(maxIdsForSoql(13_835)).toBeGreaterThanOrEqual(4_000)
    // ...and one more field's worth of SELECT tips it under.
    expect(maxIdsForSoql(14_500)).toBeLessThan(4_000)
  })

  it('never returns 0 — a huge SELECT still makes progress', () => {
    expect(maxIdsForSoql(99_999)).toBe(1)
    expect(maxIdsForSoql(500_000)).toBe(1)
  })

  it('keeps the whole statement under the ceiling at the boundary', () => {
    for (const sel of [30, 6_000, 13_835, 20_000, 60_000]) {
      const n = maxIdsForSoql(sel)
      expect(sel + n * 21).toBeLessThanOrEqual(100_000)
    }
  })
})

describe('chunkIds — explicit size (S50 B2)', () => {
  it('defaults to IN_CLAUSE_MAX_IDS so FROZEN plan chunks are unchanged', () => {
    const ids = Array.from({ length: 4_001 }, (_, i) => `001${String(i).padStart(15, '0')}`)
    expect(chunkIds(ids).map((c) => c.length)).toEqual([4_000, 1])
  })

  it('partitions at an explicit smaller size without losing or duplicating ids', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`)
    const chunks = chunkIds(ids, 3)
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 3, 1])
    expect(chunks.flat()).toEqual(ids)
  })

  it('falls back to the default for a non-positive size', () => {
    expect(chunkIds(['a', 'b'], 0)).toEqual([['a', 'b']])
  })
})

// ───────────────────────────── SOQL builders ─────────────────────────────────

describe('queriesForScope', () => {
  it('all → bare query', () => {
    expect(queriesForScope('SELECT Id', 'Account', { kind: 'all' })).toEqual([
      'SELECT Id FROM Account'
    ])
  })

  it('raw → applyFilterToSoql semantics (WHERE / LIMIT / bare)', () => {
    expect(
      queriesForScope('SELECT Id', 'Account', { kind: 'raw', where: 'WHERE X = 1 LIMIT 5' })
    ).toEqual(['SELECT Id FROM Account WHERE X = 1 LIMIT 5'])
    expect(queriesForScope('SELECT Id', 'Account', { kind: 'raw', where: 'X = 1' })).toEqual([
      'SELECT Id FROM Account WHERE X = 1'
    ])
  })

  it('parentIn → one query per chunk', () => {
    const scope: ScopedFilter = {
      kind: 'parentIn',
      lookupField: 'AccountId',
      parentObject: 'Account',
      idChunks: [['a', 'b'], ['c']]
    }
    expect(queriesForScope('SELECT Id', 'Contact', scope)).toEqual([
      "SELECT Id FROM Contact WHERE AccountId IN ('a','b')",
      "SELECT Id FROM Contact WHERE AccountId IN ('c')"
    ])
  })

  it('parentSubquery → single subquery form', () => {
    const scope: ScopedFilter = {
      kind: 'parentSubquery',
      lookupField: 'AccountId',
      parentObject: 'Account',
      conditions: "Type = 'Customer'"
    }
    expect(queriesForScope('SELECT Id', 'Contact', scope)).toEqual([
      "SELECT Id FROM Contact WHERE AccountId IN (SELECT Id FROM Account WHERE Type = 'Customer')"
    ])
  })
})

describe('countQueriesForScope (Apex countRecords parity)', () => {
  it('all → COUNT()', () => {
    expect(countQueriesForScope('Account', { kind: 'all' })).toEqual([
      'SELECT COUNT() FROM Account'
    ])
  })

  it('raw without LIMIT → COUNT() over stripped conditions', () => {
    expect(
      countQueriesForScope('Account', { kind: 'raw', where: 'WHERE X = 1 ORDER BY Name' })
    ).toEqual(['SELECT COUNT() FROM Account WHERE X = 1'])
  })

  it('raw with LIMIT → SELECT Id + conditions + LIMIT (Apex hasLimit branch)', () => {
    expect(countQueriesForScope('Account', { kind: 'raw', where: 'WHERE X = 1 LIMIT 25' })).toEqual(
      ['SELECT Id FROM Account WHERE X = 1 LIMIT 25']
    )
  })

  it('raw with LIMIT only (no conditions) omits WHERE', () => {
    expect(countQueriesForScope('Account', { kind: 'raw', where: 'LIMIT 10' })).toEqual([
      'SELECT Id FROM Account LIMIT 10'
    ])
  })

  it('parentIn → one COUNT() per chunk', () => {
    const scope: ScopedFilter = {
      kind: 'parentIn',
      lookupField: 'AccountId',
      parentObject: 'Account',
      idChunks: [['a'], ['b']]
    }
    expect(countQueriesForScope('Contact', scope)).toEqual([
      "SELECT COUNT() FROM Contact WHERE AccountId IN ('a')",
      "SELECT COUNT() FROM Contact WHERE AccountId IN ('b')"
    ])
  })

  it('parentSubquery → COUNT() over the subquery', () => {
    const scope: ScopedFilter = {
      kind: 'parentSubquery',
      lookupField: 'AccountId',
      parentObject: 'Account',
      conditions: 'X = 1'
    }
    expect(countQueriesForScope('Contact', scope)).toEqual([
      'SELECT COUNT() FROM Contact WHERE AccountId IN (SELECT Id FROM Account WHERE X = 1)'
    ])
  })
})

describe('scopedFilterDisplay (the Apex Scoped_Filter__c parity surface)', () => {
  it('all → null (Apex leaves Scoped_Filter__c null)', () => {
    expect(scopedFilterDisplay({ kind: 'all' })).toBeNull()
  })

  it('raw → verbatim', () => {
    expect(scopedFilterDisplay({ kind: 'raw', where: 'WHERE X = 1' })).toBe('WHERE X = 1')
  })

  it('single-chunk parentIn → byte-identical to the Apex IN-clause string', () => {
    const scope: ScopedFilter = {
      kind: 'parentIn',
      lookupField: 'AccountId',
      parentObject: 'Account',
      idChunks: [['001A', '001B']]
    }
    expect(scopedFilterDisplay(scope)).toBe("WHERE AccountId IN ('001A','001B')")
  })

  it('multi-chunk parentIn → summary (impossible in-org; not valid SOQL)', () => {
    const scope: ScopedFilter = {
      kind: 'parentIn',
      lookupField: 'AccountId',
      parentObject: 'Account',
      idChunks: [ids(4000), ids(2)]
    }
    expect(scopedFilterDisplay(scope)).toBe(
      'WHERE AccountId IN (<4002 Account ids across 2 chunks>)'
    )
  })

  it('parentSubquery → byte-identical to the Apex subquery string', () => {
    const scope: ScopedFilter = {
      kind: 'parentSubquery',
      lookupField: 'AccountId',
      parentObject: 'Account',
      conditions: "Type = 'Customer'"
    }
    expect(scopedFilterDisplay(scope)).toBe(
      "WHERE AccountId IN (SELECT Id FROM Account WHERE Type = 'Customer')"
    )
  })
})
