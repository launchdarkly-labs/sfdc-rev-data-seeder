/**
 * Apex trigger STATUS changes (S59 plan §4.3, decision D2) — "Deactivate"
 * instead of commenting the body out.
 *
 * The facts, in cost order:
 *  1. Tooling REST `PATCH ApexTrigger.Status` is rejected in sandboxes
 *     (INVALID_TYPE — seen live by both the reference tool and the RDS trigger
 *     engine). Not a candidate.
 *  2. Tooling MetadataContainer + ApexTriggerMember — the pipeline
 *     triggerBodyToggle.ts already uses for bodies. `ApexTriggerMember.Metadata`
 *     carries `{ apiVersion, status, packageVersions }`; a container save with
 *     `status: 'Inactive'` is spike #1 (`setTriggerStatusViaContainer`).
 *  3. File-based Metadata API deploy with `<status>Inactive</status>` in the
 *     `.trigger-meta.xml` — what change sets do (`buildTriggerStatusZip` +
 *     OrgWriter.metadataDeploy). Spike #2, used when #1 does not take.
 *
 * Both paths VERIFY by re-reading `ApexTrigger.Status` afterwards — the
 * ContainerAsyncRequest can report Completed while the status stays put, and
 * the trigger body engine's lesson (deterministic confirm, never an optimistic
 * count) applies here too. The caller (automationApply) falls back to the
 * comment-out stub when both mechanisms leave the status unchanged.
 *
 * ENGINE-PURE: all IO through TriggerToggleIo (Tooling) and OrgWriter
 * (metadata deploy + Tooling query).
 */
import { urlEncode } from '../automationToggle'
import type { TriggerToggleIo } from '../triggerBodyToggle'
import { escapeSingleQuotes, ciEquals } from '../deploy/transform/apexSemantics'
import { buildZip } from './zip'
import type { OrgWriter } from './io'

const TOOLING_BASE = '/services/data/v66.0/tooling/sobjects/'
const TOOLING_QUERY = '/services/data/v66.0/tooling/query/?q='
const MD_NS = 'http://soap.sforce.com/2006/04/metadata'

export type TriggerStatus = 'Active' | 'Inactive'

export interface TriggerRecord {
  id: string
  name: string
  body: string
  apiVersion: number
  status: string
}

/** `SELECT Id, Name, Body, ApiVersion, Status FROM ApexTrigger WHERE Name IN (…)` via the toggle seam. */
export async function fetchTriggerRecords(
  io: TriggerToggleIo,
  names: ReadonlyArray<string>
): Promise<Map<string, TriggerRecord>> {
  const out = new Map<string, TriggerRecord>()
  if (names.length === 0) return out
  const quoted = names.map((n) => `'${escapeSingleQuotes(n)}'`).join(',')
  const res = await io.callout(
    TOOLING_QUERY + urlEncode(`SELECT Id, Name, Body, ApiVersion, Status FROM ApexTrigger WHERE Name IN (${quoted})`),
    'GET',
    null
  )
  if (!res.success) throw new Error(`Trigger query failed: ${res.errorMessage ?? res.statusCode}`)
  const parsed = JSON.parse(res.body ?? '{}') as { records?: unknown }
  for (const r of Array.isArray(parsed.records) ? parsed.records : []) {
    const m = (r ?? {}) as Record<string, unknown>
    if (typeof m.Id !== 'string' || typeof m.Name !== 'string') continue
    out.set(m.Name, {
      id: m.Id,
      name: m.Name,
      body: typeof m.Body === 'string' ? m.Body : '',
      apiVersion: typeof m.ApiVersion === 'number' ? m.ApiVersion : parseFloat(String(m.ApiVersion ?? '66.0')) || 66,
      status: typeof m.Status === 'string' ? m.Status : 'Unknown'
    })
  }
  return out
}

