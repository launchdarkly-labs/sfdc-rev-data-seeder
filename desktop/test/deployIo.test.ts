/**
 * E4E.2 — the DeployIo binding's new members, against fake connections.
 *
 * getTargetUserId ports DataSeederController.getOrgUserId (L869-886): fail-
 * SILENT (any failure → null, the deploy proceeds) and re-resolvable — the
 * failure memo is cleared so a later object/bounded retry gets a fresh
 * attempt (review finding: a cached rejected promise structurally defeated
 * MAX_OBJECT_RETRIES and failed every User-ref object for the run's life).
 *
 * querySourcePages: page-boundary-preserving walk — always yields the first
 * page (even empty, so the engine's 0-record guard fires), carries totalSize.
 */
import { describe, expect, it } from 'vitest'
import { makeDeployIo, makeDescribeMemo } from '../src/main/services/deployIo'
import type { GuardedOrg } from '../src/main/services/salesforce'
import type { DeployStore } from '../src/main/services/deployStore'
import type { QueryPage } from '../src/main/engine/deploy/types'

function org(conn: Record<string, unknown>): GuardedOrg {
  return {
    alias: 'fake',
    role: 'target',
    orgId: '00Dfake0000000',
    conn: conn as never,
    assertWritable: () => {}
  } as GuardedOrg
}

function ioWith(source: GuardedOrg, target: GuardedOrg): ReturnType<typeof makeDeployIo> {
  return makeDeployIo({ source, target, store: {} as DeployStore, emit: () => {} })
}

describe('deployIo.getTargetUserId', () => {
  it('fails SILENT (null) on identity failure and retries on the next call', async () => {
    let calls = 0
    const target = org({
      identity: async (): Promise<{ user_id: string }> => {
        calls++
        if (calls === 1) throw new Error('503 Service Unavailable')
        return { user_id: '005TGT0000000001AA' }
      }
    })
    const io = ioWith(org({}), target)
    // Apex getOrgUserId parity: the failure resolves null, never rejects.
    await expect(io.getTargetUserId()).resolves.toBeNull()
    // The failure memo was cleared — the next object's prefetch gets a fresh
    // attempt (Apex re-resolved every hop) and the success IS memoized.
    await expect(io.getTargetUserId()).resolves.toBe('005TGT0000000001AA')
    await expect(io.getTargetUserId()).resolves.toBe('005TGT0000000001AA')
    expect(calls).toBe(2)
  })

  it('resolves null when identity has no user_id', async () => {
    const io = ioWith(org({}), org({ identity: async (): Promise<object> => ({}) }))
    await expect(io.getTargetUserId()).resolves.toBeNull()
  })
})

describe('deployIo.querySourcePages', () => {
  it('yields real API pages with totalSize, walking nextRecordsUrl', async () => {
    const r = (n: number): Record<string, unknown> => ({ Id: `00100000000000${n}AAA` })
    const source = org({
      request: async (req: unknown): Promise<unknown> => {
        const url = typeof req === 'string' ? req : (req as { url: string }).url
        if (url.includes('/query/?q=')) {
          return { totalSize: 3, done: false, records: [r(1), r(2)], nextRecordsUrl: '/next-1' }
        }
        expect(url).toBe('/next-1')
        return { totalSize: 3, done: true, records: [r(3)] }
      }
    })
    const io = ioWith(source, org({}))
    const pages: QueryPage[] = []
    for await (const p of io.querySourcePages('SELECT Id FROM Account')) pages.push(p)
    expect(pages).toHaveLength(2)
    expect(pages[0]!.records).toHaveLength(2)
    expect(pages[0]!.totalSize).toBe(3)
    expect(pages[1]!.records).toHaveLength(1)
    expect(pages[1]!.totalSize).toBe(3)
  })

  it('always yields the first page, even empty (the engine 0-record guard input)', async () => {
    const source = org({
      request: async (): Promise<unknown> => ({ totalSize: 0, done: true, records: [] })
    })
    const io = ioWith(source, org({}))
    const pages: QueryPage[] = []
    for await (const p of io.querySourcePages('SELECT Id FROM Account')) pages.push(p)
    expect(pages).toHaveLength(1)
    expect(pages[0]!.records).toHaveLength(0)
  })
})

