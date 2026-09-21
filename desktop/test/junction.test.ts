/**
 * E4E.5 — junction deploy (engine/deploy/junction.ts) vs the frozen Apex
 * `executeJunctionDeploy` (DDQ L764-1017): run-scoped parent divergence,
 * 200-parent-chunked source queries + pagination fidelity, dedupe keys
 * (Role in / IsPrimary out), composite INSERT payload shapes, junction-format
 * error rendering, the per-batch tripwire (nothing persisted), idempotency,
 * and the misconfiguration / error paths.
 */
import { describe, expect, it } from 'vitest'
import {
  makeJunctionPass,
  parentRelationshipName,
  runJunctionPass
} from '../src/main/engine/deploy/junction'
import { EXTERNAL_ID_FIELD, reverse } from '../src/main/engine/deploy/transform/sfid'
import { frozenObject, harness, passCtx, planOf } from './helpers/deployFakes'
import type { FrozenObjectPlan } from '../src/main/engine/deploy/planFreeze'
import type { QueryPage } from '../src/main/engine/deploy/types'

const EXT = EXTERNAL_ID_FIELD
const O1 = '006AAAAAAAAAAAAAAA'
const O2 = '006BBBBBBBBBBBBBBB'
const C1 = '003AAAAAAAAAAAAAAA'
const C2 = '003BBBBBBBBBBBBBBB'
const R1 = '00KAAAAAAAAAAAAAAA'
const R2 = '00KBBBBBBBBBBBBBBB'
const R3 = '00KCCCCCCCCCCCCCCC'

function ocrPlan(over: Partial<FrozenObjectPlan> = {}): FrozenObjectPlan {
  return frozenObject('OpportunityContactRole', [], {
    isJunction: true,
    junctionParents: ['Opportunity', 'Contact'],
    junctionParentFields: ['OpportunityId', 'ContactId'],
    ...over
  })
}

function junctionCtx(io: Parameters<typeof passCtx>[0]): ReturnType<typeof passCtx> {
  return passCtx(io, 'OpportunityContactRole', {
    passKind: 'junction',
    object: {
      objectName: 'OpportunityContactRole',
      sortOrder: 9,
      hasCircularReference: false,
      isJunction: true,
      recordCount: 0
    }
  })
}

/**
 * Seed successfully-deployed Opportunity first-pass rows (the parent scope) and,
 * by default, the two fixture Contacts as written this run. S53 (L3): the
 * junction path no longer fails open when the run wrote no parent2 rows — it
 * probes the target — so a test that wants a contact to count as deployed must
 * say so (the pre-S53 fixtures got that for free from the fail-open).
 */
function seedParents(
  h: ReturnType<typeof harness>,
  ids: string[],
  contacts: string[] = [C1, C2]
): void {
  const row = (objectApiName: string, sourceId: string) => ({
    objectApiName,
    sourceId,
    pass: 1 as const,
    retryPass: 0,
    objectAttempt: 0,
    outcome: 'success' as const
  })
  h.store.recordResults(1, [
    ...ids.map((id) => row('Opportunity', id)),
    ...contacts.map((id) => row('Contact', id))
  ])
}

describe('parentRelationshipName (DDQ L1126-1131)', () => {
  it('maps standard and custom FK fields', () => {
    expect(parentRelationshipName('OpportunityId')).toBe('Opportunity')
    expect(parentRelationshipName('ContactId')).toBe('Contact')
    expect(parentRelationshipName('My_Parent__c')).toBe('My_Parent__r')
    expect(parentRelationshipName('Weird')).toBe('Weird')
    expect(parentRelationshipName(null)).toBeNull()
  })
})

