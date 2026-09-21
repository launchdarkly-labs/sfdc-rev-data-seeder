/**
 * E4E.4 — deferred-field second pass (engine/deploy/secondPass.ts) vs the
 * frozen Apex `executeSecondPassV2` (DDQ L522-737): payload shapes + key
 * order, strategy dispatch, the run-materialized scope divergence, updateOnly
 * transport contract, pass-2 row/counter inertness, the empty-patch
 * markObjectComplete quirk, cancel, and the tripwire.
 */
import { describe, expect, it } from 'vitest'
import { makeSecondPass, runSecondPass } from '../src/main/engine/deploy/secondPass'
import { CpqTriggersActiveError } from '../src/main/engine/deploy/cpqTripwire'
import { EXTERNAL_ID_FIELD, reverse } from '../src/main/engine/deploy/transform/sfid'
import { fld, frozenObject, harness, passCtx, planOf } from './helpers/deployFakes'
import type { FrozenObjectPlan } from '../src/main/engine/deploy/planFreeze'
import type { UpsertBatchResult } from '../src/main/engine/deploy/types'

const A1 = '001AAAAAAAAAAAAAAA'
const A2 = '001BBBBBBBBBBBBBBB'
const P1 = '001PPPPPPPPPPPPPPP'
const EXT = EXTERNAL_ID_FIELD

/**
 * Strip-probe fake: echo every ExtId the probe asked about, i.e. "all parents
 * ARE on target" — the normal case. Needed since S49 (BUG-11) made the second
 * pass probe SELF-references too; tests that are about query shape, chunking
 * or row-writing want the strip to be a no-op so it stays out of their way.
 */
const parentsOnTarget = (soql: string): Array<Record<string, unknown>> =>
  [...soql.matchAll(/'([^']+)'/g)].map((m) => ({ [EXT]: m[1]! }))

/** Account with a deferred self-ref ParentId mapped externalId. */
function accountPlan(over: Partial<FrozenObjectPlan> = {}): FrozenObjectPlan {
  return frozenObject('Account', ['Id', 'Name', 'ParentId'], {
    hasCircularReference: true,
    deferredFields: ['ParentId'],
    mappings: { ParentId: { strategy: 'externalId', matchField: null, customValue: null } },
    ...over
  })
}

const accountDescribe = [
  fld('Id', { isCreateable: false }),
  fld('Name'),
  fld('ParentId', { isReference: true, referenceTo: ['Account'], relationshipName: 'Parent' })
]

function seedFirstPass(h: ReturnType<typeof harness>, objectName: string, ids: string[]): void {
  h.store.recordResults(
    1,
    ids.map((sourceId) => ({
      objectApiName: objectName,
      sourceId,
      pass: 1 as const,
      retryPass: 0,
      objectAttempt: 0,
      outcome: 'success' as const
    }))
  )
}

