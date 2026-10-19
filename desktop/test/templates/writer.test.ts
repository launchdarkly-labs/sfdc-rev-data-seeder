import { describe, it, expect } from 'vitest'
import { writeRows, STILL_FAILING, SINGLE_RETRY_CAP } from '../../src/main/engine/templates/seed/writer'
import type { RowResult } from '../../src/main/engine/templates/io'
import { FakeOrg, fakeIo } from './fakes'

const fail = (error: string): RowResult => ({ success: false, id: null, error, statusCode: null })
const recs = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ Name: `r${i}` }))

describe('seed writer — the retry ladder', () => {
  it('batches at the tier size and returns results aligned with the records', async () => {
    const target = new FakeOrg({ orgId: 't' })
    const io = fakeIo({ target })
    const out = await writeRows(io, 'POST', 'A__c', recs(450), 200)
    expect(target.writes.map((w) => w.records.length)).toEqual([200, 200, 50])
    expect(out.results).toHaveLength(450)
    expect(out.results.every((r) => r.success)).toBe(true)
    expect(out.savedOnSingleRetry).toBe(0)
  })

  it('transient errors move to smaller batches (200 → 50 → 10), then "still failing"', async () => {
    // Every batch of more than 10 rows fails all its rows with a lock error; 10-row batches succeed.
    const target = new FakeOrg({
      orgId: 't',
      onWrite: (_m, _o, _r, call) => (call < 100 && CALL_SIZES[call]! > 10 ? fail('UNABLE_TO_LOCK_ROW: locked') : undefined)
    })
    const CALL_SIZES: number[] = []
    const origCollections = target.collections.bind(target)
    target.collections = async (m, o, r) => {
      CALL_SIZES.push(r.length)
      return origCollections(m, o, r)
    }
    const io = fakeIo({ target })
    const out = await writeRows(io, 'POST', 'A__c', recs(120), 200)
    // 1×120 (fail) → 3 × (50,50,20) fail → 12 × 10 succeed
    expect(CALL_SIZES.slice(0, 4)).toEqual([120, 50, 50, 20])
    expect(CALL_SIZES.slice(4)).toEqual(Array(12).fill(10))
    expect(out.results.every((r) => r.success)).toBe(true)
  })

  it('rows still transient at the smallest size end as "still failing" and get ONE single-record retry', async () => {
    // r3 keeps hitting a lock error through the ladder (12-row batch, then the 10-stage
    // retry that holds only r3) and saves on the THIRD attempt — the single-record retry.
    let r3Attempts = 0
    const target = new FakeOrg({
      orgId: 't',
      onWrite: (_m, _o, r) => {
        if (r.Name !== 'r3') return undefined
        r3Attempts++
        return r3Attempts < 3 ? fail('UNABLE_TO_LOCK_ROW: locked') : undefined
      }
    })
    const io = fakeIo({ target })
    const out = await writeRows(io, 'POST', 'A__c', recs(12), 12)
    expect(r3Attempts).toBe(3)
    expect(target.writes.map((w) => w.records.length)).toEqual([12, 1, 1])
    expect(out.results[3]!.success).toBe(true)
    expect(out.savedOnSingleRetry).toBe(1)
    expect(out.results.filter((r) => !r.success)).toEqual([])
  })

  it('the bulk-only class (CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY) is retried singly; validation errors are final', async () => {
    const target = new FakeOrg({
      orgId: 't',
      onWrite: (_m, _o, r) => {
        if (r.Name === 'r1') return fail('FIELD_CUSTOM_VALIDATION_EXCEPTION: nope')
        if (r.Name === 'r2') return fail('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SBQQ.ProductRuleBefore: NPE')
        return undefined
      }
    })
    const io = fakeIo({ target })
    const out = await writeRows(io, 'POST', 'A__c', recs(4), 200)
    expect(out.results[1]!.error).toMatch(/VALIDATION/)
    // r2 fails singly too (the script keeps failing it) → bulkOnlyFailures.
    expect(out.results[2]!.success).toBe(false)
    expect(out.bulkOnlyFailures).toBe(1)
    expect(out.savedOnSingleRetry).toBe(0)
    expect(target.writes).toHaveLength(2) // one batch + one single retry (r1 is NOT retried)
  })

  it('single retries are capped and never happen at batch size 1', async () => {
    const target = new FakeOrg({ orgId: 't', onWrite: () => fail('UNKNOWN_EXCEPTION') })
    const io = fakeIo({ target })
    const out = await writeRows(io, 'POST', 'A__c', recs(SINGLE_RETRY_CAP + 1), 200)
    expect(out.bulkOnlyFailures).toBe(SINGLE_RETRY_CAP + 1)
    expect(target.writes.length).toBe(2) // 200 + 101, no singles
    const t2 = new FakeOrg({ orgId: 't', onWrite: () => fail('UNKNOWN_EXCEPTION') })
    const out2 = await writeRows(fakeIo({ target: t2 }), 'POST', 'A__c', recs(3), 1)
    expect(t2.writes.length).toBe(3)
    expect(out2.bulkOnlyFailures).toBe(3)
  })

  it('a whole-call transport failure fails every row and is NOT resent unless transient-class', async () => {
    const target = new FakeOrg({ orgId: 't', onWrite: () => fail('ECONNRESET during write') })
    const out = await writeRows(fakeIo({ target }), 'POST', 'A__c', recs(5), 200)
    expect(out.results.every((r) => !r.success)).toBe(true)
    expect(target.writes).toHaveLength(1)
    expect(out.results[0]!.error).not.toContain(STILL_FAILING)
  })

  it('stops at a batch boundary when cancelled', async () => {
    const target = new FakeOrg({ orgId: 't' })
    const io = fakeIo({ target })
    io.cancel()
    await expect(writeRows(io, 'POST', 'A__c', recs(5), 2)).rejects.toThrow(/cancelled/)
    expect(target.writes).toHaveLength(0)
  })
})
