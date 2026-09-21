import { describe, it, expect } from 'vitest'
import {
  partitionActivatedContracts,
  fetchActivatedContractExtIds,
  applyContractIdempotency,
  buildActivatedContractQuery,
  buildDraftActivationQuery,
  buildActivationPatchRecords,
  type ContractsIo
} from '../src/main/engine/deploy/transform/contracts'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'

/**
 * E4X.7 — Contract activation/idempotency suite (Apex DDQ L1906-1933 /
 * queryActivatedContractExtIds L2755-2783 + PostDeployment L195-252). Covers the
 * fail-open re-run guard (counted-as-deployed) and the RUN-SCOPED activation
 * queries (the deliberate improvement over the Apex org-wide activation).
 */

function ciMock(opts: { found?: (soql: string) => string[]; reject?: boolean } = {}): {
  io: ContractsIo
  queries: string[]
} {
  const queries: string[] = []
  return {
    queries,
    io: {
      async queryExtIds(soql) {
        queries.push(soql)
        if (opts.reject) throw new Error('query failed')
        return opts.found ? opts.found(soql) : []
      }
    }
  }
}

const rec = (extId: string | null): Record<string, unknown> => ({ [EXTERNAL_ID_FIELD]: extId, Name: 'C' })

describe('partitionActivatedContracts — pure idempotency filter', () => {
  it('skips already-Activated records (counted as deployed) and keeps the rest', () => {
    const records = [rec('E1'), rec('E2'), rec('E3')]
    const { remaining, alreadyActivated } = partitionActivatedContracts(records, new Set(['E1', 'E3']))
    expect(alreadyActivated).toBe(2)
    expect(remaining.map((r) => r[EXTERNAL_ID_FIELD])).toEqual(['E2'])
  })

  it('leaves the batch untouched when the activated set is empty (fresh target)', () => {
    const records = [rec('E1'), rec('E2')]
    const { remaining, alreadyActivated } = partitionActivatedContracts(records, new Set())
    expect(alreadyActivated).toBe(0)
    expect(remaining).toHaveLength(2)
  })

  it('always keeps a record with a null ExtId', () => {
    const { remaining, alreadyActivated } = partitionActivatedContracts([rec(null)], new Set(['E1']))
    expect(alreadyActivated).toBe(0)
    expect(remaining).toHaveLength(1)
  })
})

describe('run-scoped activation queries (improvement over Apex org-wide)', () => {
  it('scopes the Activated idempotency query to the run ExtIds — NOT org-wide != null', () => {
    const soql = buildActivatedContractQuery(['E1', "E'2"])
    expect(soql).toBe(
      `SELECT ${EXTERNAL_ID_FIELD} FROM Contract WHERE Status = 'Activated' AND ` +
        `${EXTERNAL_ID_FIELD} IN ('E1','E\\'2')`
    )
    expect(soql).not.toContain('!= null') // proves it's run-scoped, not org-wide
  })

  it('scopes the Draft activation query to the run ExtIds', () => {
    const soql = buildDraftActivationQuery(['E1'])
    expect(soql).toBe(
      `SELECT Id, Status FROM Contract WHERE Status = 'Draft' AND ${EXTERNAL_ID_FIELD} IN ('E1')`
    )
    expect(soql).not.toContain('!= null')
  })

  it('builds the activation PATCH records', () => {
    expect(buildActivationPatchRecords(['003A', '003B'])).toEqual([
      { attributes: { type: 'Contract' }, Id: '003A', Status: 'Activated' },
      { attributes: { type: 'Contract' }, Id: '003B', Status: 'Activated' }
    ])
  })
})

describe('fetchActivatedContractExtIds — fail-OPEN + chunking', () => {
  it('returns the Activated ExtIds found on target', async () => {
    const { io } = ciMock({ found: () => ['E1', 'E3'] })
    const set = await fetchActivatedContractExtIds(io, ['E1', 'E2', 'E3'])
    expect([...set].sort()).toEqual(['E1', 'E3'])
  })

  it('returns an empty set WITHOUT throwing when the query fails (fail-OPEN)', async () => {
    const { io } = ciMock({ reject: true })
    const set = await fetchActivatedContractExtIds(io, ['E1'])
    expect(set.size).toBe(0)
  })

  it('does not query when there are no run ExtIds', async () => {
    const { io, queries } = ciMock({ found: () => ['E1'] })
    const set = await fetchActivatedContractExtIds(io, [])
    expect(set.size).toBe(0)
    expect(queries).toEqual([])
  })

  it('chunks the run ExtIds into ≤200-value queries', async () => {
    const { io, queries } = ciMock({ found: () => [] })
    const many = Array.from({ length: 201 }, (_, i) => `E${i}`)
    await fetchActivatedContractExtIds(io, many)
    expect(queries).toHaveLength(2) // 200 + 1
  })
})

describe('applyContractIdempotency — end-to-end guard', () => {
  it('derives scope from the batch records, then partitions (counting already-Activated as deployed)', async () => {
    const { io, queries } = ciMock({ found: () => ['E2'] })
    const { remaining, alreadyActivated } = await applyContractIdempotency(io, [rec('E1'), rec('E2')])
    expect(alreadyActivated).toBe(1)
    expect(remaining.map((r) => r[EXTERNAL_ID_FIELD])).toEqual(['E1'])
    // Scope is the batch's own ExtIds — safe by construction (can't omit a batch record).
    expect(queries[0]).toContain("IN ('E1','E2')")
  })

  it('keeps the whole batch when the idempotency fetch fails (fail-OPEN)', async () => {
    const { io } = ciMock({ reject: true })
    const { remaining, alreadyActivated } = await applyContractIdempotency(io, [rec('E1'), rec('E2')])
    expect(alreadyActivated).toBe(0)
    expect(remaining).toHaveLength(2)
  })

  it('does not query when the batch has no ExtId-bearing records', async () => {
    const { io, queries } = ciMock({ found: () => ['E1'] })
    const { remaining, alreadyActivated } = await applyContractIdempotency(io, [rec(null)])
    expect(alreadyActivated).toBe(0)
    expect(remaining).toHaveLength(1)
    expect(queries).toEqual([])
  })
})
