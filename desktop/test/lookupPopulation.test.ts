/**
 * S75 — the lookup population check (engine/deploy/lookupPopulation.ts): per
 * reference field, the non-null count over the rows a run deployed, source vs
 * target. The failure it exists for: a MAPPED lookup populated on the source
 * and empty on every deployed target row (deployments 68/69). Scenarios: the
 * classification table, keyed and keyless target scoping, unmapped fields
 * reported but not failed, the per-object replace, junctions skipped, an
 * unreadable object, cancel.
 *
 * S76 — scope: a dropped / partial External ID lookup to an object of the plan
 * is judged on the source values whose parent was reachable (deployed by the
 * run, or already on the target), so a reference to a record outside the scope
 * no longer fails the check — the first live run's four false failures.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyInScope,
  classifyPopulation,
  planMapsField,
  runLookupPopulationCheck
} from '../src/main/engine/deploy/lookupPopulation'
import { EXTERNAL_ID_FIELD, generateExternalId } from '../src/main/engine/deploy/transform/sfid'
import type { DeployIdMapIo } from '../src/main/engine/deploy/types'
import { fld, frozenObject, harness, planOf, type HarnessOpts } from './helpers/deployFakes'

const SUB = 'SBQQ__Subscription__c'
const ref = (apiName: string, to: string) => fld(apiName, { dataType: 'reference', isReference: true, referenceTo: [to] })
const describe_ = [
  fld('Id'),
  fld('Name'),
  ref('SBQQ__ProductOption__c', 'SBQQ__ProductOption__c'),
  ref('SBQQ__Product__c', 'Product2'),
  ref('SBQQ__Contract__c', 'Contract'),
  ref('SBQQ__OrderProduct__c', 'OrderItem'),
  ref('CreatedById', 'User')
]
const S = ['a0S000000000001AAA', 'a0S000000000002AAA', 'a0S000000000003AAA']

function subPlan(over = {}) {
  return planOf(
    frozenObject(SUB, ['Name', 'SBQQ__ProductOption__c', 'SBQQ__Product__c', 'SBQQ__Contract__c', 'SBQQ__OrderProduct__c'], {
      mappings: {
        SBQQ__ProductOption__c: { strategy: 'nameMatch', matchField: 'Name', customValue: null },
        SBQQ__Product__c: { strategy: 'directId', matchField: null, customValue: null },
        SBQQ__Contract__c: { strategy: 'externalId', matchField: null, customValue: null },
        SBQQ__OrderProduct__c: { strategy: 'skip', matchField: null, customValue: null }
      },
      ...over
    })
  )
}

/** COUNT() answers by field name, parsed out of the aggregate SOQL the check sends. */
function answer(soql: string, n: number, counts: Record<string, number>): Array<Record<string, unknown>> {
  const row: Record<string, unknown> = { n }
  for (const m of soql.matchAll(/COUNT\((\w+)\) c(\d+)/g)) row['c' + m[2]] = counts[m[1]!] ?? 0
  return [row]
}

function run(opts: Partial<HarnessOpts> & { source: Record<string, number>; target: Record<string, number> }, plan = subPlan()) {
  const h = harness({
    sourceDescribe: describe_,
    onQuerySource: (soql) => answer(soql, 3, opts.source),
    onQueryTarget: (soql) => answer(soql, 3, opts.target),
    ...opts
  })
  h.store.results.push(...S.map((sourceId) => ({ objectApiName: SUB, sourceId, pass: 1 as const, retryPass: 0, objectAttempt: 0, outcome: 'success' as const })))
  return { h, plan }
}

describe('classifyPopulation / planMapsField', () => {
  it('classifies the four cases and ignores an empty source', () => {
    expect(classifyPopulation(0, 0, true)).toBeNull()
    expect(classifyPopulation(5, 0, true)).toBe('dropped')
    expect(classifyPopulation(5, 0, false)).toBe('notDeployed')
    expect(classifyPopulation(5, 3, true)).toBe('partial')
    expect(classifyPopulation(5, 5, true)).toBe('ok')
    expect(classifyPopulation(5, 9, false)).toBe('ok') // target automation may add values
  })

  it('a field is mapped when the plan keeps it and its strategy is not Skip', () => {
    const o = subPlan().objects[0]!
    expect(planMapsField(o, 'SBQQ__ProductOption__c')).toBe(true)
    expect(planMapsField(o, 'SBQQ__OrderProduct__c')).toBe(false) // skip
    expect(planMapsField(o, 'CreatedById')).toBe(false) // not in the plan
    expect(planMapsField(frozenObject('Account', ['RecordTypeId']), 'RecordTypeId')).toBe(true) // no mapping row
  })
})