describe('runJunctionPass — guards + short-circuits', () => {
  it('throws for a non-junction object', async () => {
    const h = harness({ sourceDescribe: [] })
    const plan = planOf(frozenObject('Account', ['Id']))
    await expect(
      runJunctionPass(plan, passCtx(h.io, 'Account', { passKind: 'junction' }))
    ).rejects.toThrow('not a junction object')
  })

  it('misconfiguration (≠2 parents): Error log, object ends, no throw (DDQ L774-783)', async () => {
    const h = harness({ sourceDescribe: [] })
    const plan = planOf(
      ocrPlan({ junctionParents: ['Opportunity'], junctionParentFields: ['OpportunityId'] })
    )
    await runJunctionPass(plan, junctionCtx(h.io))
    expect(h.logs).toEqual([
      {
        level: 'Error',
        message:
          'Junction misconfiguration for OpportunityContactRole — v1 supports exactly 2 parents.'
      }
    ])
    expect(h.sourceSoqls).toEqual([])
    expect(h.insertCalls).toEqual([])
  })

  it('empty run-scoped parent set: Info log + skip (DDQ L801-807)', async () => {
    const h = harness({ sourceDescribe: [] })
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.logs).toEqual([
      {
        level: 'Info',
        message:
          'No deployed Opportunity records found on target — skipping junction OpportunityContactRole'
      }
    ])
    expect(h.sourceSoqls).toEqual([])
  })

  it('no source rows: Info log + complete (DDQ L888-894)', async () => {
    const h = harness({ sourceDescribe: [], pages: [{ records: [], totalSize: 0 }] })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.logs).toEqual([
      {
        level: 'Info',
        message: 'No source OpportunityContactRole rows found for in-scope parents.'
      }
    ])
    expect(h.insertCalls).toEqual([])
  })
})

