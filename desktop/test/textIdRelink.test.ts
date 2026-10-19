/**
 * S63 — the text-Id relink pass. CPQ stores record Ids in TEXT fields the
 * reference remap never sees; this pass rewrites the EXPLICIT list in
 * fieldPolicy.TEXT_ID_FIELDS after the load. Scenarios: keyed resolve by RDS
 * key, keyless resolve through the id map, unresolved stays verbatim (and is
 * logged with a reason), not-an-Id left alone, compare-before-PATCH (a second
 * run sends nothing), catalog match by name with the missing / ambiguous
 * cases, a field absent on one org, a PATCH failure, cancel.
 */
import { describe, it, expect } from 'vitest'
import { runTextIdRelink, looksLikeSfId } from '../src/main/engine/deploy/textIdRelink'
import { EXTERNAL_ID_FIELD, generateExternalId, to18 } from '../src/main/engine/deploy/transform/sfid'
import type { DeployIdMapIo, TextIdRelinkInput } from '../src/main/engine/deploy/types'
import { fld, frozenObject, harness, planOf, type HarnessOpts } from './helpers/deployFakes'

const SUB = 'SBQQ__Subscription__c'
const REQ = 'SBQQ__RequiredById__c'
const ROOT = 'SBQQ__RootId__c'
const id = (prefix: string, n: number): string => (prefix + String(n).padStart(18 - prefix.length, '0')).replace(/[^a-zA-Z0-9]/g, '0')
const S = (n: number): string => id('a0S', n) // source subscription ids
const T = (n: number): string => to18(id('a0T', n).slice(0, 15)) // target subscription ids (valid 18-char checksum)
const ext = (sourceId: string): string => generateExternalId(sourceId)

const subDescribe = [fld('Id'), fld(REQ, { dataType: 'string' }), fld(ROOT, { dataType: 'string' })]

function subPlan() {
  return planOf(frozenObject(SUB, ['Id', REQ, ROOT], { recommendedBatchSize: 200 }))
}

/** Mark source rows as deployed in the fake store (the pass scopes to deployedSourceIds). */
function deployed(h: ReturnType<typeof harness>, object: string, sourceIds: string[]): void {
  h.store.results.push(
    ...sourceIds.map((sourceId) => ({ objectApiName: object, sourceId, pass: 1 as const, retryPass: 0, objectAttempt: 0, outcome: 'success' as const }))
  )
}

const by = (rows: TextIdRelinkInput[], sourceId: string, field: string): TextIdRelinkInput | undefined =>
  rows.find((r) => r.sourceId === sourceId && r.fieldName === field)

describe('looksLikeSfId', () => {
  it('accepts 15 and 18 alphanumerics, rejects everything else', () => {
    expect(looksLikeSfId(S(1))).toBe(true)
    expect(looksLikeSfId(S(1).slice(0, 15))).toBe(true)
    expect(looksLikeSfId('junk')).toBe(false)
    expect(looksLikeSfId('a0S0000000000001AAA-x')).toBe(false)
    expect(looksLikeSfId(null)).toBe(false)
    expect(looksLikeSfId(12)).toBe(false)
  })
})