describe('runLookupPopulationCheck', () => {
  it('FAILS a mapped lookup that is populated on the source and empty on every deployed row', async () => {
    const { h, plan } = run({
      source: { SBQQ__ProductOption__c: 2, SBQQ__Product__c: 3, SBQQ__Contract__c: 3, SBQQ__OrderProduct__c: 1, CreatedById: 3 },
      target: { SBQQ__ProductOption__c: 0, SBQQ__Product__c: 3, SBQQ__Contract__c: 2, SBQQ__OrderProduct__c: 0, CreatedById: 3 }
    })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r).toEqual({ compared: 5, dropped: 1, partial: 1, notDeployed: 1, outOfScope: 0 })
    // Contract is not an object of this plan, so its External ID lookup has no scope to measure.
    expect(h.store.lookupRows.every((x) => x.inScopeCount === null)).toBe(true)

    const by = Object.fromEntries(h.store.lookupRows.map((x) => [x.fieldName, x]))
    expect(by.SBQQ__ProductOption__c).toMatchObject({ status: 'dropped', sourceCount: 2, targetCount: 0, strategy: 'nameMatch', refObject: 'SBQQ__ProductOption__c' })
    expect(by.SBQQ__Contract__c!.status).toBe('partial')
    expect(by.SBQQ__OrderProduct__c).toMatchObject({ status: 'notDeployed', strategy: 'skip' })
    expect(by.SBQQ__Product__c!.status).toBe('ok')
    // A field the plan does not carry is still compared.
    expect(by.CreatedById).toMatchObject({ status: 'ok', strategy: 'notInPlan' })

    const errors = h.logs.filter((l) => l.level === 'Error').map((l) => l.message)
    expect(errors[0]).toMatch(/Lookup check SBQQ__Subscription__c: 1 mapped lookup\(s\) populated on the source are EMPTY/)
    expect(errors[1]).toMatch(/Lookup population check FAILED: 1 of 5/)
    expect(h.logs.find((l) => l.level === 'Error')!.detail).toContain('SBQQ__ProductOption__c → SBQQ__ProductOption__c: source 2, target 0 (nameMatch)')
  })

  it('passes when every populated lookup arrived, and scopes the target by RDS key when keyed', async () => {
    const all = { SBQQ__ProductOption__c: 2, SBQQ__Product__c: 3 }
    const { h, plan } = run({ source: all, target: all })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.dropped).toBe(0)
    expect(h.logs.at(-1)).toMatchObject({ level: 'Info' })
    expect(h.logs.at(-1)!.message).toMatch(/passed: 2 populated lookup field/)
    expect(h.targetSoqls[0]).toContain(`WHERE ${EXTERNAL_ID_FIELD} IN ('${generateExternalId(S[0]!)}'`)
    expect(h.targetSoqls[0]).toContain('COUNT(Id) n, COUNT(SBQQ__ProductOption__c) c0')
  })

  it('keyless: scopes the target by the mapped Ids', async () => {
    const { h, plan } = run({ source: { SBQQ__Product__c: 3 }, target: { SBQQ__Product__c: 3 } })
    const idMap: DeployIdMapIo = {
      lookup: async (_o, ids) => new Map(ids.map((s, i) => [s, 'a0T00000000000' + i + 'AAA'])),
      record: async () => {},
      existingTargetIds: async () => new Set()
    }
    h.io.idMap = idMap
    await runLookupPopulationCheck(plan, 1, h.io)
    expect(h.targetSoqls[0]).toContain("WHERE Id IN ('a0T000000000000AAA'")
  })

  it('replaces an object\'s rows on a second pass over the same run', async () => {
    const { h, plan } = run({ source: { SBQQ__Product__c: 3 }, target: { SBQQ__Product__c: 3 } })
    await runLookupPopulationCheck(plan, 1, h.io)
    await runLookupPopulationCheck(plan, 1, h.io)
    expect(h.store.lookupRows).toHaveLength(1)
  })

  it('skips junctions and objects with nothing deployed; reports an object whose rows are not on the target', async () => {
    const junction = frozenObject('OpportunityContactRole', ['ContactId'], { isJunction: true })
    const empty = frozenObject('Account', ['OwnerId'])
    const { h } = run({ source: { SBQQ__Product__c: 3 }, target: {}, onQueryTarget: () => [{ n: 0 }] })
    const r = await runLookupPopulationCheck(planOf(junction, empty, subPlan().objects[0]!), 1, h.io)
    expect(r.compared).toBe(0)
    expect(h.logs.some((l) => l.level === 'Warning' && /none of the 3 deployed row\(s\) could be found on the target/.test(l.message))).toBe(true)
    expect(h.sourceSoqls).toEqual([]) // aggregate reads go through querySource, not the page walk
  })

  it('an unreadable object is a Warning, not a throw', async () => {
    const { h, plan } = run({ source: {}, target: {} })
    h.io.querySource = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('MALFORMED_QUERY')) })
    })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.compared).toBe(0)
    expect(h.logs[0]).toMatchObject({ level: 'Warning' })
    expect(h.logs[0]!.message).toMatch(/could not be read \(MALFORMED_QUERY\)/)
  })

  it('stops between objects on cancel', async () => {
    const { h, plan } = run({ source: { SBQQ__Product__c: 3 }, target: { SBQQ__Product__c: 3 } })
    h.io.store.isCancelRequested = () => true
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.compared).toBe(0)
    expect(h.store.lookupRows).toEqual([])
  })
})