describe('runJunctionPass — queries, dedupe, payloads', () => {
  it('runs the full happy path: source query shape, dedupe skip, payload shape, rows, summary', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [
            { Id: R1, OpportunityId: O1, ContactId: C1, Role: 'Decision Maker', IsPrimary: true },
            { Id: R2, OpportunityId: O1, ContactId: C2, Role: null, IsPrimary: false },
            { Id: R3, OpportunityId: O2, ContactId: null, Role: 'X', IsPrimary: false }
          ],
          totalSize: 3
        }
      ],
      // Target already has the (O1, C2, null-role) row → dedupe skip.
      onQueryTarget: () => [
        {
          Id: '00Kzzzzzzzzzzzzzzz',
          Opportunity: { [EXT]: reverse(O1) },
          Contact: { [EXT]: reverse(C2) },
          Role: null
        }
      ]
    })
    seedParents(h, [O1, O2])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))

    // Source query: OCR fields incl. Role/IsPrimary, parents IN-clause.
    expect(h.sourceSoqls).toEqual([
      `SELECT Id, OpportunityId, ContactId, Role, IsPrimary FROM OpportunityContactRole WHERE OpportunityId IN ('${O1}','${O2}')`
    ])
    // Dedupe query: relationship-traversal ExtIds + Role, parents' ExtIds unescaped.
    expect(h.targetSoqls).toEqual([
      `SELECT Id, Opportunity.${EXT}, Contact.${EXT}, Role FROM OpportunityContactRole WHERE Opportunity.${EXT} IN ('${reverse(O1)}','${reverse(O2)}')`
    ])

    // Payload: attributes → Opportunity → Contact → Role → IsPrimary, byte-ordered.
    expect(h.insertCalls).toHaveLength(1)
    expect(JSON.stringify(h.insertCalls[0]!.records[0])).toBe(
      JSON.stringify({
        attributes: { type: 'OpportunityContactRole' },
        Opportunity: { attributes: { type: 'Opportunity' }, [EXT]: reverse(O1) },
        Contact: { attributes: { type: 'Contact' }, [EXT]: reverse(C1) },
        Role: 'Decision Maker',
        IsPrimary: true
      })
    )

    // Rows: R1 success (with target id), R2 skipped already-on-target,
    // R3 skipped missing FK — all pass-1 family; NO failed_records.
    const rows = h.store.results.filter((r) => r.objectApiName === 'OpportunityContactRole')
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.sourceId === R1)!.outcome).toBe('success')
    expect(rows.find((r) => r.sourceId === R1)!.targetId).toBeTruthy()
    expect(rows.find((r) => r.sourceId === R2)!.outcome).toBe('skipped')
    expect(rows.find((r) => r.sourceId === R2)!.errorMessage).toBe('already on target')
    expect(rows.find((r) => r.sourceId === R3)!.outcome).toBe('skipped')
    expect(rows.find((r) => r.sourceId === R3)!.errorMessage).toBe('missing FK')
    expect(h.store.failures).toEqual([])

    // Apex summary line, byte-exact (String.format L1007-1010).
    expect(h.logs).toEqual([
      {
        level: 'Info',
        message:
          'Junction OpportunityContactRole: 1 succeeded, 0 failed (queried 3, 1 already on target, 1 missing FK)'
      }
    ])
  })

  it('a different Role defeats the dedupe (Role in the key, IsPrimary out)', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [
            { Id: R1, OpportunityId: O1, ContactId: C1, Role: 'Economic Buyer', IsPrimary: false }
          ],
          totalSize: 1
        }
      ],
      // Target row exists for the SAME parents but a different Role — no dedupe.
      // (IsPrimary intentionally differs too: it must not matter.)
      onQueryTarget: () => [
        {
          Id: 'x',
          Opportunity: { [EXT]: reverse(O1) },
          Contact: { [EXT]: reverse(C1) },
          Role: 'Decision Maker'
        }
      ]
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.insertCalls[0]!.records).toHaveLength(1)
  })

  it('idempotent re-run: every source row already on target inserts 0 (the E4V.3 AC shape)', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [
            { Id: R1, OpportunityId: O1, ContactId: C1, Role: 'Decision Maker', IsPrimary: true },
            { Id: R2, OpportunityId: O1, ContactId: C2, Role: null, IsPrimary: false }
          ],
          totalSize: 2
        }
      ],
      onQueryTarget: () => [
        {
          Id: 'a',
          Opportunity: { [EXT]: reverse(O1) },
          Contact: { [EXT]: reverse(C1) },
          Role: 'Decision Maker'
        },
        {
          Id: 'b',
          Opportunity: { [EXT]: reverse(O1) },
          Contact: { [EXT]: reverse(C2) },
          Role: null
        }
      ]
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.insertCalls).toEqual([])
    expect(h.logs.at(-1)).toEqual({
      level: 'Info',
      message:
        'Junction OpportunityContactRole: 0 succeeded, 0 failed (queried 2, 2 already on target, 0 missing FK)'
    })
  })

  it('chunks the parent IN clause at 200 ids and the dedupe ExtIds at 100', async () => {
    const parents = Array.from({ length: 201 }, (_, i) => `006${String(i).padStart(15, '0')}`)
    const h = harness({
      sourceDescribe: [],
      onQuerySourcePages: () => [{ records: [], totalSize: 0 }]
    })
    seedParents(h, parents)
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.sourceSoqls).toHaveLength(2) // 200 + 1
    expect(h.sourceSoqls[1]).toContain(`'${parents[200]}'`)
    // Both chunks empty → 'No source rows' — dedupe never queried.
    expect(h.targetSoqls).toEqual([])
  })

  it('custom-field parents render __r traversal payloads', async () => {
    const J1 = 'a00AAAAAAAAAAAAAAA'
    const P = 'a01AAAAAAAAAAAAAAA'
    const Q = 'a02AAAAAAAAAAAAAAA'
    const plan = planOf(
      frozenObject('My_Junction__c', [], {
        isJunction: true,
        junctionParents: ['Parent_A__c', 'Parent_B__c'],
        junctionParentFields: ['A_Ref__c', 'B_Ref__c']
      })
    )
    const h = harness({
      sourceDescribe: [],
      pages: [{ records: [{ Id: J1, A_Ref__c: P, B_Ref__c: Q }], totalSize: 1 }]
    })
    h.store.recordResults(1, [
      {
        objectApiName: 'Parent_A__c',
        sourceId: P,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      },
      // S53 (L3): parent2 must be written this run (or on target) to be inserted.
      {
        objectApiName: 'Parent_B__c',
        sourceId: Q,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      }
    ])
    await runJunctionPass(
      plan,
      passCtx(h.io, 'My_Junction__c', {
        passKind: 'junction',
        object: {
          objectName: 'My_Junction__c',
          sortOrder: 5,
          hasCircularReference: false,
          isJunction: true,
          recordCount: 0
        }
      })
    )
    // No Role/IsPrimary on a non-OCR junction; __c fields → __r traversals.
    expect(h.sourceSoqls[0]).toBe(
      `SELECT Id, A_Ref__c, B_Ref__c FROM My_Junction__c WHERE A_Ref__c IN ('${P}')`
    )
    expect(JSON.stringify(h.insertCalls[0]!.records[0])).toBe(
      JSON.stringify({
        attributes: { type: 'My_Junction__c' },
        A_Ref__r: { attributes: { type: 'Parent_A__c' }, [EXT]: reverse(P) },
        B_Ref__r: { attributes: { type: 'Parent_B__c' }, [EXT]: reverse(Q) }
      })
    )
    // Dedupe rel names derive from {parentObject}Id → __c parents keep the raw name.
    expect(h.targetSoqls[0]).toContain('Parent_A__cId'.slice(0, -2)) // 'Parent_A__c'
  })
})

