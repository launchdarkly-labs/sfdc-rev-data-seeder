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
import { makeDeployIo } from '../src/main/services/deployIo'
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
