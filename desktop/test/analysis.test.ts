/**
 * Tests for engine/analysis.ts — the plan-building pipeline port of
 * DeploymentAnalysisQueueable (buildPlanBatch + injectDetectedJunctions +
 * countRecords + materializeIds + plan assembly), driven through a fake
 * AnalysisIo that pins the EXACT SOQL strings the engine emits.
 */
import { describe, it, expect } from 'vitest'
import {
  analyzeDeployment,
  AnalysisError,
  type AnalysisIo,
  type AnalysisResult
} from '../src/main/engine/analysis'
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

interface FakeIoOptions {
  describes?: Record<string, FieldInfo[]>
  /** exact SOQL → ids returned by queryIds (unknown SOQL returns []). */
  idsBySoql?: Record<string, string[]>
  /** exact SOQL → count returned by countQuery (unknown SOQL returns 0). */
  countsBySoql?: Record<string, number>
  dupRules?: Set<string>
  failCountsMatching?: RegExp
  failIdsMatching?: RegExp
  dupRulesReject?: boolean
}

function makeIo(opts: FakeIoOptions = {}): AnalysisIo & {
  calls: { describes: string[]; idQueries: string[]; countQueries: string[]; logs: string[] }
} {
  const calls = {
    describes: [] as string[],
    idQueries: [] as string[],
    countQueries: [] as string[],
    logs: [] as string[]
  }
  return {
    calls,
    async describeFields(objectApiName: string): Promise<FieldInfo[]> {
      calls.describes.push(objectApiName)
      return opts.describes?.[objectApiName] ?? []
    },
    async queryIds(soql: string): Promise<string[]> {
      calls.idQueries.push(soql)
      if (opts.failIdsMatching?.test(soql)) throw new Error('SOURCE QUERY DOWN')
      return opts.idsBySoql?.[soql] ?? []
    },
    async countQuery(soql: string): Promise<number> {
      calls.countQueries.push(soql)
      if (opts.failCountsMatching?.test(soql)) throw new Error('COUNT QUERY DOWN')
      return opts.countsBySoql?.[soql] ?? 0
    },
    async queryActiveDuplicateRuleObjects(): Promise<Set<string>> {
      if (opts.dupRulesReject) throw new Error('DuplicateRule not queryable')
      return opts.dupRules ?? new Set<string>()
    },
    log(level: 'Info' | 'Warning', message: string): void {
      calls.logs.push(`${level}: ${message}`)
    }
  }
}

/** The canonical 3-object Sales scope: Account (filtered) → Contact + Opportunity. */
function salesScopeIo() {
  return makeIo({
    describes: {
      Account: [field('Industry', { type: 'string', isReference: false })],
      Contact: [field('AccountId', { referenceTo: ['Account'] })],
      Opportunity: [field('AccountId', { referenceTo: ['Account'] })]
    },
    idsBySoql: {
      "SELECT Id FROM Account WHERE Type = 'Customer'": ['001A', '001B'],
      "SELECT Id FROM Contact WHERE AccountId IN ('001A','001B')": ['003A'],
      "SELECT Id FROM Opportunity WHERE AccountId IN ('001A','001B')": ['006A', '006B']
    },
    countsBySoql: {
      "SELECT COUNT() FROM Account WHERE Type = 'Customer'": 2,
      "SELECT COUNT() FROM Contact WHERE AccountId IN ('001A','001B')": 5,
      "SELECT COUNT() FROM Opportunity WHERE AccountId IN ('001A','001B')": 3,
      "SELECT COUNT() FROM OpportunityContactRole WHERE OpportunityId IN ('006A','006B')": 4
    }
  })
}

const SALES_INPUT = {
  objects: [
    { objectName: 'Account', userFilter: "WHERE Type = 'Customer'" },
    { objectName: 'Contact' },
    { objectName: 'Opportunity' }
  ]
}

