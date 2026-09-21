/**
 * E4E.3 — the targeted-retry drain (retry.ts) against the scripted kit.
 * Pins: 150-id chunking, per-chunk batch-0 numbering (Apex enqueueNextHop),
 * the retry query shape (no user filter, PA filter kept, Id IN), coordinates
 * verbatim from ObjectPassContext, the empty-result abandon (deleted source
 * records), cancel-between-chunks, multi-chunk failure counting by rows
 * (FINDINGS #15 shape), and the classification wiring on retry failures.
 */
import { describe, expect, it } from 'vitest'
import { runRetryPass, makeRetryPass } from '../src/main/engine/deploy/retry'
import {
  fld,
  frozenObject,
  harness,
  okResult,
  passCtx,
  planOf
} from './helpers/deployFakes'
import { generateExternalId } from '../src/main/engine/deploy/transform/sfid'
import type { QueryPage } from '../src/main/engine/deploy/types'

/** n realistic 18-char ids: 001…0001AAA, 001…0002AAA, … */
function ids(n: number, prefix = '001'): string[] {
  return Array.from({ length: n }, (_, i) => {
    const seq = String(i + 1).padStart(12, '0')
    return `${prefix}${seq}AAA`
  })
}

function pageOf(sourceIds: string[]): QueryPage {
  return { records: sourceIds.map((id) => ({ Id: id, Name: `r${id}` })), totalSize: sourceIds.length }
}