describe('runSecondPass — guards', () => {
  it('throws when the object is not in the frozen plan', async () => {
    const h = harness({ sourceDescribe: accountDescribe })
    await expect(
      runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Contact', { passKind: 'second' }))
    ).rejects.toThrow('No frozen plan object for Contact')
  })

  it('refuses junction objects', async () => {
    const h = harness({ sourceDescribe: accountDescribe })
    const plan = planOf(frozenObject('OpportunityContactRole', [], { isJunction: true }))
    await expect(
      runSecondPass(plan, passCtx(h.io, 'OpportunityContactRole', { passKind: 'second' }))
    ).rejects.toThrow('junctions have no second pass')
  })

  it('no-ops silently when the frozen deferred set is empty (DDQ L364-368)', async () => {
    const h = harness({ sourceDescribe: accountDescribe })
    const plan = planOf(accountPlan({ deferredFields: [] }))
    await runSecondPass(plan, passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.sourceSoqls).toEqual([])
    expect(h.upsertCalls).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('no-ops when the run has no first-pass scope rows for the object', async () => {
    const h = harness({ sourceDescribe: accountDescribe })
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.sourceSoqls).toEqual([])
    expect(h.upsertCalls).toEqual([])
  })
})

describe('runSecondPass — query + payloads (externalId strategy)', () => {
  it('builds the deferred-only query scoped to the run-materialized ids and byte-shapes the payloads', async () => {
    const h = harness({
      onQueryTarget: parentsOnTarget,
      sourceDescribe: accountDescribe,
      pages: [
        {
          records: [
            { Id: A1, ParentId: P1 },
            { Id: A2, ParentId: P1 }
          ],
          totalSize: 2
        }
      ]
    })
    seedFirstPass(h, 'Account', [A1, A2])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))

    expect(h.sourceSoqls).toHaveLength(1)
    expect(h.sourceSoqls[0]).toBe(
      `SELECT Id, ParentId FROM Account WHERE (ParentId != null) AND Id IN ('${A1}','${A2}')`
    )

    // Payload: self ExtId FIRST, then the deferred relationship traversal, then
    // the attributes stamp — JSON key order matches the Apex map insertion.
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.upsertCalls[0]!.batchSize).toBe(200)
    expect(JSON.stringify(h.upsertCalls[0]!.records[0])).toBe(
      JSON.stringify({
        [EXT]: reverse(A1),
        Parent: { [EXT]: reverse(P1) },
        attributes: { type: 'Account' }
      })
    )

    // Apex batch log line, byte-exact.
    expect(h.logs).toEqual([
      {
        level: 'Info',
        message: 'V2 second pass REST batch 0 (updateOnly=true): 2 succeeded, 0 failed for Account'
      }
    ])
  })

  it('always upserts with updateOnly=true — even when the plan strategy is Bulk', async () => {
    const upsertOpts: Array<{ updateOnly: boolean }> = []
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [{ records: [{ Id: A1, ParentId: P1 }], totalSize: 1 }]
    })
    const io = {
      ...h.io,
      upsertBatch: (
        objectName: string,
        records: Array<Record<string, unknown>>,
        o: { updateOnly: boolean; batchSize: number | null }
      ): Promise<UpsertBatchResult> => {
        upsertOpts.push({ updateOnly: o.updateOnly })
        return h.io.upsertBatch(objectName, records, o)
      }
    }
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(
      planOf(accountPlan({ apiStrategy: 'Bulk' })),
      passCtx(io, 'Account', { passKind: 'second' })
    )
    expect(upsertOpts).toEqual([{ updateOnly: true }])
  })

  it('drops records whose deferred fields are all null (hasUpdate gate) and abandons the walk when a page has none (DDQ L684-688)', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [
        { records: [{ Id: A1, ParentId: null }], totalSize: 2 },
        { records: [{ Id: A2, ParentId: P1 }], totalSize: 2 }
      ]
    })
    seedFirstPass(h, 'Account', [A1, A2])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    // Page 1 produced zero patch records → object DONE, page 2 never processed.
    expect(h.upsertCalls).toEqual([])
    expect(h.logs).toEqual([])
    expect(h.store.results.filter((r) => r.pass === 2)).toEqual([])
  })

  it('a mixed page keeps only hasUpdate records', async () => {
    const h = harness({
      onQueryTarget: parentsOnTarget,
      sourceDescribe: accountDescribe,
      pages: [
        {
          records: [
            { Id: A1, ParentId: null },
            { Id: A2, ParentId: P1 }
          ],
          totalSize: 2
        }
      ]
    })
    seedFirstPass(h, 'Account', [A1, A2])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.upsertCalls[0]!.records).toHaveLength(1)
    expect(h.logs[0]!.message).toBe(
      'V2 second pass REST batch 0 (updateOnly=true): 1 succeeded, 0 failed for Account'
    )
  })

  it('ends the object silently on an empty page (no first-pass skip line)', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [{ records: [], totalSize: 0 }]
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.upsertCalls).toEqual([])
    expect(h.logs).toEqual([]) // Apex L604-608 logs nothing
  })
})