describe('runJunctionPass — failures, batching, tripwire', () => {
  const onePage = (): QueryPage[] => [
    {
      records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: 'X', IsPrimary: false }],
      totalSize: 1
    }
  ]

  it('renders per-record failures junction-style (CODE: message) and counts them root via rows', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: onePage(),
      onInsert: () => ({
        ok: true,
        results: [
          {
            success: false,
            id: null,
            errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'duplicate found', fields: [] }]
          }
        ]
      })
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    const row = h.store.results.find((r) => r.sourceId === R1)!
    expect(row.outcome).toBe('failed')
    expect(row.errorCode).toBe('DUPLICATE_VALUE')
    expect(row.errorMessage).toBe('DUPLICATE_VALUE: duplicate found')
    expect(h.store.failures).toEqual([]) // junctions never feed the classifier/retry
    expect(h.logs.at(-1)).toEqual({
      level: 'Warning',
      message:
        'Junction OpportunityContactRole: 0 succeeded, 1 failed (queried 1, 0 already on target, 0 missing FK)',
      detail: 'DUPLICATE_VALUE: duplicate found'
    })
  })

  it('a failed record with EMPTY errors[] counts but adds no detail line (DDQ L975-980)', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: onePage(),
      onInsert: () => ({ ok: true, results: [{ success: false, id: null, errors: [] }] })
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    const last = h.logs.at(-1)!
    expect(last.message).toContain('0 succeeded, 1 failed')
    expect(last.detail).toBeUndefined()
  })

  it('whole-batch callout failure: batch counted failed with the Batch N line, loop continues (DDQ L962-966)', async () => {
    const records = Array.from({ length: 201 }, (_, i) => ({
      Id: `00K${String(i).padStart(15, '0')}`,
      OpportunityId: O1,
      ContactId: C1,
      Role: `r${i}`, // unique roles defeat cross-record dedupe
      IsPrimary: false
    }))
    const h = harness({
      sourceDescribe: [],
      pages: [{ records, totalSize: records.length }],
      onInsert: (batch, call) =>
        call === 0
          ? { ok: false, errorMessage: 'x'.repeat(300) }
          : { ok: true, results: batch.map(() => ({ success: true, id: 'ok', errors: [] })) }
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.insertCalls).toHaveLength(2) // 200 + 1 — the failure did not stop the loop
    const last = h.logs.at(-1)!
    expect(last.message).toBe(
      'Junction OpportunityContactRole: 1 succeeded, 200 failed (queried 201, 0 already on target, 0 missing FK)'
    )
    // Batch index + left(200) truncation, byte-exact.
    expect(last.detail).toBe('Batch 0 callout failed: ' + 'x'.repeat(200))
    // Every record of the failed batch got a failed row.
    expect(h.store.results.filter((r) => r.outcome === 'failed')).toHaveLength(200)
  })

  it('CPQ tripwire: throws before the next batch and persists NOTHING (Apex wrote counters only at completion)', async () => {
    const records = Array.from({ length: 201 }, (_, i) => ({
      Id: `00K${String(i).padStart(15, '0')}`,
      OpportunityId: O1,
      ContactId: C1,
      Role: `r${i}`,
      IsPrimary: false
    }))
    const h = harness({
      sourceDescribe: [],
      pages: [{ records, totalSize: records.length }],
      onInsert: () => ({
        ok: true,
        results: [
          {
            success: false,
            id: null,
            errors: [
              {
                statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
                message: 'SBQQ.QuoteTrigger: boom',
                fields: []
              }
            ]
          }
        ]
      })
    })
    seedParents(h, [O1])
    await expect(runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))).rejects.toMatchObject({
      name: 'CpqTriggersActiveError',
      message:
        'CPQ managed triggers fired on the target while loading OpportunityContactRole — ' +
        '"Triggers Disabled" is not checked. Original error: ' +
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SBQQ.QuoteTrigger: boom'
    })
    expect(h.insertCalls).toHaveLength(1) // second batch never dispatched
    // Nothing persisted on the tripwire path (only the seeded parent rows exist).
    expect(h.store.results.filter((r) => r.objectApiName === 'OpportunityContactRole')).toEqual([])
  })

  it('first-page source-query failure rethrows into the bounded whole-object retry', async () => {
    const h = harness({
      sourceDescribe: [],
      onQuerySourcePages: () => {
        throw new Error('boom on page 1')
      }
    })
    seedParents(h, [O1])
    await expect(runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))).rejects.toThrow(
      'boom on page 1'
    )
  })

  it('continuation-page failure abandons the object with the pagination Error log (DDQ L871-879)', async () => {
    const h = harness({ sourceDescribe: [] })
    const io = {
      ...h.io,
      querySourcePages: (): AsyncIterable<QueryPage> =>
        (async function* (): AsyncGenerator<QueryPage> {
          yield {
            records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: 'X', IsPrimary: false }],
            totalSize: 2
          }
          throw new Error('cursor expired')
        })()
    }
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(io))
    expect(h.logs).toEqual([
      {
        level: 'Error',
        message: 'Junction source pagination failed for OpportunityContactRole: cursor expired'
      }
    ])
    expect(h.insertCalls).toEqual([])
    expect(h.store.results.filter((r) => r.objectApiName === 'OpportunityContactRole')).toEqual([])
  })

  it('dedupe target-query failure propagates (bounded retry — DDQ L1098-1103)', async () => {
    const h = harness({ sourceDescribe: [], pages: onePage() })
    const io = {
      ...h.io,
      queryTarget: (): AsyncIterable<Record<string, unknown>> =>
        (async function* (): AsyncGenerator<Record<string, unknown>> {
          throw new Error('target 500')
          yield {} // unreachable; satisfies require-yield
        })()
    }
    seedParents(h, [O1])
    await expect(runJunctionPass(planOf(ocrPlan()), junctionCtx(io))).rejects.toThrow('target 500')
  })

  it("does NOT tripwire on a callout-failed batch's own detail (the Apex continue — review wf_8a5828d1)", async () => {
    // The final (only) batch fails at the HTTP level with 'SBQQ.' in the
    // message: the Apex `continue` skipped the scan, so the run does NOT fail —
    // the batch is just counted failed.
    const h = harness({
      sourceDescribe: [],
      pages: onePage(),
      onInsert: () => ({ ok: false, errorMessage: 'SBQQ.QuoteTrigger: exploded upstream' })
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.logs.at(-1)!.message).toContain('0 succeeded, 1 failed')
    expect(h.logs.at(-1)!.detail).toContain('Batch 0 callout failed: SBQQ.QuoteTrigger')
  })

  it("a LATER successful batch's scan still tripwires on the earlier callout-failure detail (accumulated scan)", async () => {
    const records = Array.from({ length: 201 }, (_, i) => ({
      Id: `00K${String(i).padStart(15, '0')}`,
      OpportunityId: O1,
      ContactId: C1,
      Role: `r${i}`,
      IsPrimary: false
    }))
    const h = harness({
      sourceDescribe: [],
      pages: [{ records, totalSize: records.length }],
      onInsert: (batch, call) =>
        call === 0
          ? { ok: false, errorMessage: 'SBQQ.QuoteTrigger: exploded' }
          : { ok: true, results: batch.map(() => ({ success: true, id: 'ok', errors: [] })) }
    })
    seedParents(h, [O1])
    await expect(runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))).rejects.toMatchObject({
      name: 'CpqTriggersActiveError'
    })
    expect(h.insertCalls).toHaveLength(2) // batch 1 dispatched, THEN the scan fired
  })

  it('locale-groups summary counts ≥1,000 like Apex String.format (MessageFormat)', async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({
      Id: `00K${String(i).padStart(15, '0')}`,
      OpportunityId: O1,
      ContactId: null, // all missing-FK → skipped; no inserts
      Role: 'X',
      IsPrimary: false
    }))
    const h = harness({ sourceDescribe: [], pages: [{ records, totalSize: records.length }] })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.logs.at(-1)!.message).toBe(
      'Junction OpportunityContactRole: 0 succeeded, 0 failed (queried 1,001, 0 already on target, 1,001 missing FK)'
    )
  })

  it('sends IsPrimary=false and Role empty-string explicitly (Apex != null gate, mutation pin)', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: '', IsPrimary: false }],
          totalSize: 1
        }
      ]
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(JSON.stringify(h.insertCalls[0]!.records[0])).toBe(
      JSON.stringify({
        attributes: { type: 'OpportunityContactRole' },
        Opportunity: { attributes: { type: 'Opportunity' }, [EXT]: reverse(O1) },
        Contact: { attributes: { type: 'Contact' }, [EXT]: reverse(C1) },
        Role: '',
        IsPrimary: false
      })
    )
  })

  // S50 (B1). WAS: 'stops following continuation pages at the 50k source-row
  // cap (check AFTER append, BEFORE next fetch)' — which asserted the DEFECT.
  // The old check ran after the push and returned "not abandoned", so the
  // caller's chunk loop continued: the current chunk's remaining pages were
  // dropped, every LATER chunk still contributed one more page before tripping
  // again, nothing was logged, and the summary printed the truncated number as
  // though it were the total ('queried 50,000' of a real 60,000).
  it('ABANDONS loudly at the 50k source-row cap instead of truncating silently', async () => {
    const mkRows = (n: number, offset: number): Array<Record<string, unknown>> =>
      Array.from({ length: n }, (_, i) => ({
        Id: `00K${String(offset + i).padStart(15, '0')}`,
        OpportunityId: O1,
        ContactId: null, // missing FK → all skipped, no dedupe/insert work
        Role: 'X',
        IsPrimary: false
      }))
    let page3Pulled = false
    const h = harness({ sourceDescribe: [] })
    const io = {
      ...h.io,
      querySourcePages: (): AsyncIterable<QueryPage> =>
        (async function* (): AsyncGenerator<QueryPage> {
          yield { records: mkRows(25000, 0), totalSize: 60000 }
          yield { records: mkRows(25000, 25000), totalSize: 60000 }
          page3Pulled = true
          yield { records: mkRows(10000, 50000), totalSize: 60000 }
        })()
    }
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(io))

    // Still no wasted fetch — the cap is checked at the top of the loop.
    expect(page3Pulled).toBe(false)

    // Loud, and specific about what to do about it.
    const last = h.logs.at(-1)!
    expect(last.level).toBe('Error')
    expect(last.message).toContain('hit the 50,000-row cap')
    expect(last.message).toContain('NOTHING was deployed')
    expect(last.message).toContain('Narrow the scope')

    // And critically: no batch-result line claiming a truncated total as the
    // real one. Abandoning writes nothing rather than reporting a wrong number.
    expect(h.logs.some((l) => l.message.includes('queried 50,000'))).toBe(false)
    // (h.store.results still holds the seeded PARENT rows — assert no junction
    // rows specifically.)
    expect(h.store.results.filter((r) => r.objectApiName === 'OpportunityContactRole')).toEqual([])
  })

  it('makeJunctionPass closes over the plan', async () => {
    const h = harness({ sourceDescribe: [] })
    const exec = makeJunctionPass(planOf(ocrPlan()))
    await exec(junctionCtx(h.io))
    expect(h.logs[0]!.message).toContain('No deployed Opportunity records')
  })
})