describe('S76 — lookups to records outside the run\'s scope', () => {
  const CON = 'Contact'
  const C = ['003000000000001AAA', '003000000000002AAA', '003000000000003AAA']
  const A_IN = '001000000000001AAA'
  const A_OUT = ['001000000000008AAA', '001000000000009AAA']
  const C_OUT = '003000000000009AAA'
  const fields = [
    fld('Id'),
    ref('Past_Account__c', 'Account'),
    ref('ReportsToId', 'Contact'),
    ref('SBQQ__ProductOption__c', 'SBQQ__ProductOption__c')
  ]
  const plan = planOf(
    frozenObject('Account', []),
    frozenObject(CON, ['Past_Account__c', 'ReportsToId', 'SBQQ__ProductOption__c'], {
      mappings: {
        Past_Account__c: { strategy: 'externalId', matchField: null, customValue: null },
        ReportsToId: { strategy: 'externalId', matchField: null, customValue: null },
        SBQQ__ProductOption__c: { strategy: 'nameMatch', matchField: 'Name', customValue: null }
      }
    })
  )
  const ok = (objectApiName: string, sourceId: string) => ({ objectApiName, sourceId, pass: 1 as const, retryPass: 0, objectAttempt: 0, outcome: 'success' as const })

  /** `parents` = the rows the second look reads back; `onTarget` = parent source ids already on the target (keyed). */
  function scoped(o: {
    source: Record<string, number>
    target: Record<string, number>
    parents: Array<Record<string, unknown>>
    onTarget?: string[]
    failParents?: boolean
  }) {
    const h = harness({
      sourceDescribe: fields,
      onQuerySource: (soql) => {
        if (soql.includes('FROM Account')) return answer(soql, 1, {})
        if (soql.includes('COUNT(')) return answer(soql, 3, o.source)
        if (o.failParents) throw new Error('QUERY_TIMEOUT')
        return o.parents
      },
      onQueryTarget: (soql) => {
        if (soql.includes('FROM Account') && soql.includes('COUNT(')) return answer(soql, 1, {})
        if (soql.includes('COUNT(')) return answer(soql, 3, o.target)
        return (o.onTarget ?? []).filter((id) => soql.includes(generateExternalId(id))).map((id) => ({ [EXTERNAL_ID_FIELD]: generateExternalId(id) }))
      }
    })
    h.store.results.push(ok('Account', A_IN), ...C.map((id) => ok(CON, id)))
    return h
  }
  const rowsOf = (h: ReturnType<typeof scoped>) => Object.fromEntries(h.store.lookupRows.map((x) => [x.fieldName, x]))

  it('classifyInScope: nothing reachable is out of scope; a reachable parent that did not land still fails', () => {
    expect(classifyInScope(0, 0)).toBe('outOfScope')
    expect(classifyInScope(2, 2)).toBe('ok')
    expect(classifyInScope(2, 3)).toBe('ok')
    expect(classifyInScope(2, 1)).toBe('partial')
    expect(classifyInScope(2, 0)).toBe('dropped')
  })

  it('every parent outside the scope → out of scope, not a failure; a natural-key lookup at zero still fails', async () => {
    const h = scoped({
      source: { Past_Account__c: 2, ReportsToId: 3, SBQQ__ProductOption__c: 2 },
      target: { Past_Account__c: 0, ReportsToId: 2, SBQQ__ProductOption__c: 0 },
      parents: [
        { Past_Account__c: A_OUT[0], ReportsToId: C[1] },
        { Past_Account__c: A_OUT[1], ReportsToId: C[2] },
        { Past_Account__c: null, ReportsToId: C_OUT }
      ]
    })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r).toEqual({ compared: 3, dropped: 1, partial: 0, notDeployed: 0, outOfScope: 1 })
    const by = rowsOf(h)
    expect(by.Past_Account__c).toMatchObject({ status: 'outOfScope', sourceCount: 2, inScopeCount: 0, targetCount: 0 })
    // Two of the three managers were deployed by this run and both landed; the third is outside it.
    expect(by.ReportsToId).toMatchObject({ status: 'ok', sourceCount: 3, inScopeCount: 2, targetCount: 2 })
    // No scope for a natural-key lookup: the plain rule stands.
    expect(by.SBQQ__ProductOption__c).toMatchObject({ status: 'dropped', inScopeCount: null })

    const note = h.logs.find((l) => /outside this run's scope/.test(l.message))!
    expect(note.level).toBe('Info')
    expect(note.detail).toContain('Past_Account__c → Account: source 2, in scope 0, target 0 (externalId)')
    expect(h.logs.at(-1)!.message).toMatch(/FAILED: 1 of 3/)
  })

  it('only out-of-scope references → the check passes', async () => {
    const h = scoped({
      source: { Past_Account__c: 1 },
      target: { Past_Account__c: 0 },
      parents: [{ Past_Account__c: A_OUT[0], ReportsToId: null }]
    })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.dropped).toBe(0)
    expect(h.logs.at(-1)).toMatchObject({ level: 'Info' })
    expect(h.logs.at(-1)!.message).toMatch(/passed: 1 populated lookup field\(s\) compared, 0 partly populated, 0 not deployed, 1 out of scope/)
  })

  it('keyed: a parent already on the target by its RDS key is reachable — empty on the target is a real failure', async () => {
    const h = scoped({
      source: { Past_Account__c: 2 },
      target: { Past_Account__c: 0 },
      parents: [{ Past_Account__c: A_OUT[0] }, { Past_Account__c: A_OUT[1] }],
      onTarget: [A_OUT[0]!]
    })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.dropped).toBe(1)
    expect(rowsOf(h).Past_Account__c).toMatchObject({ status: 'dropped', inScopeCount: 1 })
    expect(h.targetSoqls.some((q) => q.startsWith(`SELECT ${EXTERNAL_ID_FIELD} FROM Account WHERE ${EXTERNAL_ID_FIELD} IN (`))).toBe(true)
  })

  it('a parent deployed by this run that did not land is a failure; the run\'s own rows need no target read', async () => {
    const h = scoped({
      source: { Past_Account__c: 1 },
      target: { Past_Account__c: 0 },
      parents: [{ Past_Account__c: A_IN }]
    })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.dropped).toBe(1)
    expect(h.targetSoqls.some((q) => q.startsWith(`SELECT ${EXTERNAL_ID_FIELD} FROM Account`))).toBe(false)
  })

  it('keyless: reachability comes from the id map; short of the reachable count is partial', async () => {
    const h = scoped({
      source: { Past_Account__c: 3 },
      target: { Past_Account__c: 1 },
      parents: [{ Past_Account__c: A_IN }, { Past_Account__c: A_OUT[0] }, { Past_Account__c: A_OUT[1] }]
    })
    const asked: string[][] = []
    h.io.idMap = {
      lookup: async (objectName, ids) => {
        if (objectName === 'Account') {
          asked.push([...ids])
          return new Map(ids.filter((id) => id === A_OUT[0]).map((id) => [id, '001T00000000001AAA']))
        }
        return new Map(ids.map((s, i) => [s, '003T0000000000' + i + 'AAA']))
      },
      record: async () => {},
      existingTargetIds: async () => new Set()
    }
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r).toMatchObject({ dropped: 0, partial: 1, outOfScope: 0 })
    // A_IN was deployed by the run, A_OUT[0] is in the id map, A_OUT[1] is nowhere.
    expect(rowsOf(h).Past_Account__c).toMatchObject({ status: 'partial', sourceCount: 3, inScopeCount: 2, targetCount: 1 })
    expect(asked.some((ids) => ids.includes(A_OUT[0]!) && !ids.includes(A_IN))).toBe(true)
  })

  it('an unreadable scope leaves the plain verdict and says so', async () => {
    const h = scoped({ source: { Past_Account__c: 1 }, target: { Past_Account__c: 0 }, parents: [], failParents: true })
    const r = await runLookupPopulationCheck(plan, 1, h.io)
    expect(r.dropped).toBe(1)
    expect(rowsOf(h).Past_Account__c).toMatchObject({ status: 'dropped', inScopeCount: null })
    expect(h.logs.some((l) => l.level === 'Warning' && /scope of 1 lookup\(s\) could not be read \(QUERY_TIMEOUT\)/.test(l.message))).toBe(true)
  })
})
