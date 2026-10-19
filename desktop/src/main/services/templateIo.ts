/**
 * Live binding of the template runner's IO seam (engine/templates/io.ts) over
 * GuardedOrg. The source side is a pure READER; the target side adds writes,
 * every one of them behind `assertWritable` (role must be exactly 'target';
 * production is pinned read-only by org id — rule 1 and rule 4).
 *
 * Transport notes carried over from the reference tool and the deploy engine:
 *  - Long SOQL GETs are wrapped in POST /composite by `runQuery` (the FINDINGS
 *    #14 414 shim) and paged through nextRecordsUrl.
 *  - READS retry a dropped connection 5 times (2/4/8/16 s backoff). WRITES ARE
 *    NEVER RESENT: a write may have landed before the connection died and a
 *    resend would insert duplicates (the reference tool's rule, kept verbatim).
 *  - Attachment bytes come from the blob API (`record(id).blob('Body')`), not
 *    the JSON request helper — the latter decodes the body as text.
 */
import type { Connection } from '@jsforce/jsforce-node'
import type { GuardedOrg } from './salesforce'
import { API_VERSION } from './salesforce'
import { runQuery } from './analysisIo'
import { DUPLICATE_RULE_BYPASS_HEADER } from './transport/collections'
import { makeAutomationToggleIo, makeTriggerToggleIo } from './automationToggleIo'
import { isNoResponseTransportError } from './metadataToggleIo'
import type {
  GlobalObjectInfo,
  MetadataDeployResult,
  OrgReader,
  OrgWriter,
  RowResult,
  TemplateDescribe,
  TemplateDescribeField
} from '../engine/templates/io'
import { renderRowErrors } from '../engine/templates/io'

/** Read retries for a dropped connection: attempts 2/4/8/16 s apart (NET_RETRIES=5 in the reference). */
export const READ_RETRIES = 5

const COMPOSITE = `/services/data/v${API_VERSION}/composite/sobjects`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A dropped-connection class error (reset / timeout / no response) worth retrying on a GET. */
export function isTransientReadError(e: unknown): boolean {
  if (isNoResponseTransportError(e)) return true
  const msg = e instanceof Error ? e.message : String(e)
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|fetch failed|ECONNREFUSED/i.test(
    msg
  )
}

