/**
 * S61 (U-5) — the keyless write (services/deployIo.ts `keylessWrite`) and the id-map-backed
 * parent-strip probe (objectContext `parentStripIoFor`). The engine hands over the SAME payloads it
 * would upsert — a virtual key per record and `{ Rel: { ExtId } }` parent references — and the
 * adapter: flattens references through the id map, skips rows already mapped AND still present,
 * INSERTs the rest and records them, PATCHes by mapped Id in the second pass, and never writes a
 * row it cannot place.
 */
import { describe, expect, it } from 'vitest'
import { keylessWrite } from '../src/main/services/deployIo'
import { parentStripIoFor } from '../src/main/engine/deploy/objectContext'
import type { CollectionsHttpResult, CollectionsTransport, CompositeMethod } from '../src/main/services/transport/collections'
import type { DeployIdMapIo, DeployIo } from '../src/main/engine/deploy/types'
import type { DescribeField } from '../src/main/engine/deploy/transform/fieldFilter'
import { EXTERNAL_ID_FIELD, generateExternalId } from '../src/main/engine/deploy/transform/sfid'

const A1 = '001SRC000000000001' // source Account ids (18-char)
const A2 = '001SRC000000000002'
const A3 = '001SRC000000000003'
const ACC_T1 = '001TGT000000000001'
const K = (id: string): string => generateExternalId(id)

function fld(apiName: string, over: Partial<DescribeField> = {}): DescribeField {
  return {
    apiName,
    dataType: 'string',
    isCreateable: true,
    isNillable: true,
    isReference: false,
    referenceTo: [],
    relationshipName: null,
    isAutoNumber: false,
    isCalculated: false,
    isExternalId: false,
    isRestrictedPicklist: false,
    picklistValues: null,
    ...over
  }
}
const CONTACT_FIELDS = [fld('LastName'), fld('AccountId', { isReference: true, referenceTo: ['Account'], relationshipName: 'Account' })]

class FakeIdMap implements DeployIdMapIo {
  rows = new Map<string, Map<string, string>>() // object → source → target
  alive = new Set<string>()
  recorded: Array<{ object: string; pairs: Array<{ sourceId: string; targetId: string }> }> = []
  existenceProbes: string[][] = []
  set(object: string, sourceId: string, targetId: string, exists = true): void {
    let m = this.rows.get(object)
    if (!m) this.rows.set(object, (m = new Map()))
    m.set(sourceId, targetId)
    if (exists) this.alive.add(targetId)
  }
  async lookup(object: string, sourceIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>()
    const m = this.rows.get(object)
    for (const s of sourceIds) if (m?.has(s)) out.set(s, m.get(s)!)
    return out
  }
  async record(object: string, pairs: ReadonlyArray<{ sourceId: string; targetId: string }>): Promise<void> {
    this.recorded.push({ object, pairs: [...pairs] })
    for (const p of pairs) this.set(object, p.sourceId, p.targetId)
  }
  async existingTargetIds(_object: string, targetIds: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    this.existenceProbes.push([...targetIds])
    return new Set(targetIds.filter((t) => this.alive.has(t)))
  }
}

function transportOf(
  responder: (method: CompositeMethod, endpoint: string, records: Array<Record<string, unknown>>) => unknown[]
): { transport: CollectionsTransport; calls: Array<{ method: CompositeMethod; endpoint: string; records: Array<Record<string, unknown>> }> } {
  const calls: Array<{ method: CompositeMethod; endpoint: string; records: Array<Record<string, unknown>> }> = []
  return {
    calls,
    transport: {
      async request(method, endpoint, body): Promise<CollectionsHttpResult> {
        const records = (JSON.parse(body) as { records: Array<Record<string, unknown>> }).records
        calls.push({ method, endpoint, records })
        return { success: true, body: JSON.stringify(responder(method, endpoint, records)) }
      }
    }
  }
}

const describe_ = async (): Promise<DescribeField[]> => CONTACT_FIELDS

