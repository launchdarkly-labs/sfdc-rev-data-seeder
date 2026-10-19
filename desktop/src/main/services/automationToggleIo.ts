/**
 * E4A.2 — live AutomationToggleIo adapter: binds the pure toggle engine
 * (engine/automationToggle.ts) to a GuardedOrg.
 *
 * EVERY callout — reads included — is gated by `assertWritable`: automation
 * toggles only ever run against the TARGET org, so a toggle IO handed a
 * source/prod connection must refuse before any request leaves the machine.
 * That gate THROWS (ReadOnlyOrgError) rather than resolving success:false —
 * a role violation is a structural bug that must surface loudly, not degrade
 * into the engine's per-item fallback ladder.
 *
 * HTTP/network errors DO resolve success:false (never reject) — the engine's
 * composite→per-item fallback semantics depend on that contract, mirroring
 * Apex `OrgConnectionService.makeCallout` which never throws on HTTP failure.
 *
 * OCS FAILURE-SHAPE PARITY (E4A.5 REVIEW-FIX): on an HTTP error RESPONSE the
 * Apex result carries the real status + the Salesforce error body
 * (OCS:898-903) — `statusCode 0` with no body is reserved for the
 * transport-exception catch (:904-908). jsforce-node throws HttpApiError for
 * status ≥ 400, discarding the raw response, so the adapter RECONSTRUCTS the
 * error body from the error's parsed data/message — cpqGuard.writeControl's
 * INVALID_FIELD retry (the older-connector-package fallback that prevents
 * the 159-SBQQ-error storm) reads exactly that body.
 */
import type { GuardedOrg } from './salesforce'
import type {
  AutomationToggleIo,
  ToggleCalloutResult,
  ToggleHttpMethod
} from '../engine/automationToggle'
import type { TriggerToggleIo } from '../engine/triggerBodyToggle'
import type { CpqGuardIo } from '../engine/cpqGuard'

/**
 * jsforce HttpApiError → the OCS HTTP-failure shape. An HTTP-RESPONSE error
 * always carries `errorCode` (the SF error code, or `ERROR_HTTP_<status>`
 * when unparsable) plus the parsed error details in `data`; a transport
 * error (fetch failed, DNS, timeout) carries neither → null.
 */
function httpErrorShape(
  e: unknown
): { statusCode: number; body: string; errorMessage: string } | null {
  if (!(e instanceof Error)) return null
  const errorCode = (e as { errorCode?: unknown }).errorCode
  if (typeof errorCode !== 'string') return null
  const statusMatch = /^ERROR_HTTP_(\d+)$/.exec(errorCode)
  const data = (e as { data?: unknown }).data
  return {
    // the real status when jsforce preserved it; otherwise 400 as the
    // generic received-an-HTTP-error marker (engine checks are ===200/204
    // equality only — never a range — so the placeholder is inert)
    statusCode: statusMatch ? parseInt(statusMatch[1]!, 10) : 400,
    body: JSON.stringify(data ?? [{ message: e.message, errorCode }]),
    errorMessage: e.message
  }
}

export function makeAutomationToggleIo(
  target: GuardedOrg,
  log?: (level: 'warn' | 'error', message: string) => void
): AutomationToggleIo {
  return {
    async callout(
      path: string,
      method: ToggleHttpMethod,
      body: string | null
    ): Promise<ToggleCalloutResult> {
      target.assertWritable(`automation toggle: ${method} ${path}`)
      try {
        const res = await target.conn.request({
          method,
          url: path,
          body: body ?? undefined,
          headers: body != null ? { 'Content-Type': 'application/json' } : undefined
        })
        // jsforce resolves 204 No Content as undefined → empty body; the
        // engine's PATCH checks accept success:true without a parsable body.
        return { success: true, statusCode: 200, body: res === undefined ? '' : JSON.stringify(res) }
      } catch (e) {
        const httpErr = httpErrorShape(e)
        if (httpErr !== null) return { success: false, ...httpErr }
        return {
          success: false,
          statusCode: 0,
          errorMessage: e instanceof Error ? e.message : String(e)
        }
      }
    },
    log
  }
}

/**
 * E4A.3 — the trigger-body toggle IO: the same guarded callout seam plus
 * deterministic-poll pacing (real sleep) and container naming (real clock).
 * Tests inject fakes via `opts`.
 */
export function makeTriggerToggleIo(
  target: GuardedOrg,
  log?: (level: 'warn' | 'error', message: string) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => Date }
): TriggerToggleIo {
  return {
    ...makeAutomationToggleIo(target, log),
    sleep: opts?.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))),
    now: opts?.now ?? ((): Date => new Date())
  }
}

/**
 * E4A.5 — the CPQ guard IO: the same guarded callout seam plus the clock the
 * TTL stamps need and the connection's cached target Org Id (≙ the
 * Org_Connection__c.Org_Id__c cache in AMS.resolveTargetOrganizationId —
 * GuardedOrg always mints orgId, so the live-query fallback is belt-and-
 * suspenders). Tests inject a fake clock via `opts`.
 */
export function makeCpqGuardIo(
  target: GuardedOrg,
  log?: (level: 'warn' | 'error', message: string) => void,
  opts?: { now?: () => Date }
): CpqGuardIo {
  return {
    ...makeAutomationToggleIo(target, log),
    now: opts?.now ?? ((): Date => new Date()),
    cachedTargetOrgId: target.orgId
  }
}
