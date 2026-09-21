/**
 * analysisIo — binds the pure analysis engine (engine/analysis.ts) to live
 * orgs through GuardedOrg + the describe cache. The engine only READS the
 * source and target orgs; the guardrail never comes into play here, but the
 * adapter deliberately takes GuardedOrgs so any future write sneaking into
 * the analysis path hits assertWritable.
 *
 * Transport parity with the Apex OrgConnectionService (Session 29):
 *  - REST /query is GET-only and dies HTTP 414 around ~16KB of URL (~600
 *    quoted ids) — the exact FINDINGS #14 failure. The in-org engine
 *    transparently re-sends long query GETs as a single-subrequest
 *    POST /composite (verified live to ≥108KB); runQuery() below is the
 *    jsforce port of that shim, same 8,000-char threshold
 *    (OrgConnectionService.QUERY_URI_WRAP_THRESHOLD). The engine's 4,000-id
 *    chunks (~100KB of SOQL, the statement ceiling) therefore always fit.
 *  - queryIds paginates via nextRecordsUrl until done (those URLs are short —
 *    no wrapping needed). No CAP+1 early stop (deviation noted in scoping.ts).
 *  - countQuery returns the response's totalSize, which is how the Apex
 *    countRecords read both COUNT() results and LIMIT-query results.
 */
import type { Connection } from '@jsforce/jsforce-node'
import type { FieldInfo } from '../../shared/types'
import type { AnalysisIo } from '../engine/analysis'
import type { GuardedOrg } from './salesforce'
import { API_VERSION } from './salesforce'
import type { Store } from './store'
import { describeObject } from './describe'

/**
 * Mirror of OrgConnectionService.QUERY_URI_WRAP_THRESHOLD: a query whose
 * encoded GET path exceeds this is wrapped in POST /composite. 8,000 chars is
 * far under the ~16KB 414 ceiling measured live in Session 29.
 */
export const QUERY_URI_WRAP_THRESHOLD = 8000

interface RawQueryResult {
  totalSize: number
  done: boolean
  records: Array<Record<string, unknown>>
  nextRecordsUrl?: string
}

interface CompositeSubResponse {
  httpStatusCode: number
  body: unknown
}

/**
 * GET /query with the composite-wrap shim for over-threshold URLs.
 * Exported for tests (the Apex equivalent is @TestVisible).
 */
export async function runQuery(conn: Connection, soql: string): Promise<RawQueryResult> {
  const path = `/services/data/v${API_VERSION}/query/?q=${encodeURIComponent(soql)}`
  if (path.length <= QUERY_URI_WRAP_THRESHOLD) {
    return (await conn.request(path)) as RawQueryResult
  }
  const res = (await conn.request({
    method: 'POST',
    url: `/services/data/v${API_VERSION}/composite`,
    body: JSON.stringify({
      allOrNone: false,
      compositeRequest: [{ method: 'GET', url: path, referenceId: 'q0' }]
    }),
    headers: { 'Content-Type': 'application/json' }
  })) as { compositeResponse?: CompositeSubResponse[] }
  const sub = res.compositeResponse?.[0]
  if (sub == null) {
    throw new Error('composite-wrapped query returned no subresponse')
  }
  if (sub.httpStatusCode < 200 || sub.httpStatusCode >= 300) {
    throw new Error(
      `composite-wrapped query failed (HTTP ${sub.httpStatusCode}): ` +
        JSON.stringify(sub.body).slice(0, 300)
    )
  }
  return sub.body as RawQueryResult
}

export interface AnalysisIoOptions {
  source: GuardedOrg
  target: GuardedOrg
  store: Store
  log?: (level: 'Info' | 'Warning', message: string) => void
}

export function makeAnalysisIo(opts: AnalysisIoOptions): AnalysisIo {
  const { source, target, store } = opts
  const log = opts.log ?? (() => undefined)

  return {
    async queryIds(soql: string): Promise<string[]> {
      const ids: string[] = []
      let res = await runQuery(source.conn, soql)
      for (;;) {
        for (const rec of res.records) {
          const id = rec['Id']
          if (typeof id === 'string') ids.push(id)
        }
        if (res.done || res.nextRecordsUrl == null) break
        res = (await source.conn.request(res.nextRecordsUrl)) as RawQueryResult
      }
      return ids
    },

    async countQuery(soql: string): Promise<number> {
      const res = await runQuery(source.conn, soql)
      return res.totalSize
    },

    async describeFields(objectApiName: string): Promise<FieldInfo[]> {
      return describeObject(source, store, objectApiName)
    },

    async queryActiveDuplicateRuleObjects(): Promise<Set<string>> {
      const res = await runQuery(
        target.conn,
        'SELECT SobjectType FROM DuplicateRule WHERE IsActive = true'
      )
      const objs = new Set<string>()
      for (const rec of res.records) {
        const so = rec['SobjectType']
        if (typeof so === 'string' && so.trim() !== '') objs.add(so)
      }
      return objs
    },

    log
  }
}