describe('analyzeDeployment — full pipeline (Sales scope + auto junction)', () => {
  let result: AnalysisResult
  let io: ReturnType<typeof salesScopeIo>

  async function run() {
    io = salesScopeIo()
    result = await analyzeDeployment(SALES_INPUT, io)
  }

  it('orders objects parent-first with the junction last (Kahn + alpha tie-break)', async () => {
    await run()
    expect(result.objects.map((o) => o.objectName)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
      'OpportunityContactRole'
    ])
    expect(result.objects.map((o) => o.sortOrder)).toEqual([1, 2, 3, 4])
  })

  it('auto-injects OpportunityContactRole when both parents are in scope', async () => {
    await run()
    expect(result.autoInjectedJunctions).toEqual(['OpportunityContactRole'])
    const ocr = result.objects[3]!
    expect(ocr.isJunction).toBe(true)
    expect(ocr.junctionParents).toEqual(['Opportunity', 'Contact'])
    expect(ocr.junctionParentFields).toEqual(['OpportunityId', 'ContactId'])
    expect(io.calls.logs).toContain(
      'Info: Auto-included 1 junction object(s): OpportunityContactRole'
    )
    // S49 (BUG-7): an auto-injected junction IS described now. The old
    // parent-only synthetic describe left the plan's `fields` empty, and
    // junction.ts then carried only the hardcoded Role/IsPrimary — silently
    // dropping every other field (26 of one account's 52 source OCRs had
    // NektarActions__c set; all 51 rows written to the target had it blank).
    // The parent FKs are still re-hardened to isNillable:false so the junction
    // keeps sorting after both parents.
    expect(io.calls.describes).toContain('OpportunityContactRole')
  })

  it('builds the Apex-identical scoped filters (P1 raw, P2 parentIn cascade)', async () => {
    await run()
    expect(result.objects.map((o) => o.scopedFilterDisplay)).toEqual([
      "WHERE Type = 'Customer'",
      "WHERE AccountId IN ('001A','001B')",
      "WHERE AccountId IN ('001A','001B')",
      "WHERE OpportunityId IN ('006A','006B')"
    ])
    expect(result.warnings).toEqual([])
  })

  it('counts each scope and rolls up totals', async () => {
    await run()
    expect(result.objects.map((o) => o.recordCount)).toEqual([2, 5, 3, 4])
    expect(result.totalRecords).toBe(14)
    expect(result.totalObjects).toBe(4)
  })

  it('materializes each parent exactly once (memoized across children)', async () => {
    await run()
    const accountMaterializations = io.calls.idQueries.filter(
      (q) => q === "SELECT Id FROM Account WHERE Type = 'Customer'"
    )
    expect(accountMaterializations).toHaveLength(1)
    // Contact + Opportunity materialize (they parent the junction); OCR does not.
    expect(io.calls.idQueries).toHaveLength(3)
  })

  it('applies the playbook per object (semi/auto for Sales core, junction for OCR)', async () => {
    await run()
    const [account, contact, opp, ocr] = result.objects
    expect(account!.gatingTier).toBe('semi')
    expect(account!.apiStrategy).toBe('REST') // 2 records, auto → fits REST
    expect(account!.requiresTriggerBypass).toBe(false)
    expect(account!.recommendedBatchSize).toBe(200) // REST caps at composite max
    expect(contact!.gatingTier).toBe('semi')
    expect(opp!.requiresTriggerBypass).toBe(true) // Contracted trip-wire entry
    expect(ocr!.gatingTier).toBe('junction')
    expect(ocr!.apiStrategy).toBe('REST')
  })
})

describe('junction injection edge cases', () => {
  it('does NOT inject when only one parent is in scope', async () => {
    const io = makeIo({
      describes: { Opportunity: [] }
    })
    const result = await analyzeDeployment({ objects: [{ objectName: 'Opportunity' }] }, io)
    expect(result.autoInjectedJunctions).toEqual([])
    expect(result.objects.map((o) => o.objectName)).toEqual(['Opportunity'])
  })

  // S49 (BUG-4): this test previously asserted the OPPOSITE — that a
  // user-selected junction kept isJunction:false. That routed it to the
  // ExtId-upsert path and failed 100% of records live (all 366 OCRs of
  // deployment 7), while the same object auto-injected deployed 51/52.
  // Junction-ness is a property of the object, not of how it entered the plan.
  it('treats a manually-selected junction AS a junction (real describe kept)', async () => {
    const io = makeIo({
      describes: {
        Contact: [],
        Opportunity: [],
        OpportunityContactRole: [
          field('OpportunityId', { referenceTo: ['Opportunity'], isNillable: false }),
          field('ContactId', { referenceTo: ['Contact'], isNillable: false })
        ]
      }
    })
    const result = await analyzeDeployment(
      {
        objects: [
          { objectName: 'Contact' },
          { objectName: 'Opportunity' },
          { objectName: 'OpportunityContactRole' }
        ]
      },
      io
    )
    // not AUTO-injected (the user picked it), but still a junction
    expect(result.autoInjectedJunctions).toEqual([])
    expect(io.calls.describes).toContain('OpportunityContactRole')
    const ocr = result.objects.find((o) => o.objectName === 'OpportunityContactRole')!
    expect(ocr.isJunction).toBe(true)
    expect(ocr.junctionParents).toEqual(['Opportunity', 'Contact'])
    expect(ocr.junctionParentFields).toEqual(['OpportunityId', 'ContactId'])
    // still sorts after its parents via its real hard-ref describe
    expect(ocr.sortOrder).toBe(3)
  })
})