describe('keylessWrite — first pass (insert through the id map)', () => {
  it('flattens nested parent references through the map, strips the key, inserts, records the map, and skips rows already mapped and alive', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Account', A1, ACC_T1) // the parent of c1 is mapped
    idMap.set('Contact', '003SRC000000000009', '003TGT000000000009') // c9 already there from an earlier run
    const { transport, calls } = transportOf((_m, _e, records) => records.map((_r, i) => ({ success: true, id: `003NEW00000000000${i}` })))
    const payloads = [
      { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001'), LastName: 'One', Account: { [EXTERNAL_ID_FIELD]: K(A1) } },
      { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000002'), LastName: 'Two', Account: { [EXTERNAL_ID_FIELD]: K(A2) } }, // A2 unmapped → reference left off
      { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000009'), LastName: 'Nine' }
    ]
    const res = await keylessWrite(transport, idMap, describe_, 'Contact', payloads, { updateOnly: false, batchSize: 200 })
    // ONE insert call with the two unmapped rows; the key is gone, the nested ref became a flat Id.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.records).toEqual([
      { attributes: { type: 'Contact' }, LastName: 'One', AccountId: ACC_T1 },
      { attributes: { type: 'Contact' }, LastName: 'Two' }
    ])
    // The engine's payloads were NOT mutated (it still reads its key off them afterwards).
    expect(payloads[0]![EXTERNAL_ID_FIELD]).toBe(K('003SRC000000000001'))
    expect(payloads[0]!.Account).toEqual({ [EXTERNAL_ID_FIELD]: K(A1) })
    // Results: 3 successes — 2 inserted (keyed by the virtual key) + 1 already mapped (its existing id).
    expect(res.successCount).toBe(3)
    expect(res.failureCount).toBe(0)
    expect(res.successIds).toEqual([
      { extId: K('003SRC000000000001'), id: '003NEW000000000000' },
      { extId: K('003SRC000000000002'), id: '003NEW000000000001' },
      { extId: K('003SRC000000000009'), id: '003TGT000000000009' }
    ])
    // The map learned the two new rows, with DECODED (18-char source) ids.
    expect(idMap.recorded).toEqual([
      { object: 'Contact', pairs: [{ sourceId: '003SRC000000000001', targetId: '003NEW000000000000' }, { sourceId: '003SRC000000000002', targetId: '003NEW000000000001' }] }
    ])
    // The already-mapped row was checked to still exist before it was trusted.
    expect(idMap.existenceProbes).toEqual([['003TGT000000000009']])
  })

  it('a mapped row whose target was DELETED is re-inserted (stale-map guard)', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Contact', '003SRC000000000009', '003GONE00000000009', false) // mapped, not alive
    const { transport, calls } = transportOf((_m, _e, records) => records.map(() => ({ success: true, id: '003NEW000000000007' })))
    const res = await keylessWrite(transport, idMap, describe_, 'Contact', [{ attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000009'), LastName: 'Nine' }], { updateOnly: false, batchSize: 200 })
    expect(calls).toHaveLength(1)
    expect(res.successIds).toEqual([{ extId: K('003SRC000000000009'), id: '003NEW000000000007' }])
    expect(idMap.rows.get('Contact')!.get('003SRC000000000009')).toBe('003NEW000000000007') // re-pointed
  })

  it('an insert failure keeps the legacy attribution shape (failed key + detail line) and records nothing for it', async () => {
    const idMap = new FakeIdMap()
    const { transport } = transportOf(() => [{ success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] }] }])
    const res = await keylessWrite(transport, idMap, describe_, 'Contact', [{ attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001') }], { updateOnly: false, batchSize: 200 })
    expect(res.failureCount).toBe(1)
    expect(res.failedExternalIds).toEqual([K('003SRC000000000001')])
    expect(res.errorDetails[0]).toMatch(new RegExp(`^${K('003SRC000000000001')} → REQUIRED_FIELD_MISSING`))
    expect(idMap.recorded).toEqual([])
  })
})

describe('keylessWrite — second pass (PATCH by mapped Id)', () => {
  it('resolves the row’s own Id from the map, flattens deferred references, PATCHes, and fails an unmapped row synthetically', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Contact', '003SRC000000000001', '003TGT000000000001')
    idMap.set('Account', A3, '001TGT000000000003')
    const { transport, calls } = transportOf((_m, _e, records) => records.map((r) => ({ success: true, id: r.Id })))
    const res = await keylessWrite(
      transport,
      idMap,
      describe_,
      'Contact',
      [
        { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001'), Account: { [EXTERNAL_ID_FIELD]: K(A3) } },
        { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000002'), Account: { [EXTERNAL_ID_FIELD]: K(A3) } } // never inserted → no Id
      ],
      { updateOnly: true, batchSize: 200 }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.records).toEqual([{ attributes: { type: 'Contact' }, AccountId: '001TGT000000000003', Id: '003TGT000000000001' }])
    expect(res.successCount).toBe(1)
    expect(res.failureCount).toBe(1)
    expect(res.failedExternalIds).toEqual([K('003SRC000000000002')])
    expect(res.typedErrors[0]).toMatchObject({ extId: K('003SRC000000000002'), statusCode: 'NOT_MAPPED' })
    expect(res.errorDetails[0]).toMatch(/NOT_MAPPED/)
  })
})

describe('parentStripIoFor — the id-map-backed existence probe (keyless)', () => {
  it('answers an ExtId probe from the map (alive rows only) and leaves Id probes to the org', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Account', A1, ACC_T1)
    idMap.set('Account', A2, '001GONE00000000002', false)
    const targetSoqls: string[] = []
    const io = {
      idMap,
      queryTarget: (soql: string) => {
        targetSoqls.push(soql)
        return (async function* (): AsyncGenerator<Record<string, unknown>> {
          yield { Id: '01tX' }
        })()
      }
    } as unknown as DeployIo
    const probe = parentStripIoFor(io)
    const found = await probe.queryExisting('Account', EXTERNAL_ID_FIELD, [K(A1), K(A2), K(A3)])
    expect(found).toEqual([K(A1)]) // A2 is mapped but gone; A3 was never mapped
    expect(targetSoqls).toEqual([]) // no SOQL for a key probe
    expect(idMap.existenceProbes).toEqual([[ACC_T1, '001GONE00000000002']])
    // A flat directId probe still goes to the org.
    const ids = await probe.queryExisting('Product2', 'Id', ['01tX'])
    expect(ids).toEqual(['01tX'])
    expect(targetSoqls).toHaveLength(1)
  })
})

describe('keylessWrite — S62 already-on-target reporting + second-pass compare', () => {
  it('first pass: names the already-mapped-and-alive rows so the engine can tag them (counted as successes, not written)', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Contact', '003SRC000000000009', '003TGT000000000009')
    const { transport, calls } = transportOf((_m, _e, records) => records.map((_r, i) => ({ success: true, id: `003NEW00000000000${i}` })))
    const res = await keylessWrite(
      transport,
      idMap,
      describe_,
      'Contact',
      [
        { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001'), LastName: 'One' },
        { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000009'), LastName: 'Nine' }
      ],
      { updateOnly: false, batchSize: 200 }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.records).toHaveLength(1) // only the unmapped row was inserted
    expect(res.successCount).toBe(2)
    expect(res.alreadyOnTargetExtIds).toEqual([K('003SRC000000000009')])
  })

  it('second pass: with readCurrent, rows whose every value already matches are NOT sent (counted as successes, listed as unchanged)', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Contact', '003SRC000000000001', '003TGT000000000001')
    idMap.set('Contact', '003SRC000000000002', '003TGT000000000002')
    idMap.set('Account', A3, '001TGT000000000003')
    const { transport, calls } = transportOf((_m, _e, records) => records.map((r) => ({ success: true, id: r.Id })))
    const reads: Array<{ object: string; ids: string[]; fields: string[] }> = []
    const res = await keylessWrite(
      transport,
      idMap,
      describe_,
      'Contact',
      [
        { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001'), Account: { [EXTERNAL_ID_FIELD]: K(A3) } }, // already points at the mapped account
        { attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000002'), Account: { [EXTERNAL_ID_FIELD]: K(A3) } } // currently null → must be PATCHed
      ],
      {
        updateOnly: true,
        batchSize: 200,
        readCurrent: async (object, ids, fields) => {
          reads.push({ object, ids: [...ids], fields: [...fields] })
          return new Map([
            ['003TGT000000000001', { Id: '003TGT000000000001', AccountId: '001TGT000000000003' }],
            ['003TGT000000000002', { Id: '003TGT000000000002', AccountId: null }]
          ])
        }
      }
    )
    expect(reads).toEqual([{ object: 'Contact', ids: ['003TGT000000000001', '003TGT000000000002'], fields: ['AccountId'] }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.records).toEqual([{ attributes: { type: 'Contact' }, AccountId: '001TGT000000000003', Id: '003TGT000000000002' }])
    expect(res.successCount).toBe(2)
    expect(res.failureCount).toBe(0)
    expect(res.unchangedExtIds).toEqual([K('003SRC000000000001')])
    expect(res.successIds).toEqual(expect.arrayContaining([{ extId: K('003SRC000000000001'), id: '003TGT000000000001' }, { extId: K('003SRC000000000002'), id: '003TGT000000000002' }]))
  })

  it('second pass: a readCurrent failure sends every row (the compare must never block a write it cannot judge)', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Contact', '003SRC000000000001', '003TGT000000000001')
    idMap.set('Account', A3, '001TGT000000000003')
    const { transport, calls } = transportOf((_m, _e, records) => records.map((r) => ({ success: true, id: r.Id })))
    const res = await keylessWrite(
      transport,
      idMap,
      describe_,
      'Contact',
      [{ attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001'), Account: { [EXTERNAL_ID_FIELD]: K(A3) } }],
      {
        updateOnly: true,
        batchSize: 200,
        readCurrent: async () => {
          throw new Error('INVALID_FIELD')
        }
      }
    )
    expect(calls).toHaveLength(1)
    expect(res.successCount).toBe(1)
    expect(res.unchangedExtIds).toBeUndefined()
  })

  it('second pass: when every row is unchanged nothing is sent at all', async () => {
    const idMap = new FakeIdMap()
    idMap.set('Contact', '003SRC000000000001', '003TGT000000000001')
    idMap.set('Account', A3, '001TGT000000000003')
    const { transport, calls } = transportOf((_m, _e, records) => records.map((r) => ({ success: true, id: r.Id })))
    const res = await keylessWrite(
      transport,
      idMap,
      describe_,
      'Contact',
      [{ attributes: { type: 'Contact' }, [EXTERNAL_ID_FIELD]: K('003SRC000000000001'), Account: { [EXTERNAL_ID_FIELD]: K(A3) } }],
      { updateOnly: true, batchSize: 200, readCurrent: async () => new Map([['003TGT000000000001', { Id: '003TGT000000000001', AccountId: '001TGT000000000003' }]]) }
    )
    expect(calls).toHaveLength(0)
    expect(res.successCount).toBe(1)
    expect(res.unchangedExtIds).toEqual([K('003SRC000000000001')])
  })
})