/** Extract the quoted ids of a `Id IN ('a','b')` clause. */
function inIds(soql: string): string[] {
  const m = soql.match(/Id IN \(([^)]*)\)/)
  return m == null ? [] : m[1]!.split(',').map((s) => s.replace(/'/g, ''))
}

describe('runRetryPass — chunked drain', () => {
  it('drains 160 queued ids in a 150 + 10 chunk, rows at the ctx coordinates', async () => {
    const all = ids(160)
    const h = harness({
      sourceDescribe: [fld('Name')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))]
    })
    h.store.enqueueRetries(1, 'Account', all, 1)

    const plan = planOf(frozenObject('Account', ['Name']))
    await runRetryPass(plan, passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 1, objectAttempt: 0 }))

    // two chunk queries: 150 then 10, insertion order
    expect(h.sourceSoqls).toHaveLength(2)
    expect(inIds(h.sourceSoqls[0]!)).toEqual(all.slice(0, 150))
    expect(inIds(h.sourceSoqls[1]!)).toEqual(all.slice(150))
    expect(h.sourceSoqls[0]!.startsWith('SELECT Id, Name FROM Account WHERE Id IN (')).toBe(true)

    // every record re-attempted, recorded at (pass 1, retryPass 1, attempt 0)
    expect(h.store.results).toHaveLength(160)
    expect(h.store.results.every((r) => r.pass === 1 && r.retryPass === 1 && r.objectAttempt === 0)).toBe(
      true
    )
    expect(h.store.retryQueueDepth(1, 'Account')).toBe(0)
  })

  it('each chunk is its own Apex hop: batch numbering restarts at 0 per chunk', async () => {
    const all = ids(151)
    const h = harness({
      sourceDescribe: [fld('Name')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))]
    })
    h.store.enqueueRetries(1, 'Account', all, 1)
    await runRetryPass(
      planOf(frozenObject('Account', ['Name'])),
      passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 1 })
    )
    const batchLines = h.logs.filter((l) => l.message.startsWith('REST upsert batch'))
    expect(batchLines.map((l) => l.message)).toEqual([
      'REST upsert batch 0: 150 succeeded, 0 failed for Account',
      'REST upsert batch 0: 1 succeeded, 0 failed for Account'
    ])
  })

  it('rebuilds the object context PER CHUNK — each chunk was its own Apex hop (review fix)', async () => {
    const all = ids(160)
    const h = harness({
      sourceDescribe: [fld('Name')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))]
    })
    let describeCalls = 0
    const orig = h.io.describeSource
    h.io.describeSource = (o) => {
      describeCalls++
      return orig(o)
    }
    h.store.enqueueRetries(1, 'Account', all, 1)
    await runRetryPass(
      planOf(frozenObject('Account', ['Name'])),
      passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 1 })
    )
    // one Phase-A rebuild per 150-id chunk (Apex re-ran the prefetch per hop —
    // target-side changes between chunks stay visible)
    expect(describeCalls).toBe(2)
  })

  it('keeps the Contact PA filter on retry queries (DDQ L1716-1720)', async () => {
    const h = harness({
      sourceDescribe: [
        fld('LastName'),
        fld('IsPersonAccount', { dataType: 'boolean', isCreateable: false })
      ],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))]
    })
    h.store.enqueueRetries(1, 'Contact', ids(2, '003'), 1)
    await runRetryPass(
      planOf(frozenObject('Contact', ['LastName'])),
      passCtx(h.io, 'Contact', { passKind: 'retry', retryPass: 1 })
    )
    expect(h.sourceSoqls[0]!).toMatch(
      /^SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false AND Id IN \(/
    )
  })

  it('multi-chunk failures count by ROWS at the same retryPass (FINDINGS #15 shape)', async () => {
    const all = ids(160)
    const failFirst5 = new Set(all.slice(0, 5).map((id) => generateExternalId(id)))
    const failLast3 = new Set(all.slice(157).map((id) => generateExternalId(id)))
    const h = harness({
      sourceDescribe: [fld('Name')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))],
      onUpsert: (records) => {
        const failed = records
          .map((r) => String(r['Data_Deployment_External_Id__c']))
          .filter((e) => failFirst5.has(e) || failLast3.has(e))
        return {
          successCount: records.length - failed.length,
          failureCount: failed.length,
          errorDetails: failed.map((e) => `${e} → REQUIRED_FIELD_MISSING: boom; `),
          failedExternalIds: failed,
          typedErrors: failed.map((extId) => ({
            extId,
            statusCode: 'REQUIRED_FIELD_MISSING',
            message: 'boom',
            fields: []
          }))
        }
      }
    })
    h.store.enqueueRetries(1, 'Account', all, 2)
    await runRetryPass(
      planOf(frozenObject('Account', ['Name'])),
      passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 2 })
    )
    // 5 (chunk 1) + 3 (chunk 2) failure ROWS at retryPass 2 — nothing
    // accumulates, nothing resets between chunks.
    const failedRows = h.store.results.filter((r) => r.outcome === 'failed')
    expect(failedRows).toHaveLength(8)
    expect(failedRows.every((r) => r.retryPass === 2)).toBe(true)
    expect(h.store.failures).toHaveLength(8)
    expect(h.store.failures.every((f) => f.retryPass === 2 && f.classification === 'root')).toBe(true)
  })

  it('an empty retry query result logs the Apex skip line and abandons the drain', async () => {
    const all = ids(160)
    const h = harness({
      sourceDescribe: [fld('Name')],
      // records were deleted on source: the first chunk query returns nothing
      onQuerySourcePages: () => [{ records: [], totalSize: 0 }]
    })
    h.store.enqueueRetries(1, 'Account', all, 1)
    await runRetryPass(
      planOf(frozenObject('Account', ['Name'])),
      passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 1 })
    )
    expect(h.logs.at(-1)).toEqual({
      level: 'Info',
      message: 'Skipped Account — no records on source'
    })
    expect(h.sourceSoqls).toHaveLength(1) // second chunk never dequeued
    expect(h.store.retryQueueDepth(1, 'Account')).toBe(10) // remainder left queued
    expect(h.store.results).toHaveLength(0)
  })

  it('cancel between chunks stops the drain; undrained ids stay queued', async () => {
    const all = ids(160)
    const h = harness({
      sourceDescribe: [fld('Name')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))],
      onUpsert: (records) => {
        h.store.cancelled = true // cancel arrives during chunk 1's upsert
        return okResult(records.length)
      }
    })
    h.store.enqueueRetries(1, 'Account', all, 1)
    await runRetryPass(
      planOf(frozenObject('Account', ['Name'])),
      passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 1 })
    )
    expect(h.sourceSoqls).toHaveLength(1)
    expect(h.store.results).toHaveLength(150) // chunk 1 recorded
    expect(h.store.retryQueueDepth(1, 'Account')).toBe(10) // chunk 2 preserved
  })

  it('transform-skips during a retry record rows at retryPass N (views then drop them everywhere)', async () => {
    const pbeInactive = '01u000000000001AAA'
    const oliIds = ids(2, '00k')
    const h = harness({
      sourceDescribe: [
        fld('UnitPrice', { dataType: 'currency' }),
        fld('PricebookEntryId', {
          dataType: 'reference',
          isReference: true,
          referenceTo: ['PricebookEntry'],
          relationshipName: 'PricebookEntry'
        })
      ],
      onQuerySourcePages: (soql) => [
        {
          records: inIds(soql).map((id, i) => ({
            Id: id,
            UnitPrice: 1,
            PricebookEntryId: i === 0 ? pbeInactive : '01u000000000009AAA'
          })),
          totalSize: 2
        }
      ],
      onQueryTarget: (soql) => {
        if (soql.includes('FROM PricebookEntry WHERE IsActive = false')) {
          return [{ Id: pbeInactive, Product2Id: '01t000000000001AAA', Pricebook2Id: '01s000000000001AAA' }]
        }
        return []
      }
    })
    h.store.enqueueRetries(1, 'OpportunityLineItem', oliIds, 1)
    const plan = planOf(
      frozenObject('OpportunityLineItem', ['UnitPrice', 'PricebookEntryId'], {
        mappings: { PricebookEntryId: { strategy: 'directId', matchField: null, customValue: null } }
      })
    )
    await runRetryPass(plan, passCtx(h.io, 'OpportunityLineItem', { passKind: 'retry', retryPass: 1 }))
    expect(h.store.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: oliIds[0], outcome: 'skipped', retryPass: 1 }),
        expect.objectContaining({ sourceId: oliIds[1], outcome: 'success', retryPass: 1 })
      ])
    )
  })

  it('junction objects are refused; unknown objects are refused', async () => {
    const h = harness({ sourceDescribe: [], onQuerySourcePages: () => [] })
    await expect(
      runRetryPass(
        planOf(frozenObject('OpportunityContactRole', [], { isJunction: true })),
        passCtx(h.io, 'OpportunityContactRole', { passKind: 'retry', retryPass: 1 })
      )
    ).rejects.toThrow(/junctions never take targeted retries/)
    await expect(
      runRetryPass(planOf(frozenObject('Account', [])), passCtx(h.io, 'Contact'))
    ).rejects.toThrow('No frozen plan object for Contact')
  })

  it('makeRetryPass closes over the plan (PassExecutors seam)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))]
    })
    h.store.enqueueRetries(1, 'Account', ids(1), 1)
    const retryPass = makeRetryPass(planOf(frozenObject('Account', ['Name'])))
    await retryPass(passCtx(h.io, 'Account', { passKind: 'retry', retryPass: 1 }))
    expect(h.store.results).toHaveLength(1)
  })
})