describe('deployIo.queryTarget', () => {
  it('walks nextRecordsUrl to exhaustion (the junction dedupe divergence pin — wf_ea0c182d)', async () => {
    // The E4E.5 dedupe read DEPENDS on full pagination (documented divergence:
    // the frozen Apex read only the first page and re-inserted duplicates past
    // ~2,000 rows). A mutant dropping this loop must fail here.
    const r = (n: number): Record<string, unknown> => ({ Id: `00K0000000000${String(n).padStart(2, '0')}AAA` })
    const target = org({
      request: async (req: unknown): Promise<unknown> => {
        const url = typeof req === 'string' ? req : (req as { url: string }).url
        if (url.includes('/query/?q=')) {
          return { totalSize: 5, done: false, records: [r(1), r(2)], nextRecordsUrl: '/next-a' }
        }
        if (url === '/next-a') {
          return { totalSize: 5, done: false, records: [r(3), r(4)], nextRecordsUrl: '/next-b' }
        }
        expect(url).toBe('/next-b')
        return { totalSize: 5, done: true, records: [r(5)] }
      }
    })
    const io = ioWith(org({}), target)
    const rows: Array<Record<string, unknown>> = []
    for await (const rec of io.queryTarget('SELECT Id FROM OpportunityContactRole')) rows.push(rec)
    expect(rows).toHaveLength(5)
    expect(rows.map((x) => x.Id)).toContain('00K000000000005AAA')
  })
})

/**
 * S64 P5 (5.2, perf #2): one describe per (org, object) for the life of a run.
 * ~65 describes per 11-object run came from the freeze (2N), every object
 * context (2N + 2 per retry chunk), the second pass and the relink; the schema
 * cannot change inside a run. The memo is a Map of PROMISES (concurrent callers
 * share the in-flight request) and a rejection is EVICTED — the E4E.2 lesson.
 */
describe('makeDescribeMemo (S64 P5 5.2)', () => {
  const fieldsOf = (name: string) => [{ apiName: `${name}Field` }] as never

  it('fetches once per org+object (case-insensitive), serves repeats, keeps the source and target apart', async () => {
    const calls: string[] = []
    const memo = makeDescribeMemo(async (org, obj) => {
      calls.push(`${org.role}:${obj}`)
      return fieldsOf(obj)
    })
    const src = { ...org({}), role: 'source' as const, orgId: '00Dsrc' } as GuardedOrg
    const tgt = { ...org({}), role: 'target' as const, orgId: '00Dtgt' } as GuardedOrg
    const [a, b, c] = await Promise.all([memo.get(src, 'Account'), memo.get(src, 'account'), memo.get(tgt, 'Account')])
    expect(a).toBe(b) // same promise → same array
    expect(c).not.toBe(a)
    await memo.get(src, 'Account')
    await memo.get(tgt, 'Contact')
    expect(calls).toEqual(['source:Account', 'target:Account', 'target:Contact'])
    expect(memo.stats()).toEqual({ fetched: 3, served: 2 })
  })

  it('a rejected describe is NOT pinned: the next call fetches again', async () => {
    let n = 0
    const memo = makeDescribeMemo(async (_org, obj) => {
      n++
      if (n === 1) throw new Error('transient')
      return fieldsOf(obj)
    })
    const o = org({})
    await expect(memo.get(o, 'Account')).rejects.toThrow('transient')
    await expect(memo.get(o, 'Account')).resolves.toEqual(fieldsOf('Account'))
    expect(n).toBe(2)
    expect(memo.stats()).toEqual({ fetched: 2, served: 0 })
  })

  it('makeDeployIo routes describeSource / describeTarget (and the keyless target memo) through the shared memo', async () => {
    const calls: string[] = []
    const memo = makeDescribeMemo(async (org, obj) => {
      calls.push(`${org.role}:${obj}`)
      return fieldsOf(obj)
    })
    const src = { ...org({}), role: 'source' as const, orgId: '00Dsrc' } as GuardedOrg
    const tgt = { ...org({}), role: 'target' as const, orgId: '00Dtgt' } as GuardedOrg
    const io = makeDeployIo({ source: src, target: tgt, store: {} as DeployStore, emit: () => {}, describes: memo })
    await io.describeSource('Opportunity')
    await io.describeTarget('Opportunity')
    await io.describeSource('Opportunity') // the freeze, the first pass, the second pass, the relink — one fetch
    await io.describeTarget('Opportunity')
    expect(calls).toEqual(['source:Opportunity', 'target:Opportunity'])
    expect(memo.stats()).toEqual({ fetched: 2, served: 2 })
  })
})