/** Re-read one trigger's Status (the verify step both mechanisms end with). */
export async function readTriggerStatus(io: TriggerToggleIo, triggerId: string): Promise<string | null> {
  const res = await io.callout(
    TOOLING_QUERY + urlEncode(`SELECT Status FROM ApexTrigger WHERE Id = '${escapeSingleQuotes(triggerId)}'`),
    'GET',
    null
  )
  if (!res.success) return null
  const parsed = JSON.parse(res.body ?? '{}') as { records?: Array<{ Status?: unknown }> }
  const s = parsed.records?.[0]?.Status
  return typeof s === 'string' ? s : null
}

export interface StatusAttempt {
  mechanism: 'container' | 'metadataDeploy'
  /** The status the org reports AFTER the attempt (null = could not read). */
  statusAfter: string | null
  ok: boolean
  detail: string | null
}

/**
 * Spike #1 — status through a MetadataContainer. Mirrors deployContainer in
 * triggerBodyToggle.ts (create → member with Body + Metadata → async request →
 * poll → delete), with `Metadata.status` set. Confirms by re-reading Status.
 */
export async function setTriggerStatusViaContainer(
  io: TriggerToggleIo,
  trigger: TriggerRecord,
  status: TriggerStatus
): Promise<StatusAttempt> {
  const containerName = `RDS_TplStatus_${io.now().getTime()}`
  const create = await io.callout(`${TOOLING_BASE}MetadataContainer/`, 'POST', JSON.stringify({ Name: containerName }))
  if (!create.success) {
    return { mechanism: 'container', statusAfter: null, ok: false, detail: `container create failed: ${create.errorMessage ?? create.body ?? ''}` }
  }
  const containerId = (JSON.parse(create.body ?? '{}') as { id?: unknown }).id
  if (typeof containerId !== 'string') {
    return { mechanism: 'container', statusAfter: null, ok: false, detail: 'container create returned no id' }
  }
  let detail: string | null = null
  try {
    const member = await io.callout(
      `${TOOLING_BASE}ApexTriggerMember/`,
      'POST',
      JSON.stringify({
        MetadataContainerId: containerId,
        ContentEntityId: trigger.id,
        Body: trigger.body,
        Metadata: { apiVersion: trigger.apiVersion, status }
      })
    )
    if (!member.success) {
      return {
        mechanism: 'container',
        statusAfter: null,
        ok: false,
        detail: `member add failed: ${member.errorMessage ?? member.body ?? ''}`
      }
    }
    const req = await io.callout(
      `${TOOLING_BASE}ContainerAsyncRequest/`,
      'POST',
      JSON.stringify({ MetadataContainerId: containerId, IsCheckOnly: false })
    )
    if (!req.success) {
      return { mechanism: 'container', statusAfter: null, ok: false, detail: `async request failed: ${req.errorMessage ?? req.body ?? ''}` }
    }
    const reqId = (JSON.parse(req.body ?? '{}') as { id?: unknown }).id
    const state = await pollContainer(io, typeof reqId === 'string' ? reqId : null)
    if (!ciEquals(state.state, 'Completed')) detail = `container request ended ${state.state}${state.error ? `: ${state.error}` : ''}`
  } finally {
    await io.callout(`${TOOLING_BASE}MetadataContainer/${containerId}`, 'DELETE', null)
  }
  const after = await readTriggerStatus(io, trigger.id)
  const ok = after !== null && ciEquals(after, status)
  return {
    mechanism: 'container',
    statusAfter: after,
    ok,
    detail: ok ? null : (detail ?? `status still ${after ?? 'unreadable'} after the container save`)
  }
}

async function pollContainer(
  io: TriggerToggleIo,
  reqId: string | null,
  maxAttempts = 90,
  intervalMs = 2000
): Promise<{ state: string; error: string | null }> {
  if (reqId === null) return { state: 'Unknown', error: 'no request id' }
  for (let i = 0; i < maxAttempts; i++) {
    const res = await io.callout(
      TOOLING_QUERY +
        urlEncode(`SELECT State, ErrorMsg, DeployDetails FROM ContainerAsyncRequest WHERE Id = '${escapeSingleQuotes(reqId)}'`),
      'GET',
      null
    )
    if (!res.success) return { state: 'Unknown', error: res.errorMessage ?? null }
    const rec = ((JSON.parse(res.body ?? '{}') as { records?: unknown[] }).records?.[0] ?? {}) as Record<string, unknown>
    const state = typeof rec.State === 'string' ? rec.State : 'Unknown'
    if (['Completed', 'Failed', 'Aborted', 'Invalidated'].some((s) => ciEquals(s, state))) {
      return { state, error: extractProblem(rec) }
    }
    await io.sleep(intervalMs)
  }
  return { state: 'Timeout', error: null }
}