async function withReadRetry<T>(fn: () => Promise<T>, log?: (m: string) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= READ_RETRIES || !isTransientReadError(e)) throw e
      const wait = 2 ** attempt * 1000
      log?.(`network error on read (${e instanceof Error ? e.message : String(e)}), retry ${attempt}/${READ_RETRIES - 1} in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
}

interface Page {
  totalSize: number
  done: boolean
  records: Array<Record<string, unknown>>
  nextRecordsUrl?: string
}

function stripAttributes(rec: Record<string, unknown>): Record<string, unknown> {
  if ('attributes' in rec) {
    const { attributes: _a, ...rest } = rec
    return rest
  }
  return rec
}

export function toTemplateDescribe(res: {
  name: string
  fields: Array<Record<string, unknown>>
}): TemplateDescribe {
  const fields: TemplateDescribeField[] = res.fields.map((f) => ({
    name: String(f.name),
    type: typeof f.type === 'string' ? f.type : 'string',
    createable: f.createable === true,
    updateable: f.updateable === true,
    nillable: f.nillable !== false,
    defaultedOnCreate: f.defaultedOnCreate === true,
    calculated: f.calculated === true,
    autoNumber: f.autoNumber === true,
    referenceTo: Array.isArray(f.referenceTo) ? (f.referenceTo as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    relationshipName: typeof f.relationshipName === 'string' ? f.relationshipName : null,
    length: typeof f.length === 'number' ? f.length : null,
    cascadeDelete: f.cascadeDelete === true
  }))
  return { name: res.name, fields }
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  const code = (e as { errorCode?: unknown } | null)?.errorCode
  return code === 'NOT_FOUND' || code === 'ERROR_HTTP_404' || /NOT_FOUND|resource does not exist|-> 404/i.test(msg)
}

export function makeOrgReader(org: GuardedOrg, log?: (m: string) => void): OrgReader {
  const conn: Connection = org.conn
  const describeCache = new Map<string, TemplateDescribe | null>()
  return {
    orgId: org.orgId,
    label: org.alias,
    async describeGlobal(): Promise<GlobalObjectInfo[]> {
      const res = await withReadRetry(() => conn.describeGlobal(), log)
      return res.sobjects.map((o) => ({
        name: o.name,
        keyPrefix: o.keyPrefix ?? null,
        queryable: o.queryable ?? false
      }))
    },
    async describe(object: string): Promise<TemplateDescribe | null> {
      if (describeCache.has(object)) return describeCache.get(object)!
      let out: TemplateDescribe | null
      try {
        const res = await withReadRetry(() => conn.describe(object), log)
        out = toTemplateDescribe(res as unknown as { name: string; fields: Array<Record<string, unknown>> })
      } catch (e) {
        if (!isNotFound(e)) throw e
        out = null
      }
      describeCache.set(object, out)
      return out
    },
    async query(soql: string): Promise<Array<Record<string, unknown>>> {
      const out: Array<Record<string, unknown>> = []
      let page = (await withReadRetry(() => runQuery(conn, soql), log)) as Page
      for (;;) {
        for (const r of page.records) out.push(stripAttributes(r))
        if (page.done || page.nextRecordsUrl == null) break
        const next = page.nextRecordsUrl
        page = (await withReadRetry(() => conn.request(next), log)) as Page
      }
      return out
    },
    async toolingQuery(soql: string): Promise<Array<Record<string, unknown>>> {
      type ToolingPage = { done: boolean; nextRecordsUrl?: string; records?: unknown[] }
      const out: Array<Record<string, unknown>> = []
      // jsforce's tooling.query returns a thenable Query, not a Promise — await it inside an async fn.
      let res = await withReadRetry(async (): Promise<ToolingPage> => (await conn.tooling.query(soql)) as ToolingPage, log)
      out.push(...((res.records ?? []) as Array<Record<string, unknown>>).map(stripAttributes))
      while (!res.done && res.nextRecordsUrl) {
        const next = res.nextRecordsUrl
        res = await withReadRetry(async (): Promise<ToolingPage> => (await conn.tooling.queryMore(next)) as ToolingPage, log)
        out.push(...((res.records ?? []) as Array<Record<string, unknown>>).map(stripAttributes))
      }
      return out
    },
    async count(object: string, where?: string | null): Promise<number> {
      const w = (where ?? '').trim()
      const soql = `SELECT COUNT() FROM ${object}${w ? ` WHERE ${w}` : ''}`
      const res = (await withReadRetry(() => runQuery(conn, soql), log)) as Page
      return res.totalSize
    },
    async attachmentBody(attachmentId: string): Promise<Uint8Array> {
      return withReadRetry(
        () =>
          new Promise<Uint8Array>((resolve, reject) => {
            const chunks: Buffer[] = []
            const stream = conn.sobject('Attachment').record(attachmentId).blob('Body')
            stream.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            stream.on('error', reject)
            stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
          }),
        log
      )
    },
    async organization(): Promise<{ id: string; name: string; isSandbox: boolean }> {
      const res = (await withReadRetry(
        () => runQuery(conn, 'SELECT Id, Name, IsSandbox FROM Organization LIMIT 1'),
        log
      )) as Page
      const r = res.records[0] ?? {}
      return { id: String(r.Id ?? org.orgId), name: String(r.Name ?? ''), isSandbox: r.IsSandbox === true }
    }
  }
}

function rowResults(res: unknown, submitted: number, fallbackIds: ReadonlyArray<string | null>): RowResult[] {
  const parsed = Array.isArray(res) ? (res as Array<Record<string, unknown>>) : []
  const out: RowResult[] = []
  for (let i = 0; i < submitted; i++) {
    const r = parsed[i]
    if (r == null) {
      out.push({ success: false, id: null, error: 'no result returned for this row', statusCode: null })
      continue
    }
    if (r.success === true) {
      out.push({ success: true, id: r.id != null ? String(r.id) : fallbackIds[i] ?? null, error: '', statusCode: null })
      continue
    }
    const { error, statusCode } = renderRowErrors(r.errors)
    out.push({ success: false, id: null, error: error || 'failed', statusCode })
  }
  return out
}

function allFailed(n: number, message: string): RowResult[] {
  return Array.from({ length: n }, () => ({ success: false, id: null, error: message, statusCode: null }))
}

export function makeOrgWriter(
  org: GuardedOrg,
  log?: (level: 'warn' | 'error', message: string) => void
): OrgWriter {
  const reader = makeOrgReader(org, log ? (m) => log('warn', m) : undefined)
  const conn: Connection = org.conn
  return {
    ...reader,
    async collections(method, object, records): Promise<RowResult[]> {
      if (records.length === 0) return []
      org.assertWritable(`${method} ${COMPOSITE} (${object})`)
      const body = JSON.stringify({
        allOrNone: false,
        records: records.map((r) => ({ attributes: { type: object }, ...r }))
      })
      try {
        const res = await conn.request({
          method,
          url: COMPOSITE,
          body,
          headers: { 'Content-Type': 'application/json', ...DUPLICATE_RULE_BYPASS_HEADER }
        })
        return rowResults(res, records.length, records.map((r) => (typeof r.Id === 'string' ? r.Id : null)))
      } catch (e) {
        // Never resent (a write may have landed) — every row fails with the transport error.
        return allFailed(records.length, e instanceof Error ? e.message : String(e))
      }
    },
    async deleteIds(ids): Promise<RowResult[]> {
      if (ids.length === 0) return []
      org.assertWritable(`DELETE ${COMPOSITE}`)
      try {
        const res = await conn.request({
          method: 'DELETE',
          url: `${COMPOSITE}?ids=${ids.join(',')}&allOrNone=false`
        })
        return rowResults(res, ids.length, ids)
      } catch (e) {
        return allFailed(ids.length, e instanceof Error ? e.message : String(e))
      }
    },
    async createRecord(object, record): Promise<string> {
      org.assertWritable(`POST /sobjects/${object}`)
      const res = (await conn.request({
        method: 'POST',
        url: `/services/data/v${API_VERSION}/sobjects/${object}`,
        body: JSON.stringify(record),
        headers: { 'Content-Type': 'application/json' }
      })) as { id?: unknown; success?: unknown; errors?: unknown }
      if (res?.success !== true || typeof res.id !== 'string') {
        throw new Error(`create ${object} failed: ${renderRowErrors(res?.errors).error || JSON.stringify(res).slice(0, 300)}`)
      }
      return res.id
    },
    toggle: makeAutomationToggleIo(org, log),
    triggerIo: makeTriggerToggleIo(org, log),
    async metadataDeploy(zip): Promise<MetadataDeployResult> {
      org.assertWritable('Metadata API deploy')
      try {
        const result = await conn.metadata
          .deploy(Buffer.from(zip), {
            singlePackage: true,
            rollbackOnError: true,
            testLevel: 'NoTestRun',
            checkOnly: false
          })
          .complete(true)
        const details = result.details as { componentFailures?: unknown } | undefined
        const raw = details?.componentFailures
        const failures = (Array.isArray(raw) ? raw : raw != null ? [raw] : []) as Array<Record<string, unknown>>
        const problems = failures.map((f) => `${String(f.fullName ?? '')}: ${String(f.problem ?? '')}`)
        if (!result.success && problems.length === 0 && result.errorMessage) problems.push(String(result.errorMessage))
        return { success: result.success === true, problems }
      } catch (e) {
        return { success: false, problems: [e instanceof Error ? e.message : String(e)] }
      }
    }
  }
}