describe('textIdRelink — keyed (RDS key on the target)', () => {
  /** S1.RequiredById → S0 (loaded), S1.RootId → S1 (itself); S2 holds junk; S3 points at SX (never loaded). */
  const sourceRows = [
    { Id: S(1), [REQ]: S(0), [ROOT]: S(1) },
    { Id: S(2), [REQ]: 'junk', [ROOT]: null },
    { Id: S(3), [REQ]: S(99), [ROOT]: null }
  ]
  function targetRows(current: Record<string, Record<string, unknown>> = {}) {
    return [0, 1, 2, 3].map((n) => ({ Id: T(n), [EXTERNAL_ID_FIELD]: ext(S(n)), [REQ]: null, [ROOT]: null, ...(current[S(n)] ?? {}) }))
  }
  function keyedHarness(current?: Record<string, Record<string, unknown>>, over: Partial<HarnessOpts> = {}) {
    const h = harness({
      sourceDescribe: subDescribe,
      onQuerySource: (soql) => (soql.includes(`FROM ${SUB}`) ? sourceRows : []),
      onQueryTarget: (soql) => (soql.includes(`FROM ${SUB}`) ? targetRows(current) : []),
      ...over
    })
    deployed(h, SUB, [S(0), S(1), S(2), S(3)])
    return h
  }

  it('rewrites source Ids to the target rows that carry their RDS key, leaves junk and unloaded parents alone', async () => {
    const h = keyedHarness()
    await runTextIdRelink(subPlan(), 1, h.io)

    // ONE updateOnly upsert, S1 only, both fields, keyed by S1's RDS key.
    expect(h.upsertCalls).toHaveLength(1)
    const call = h.upsertCalls[0]!
    expect(call.objectName).toBe(SUB)
    expect(call.records).toEqual([{ [EXTERNAL_ID_FIELD]: ext(S(1)), [REQ]: T(0), [ROOT]: T(1), attributes: { type: SUB } }])

    const L = h.store.relinks
    expect(by(L, S(1), REQ)).toMatchObject({ outcome: 'relinked', sourceValue: S(0), resolvedValue: T(0), targetId: T(1), refObject: SUB })
    expect(by(L, S(1), ROOT)).toMatchObject({ outcome: 'relinked', resolvedValue: T(1) })
    expect(by(L, S(2), REQ)).toMatchObject({ outcome: 'not_an_id', sourceValue: 'junk', resolvedValue: null })
    expect(by(L, S(3), REQ)).toMatchObject({ outcome: 'unresolved', sourceValue: S(99), resolvedValue: null })
    expect(by(L, S(3), REQ)!.reason).toMatch(/no SBQQ__Subscription__c row on the target carries this source Id's RDS key/)
    // Never nulled, never rewritten: no patch mentions S3.
    expect(JSON.stringify(call.records)).not.toContain(ext(S(3)))

    // Log lines: one per field, the unresolved one a Warning naming the row.
    const req = h.logs.find((l) => l.message.startsWith(`Relink ${SUB}.${REQ}:`))!
    expect(req.level).toBe('Warning')
    expect(req.message).toBe(`Relink ${SUB}.${REQ}: 1 relinked, 0 already current, 1 unresolved (left as the source Id), 1 not an Id`)
    expect(req.detail).toContain(`${S(3)} ${REQ}=${S(99)}`)
    const root = h.logs.find((l) => l.message.startsWith(`Relink ${SUB}.${ROOT}:`))!
    expect(root.level).toBe('Info')
    expect(root.message).toBe(`Relink ${SUB}.${ROOT}: 1 relinked, 0 already current`)
  })

  it('compare before PATCH: a target already holding the right Ids gets no write (already_current)', async () => {
    const h = keyedHarness({ [S(1)]: { [REQ]: T(0), [ROOT]: T(1) } })
    await runTextIdRelink(subPlan(), 1, h.io)
    expect(h.upsertCalls).toHaveLength(0)
    expect(by(h.store.relinks, S(1), REQ)).toMatchObject({ outcome: 'already_current', resolvedValue: T(0) })
    expect(by(h.store.relinks, S(1), ROOT)).toMatchObject({ outcome: 'already_current' })
  })

  it('accepts a 15-char current value as equal to the 18-char resolution', async () => {
    const h = keyedHarness({ [S(1)]: { [REQ]: T(0).slice(0, 15), [ROOT]: T(1) } })
    await runTextIdRelink(subPlan(), 1, h.io)
    expect(h.upsertCalls).toHaveLength(0)
  })

  it('a PATCH failure is recorded per field with the transport message, the rest still relink', async () => {
    const h = keyedHarness(undefined, {
      onUpsert: (records) => ({
        successCount: records.length - 1,
        failureCount: 1,
        errorDetails: [`${ext(S(1))} → FIELD_INTEGRITY_EXCEPTION: nope; `],
        failedExternalIds: [ext(S(1))],
        typedErrors: [{ extId: ext(S(1)), statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'nope', fields: [REQ] }]
      })
    })
    await runTextIdRelink(subPlan(), 1, h.io)
    expect(by(h.store.relinks, S(1), REQ)).toMatchObject({ outcome: 'failed', reason: 'FIELD_INTEGRITY_EXCEPTION: nope; ' })
    expect(by(h.store.relinks, S(1), ROOT)).toMatchObject({ outcome: 'failed' })
    expect(h.logs.find((l) => l.message.startsWith(`Relink ${SUB}.${REQ}:`))!.message).toContain('1 failed')
  })

  it('a listed field missing on the TARGET describe is skipped — no queries, no ledger', async () => {
    const srcQ: string[] = []
    const h = keyedHarness(undefined, {
      targetDescribe: [fld('Id'), fld(ROOT)],
      onQuerySource: (soql) => {
        srcQ.push(soql)
        return soql.includes(`FROM ${SUB}`) ? sourceRows : []
      }
    })
    await runTextIdRelink(subPlan(), 1, h.io)
    // RootId still handled; RequiredById never selected.
    expect(srcQ.length).toBeGreaterThan(0)
    expect(srcQ.some((q) => q.includes(REQ))).toBe(false)
    expect(h.store.relinks.every((r) => r.fieldName === ROOT)).toBe(true)
    expect(by(h.store.relinks, S(1), ROOT)).toMatchObject({ outcome: 'relinked' })
  })

  it('an object with no listed fields, a junction, or nothing deployed → untouched', async () => {
    const h = harness({ sourceDescribe: subDescribe })
    const plan = planOf(frozenObject('Account', ['Id']), frozenObject(SUB, ['Id', REQ], { isJunction: true }))
    await runTextIdRelink(plan, 1, h.io)
    expect(h.sourceSoqls).toEqual([])
    const h2 = keyedHarness()
    h2.store.results.length = 0 // nothing deployed this run
    await runTextIdRelink(subPlan(), 1, h2.io)
    expect(h2.sourceSoqls).toEqual([])
  })

  it('a cancel request returns before touching the org', async () => {
    const h = keyedHarness()
    h.store.cancelled = true
    await runTextIdRelink(subPlan(), 1, h.io)
    expect(h.sourceSoqls).toEqual([])
    expect(h.upsertCalls).toEqual([])
  })
})

describe('textIdRelink — keyless (id map)', () => {
  it('resolves through io.idMap, reads the target by mapped Id, and PATCHes with the virtual key', async () => {
    const map = new Map([
      [S(0), T(0)],
      [S(1), T(1)]
      // S(3) never mapped → unresolved
    ])
    const lookups: Array<[string, string[]]> = []
    const idMap: DeployIdMapIo = {
      lookup: async (obj, ids) => {
        lookups.push([obj, [...ids]])
        return new Map([...ids].filter((i) => map.has(i)).map((i) => [i, map.get(i)!]))
      },
      record: async () => {},
      existingTargetIds: async () => new Set()
    }
    const h = harness({
      sourceDescribe: subDescribe,
      onQuerySource: (soql) => (soql.includes(`FROM ${SUB}`) ? [{ Id: S(1), [REQ]: S(0), [ROOT]: null }, { Id: S(3), [REQ]: S(0), [ROOT]: null }] : []),
      onQueryTarget: (soql) => (soql.includes('WHERE Id IN') ? [{ Id: T(1), [REQ]: null, [ROOT]: null }] : [])
    })
    h.io.idMap = idMap
    deployed(h, SUB, [S(0), S(1), S(3)])
    await runTextIdRelink(subPlan(), 1, h.io)

    // No RDS-key query in keyless mode.
    expect(h.targetSoqls.some((q) => q.includes(EXTERNAL_ID_FIELD))).toBe(false)
    expect(lookups.some(([obj, ids]) => obj === SUB && ids.includes(S(0)))).toBe(true)
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.upsertCalls[0]!.records).toEqual([{ [EXTERNAL_ID_FIELD]: ext(S(1)), [REQ]: T(0), attributes: { type: SUB } }])
    expect(by(h.store.relinks, S(1), REQ)).toMatchObject({ outcome: 'relinked', resolvedValue: T(0), targetId: T(1) })
    // S3's own row is not in the map → "not found on the target", never written.
    expect(by(h.store.relinks, S(3), REQ)).toMatchObject({ outcome: 'unresolved', reason: 'this row was not found on the target' })
  })

  it('the keyless adapter reporting rows as unchanged tags them already_current', async () => {
    const pairs = new Map([
      [S(0), T(0)],
      [S(1), T(1)]
    ])
    const idMap: DeployIdMapIo = {
      lookup: async (_obj, ids) => new Map([...ids].filter((i) => pairs.has(i)).map((i) => [i, pairs.get(i)!])),
      record: async () => {},
      existingTargetIds: async () => new Set()
    }
    const h = harness({
      sourceDescribe: subDescribe,
      onQuerySource: () => [{ Id: S(1), [REQ]: S(0), [ROOT]: null }],
      onQueryTarget: () => [{ Id: T(1), [REQ]: 'a0Tstale000000000', [ROOT]: null }],
      onUpsert: (records) => ({ successCount: 1, failureCount: 0, errorDetails: [], failedExternalIds: [], typedErrors: [], unchangedExtIds: records.map((r) => String(r[EXTERNAL_ID_FIELD])) })
    })
    h.io.idMap = idMap
    deployed(h, SUB, [S(0), S(1)])
    await runTextIdRelink(subPlan(), 1, h.io)
    expect(by(h.store.relinks, S(1), REQ)).toMatchObject({ outcome: 'already_current' })
  })
})

