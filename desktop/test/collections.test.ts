import { describe, it, expect } from 'vitest'
import {
  upsertByExtId,
  insertRecords,
  clampBatchSize,
  buildUpsertEndpoint,
  findCpqTriggerErrorSignature,
  CpqTriggersActiveError,
  DUPLICATE_RULE_BYPASS_HEADER,
  MAX_COMPOSITE_BATCH,
  type CollectionsTransport,
  type CollectionsHttpResult,
  type CompositeMethod
} from '../src/main/services/transport/collections'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'

/**
 * E4T.1 — REST Collections client suite (Apex upsertToTarget DDS L540-633).
 * Headline is the BYTE-EXACT legacy error-string rendering (golden-parity) plus
 * batching / whole-batch-fail / CPQ-tripwire semantics, over a mocked transport.
 */

interface Call {
  method: CompositeMethod
  endpoint: string
  body: string
}
type Responder = (method: CompositeMethod, endpoint: string, body: string) => CollectionsHttpResult

function mockTransport(responder: Responder): { transport: CollectionsTransport; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    transport: {
      async request(method, endpoint, body) {
        calls.push({ method, endpoint, body })
        return responder(method, endpoint, body)
      }
    }
  }
}

const ok = (results: unknown[]): CollectionsHttpResult => ({ success: true, body: JSON.stringify(results) })
const rec = (extId: string): Record<string, unknown> => ({ [EXTERNAL_ID_FIELD]: extId, Name: 'X' })

describe('pure helpers', () => {
  it('clampBatchSize: min(n,200); null/≤0 → 200', () => {
    expect(clampBatchSize(50)).toBe(50)
    expect(clampBatchSize(500)).toBe(MAX_COMPOSITE_BATCH)
    expect(clampBatchSize(null)).toBe(200)
    expect(clampBatchSize(0)).toBe(200)
    expect(clampBatchSize(-5)).toBe(200)
  })

  it('buildUpsertEndpoint: composite/sobjects/{obj}/{ExtId}[?updateOnly=true]', () => {
    expect(buildUpsertEndpoint('Account', false)).toMatch(
      new RegExp(`/composite/sobjects/Account/${EXTERNAL_ID_FIELD}$`)
    )
    expect(buildUpsertEndpoint('Account', true)).toMatch(
      new RegExp(`/composite/sobjects/Account/${EXTERNAL_ID_FIELD}\\?updateOnly=true$`)
    )
  })

  it('findCpqTriggerErrorSignature: SBQQ./blng. contains (case-sensitive), else null', () => {
    expect(findCpqTriggerErrorSignature(['E1 → OK'])).toBeNull()
    expect(findCpqTriggerErrorSignature(['E1 → X: SBQQ.QuoteTrigger blew up; '])).toContain('SBQQ.')
    expect(findCpqTriggerErrorSignature(['E1 → Y: blng.BillingTrigger; '])).toContain('blng.')
  })

  it('exports the exact duplicate-rule bypass header', () => {
    expect(DUPLICATE_RULE_BYPASS_HEADER).toEqual({ 'Sforce-Duplicate-Rule-Header': 'allowSave=true' })
  })
})

describe('upsertByExtId — happy path + batching', () => {
  it('counts successes and PATCHes the upsert endpoint', async () => {
    const { transport, calls } = mockTransport(() => ok([{ success: true }, { success: true }]))
    const result = await upsertByExtId(transport, 'Account', [rec('E1'), rec('E2')])
    expect(result.successCount).toBe(2)
    expect(result.failureCount).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.endpoint).toContain(`/composite/sobjects/Account/${EXTERNAL_ID_FIELD}`)
    expect(JSON.parse(calls[0]!.body)).toEqual({
      allOrNone: false,
      records: [rec('E1'), rec('E2')]
    })
  })

  it('clamps + chunks into min(batchSize,200) batches', async () => {
    const { transport, calls } = mockTransport(() => ok([{ success: true }]))
    await upsertByExtId(transport, 'Account', [rec('E1'), rec('E2'), rec('E3')], { batchSize: 1 })
    expect(calls).toHaveLength(3) // one record per batch
  })

  it('appends ?updateOnly=true on the second pass', async () => {
    const { transport, calls } = mockTransport(() => ok([{ success: true }]))
    await upsertByExtId(transport, 'Account', [rec('E1')], { updateOnly: true })
    expect(calls[0]!.endpoint).toContain('?updateOnly=true')
  })
})

describe('upsertByExtId — per-record failure parsing (BYTE-EXACT error strings)', () => {
  it('renders "<extId> → CODE: msg fields=[..]; " exactly like Apex', async () => {
    const { transport } = mockTransport(() =>
      ok([
        { success: true },
        {
          success: false,
          errors: [
            {
              statusCode: 'REQUIRED_FIELD_MISSING',
              message: 'Required fields are missing: [LastName]',
              fields: ['LastName']
            }
          ]
        }
      ])
    )
    const result = await upsertByExtId(transport, 'Contact', [rec('E1'), rec('E2')])
    expect(result.successCount).toBe(1)
    expect(result.failureCount).toBe(1)
    expect(result.failedExternalIds).toEqual(['E2'])
    expect(result.errorDetails).toEqual([
      'E2 → REQUIRED_FIELD_MISSING: Required fields are missing: [LastName] fields=["LastName"]; '
    ])
    expect(result.typedErrors).toEqual([
      {
        extId: 'E2',
        statusCode: 'REQUIRED_FIELD_MISSING',
        message: 'Required fields are missing: [LastName]',
        fields: ['LastName']
      }
    ])
  })

  it('concatenates multiple errors and omits fields= when empty', async () => {
    const { transport } = mockTransport(() =>
      ok([
        {
          success: false,
          errors: [
            { statusCode: 'A', message: 'm1' },
            { statusCode: 'B', message: 'm2', fields: ['F'] }
          ]
        }
      ])
    )
    const result = await upsertByExtId(transport, 'Account', [rec('E9')])
    expect(result.errorDetails).toEqual(['E9 → A: m1; B: m2 fields=["F"]; '])
  })

  it('uses (unknown) when a failed record has no ExtId (not added to failedExternalIds)', async () => {
    const { transport } = mockTransport(() => ok([{ success: false, errors: [{ statusCode: 'X', message: 'y' }] }]))
    const result = await upsertByExtId(transport, 'Account', [{ Name: 'noext' }])
    expect(result.errorDetails).toEqual(['(unknown) → X: y; '])
    expect(result.failedExternalIds).toEqual([])
  })
})