describe('runRetryPass — classification wiring', () => {
  it('a retry failure whose FK parent is in the current failed set classifies cascade', async () => {
    const failedParent = '001000000000042AAA'
    const child = '003000000000001AAA'
    const childExt = generateExternalId(child)
    const h = harness({
      sourceDescribe: [fld('LastName')],
      onQuerySourcePages: (soql) => [pageOf(inIds(soql))],
      onUpsert: () => ({
        successCount: 0,
        failureCount: 1,
        errorDetails: [
          `${childExt} → INVALID_FIELD: Foreign key external ID: ${generateExternalId(failedParent)} ` +
            `not found for field Data_Deployment_External_Id__c in entity Account; `
        ],
        failedExternalIds: [childExt],
        typedErrors: [
          { extId: childExt, statusCode: 'INVALID_FIELD', message: 'Foreign key…', fields: [] }
        ]
      })
    })
    // The upstream Account failure is already recorded — in failed_records,
    // the Persistent-mirror source the classifier reads (a real firstPass
    // writes both tables; the mirror derives from failures only).
    h.store.recordResults(1, [
      {
        objectApiName: 'Account',
        sourceId: failedParent,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'failed'
      }
    ])
    h.store.recordFailures(1, [
      {
        objectApiName: 'Account',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        sourceId: failedParent,
        extId: generateExternalId(failedParent),
        errorCode: 'REQUIRED_FIELD_MISSING',
        errorMessage: 'boom',
        fieldsJson: null,
        classification: 'root'
      }
    ])
    h.store.enqueueRetries(1, 'Contact', [child], 1)
    const plan = planOf(frozenObject('Account', ['Name']), frozenObject('Contact', ['LastName']))
    await runRetryPass(plan, passCtx(h.io, 'Contact', { passKind: 'retry', retryPass: 1 }))
    const contactFailures = h.store.failures.filter((f) => f.objectApiName === 'Contact')
    expect(contactFailures).toHaveLength(1)
    expect(contactFailures[0]).toMatchObject({ sourceId: child, classification: 'cascade' })
  })
})