describe('API strategy decisions (Apex buildPlanBatch parity)', () => {
  it('gated objects route REST regardless of record count', async () => {
    const io = makeIo({
      describes: { SBQQ__Quote__c: [] },
      countsBySoql: { 'SELECT COUNT() FROM SBQQ__Quote__c': 50000 }
    })
    const result = await analyzeDeployment({ objects: [{ objectName: 'SBQQ__Quote__c' }] }, io)
    const q = result.objects[0]!
    expect(q.apiStrategy).toBe('REST')
    expect(q.gatingTier).toBe('gated')
    expect(q.requiresTriggerBypass).toBe(true)
    expect(q.recommendedBatchSize).toBe(200)
  })

  it('free objects over restMaxRecords fall to Bulk with the bulk batch size', async () => {
    const io = makeIo({
      describes: { Widget__c: [] },
      countsBySoql: { 'SELECT COUNT() FROM Widget__c': 50000 }
    })
    const result = await analyzeDeployment({ objects: [{ objectName: 'Widget__c' }] }, io)
    expect(result.objects[0]!.apiStrategy).toBe('Bulk')
    expect(result.objects[0]!.gatingTier).toBe('free')
    expect(result.objects[0]!.recommendedBatchSize).toBe(10000)
  })

  it('breaching the object threshold pushes free objects to Bulk', async () => {
    const names = Array.from({ length: 11 }, (_, i) => `W${i}__c`)
    const describes: Record<string, FieldInfo[]> = {}
    const counts: Record<string, number> = {}
    for (const n of names) {
      describes[n] = []
      counts[`SELECT COUNT() FROM ${n}`] = 1
    }
    const io = makeIo({ describes, countsBySoql: counts })
    const result = await analyzeDeployment(
      { objects: names.map((objectName) => ({ objectName })) },
      io
    )
    // 11 objects > objectThreshold 10 → even 1-record free objects go Bulk
    expect(result.objects.every((o) => o.apiStrategy === 'Bulk')).toBe(true)
  })

  it('zero-count objects always route REST (Apex decideStrategy null/0 guard)', async () => {
    const io = makeIo({ describes: { Widget__c: [] } })
    const result = await analyzeDeployment({ objects: [{ objectName: 'Widget__c' }] }, io)
    expect(result.objects[0]!.recordCount).toBe(0)
    expect(result.objects[0]!.apiStrategy).toBe('REST')
  })

  it('an active duplicate rule on target forces Bulk-routed objects back to REST', async () => {
    const io = makeIo({
      describes: { Widget__c: [] },
      countsBySoql: { 'SELECT COUNT() FROM Widget__c': 50000 },
      dupRules: new Set(['Widget__c'])
    })
    const result = await analyzeDeployment({ objects: [{ objectName: 'Widget__c' }] }, io)
    expect(result.objects[0]!.apiStrategy).toBe('REST')
    // batch size follows the OVERRIDDEN strategy (Apex passes the final strategy)
    expect(result.objects[0]!.recommendedBatchSize).toBe(200)
  })

  it('a failing duplicate-rule probe fails open (Bulk routing unchanged)', async () => {
    const io = makeIo({
      describes: { Widget__c: [] },
      countsBySoql: { 'SELECT COUNT() FROM Widget__c': 50000 },
      dupRulesReject: true
    })
    const result = await analyzeDeployment({ objects: [{ objectName: 'Widget__c' }] }, io)
    expect(result.objects[0]!.apiStrategy).toBe('Bulk')
  })
})