describe('upsertByExtId — whole-batch HTTP failure = all failed', () => {
  it('counts every record failed and records one Batch HTTP error line', async () => {
    const { transport } = mockTransport(() => ({ success: false, errorMessage: 'HTTP 500 Server Error' }))
    const result = await upsertByExtId(transport, 'Account', [rec('E1'), rec('E2')])
    expect(result.successCount).toBe(0)
    expect(result.failureCount).toBe(2)
    expect(result.failedExternalIds).toEqual(['E1', 'E2'])
    expect(result.errorDetails).toEqual(['Batch HTTP error: HTTP 500 Server Error'])
  })
})

describe('upsertByExtId — CPQ tripwire', () => {
  it('throws CpqTriggersActiveError and stops BEFORE the next batch', async () => {
    let batchNo = 0
    const { transport, calls } = mockTransport(() => {
      batchNo++
      return ok([
        {
          success: false,
          errors: [{ statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message: 'SBQQ.QuoteLine trigger failed' }]
        }
      ])
    })
    // Two records, batchSize 1 → two batches; the first trips the wire.
    await expect(
      upsertByExtId(transport, 'SBQQ__QuoteLine__c', [rec('E1'), rec('E2')], { batchSize: 1 })
    ).rejects.toBeInstanceOf(CpqTriggersActiveError)
    expect(calls).toHaveLength(1) // stopped before the 2nd batch
    expect(batchNo).toBe(1)
  })

  it('carries the object name + original signature in the message', async () => {
    const { transport } = mockTransport(() =>
      ok([{ success: false, errors: [{ statusCode: 'ERR', message: 'blng.InvoiceTrigger boom' }] }])
    )
    await expect(upsertByExtId(transport, 'Order', [rec('E1')])).rejects.toThrow(
      /loading Order.*Triggers Disabled.*blng\.InvoiceTrigger boom/
    )
  })
})

describe('upsertByExtId — Apex byte-parity edge cases (review hardening)', () => {
  it('renders a MISSING statusCode/message key as "null" (Apex null-concat), not "undefined"', async () => {
    const { transport } = mockTransport(() => ok([{ success: false, errors: [{ message: 'boom' }] }]))
    const r1 = await upsertByExtId(transport, 'Account', [rec('E1')])
    expect(r1.errorDetails).toEqual(['E1 → null: boom; ']) // missing statusCode → 'null'

    const { transport: t2 } = mockTransport(() => ok([{ success: false, errors: [{ statusCode: 'REQ' }] }]))
    const r2 = await upsertByExtId(t2, 'Account', [rec('E2')])
    expect(r2.errorDetails).toEqual(['E2 → REQ: null; ']) // missing message → 'null'
  })

  it('renders a JSON-null statusCode value as "null" too', async () => {
    const { transport } = mockTransport(() => ok([{ success: false, errors: [{ statusCode: null, message: 'm' }] }]))
    const r = await upsertByExtId(transport, 'Account', [rec('E1')])
    expect(r.errorDetails).toEqual(['E1 → null: m; '])
  })

  it('excludes a whitespace-only ExtId from failedExternalIds (isNotBlank), but keeps it in the error line', async () => {
    const { transport } = mockTransport(() => ok([{ success: false, errors: [{ statusCode: 'X', message: 'y' }] }]))
    const r = await upsertByExtId(transport, 'Account', [{ [EXTERNAL_ID_FIELD]: '   ', Name: 'ws' }])
    expect(r.failedExternalIds).toEqual([]) // whitespace is blank → not queued for retry
    expect(r.errorDetails).toEqual(['    → X: y; ']) // rendered with the raw (whitespace) extId
  })

  it('uses the empty-extId "" default for an out-of-bounds result index (not "(unknown)")', async () => {
    // Response longer than the batch — Apex keeps extId='' for the extra index.
    const { transport } = mockTransport(() =>
      ok([
        { success: false, errors: [{ statusCode: 'X', message: 'm' }] },
        { success: false, errors: [{ statusCode: 'Y', message: 'n' }] }
      ])
    )
    const r = await upsertByExtId(transport, 'Account', [rec('E1')])
    expect(r.errorDetails).toEqual(['E1 → X: m; ', ' → Y: n; ']) // 2nd line: empty extId
    expect(r.failedExternalIds).toEqual(['E1']) // '' out-of-bounds not queued
  })
})

describe('insertRecords — POST junction path', () => {
  it('POSTs to the base collections endpoint with allOrNone:false', async () => {
    const { transport, calls } = mockTransport(() => ok([{ success: true }]))
    const result = await insertRecords(transport, 'OpportunityContactRole', [{ Name: 'j' }])
    expect(result.successCount).toBe(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.endpoint).toMatch(/\/composite\/sobjects\/$/)
    expect(JSON.parse(calls[0]!.body).allOrNone).toBe(false)
  })
})
