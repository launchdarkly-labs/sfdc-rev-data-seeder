/**
 * S57 (B1) — the target-key probe. Read-only; failures fail OPEN (unknown ⇒ not
 * keyed, the pre-S57 lock), never a false unlock.
 */
import { describe, expect, it } from 'vitest'
import { probeKeyedRows, probeTargetKeys, type KeyedRowsQuery } from '../src/main/services/targetKeys'
import type { GuardedOrg } from '../src/main/services/salesforce'

function fakeConn(rows: Record<string, number | Error>): KeyedRowsQuery & { soql: string[] } {
  const soql: string[] = []
  return {
    soql,
    query(q: string) {
      soql.push(q)
      const obj = /FROM (\w+) WHERE/.exec(q)?.[1] ?? ''
      const v = rows[obj]
      if (v instanceof Error) return Promise.reject(v)
      return Promise.resolve({ totalSize: v ?? 0, records: [] })
    }
  }
}

describe('probeKeyedRows', () => {
  it('one LIMIT 1 query per candidate that carries the field; ≥1 row ⇒ keyed', async () => {
    const conn = fakeConn({ Campaign: 1, Account: 0 })
    const keyed = await probeKeyedRows(conn, new Set(['Campaign', 'Account']), ['Campaign', 'Account', 'Campaign'])
    expect([...keyed]).toEqual(['Campaign'])
    expect(conn.soql).toEqual([
      "SELECT Id FROM Campaign WHERE Data_Deployment_External_Id__c != null LIMIT 1",
      "SELECT Id FROM Account WHERE Data_Deployment_External_Id__c != null LIMIT 1"
    ])
  })
  it('skips objects without the field (no query) and rejects non-API names (no injection surface)', async () => {
    const conn = fakeConn({ Lead: 5 })
    const keyed = await probeKeyedRows(conn, new Set(['Lead']), ['Lead', 'Campaign', "Bad Name; DELETE"])
    expect([...keyed]).toEqual(['Lead'])
    expect(conn.soql).toHaveLength(1)
  })
  it('a failing probe fails OPEN for that object only', async () => {
    const conn = fakeConn({ Campaign: new Error('INVALID_TYPE'), Account: 2 })
    const keyed = await probeKeyedRows(conn, new Set(['Campaign', 'Account']), ['Campaign', 'Account'])
    expect([...keyed]).toEqual(['Account'])
  })
})

describe('probeTargetKeys', () => {
  it('returns both sets, narrowed to the requested candidates, using a supplied field set', async () => {
    const conn = fakeConn({ Campaign: 1 })
    const org = { orgId: '00Dx', conn } as unknown as GuardedOrg
    const keys = await probeTargetKeys(org, ['Campaign', 'Account', 'Lead'], {
      hasField: new Set(['Campaign', 'Account', 'Contact'])
    })
    expect([...keys.hasField].sort()).toEqual(['Account', 'Campaign'])
    expect([...keys.keyedRows]).toEqual(['Campaign'])
  })
})