describe('runSecondPass — strategy dispatch (DDQ L631-676)', () => {
  const describeWith = (over: Partial<Parameters<typeof fld>[1]> = {}) => [
    fld('Id', { isCreateable: false }),
    fld('OwnerId', {
      isReference: true,
      referenceTo: ['User'],
      relationshipName: 'Owner',
      ...over
    })
  ]
  const planWith = (strategy: string, extra: Record<string, unknown> = {}): FrozenObjectPlan =>
    frozenObject('Account', ['Id', 'OwnerId'], {
      hasCircularReference: true,
      deferredFields: ['OwnerId'],
      mappings: {
        OwnerId: { strategy, matchField: null, customValue: null, ...extra } as never
      }
    })
  const U1 = '005UUUUUUUUUUUUUUU'
  const U2 = '005VVVVVVVVVVVVVVV'

  it('nameMatch: builds the map for deferred nameMatch refs and writes the mapped target id', async () => {
    const h = harness({
      sourceDescribe: describeWith(),
      pages: [{ records: [{ Id: A1, OwnerId: U1 }], totalSize: 1 }],
      onQuerySource: (soql) =>
        soql.includes('FROM User') ? [{ Id: U1, Name: 'Jack' }] : undefined,
      onQueryTarget: (soql) =>
        soql.includes('FROM User') ? [{ Id: U2, Name: 'Jack' }] : undefined
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(
      planOf(planWith('nameMatch', { matchField: 'Name' })),
      passCtx(h.io, 'Account', { passKind: 'second' })
    )
    expect(h.upsertCalls[0]!.records[0]!['OwnerId']).toBe(U2)
    expect(h.upsertCalls[0]!.records[0]!['Owner']).toBeUndefined()
  })

  it('nameMatch: an unmapped source value contributes nothing (record dropped when alone)', async () => {
    const h = harness({
      sourceDescribe: describeWith(),
      pages: [{ records: [{ Id: A1, OwnerId: U1 }], totalSize: 1 }],
      onQuerySource: (soql) =>
        soql.includes('FROM User') ? [{ Id: U1, Name: 'Jack' }] : undefined,
      onQueryTarget: (soql) => (soql.includes('FROM User') ? [] : undefined)
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(
      planOf(planWith('nameMatch', { matchField: 'Name' })),
      passCtx(h.io, 'Account', { passKind: 'second' })
    )
    expect(h.upsertCalls).toEqual([]) // no hasUpdate → the L684-688 early complete
  })

  it('directId: writes the raw source lookup id onto the FIELD', async () => {
    const h = harness({
      sourceDescribe: describeWith(),
      pages: [{ records: [{ Id: A1, OwnerId: U1 }], totalSize: 1 }]
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(planOf(planWith('directId')), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.upsertCalls[0]!.records[0]!['OwnerId']).toBe(U1)
  })

  it('customId: writes the custom value; blank custom value contributes nothing', async () => {
    const h = harness({
      sourceDescribe: describeWith(),
      pages: [{ records: [{ Id: A1, OwnerId: U1 }], totalSize: 1 }]
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(
      planOf(planWith('customId', { customValue: U2 })),
      passCtx(h.io, 'Account', { passKind: 'second' })
    )
    expect(h.upsertCalls[0]!.records[0]!['OwnerId']).toBe(U2)

    const h2 = harness({
      sourceDescribe: describeWith(),
      pages: [{ records: [{ Id: A1, OwnerId: U1 }], totalSize: 1 }]
    })
    seedFirstPass(h2, 'Account', [A1])
    await runSecondPass(
      planOf(planWith('customId', { customValue: ' ' })),
      passCtx(h2.io, 'Account', { passKind: 'second' })
    )
    expect(h2.upsertCalls).toEqual([])
  })

  it('an unmapped deferred ref defaults to externalId (DDQ L632)', async () => {
    const h = harness({
      sourceDescribe: describeWith(),
      pages: [{ records: [{ Id: A1, OwnerId: U1 }], totalSize: 1 }],
      // The cross-object strip probes User on target — the parent exists.
      onQueryTarget: (soql) =>
        soql.includes('FROM User') ? [{ [EXT]: reverse(U1) }] : undefined
    })
    seedFirstPass(h, 'Account', [A1])
    const plan = planOf(
      frozenObject('Account', ['Id', 'OwnerId'], {
        hasCircularReference: true,
        deferredFields: ['OwnerId'],
        mappings: {}
      })
    )
    await runSecondPass(plan, passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(JSON.stringify(h.upsertCalls[0]!.records[0]!['Owner'])).toBe(
      JSON.stringify({ [EXT]: reverse(U1) })
    )
  })
})

describe('runSecondPass — rows, chunking, cancel, tripwire', () => {
  it('writes pass-2 audit rows only — counters and failed_records stay untouched', async () => {
    const failedExt = reverse(A2)
    const h = harness({
      onQueryTarget: parentsOnTarget,
      sourceDescribe: accountDescribe,
      pages: [
        {
          records: [
            { Id: A1, ParentId: P1 },
            { Id: A2, ParentId: P1 }
          ],
          totalSize: 2
        }
      ],
      onUpsert: (records) => ({
        successCount: records.length - 1,
        failureCount: 1,
        errorDetails: [`${failedExt} → ENTITY_IS_LOCKED: locked; `],
        failedExternalIds: [failedExt],
        typedErrors: [
          { extId: failedExt, statusCode: 'ENTITY_IS_LOCKED', message: 'locked', fields: [] }
        ]
      })
    })
    seedFirstPass(h, 'Account', [A1, A2])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))

    const pass2 = h.store.results.filter((r) => r.pass === 2)
    expect(pass2).toHaveLength(2)
    expect(pass2.find((r) => r.sourceId === A1)!.outcome).toBe('success')
    const failedRow = pass2.find((r) => r.sourceId === A2)!
    expect(failedRow.outcome).toBe('failed')
    expect(failedRow.errorCode).toBe('ENTITY_IS_LOCKED')
    expect(failedRow.errorMessage).toBe('ENTITY_IS_LOCKED: locked')
    // failed_records is first-pass-family only.
    expect(h.store.failures).toEqual([])
    // Batch line escalates to Warning and carries the error detail.
    expect(h.logs[0]).toEqual({
      level: 'Warning',
      message: 'V2 second pass REST batch 0 (updateOnly=true): 1 succeeded, 1 failed for Account',
      detail: `${failedExt} → ENTITY_IS_LOCKED: locked; `
    })
  })

  it('first-pass counter inertness: pass-2 rows never change the seeded first-pass outcomes', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [{ records: [{ Id: A1, ParentId: P1 }], totalSize: 1 }],
      onUpsert: () => ({
        successCount: 0,
        failureCount: 1,
        errorDetails: [`${reverse(A1)} → X: y; `],
        failedExternalIds: [reverse(A1)],
        typedErrors: [{ extId: reverse(A1), statusCode: 'X', message: 'y', fields: [] }]
      })
    })
    seedFirstPass(h, 'Account', [A1])
    const before = h.store.results.filter((r) => r.pass === 1).length
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.store.results.filter((r) => r.pass === 1)).toHaveLength(before)
    // The FakeRunStore mirrors the view semantics: current-truth success set is
    // derived from pass-1 rows only, so A1 is still 'deployed'.
    expect(h.store.deployedSourceIds(1, 'Account')).toEqual([A1])
  })

  it('chunks the scope IN clause past 4,000 ids and keeps batch numbers monotonic across chunks', async () => {
    const ids = Array.from({ length: 4001 }, (_, i) => `001${String(i).padStart(15, '0')}`)
    const h = harness({
      onQueryTarget: parentsOnTarget,
      sourceDescribe: accountDescribe,
      onQuerySourcePages: (_soql, call) => [
        { records: [{ Id: ids[call === 0 ? 0 : 4000]!, ParentId: P1 }], totalSize: 1 }
      ]
    })
    seedFirstPass(h, 'Account', ids)
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.sourceSoqls).toHaveLength(2)
    expect(h.sourceSoqls[0]).toContain(`'${ids[0]}'`)
    expect(h.sourceSoqls[1]).toContain(`'${ids[4000]}'`)
    expect(h.logs.map((l) => l.message)).toEqual([
      'V2 second pass REST batch 0 (updateOnly=true): 1 succeeded, 0 failed for Account',
      'V2 second pass REST batch 1 (updateOnly=true): 1 succeeded, 0 failed for Account'
    ])
  })

  it('an empty FIRST page of one chunk advances to the next chunk', async () => {
    const ids = Array.from({ length: 4001 }, (_, i) => `001${String(i).padStart(15, '0')}`)
    const h = harness({
      sourceDescribe: accountDescribe,
      onQuerySourcePages: (_soql, call) =>
        call === 0
          ? [{ records: [], totalSize: 0 }]
          : [{ records: [{ Id: ids[4000]!, ParentId: P1 }], totalSize: 1 }]
    })
    seedFirstPass(h, 'Account', ids)
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.sourceSoqls).toHaveLength(2)
    expect(h.upsertCalls).toHaveLength(1)
  })

  it('stops dispatching between batches when cancel is requested', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [
        { records: [{ Id: A1, ParentId: P1 }], totalSize: 2 },
        { records: [{ Id: A2, ParentId: P1 }], totalSize: 2 }
      ],
      onUpsert: (records) => {
        h.store.cancelled = true
        return {
          successCount: records.length,
          failureCount: 0,
          errorDetails: [],
          failedExternalIds: [],
          typedErrors: []
        }
      }
    })
    seedFirstPass(h, 'Account', [A1, A2])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.upsertCalls).toHaveLength(1)
  })

  it('propagates the CPQ tripwire out of the upsert (orchestrator fails the run)', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [{ records: [{ Id: A1, ParentId: P1 }], totalSize: 1 }],
      onUpsert: () => {
        throw new CpqTriggersActiveError('Account', 'SBQQ.QuoteTrigger: boom')
      }
    })
    seedFirstPass(h, 'Account', [A1])
    await expect(
      runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    ).rejects.toMatchObject({ name: 'CpqTriggersActiveError' })
  })

  // ── S49 BUG-11 ──────────────────────────────────────────────────────────
  // WAS: 'self-ref payloads bypass the parent strip entirely (E4X.7 self
  // exclusion)' — that test asserted the defect. Pass 1 skips self-refs
  // because the deferred pass owns them, but the deferred pass called the very
  // same strip, which ALSO skipped them, so a self-ref was checked nowhere and
  // went to the API raw. Live: run 5 Account 0011K0000266X9aQAE (ParentId to an
  // out-of-scope account) and run 6 Opportunities 006TR00000bkf7kYAA /
  // 006TR00000bkzSzYAI, both pointing at the Opportunity BUG-9 had just failed.
  it('PROBES a self-ref in the second pass and keeps it when the parent IS on target', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      onQueryTarget: parentsOnTarget,
      pages: [{ records: [{ Id: A1, ParentId: P1 }], totalSize: 1 }]
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.targetSoqls).toHaveLength(1) // the strip probe now fires
    expect(h.targetSoqls[0]).toContain('FROM Account')
    expect(h.upsertCalls[0]!.records[0]!['Parent']).toBeDefined()
  })

  it('DROPS a self-ref whose parent is not on target instead of failing the row', async () => {
    const h = harness({
      sourceDescribe: accountDescribe,
      onQueryTarget: () => [], // parent absent — the run-5 / run-6 situation
      pages: [{ records: [{ Id: A1, ParentId: P1 }], totalSize: 1 }]
    })
    seedFirstPass(h, 'Account', [A1])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    // Previously this shipped an ExtId FK for a record that was never written
    // and came back INVALID_FIELD: Foreign key external ID … in entity Account.
    expect(h.upsertCalls[0]!.records[0]!['Parent']).toBeUndefined()
    expect(h.logs.some((l) => l.message.includes('Dropped unresolvable reference(s)'))).toBe(true)
  })

  // ── S49 BUG-8 ───────────────────────────────────────────────────────────
  it('scopes pass 2 to DEPLOYED ids, not merely queried ones', async () => {
    // A1 deployed, A2 skipped in pass 1. Patching A2 could only ever produce a
    // spurious NOT_FOUND, so it must not be in the source query at all.
    const h = harness({
      sourceDescribe: accountDescribe,
      onQueryTarget: parentsOnTarget,
      pages: [{ records: [{ Id: A1, ParentId: P1 }], totalSize: 1 }]
    })
    seedFirstPass(h, 'Account', [A1])
    h.store.recordResults(1, [
      {
        objectApiName: 'Account',
        sourceId: A2,
        pass: 1 as const,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'skipped' as const,
        errorMessage: 'pbe_missing_on_target'
      }
    ])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    const soql = h.sourceSoqls[0]!
    expect(soql).toContain(A1)
    expect(soql).not.toContain(A2)
  })

  it('logs the cross-object parent-drop warning with the Second pass prefix (DDQ L719-722)', async () => {
    // Contact.AccountId deferred (forward ref): the Account parent is missing
    // on target → strip drops the FIELD, not the row, and the Warning gets the
    // 'Second pass: ' prefix.
    const contactDescribe = [
      fld('Id', { isCreateable: false }),
      fld('AccountId', { isReference: true, referenceTo: ['Account'], relationshipName: 'Account' })
    ]
    const C1 = '003CCCCCCCCCCCCCCC'
    const plan = planOf(
      frozenObject('Contact', ['Id', 'AccountId'], {
        hasCircularReference: true,
        deferredFields: ['AccountId'],
        mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
      })
    )
    const h = harness({
      sourceDescribe: contactDescribe,
      pages: [{ records: [{ Id: C1, AccountId: A1 }], totalSize: 1 }],
      onQueryTarget: (soql) => (soql.includes(EXT) ? [] : undefined)
    })
    seedFirstPass(h, 'Contact', [C1])
    await runSecondPass(plan, passCtx(h.io, 'Contact', { passKind: 'second' }))
    expect(h.logs[0]!.level).toBe('Warning')
    expect(h.logs[0]!.message.startsWith('Second pass: ')).toBe(true)
    expect(h.upsertCalls[0]!.records[0]!['Account']).toBeUndefined()
  })

  it('processes EVERY non-empty continuation page of a chunk (multi-page pin — review wf_8a5828d1)', async () => {
    const h = harness({
      onQueryTarget: parentsOnTarget,
      sourceDescribe: accountDescribe,
      pages: [
        { records: [{ Id: A1, ParentId: P1 }], totalSize: 2 },
        { records: [{ Id: A2, ParentId: P1 }], totalSize: 2 }
      ]
    })
    seedFirstPass(h, 'Account', [A1, A2])
    await runSecondPass(planOf(accountPlan()), passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.upsertCalls).toHaveLength(2)
    expect(h.logs.map((l) => l.message)).toEqual([
      'V2 second pass REST batch 0 (updateOnly=true): 1 succeeded, 0 failed for Account',
      'V2 second pass REST batch 1 (updateOnly=true): 1 succeeded, 0 failed for Account'
    ])
    expect(h.store.results.filter((r) => r.pass === 2)).toHaveLength(2)
  })

  it('attributes HTTP sub-batch failures by RANK, not clamped absolute index (review wf_8a5828d1 regression)', async () => {
    // recommendedBatchSize=1 → three sub-batches; sub 0 succeeds, subs 1 and 2
    // fail HTTP. The failing sub-batches are NOT a prefix — rank mapping must
    // stamp E-SUB1 onto the middle record and E-SUB2 onto the last.
    const A3 = '001DDDDDDDDDDDDDDD'
    const h = harness({
      sourceDescribe: accountDescribe,
      pages: [
        {
          records: [
            { Id: A1, ParentId: P1 },
            { Id: A2, ParentId: P1 },
            { Id: A3, ParentId: P1 }
          ],
          totalSize: 3
        }
      ],
      onUpsert: () => ({
        successCount: 1,
        failureCount: 2,
        errorDetails: ['Batch HTTP error: E-SUB1', 'Batch HTTP error: E-SUB2'],
        failedExternalIds: [reverse(A2), reverse(A3)],
        typedErrors: []
      })
    })
    seedFirstPass(h, 'Account', [A1, A2, A3])
    await runSecondPass(
      planOf(accountPlan({ recommendedBatchSize: 1 })),
      passCtx(h.io, 'Account', { passKind: 'second' })
    )
    const pass2 = h.store.results.filter((r) => r.pass === 2)
    expect(pass2.find((r) => r.sourceId === A2)!.errorMessage).toBe('Batch HTTP error: E-SUB1')
    expect(pass2.find((r) => r.sourceId === A3)!.errorMessage).toBe('Batch HTTP error: E-SUB2')
  })

  it('scopes a deferred RecordTypeId nameMatch to the deploying object (objContext pin)', async () => {
    const RT_S = '012SSSSSSSSSSSSSSS'
    const RT_T = '012TTTTTTTTTTTTTTT'
    const sourceSoqlsSeen: string[] = []
    const h = harness({
      sourceDescribe: [
        fld('Id', { isCreateable: false }),
        fld('RecordTypeId', {
          isReference: true,
          referenceTo: ['RecordType'],
          relationshipName: 'RecordType'
        })
      ],
      pages: [{ records: [{ Id: A1, RecordTypeId: RT_S }], totalSize: 1 }],
      onQuerySource: (soql) => {
        sourceSoqlsSeen.push(soql)
        return soql.includes('FROM RecordType') ? [{ Id: RT_S, DeveloperName: 'Partner' }] : []
      },
      onQueryTarget: (soql) =>
        soql.includes('FROM RecordType') ? [{ Id: RT_T, DeveloperName: 'Partner' }] : undefined
    })
    seedFirstPass(h, 'Account', [A1])
    const plan = planOf(
      frozenObject('Account', ['Id', 'RecordTypeId'], {
        hasCircularReference: true,
        deferredFields: ['RecordTypeId'],
        mappings: {
          RecordTypeId: { strategy: 'nameMatch', matchField: 'DeveloperName', customValue: null }
        }
      })
    )
    await runSecondPass(plan, passCtx(h.io, 'Account', { passKind: 'second' }))
    // Both sides carry the SObjectType filter; target adds IsActive = true.
    expect(sourceSoqlsSeen.find((s) => s.includes('FROM RecordType'))).toBe(
      "SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = 'Account'"
    )
    expect(h.targetSoqls.find((s) => s.includes('FROM RecordType'))).toBe(
      "SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = 'Account' AND IsActive = true"
    )
    // The mapped TARGET id lands on the raw field (nameMatch branch).
    expect(h.upsertCalls[0]!.records[0]!['RecordTypeId']).toBe(RT_T)
  })

  it('makeSecondPass closes over the plan', async () => {
    const h = harness({ sourceDescribe: accountDescribe })
    const exec = makeSecondPass(planOf(accountPlan({ deferredFields: [] })))
    await exec(passCtx(h.io, 'Account', { passKind: 'second' }))
    expect(h.upsertCalls).toEqual([])
  })
})