function extractProblem(rec: Record<string, unknown>): string | null {
  const dd = rec.DeployDetails as { componentFailures?: unknown } | null | undefined
  const failures = dd?.componentFailures
  if (Array.isArray(failures) && failures.length > 0) {
    return failures
      .map((f) => {
        const m = (f ?? {}) as Record<string, unknown>
        return `${String(m.fullName ?? '')}: ${String(m.problem ?? '')}`
      })
      .join(' | ')
  }
  return rec.ErrorMsg == null ? null : String(rec.ErrorMsg)
}

/** The `.trigger-meta.xml` for a status + api version. */
export function triggerMetaXml(apiVersion: number, status: TriggerStatus): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<ApexTrigger xmlns="${MD_NS}">\n` +
    `    <apiVersion>${apiVersion.toFixed(1)}</apiVersion>\n` +
    `    <status>${status}</status>\n` +
    '</ApexTrigger>\n'
  )
}

export function packageXml(triggerNames: ReadonlyArray<string>, apiVersion: number): string {
  const members = [...triggerNames].sort().map((n) => `        <members>${n}</members>`)
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Package xmlns="${MD_NS}">\n` +
    '    <types>\n' +
    members.join('\n') +
    '\n        <name>ApexTrigger</name>\n' +
    '    </types>\n' +
    `    <version>${apiVersion.toFixed(1)}</version>\n` +
    '</Package>\n'
  )
}

/** Spike #2 — the metadata-format zip that deploys the triggers with the wanted status. */
export function buildTriggerStatusZip(triggers: ReadonlyArray<TriggerRecord>, status: TriggerStatus): Uint8Array {
  const entries = triggers.flatMap((t) => [
    { path: `triggers/${t.name}.trigger`, data: t.body },
    { path: `triggers/${t.name}.trigger-meta.xml`, data: triggerMetaXml(t.apiVersion, status) }
  ])
  const apiVersion = Math.max(...triggers.map((t) => t.apiVersion), 66)
  entries.push({ path: 'package.xml', data: packageXml(triggers.map((t) => t.name), apiVersion) })
  return buildZip(entries)
}

export async function setTriggerStatusViaMetadataDeploy(
  target: OrgWriter,
  trigger: TriggerRecord,
  status: TriggerStatus
): Promise<StatusAttempt> {
  const result = await target.metadataDeploy(buildTriggerStatusZip([trigger], status))
  const after = await readTriggerStatus(target.triggerIo, trigger.id)
  const ok = after !== null && ciEquals(after, status)
  return {
    mechanism: 'metadataDeploy',
    statusAfter: after,
    ok,
    detail: ok ? null : result.problems.length > 0 ? result.problems.join(' | ') : `status still ${after ?? 'unreadable'} after the deploy`
  }
}

/**
 * Container first, metadata deploy second. Returns every attempt made so the
 * report can say which mechanism worked (the spike's answer, recorded live).
 */
export async function setTriggerStatus(
  target: OrgWriter,
  trigger: TriggerRecord,
  status: TriggerStatus
): Promise<{ ok: boolean; attempts: StatusAttempt[] }> {
  const attempts: StatusAttempt[] = []
  const a = await setTriggerStatusViaContainer(target.triggerIo, trigger, status)
  attempts.push(a)
  if (a.ok) return { ok: true, attempts }
  const b = await setTriggerStatusViaMetadataDeploy(target, trigger, status)
  attempts.push(b)
  return { ok: b.ok, attempts }
}