describe('runJunctionPass — S49 (BUG-7): carries every planned field, not just Role/IsPrimary', () => {
  it('queries AND writes planned custom fields', async () => {
    // Live loss this covers: 26 of one account's 52 source OCRs had NektarActions__c
    // populated; all 51 rows the junction path wrote to sb1_830 had it blank,
    // because the field list was hardcoded to Role/IsPrimary.
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [
            {
              Id: R1,
              OpportunityId: O1,
              ContactId: C1,
              Role: 'Decision Maker',
              IsPrimary: true,
              NektarActions__c: 'emailed',
              Influence__c: 'High'
            }
          ],
          totalSize: 1
        }
      ],
      onQueryTarget: () => []
    })
    seedParents(h, [O1])
    const plan = ocrPlan({
      fields: [
        'OpportunityId',
        'ContactId',
        'Role',
        'IsPrimary',
        'NektarActions__c',
        'Influence__c'
      ]
    })
    await runJunctionPass(planOf(plan), junctionCtx(h.io))

    // parent FKs + Id are not duplicated; every other planned field is queried
    expect(h.sourceSoqls[0]).toBe(
      `SELECT Id, OpportunityId, ContactId, Role, IsPrimary, NektarActions__c, Influence__c ` +
        `FROM OpportunityContactRole WHERE OpportunityId IN ('${O1}')`
    )
    // and every one of them reaches the insert payload
    expect(h.insertCalls).toHaveLength(1)
    expect(h.insertCalls[0]!.records[0]).toMatchObject({
      Role: 'Decision Maker',
      IsPrimary: true,
      NektarActions__c: 'emailed',
      Influence__c: 'High'
    })
  })

  it('falls back to Role/IsPrimary for a stale plan with no fields (old auto-injected plans)', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: 'X', IsPrimary: false }],
          totalSize: 1
        }
      ],
      onQueryTarget: () => []
    })
    seedParents(h, [O1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.sourceSoqls[0]).toBe(
      `SELECT Id, OpportunityId, ContactId, Role, IsPrimary FROM OpportunityContactRole ` +
        `WHERE OpportunityId IN ('${O1}')`
    )
  })
})