describe('count semantics', () => {
  it('a LIMIT-carrying user filter counts via SELECT Id … LIMIT (Apex hasLimit branch)', async () => {
    const io = makeIo({
      describes: { Account: [] },
      countsBySoql: { "SELECT Id FROM Account WHERE Type = 'X' LIMIT 5": 5 }
    })
    const result = await analyzeDeployment(
      { objects: [{ objectName: 'Account', userFilter: "WHERE Type = 'X' LIMIT 5" }] },
      io
    )
    expect(io.calls.countQueries).toEqual(["SELECT Id FROM Account WHERE Type = 'X' LIMIT 5"])
    expect(result.objects[0]!.recordCount).toBe(5)
  })

  it('over-cap parent with a filter falls to the Priority-3 subquery (Apex parity), no warnings', async () => {
    const bigIds = Array.from({ length: 4001 }, (_, i) => `001${String(i).padStart(15, '0')}`)
    const io = makeIo({
      describes: {
        Account: [],
        Contact: [field('AccountId', { referenceTo: ['Account'] })]
      },
      idsBySoql: { "SELECT Id FROM Account WHERE Type = 'Big'": bigIds },
      countsBySoql: {
        "SELECT COUNT() FROM Account WHERE Type = 'Big'": 4001,
        "SELECT COUNT() FROM Contact WHERE AccountId IN (SELECT Id FROM Account WHERE Type = 'Big')": 7003
      }
    })
    const result = await analyzeDeployment(
      {
        objects: [
          { objectName: 'Account', userFilter: "WHERE Type = 'Big'" },
          { objectName: 'Contact' }
        ]
      },
      io
    )
    const contact = result.objects.find((o) => o.objectName === 'Contact')!
    expect(contact.scope.kind).toBe('parentSubquery')
    expect(contact.recordCount).toBe(7003)
    expect(result.warnings).toEqual([])
  })

  it('an unfiltered parent never materializes, so its children stay unscoped (Apex parity)', async () => {
    const io = makeIo({
      describes: {
        Account: [],
        Contact: [field('AccountId', { referenceTo: ['Account'] })]
      },
      countsBySoql: {
        'SELECT COUNT() FROM Account': 12,
        'SELECT COUNT() FROM Contact': 40
      }
    })
    const result = await analyzeDeployment(
      { objects: [{ objectName: 'Account' }, { objectName: 'Contact' }] },
      io
    )
    expect(result.objects.map((o) => o.scope.kind)).toEqual(['all', 'all'])
    expect(io.calls.idQueries).toEqual([]) // no materialization anywhere
  })

  it('chunked parentIn fallback sums COUNT() across chunks (where Apex would throw "cannot be scoped")', async () => {
    // LIMIT-carrying parent filter that materializes >4000 ids: the child skips
    // the over-cap parent in P2, skips its LIMIT filter in P3 (subquery would
    // over-match), and takes the chunked fallback — two COUNT() queries summed.
    const bigIds = Array.from({ length: 4001 }, (_, i) => `001${String(i).padStart(15, '0')}`)
    const chunk1 = bigIds.slice(0, 4000)
    const chunk2 = bigIds.slice(4000)
    const inClause = (chunk: string[]) => chunk.map((id) => `'${id}'`).join(',')
    const io = makeIo({
      describes: {
        Account: [],
        Contact: [field('AccountId', { referenceTo: ['Account'] })]
      },
      idsBySoql: { "SELECT Id FROM Account WHERE Type = 'Big' LIMIT 5000": bigIds },
      countsBySoql: {
        "SELECT Id FROM Account WHERE Type = 'Big' LIMIT 5000": 4001,
        [`SELECT COUNT() FROM Contact WHERE AccountId IN (${inClause(chunk1)})`]: 7000,
        [`SELECT COUNT() FROM Contact WHERE AccountId IN (${inClause(chunk2)})`]: 3
      }
    })
    const result = await analyzeDeployment(
      {
        objects: [
          { objectName: 'Account', userFilter: "WHERE Type = 'Big' LIMIT 5000" },
          { objectName: 'Contact' }
        ]
      },
      io
    )
    const contact = result.objects.find((o) => o.objectName === 'Contact')!
    expect(contact.recordCount).toBe(7003)
    expect(contact.scope.kind).toBe('parentIn')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/in-org engine would fail here with "cannot be scoped/)
    expect(result.warnings[0]).toMatch(/2 chunked queries/)
    expect(result.totalRecords).toBe(4001 + 7003)
  })
})

describe('fail-loud (FINDINGS #14 parity)', () => {
  it('a failing count query throws the Apex error text', async () => {
    const io = makeIo({
      describes: { Widget__c: [] },
      failCountsMatching: /COUNT\(\) FROM Widget__c/
    })
    await expect(analyzeDeployment({ objects: [{ objectName: 'Widget__c' }] }, io)).rejects.toThrow(
      'Record count failed for Widget__c: COUNT QUERY DOWN'
    )
  })

  it('a failing materialization query throws the Apex error text', async () => {
    const io = makeIo({
      describes: {
        Account: [],
        Contact: [field('AccountId', { referenceTo: ['Account'] })]
      },
      failIdsMatching: /FROM Account/
    })
    await expect(
      analyzeDeployment(
        {
          objects: [{ objectName: 'Account', userFilter: 'WHERE X = 1' }, { objectName: 'Contact' }]
        },
        io
      )
    ).rejects.toThrow(
      'Could not materialize in-scope Account Ids for child scoping: SOURCE QUERY DOWN'
    )
  })

  it('errors are AnalysisError instances', async () => {
    const io = makeIo({ describes: { Widget__c: [] }, failCountsMatching: /Widget__c/ })
    await expect(
      analyzeDeployment({ objects: [{ objectName: 'Widget__c' }] }, io)
    ).rejects.toBeInstanceOf(AnalysisError)
  })
})

