/**
 * S75 — the lookup population check (engine/deploy/lookupPopulation.ts): per
 * reference field, the non-null count over the rows a run deployed, source vs
 * target. The failure it exists for: a MAPPED lookup populated on the source
 * and empty on every deployed target row (deployments 68/69). Scenarios: the
 * classification table, keyed and keyless target scoping, unmapped fields
 * reported but not failed, the per-object replace, junctions skipped, an
 * unreadable object, cancel.
 */
import { describe, it, expect } from 'vitest'
import {
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
    expect(r).toEqual({ compared: 5, dropped: 1, partial: 1, notDeployed: 1 })

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