describe('runJunctionPass — S49 (BUG-2): parent2 outside scope is skipped, not failed', () => {
  /** Seed successfully-deployed rows for an arbitrary object (parent2 scope). */
  function seedObject(h: ReturnType<typeof harness>, objectApiName: string, ids: string[]): void {
    h.store.recordResults(
      1,
      ids.map((sourceId) => ({
        objectApiName,
        sourceId,
        pass: 1 as const,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success' as const
      }))
    )
  }

  it('skips a row whose Contact was never deployed', async () => {
    // Live case: an OCR Executive Sponsor contact belonged to a
    // DIFFERENT account, so no Contact was written, yet the engine still emitted
    // an ExtId FK for it -> INVALID_FIELD on the whole record.
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [
            { Id: R1, OpportunityId: O1, ContactId: C1, Role: 'in scope', IsPrimary: false },
            { Id: R2, OpportunityId: O1, ContactId: C2, Role: 'OUT of scope', IsPrimary: false }
          ],
          totalSize: 2
        }
      ],
      onQueryTarget: () => []
    })
    seedParents(h, [O1], []) // C2 deliberately absent — only C1 is written this run
    seedObject(h, 'Contact', [C1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))

    expect(h.insertCalls).toHaveLength(1)
    expect(h.insertCalls[0]!.records).toHaveLength(1)
    const rows = h.store.results.filter((r) => r.objectApiName === 'OpportunityContactRole')
    const skipped = rows.filter((r) => r.outcome === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.sourceId).toBe(R2)
    expect(skipped[0]!.errorMessage).toContain('referenced_parent_out_of_scope')
  })

  // ── S53 (L3): the empty-set fail-open is gone; the TARGET is asked instead ──
  const probeFor =
    (obj: string) =>
    (soql: string): boolean =>
      soql.startsWith(`SELECT ${EXT} FROM ${obj} WHERE ${EXT} IN (`)

  it('a Contact the run did not write but that IS on target (earlier run) still inserts', async () => {
    const targetSoqls: string[] = []
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: 'x', IsPrimary: false }],
          totalSize: 1
        }
      ],
      onQueryTarget: (soql) => {
        targetSoqls.push(soql)
        // The probe finds C1's ExtId on target; the dedupe query finds nothing.
        return probeFor('Contact')(soql) ? [{ [EXT]: reverse(C1) }] : []
      }
    })
    seedParents(h, [O1], []) // no Contact rows written this run
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.insertCalls[0]!.records).toHaveLength(1)
    expect(h.store.results.filter((r) => r.outcome === 'skipped')).toHaveLength(0)
    const probe = targetSoqls.find(probeFor('Contact'))!
    expect(probe).toBe(`SELECT ${EXT} FROM Contact WHERE ${EXT} IN ('${reverse(C1)}')`)
  })

  it('L3 (run 16): the run wrote no Contacts AND the contact is not on target → SKIPPED, never sent', async () => {
    // Live case: Contact in the plan, 0 rows; its one OCR points at a PRIVATE
    // contact (AccountId null). S49 sent it and the API answered INVALID_FIELD.
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [
            { Id: R1, OpportunityId: O1, ContactId: C1, Role: 'Economic Buyer', IsPrimary: false }
          ],
          totalSize: 1
        }
      ],
      onQueryTarget: () => [] // neither the probe nor the dedupe query finds anything
    })
    seedParents(h, [O1], [])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(h.insertCalls).toHaveLength(0) // nothing to send — no composite call at all
    const rows = h.store.results.filter((r) => r.objectApiName === 'OpportunityContactRole')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceId: R1, outcome: 'skipped' })
    expect(rows[0]!.errorMessage).toBe(
      `referenced_parent_out_of_scope (Contact ${C1} not in this deployment and not on target)`
    )
    expect(h.logs.some((l) => l.message.includes('1 Contact out of scope'))).toBe(true)
  })

  it('probes ONLY the parent2 ids this run did not write, in 100-id chunks; none written ⇒ none probed', async () => {
    const targetSoqls: string[] = []
    const contacts = Array.from({ length: 150 }, (_, i) => '003' + String(i).padStart(15, '0'))
    const records = contacts.map((c, i) => ({
      Id: '00K' + String(i).padStart(15, '0'),
      OpportunityId: O1,
      ContactId: c,
      Role: 'r',
      IsPrimary: false
    }))
    const h = harness({
      sourceDescribe: [],
      pages: [{ records, totalSize: records.length }],
      onQueryTarget: (soql) => {
        targetSoqls.push(soql)
        return []
      }
    })
    seedParents(h, [O1], contacts.slice(0, 40)) // 40 written this run, 110 not
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    const probes = targetSoqls.filter(probeFor('Contact'))
    expect(probes).toHaveLength(2) // 110 candidates → 100 + 10
    expect(probes[0]!.match(/'/g)!.length / 2).toBe(100)
    expect(probes[1]!.match(/'/g)!.length / 2).toBe(10)
    for (const c of contacts.slice(0, 40)) expect(probes.join(' ')).not.toContain(reverse(c))
    // 40 inserted, 110 skipped out of scope
    expect(h.insertCalls[0]!.records).toHaveLength(40)
    expect(h.store.results.filter((r) => r.outcome === 'skipped')).toHaveLength(110)
  })

  it('every parent2 written this run ⇒ zero probe queries (the common case costs nothing)', async () => {
    const targetSoqls: string[] = []
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: 'x', IsPrimary: false }],
          totalSize: 1
        }
      ],
      onQueryTarget: (soql) => {
        targetSoqls.push(soql)
        return []
      }
    })
    seedParents(h, [O1], [C1])
    await runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))
    expect(targetSoqls.filter(probeFor('Contact'))).toHaveLength(0)
    expect(h.insertCalls[0]!.records).toHaveLength(1)
  })

  it('a probe failure propagates into the bounded whole-object retry (never a silent skip)', async () => {
    const h = harness({
      sourceDescribe: [],
      pages: [
        {
          records: [{ Id: R1, OpportunityId: O1, ContactId: C1, Role: 'x', IsPrimary: false }],
          totalSize: 1
        }
      ],
      onQueryTarget: (soql) => {
        if (probeFor('Contact')(soql)) throw new Error('probe failed')
        return []
      }
    })
    seedParents(h, [O1], [])
    await expect(runJunctionPass(planOf(ocrPlan()), junctionCtx(h.io))).rejects.toThrow(
      'probe failed'
    )
    expect(h.insertCalls).toHaveLength(0)
  })
})