describe('dependency metadata propagation (resolver → PlannedObject)', () => {
  it('a soft cycle propagates hasCircularReference + deferredFields, plus policy defaults', async () => {
    const io = makeIo({
      describes: {
        Alpha__c: [field('Beta_Ref__c', { referenceTo: ['Beta__c'], isNillable: true })],
        Beta__c: [field('Alpha_Ref__c', { referenceTo: ['Alpha__c'], isNillable: true })]
      },
      countsBySoql: {
        'SELECT COUNT() FROM Alpha__c': 3,
        'SELECT COUNT() FROM Beta__c': 4
      }
    })
    const result = await analyzeDeployment(
      { objects: [{ objectName: 'Alpha__c' }, { objectName: 'Beta__c' }] },
      io
    )
    const [alpha, beta] = result.objects
    // cycle broken alphabetically: Alpha first, so ITS forward ref is deferred
    expect(alpha!.objectName).toBe('Alpha__c')
    expect(alpha!.hasCircularReference).toBe(true)
    expect(alpha!.deferredFields).toEqual(['Beta_Ref__c'])
    expect(beta!.hasCircularReference).toBe(false)
    expect(beta!.deferredFields).toEqual([])
    // free-tier policy defaults must flow through untouched
    expect(alpha!.requiresAutomationDisable).toBe(true)
    expect(alpha!.restPageSize).toBe(2000)
  })
})

describe('junction-inclusive object count', () => {
  it("decideStrategy's totalObjectCount includes the auto-injected junction", async () => {
    // 10 user objects (threshold boundary) + injected OpportunityContactRole
    // = 11 > 10 → free/auto objects fall to Bulk. Without the junction in the
    // count they would stay REST — this pins sortedDeps.length semantics.
    const widgets = Array.from({ length: 8 }, (_, i) => `W${i}__c`)
    const describes: Record<string, FieldInfo[]> = { Opportunity: [], Contact: [] }
    const counts: Record<string, number> = {
      'SELECT COUNT() FROM Opportunity': 1,
      'SELECT COUNT() FROM Contact': 1,
      'SELECT COUNT() FROM OpportunityContactRole': 1
    }
    for (const w of widgets) {
      describes[w] = []
      counts[`SELECT COUNT() FROM ${w}`] = 1
    }
    const io = makeIo({ describes, countsBySoql: counts })
    const result = await analyzeDeployment(
      {
        objects: [
          ...widgets.map((objectName) => ({ objectName })),
          { objectName: 'Opportunity' },
          { objectName: 'Contact' }
        ]
      },
      io
    )
    expect(result.autoInjectedJunctions).toEqual(['OpportunityContactRole'])
    expect(result.totalObjects).toBe(11)
    const widget = result.objects.find((o) => o.objectName === 'W0__c')!
    expect(widget.apiStrategy).toBe('Bulk')
  })
})

describe('input handling', () => {
  it('blank user filters are treated as absent (Apex isNotBlank gate)', async () => {
    const io = makeIo({ describes: { Account: [] } })
    const result = await analyzeDeployment(
      { objects: [{ objectName: 'Account', userFilter: '   ' }] },
      io
    )
    expect(result.objects[0]!.scope).toEqual({ kind: 'all' })
    expect(io.calls.countQueries).toEqual(['SELECT COUNT() FROM Account'])
  })

  it('custom thresholds override the in-org defaults', async () => {
    const io = makeIo({
      describes: { Widget__c: [] },
      countsBySoql: { 'SELECT COUNT() FROM Widget__c': 8 }
    })
    // restMaxRecords (10000 default) governs free objects, so drop it via a
    // low object threshold instead: 1 object > 0 threshold → Bulk.
    const result = await analyzeDeployment(
      { objects: [{ objectName: 'Widget__c' }], objectThreshold: 0 },
      io
    )
    expect(result.objects[0]!.apiStrategy).toBe('Bulk')
  })
})