describe('textIdRelink — catalog fields (match by name on the target)', () => {
  const QUOTE = 'SBQQ__Quote__c'
  const PB = 'SBQQ__PricebookId__c'
  const Q = (n: number): string => id('a0Q', n)
  const QT = (n: number): string => id('a0q', n)
  const PBS = (n: number): string => id('01s', n) // source pricebooks
  const PBT = (n: number): string => id('01t', n) // target pricebooks
  const quoteDescribe = [fld('Id'), fld(PB)]

  function catalogHarness(targetPricebooks: Array<{ Id: string; Name: string }>) {
    const srcQ: string[] = []
    const h = harness({
      sourceDescribe: quoteDescribe,
      onQuerySource: (soql) => {
        srcQ.push(soql)
        if (soql.includes(`FROM ${QUOTE}`)) return [{ Id: Q(1), [PB]: PBS(1) }, { Id: Q(2), [PB]: PBS(2) }, { Id: Q(3), [PB]: PBS(3) }]
        if (soql.includes('FROM Pricebook2')) return [{ Id: PBS(1), Name: 'Standard' }, { Id: PBS(2), Name: 'Ghost' }, { Id: PBS(3), Name: 'Twins' }]
        return []
      },
      onQueryTarget: (soql) => {
        if (soql.includes(`FROM ${QUOTE}`)) return [1, 2, 3].map((n) => ({ Id: QT(n), [EXTERNAL_ID_FIELD]: ext(Q(n)), [PB]: null }))
        if (soql.includes('FROM Pricebook2')) return targetPricebooks
        return []
      }
    })
    deployed(h, QUOTE, [Q(1), Q(2), Q(3)])
    return { ...h, srcQ }
  }

  it('one target row with the same Name relinks; none → unresolved "no … named"; two → unresolved "ambiguous"', async () => {
    const h = catalogHarness([
      { Id: PBT(1), Name: 'Standard' },
      { Id: PBT(31), Name: 'Twins' },
      { Id: PBT(32), Name: 'Twins' }
    ])
    await runTextIdRelink(planOf(frozenObject(QUOTE, ['Id', PB])), 1, h.io)
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.upsertCalls[0]!.records).toEqual([{ [EXTERNAL_ID_FIELD]: ext(Q(1)), [PB]: PBT(1), attributes: { type: QUOTE } }])
    const L = h.store.relinks
    expect(by(L, Q(1), PB)).toMatchObject({ outcome: 'relinked', resolvedValue: PBT(1), refObject: 'Pricebook2' })
    expect(by(L, Q(2), PB)).toMatchObject({ outcome: 'unresolved', reason: 'no Pricebook2 named "Ghost" on the target' })
    expect(by(L, Q(3), PB)).toMatchObject({ outcome: 'unresolved', reason: '2 Pricebook2 rows named "Twins" on the target (ambiguous)' })
    // The target was asked by Name, the source by Id — one query each.
    expect(h.targetSoqls.filter((q) => q.includes('FROM Pricebook2'))).toHaveLength(1)
    expect(h.srcQ.filter((q) => q.includes('FROM Pricebook2'))).toHaveLength(1)
  })

  it('a source catalog row that no longer exists is unresolved with a reason', async () => {
    const h = harness({
      sourceDescribe: quoteDescribe,
      onQuerySource: (soql) => (soql.includes(`FROM ${QUOTE}`) ? [{ Id: Q(1), [PB]: PBS(9) }] : []),
      onQueryTarget: (soql) => (soql.includes(`FROM ${QUOTE}`) ? [{ Id: QT(1), [EXTERNAL_ID_FIELD]: ext(Q(1)), [PB]: null }] : [])
    })
    deployed(h, QUOTE, [Q(1)])
    await runTextIdRelink(planOf(frozenObject(QUOTE, ['Id', PB])), 1, h.io)
    expect(by(h.store.relinks, Q(1), PB)!.reason).toBe(`source Pricebook2 ${PBS(9)} not found (deleted or not visible)`)
    expect(h.upsertCalls).toHaveLength(0)
  })
})
