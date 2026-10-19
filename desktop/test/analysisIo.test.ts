/**
 * Tests for services/analysisIo.ts — above all the composite-wrap transport
 * shim (the jsforce port of OrgConnectionService's Session-29 fix): REST
 * /query is GET-only and 414s around ~16KB of URL, so over-threshold queries
 * must re-send as a single-subrequest POST /composite. Pure-logic fakes only —
 * no org, no sqlite (the fake Store never touches better-sqlite3).
 */
import { describe, it, expect } from 'vitest'
import type { Connection } from '@jsforce/jsforce-node'
import { runQuery, makeAnalysisIo, QUERY_URI_WRAP_THRESHOLD } from '../src/main/services/analysisIo'
import type { GuardedOrg } from '../src/main/services/salesforce'
import type { Store } from '../src/main/services/store'

interface FakeRequest {
  method: string
  url: string
  body?: string
}

/** A fake jsforce Connection recording request() calls and replaying responses. */
function fakeConn(handler: (req: FakeRequest) => unknown) {
  const calls: FakeRequest[] = []
  const conn = {
    async request(arg: string | { method: string; url: string; body?: string }): Promise<unknown> {
      const req: FakeRequest =
        typeof arg === 'string'
          ? { method: 'GET', url: arg }
          : { method: arg.method, url: arg.url, body: arg.body }
      calls.push(req)
      return handler(req)
    }
  }
  return { conn: conn as unknown as Connection, calls }
}

function guarded(conn: Connection): GuardedOrg {
  return {
    alias: 'fake',
    role: 'source',
    orgId: '00Dfake',
    conn,
    assertWritable() {
      throw new Error('read-only')
    }
  }
}

const fakeStore = {
  getCachedDescribe: () => null,
  putCachedDescribe: () => undefined
} as unknown as Store

function queryBody(records: Array<Record<string, unknown>>, next?: string) {
  return {
    totalSize: records.length,
    done: next == null,
    records,
    ...(next ? { nextRecordsUrl: next } : {})
  }
}

describe('runQuery — composite transport shim', () => {
  it('short queries go straight to GET /query', async () => {
    const { conn, calls } = fakeConn(() => queryBody([{ Id: 'a' }]))
    const res = await runQuery(conn, 'SELECT Id FROM Account')
    expect(res.records).toEqual([{ Id: 'a' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe(
      '/services/data/v66.0/query/?q=' + encodeURIComponent('SELECT Id FROM Account')
    )
  })

  it(`queries whose encoded path exceeds ${QUERY_URI_WRAP_THRESHOLD} chars wrap in POST /composite`, async () => {
    const longSoql =
      'SELECT Id FROM Contact WHERE AccountId IN (' +
      Array.from({ length: 500 }, (_, i) => `'001${String(i).padStart(15, '0')}'`).join(',') +
      ')'
    const { conn, calls } = fakeConn((req) => {
      if (req.method === 'POST') {
        return {
          compositeResponse: [{ httpStatusCode: 200, body: queryBody([{ Id: 'x' }]) }]
        }
      }
      throw new Error('long query must not go out as a GET')
    })
    const res = await runQuery(conn, longSoql)
    expect(res.records).toEqual([{ Id: 'x' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('/services/data/v66.0/composite')
    const payload = JSON.parse(calls[0]!.body!)
    expect(payload.allOrNone).toBe(false)
    expect(payload.compositeRequest).toHaveLength(1)
    expect(payload.compositeRequest[0].method).toBe('GET')
    expect(payload.compositeRequest[0].url).toContain('/query/?q=')
    // the inner URL round-trips the SOQL exactly
    expect(decodeURIComponent(payload.compositeRequest[0].url.split('?q=')[1])).toBe(longSoql)
  })

  it('an inner subrequest error surfaces as a throw (outer 200 must not mask it)', async () => {
    const longSoql = 'SELECT Id FROM Account WHERE Name = ' + "'x'".padEnd(9000, 'x')
    const { conn } = fakeConn(() => ({
      compositeResponse: [
        { httpStatusCode: 400, body: [{ errorCode: 'MALFORMED_QUERY', message: 'boom' }] }
      ]
    }))
    await expect(runQuery(conn, longSoql)).rejects.toThrow(
      /composite-wrapped query failed \(HTTP 400\)/
    )
  })

  it('a missing subresponse throws instead of returning undefined', async () => {
    const longSoql = 'SELECT Id FROM Account WHERE Name = ' + "'x'".padEnd(9000, 'x')
    const { conn } = fakeConn(() => ({}))
    await expect(runQuery(conn, longSoql)).rejects.toThrow(/no subresponse/)
  })
})

describe('makeAnalysisIo', () => {
  it('queryIds follows nextRecordsUrl to exhaustion', async () => {
    const { conn, calls } = fakeConn((req) => {
      if (req.url.includes('/query/?q=')) return queryBody([{ Id: 'a' }, { Id: 'b' }], '/next/1')
      if (req.url === '/next/1') return queryBody([{ Id: 'c' }], '/next/2')
      if (req.url === '/next/2') return queryBody([{ Id: 'd' }])
      throw new Error('unexpected url ' + req.url)
    })
    const org = guarded(conn)
    const io = makeAnalysisIo({ source: org, target: org, store: fakeStore })
    const ids = await io.queryIds('SELECT Id FROM Account')
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
    expect(calls).toHaveLength(3)
  })

  it('countQuery returns totalSize', async () => {
    const { conn } = fakeConn(() => ({ totalSize: 42, done: true, records: [] }))
    const org = guarded(conn)
    const io = makeAnalysisIo({ source: org, target: org, store: fakeStore })
    expect(await io.countQuery('SELECT COUNT() FROM Account')).toBe(42)
  })

  it('queryActiveDuplicateRuleObjects collects SobjectType and skips blanks', async () => {
    const { conn } = fakeConn(() =>
      queryBody([{ SobjectType: 'Account' }, { SobjectType: '' }, { SobjectType: 'Widget__c' }, {}])
    )
    const org = guarded(conn)
    const io = makeAnalysisIo({ source: org, target: org, store: fakeStore })
    const objs = await io.queryActiveDuplicateRuleObjects()
    expect([...objs].sort()).toEqual(['Account', 'Widget__c'])
  })
})
