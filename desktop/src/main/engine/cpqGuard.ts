/**
 * E4A.5 — CPQ trigger guard arm/disarm + post-deploy finalize callouts.
 * Port of the guard slice of `AutomationManagementService.cls` (AMS) and the
 * Phase-A callout core of `PostDeploymentQueueable.cls` (PDQ):
 *
 *  - setCpqTriggerDisabled (legacy)  (AMS:855-912)
 *  - CPQ_GUARD_TTL_HOURS / setRdsDeploymentControl (AMS:924-1005)
 *  - writeControl INVALID_FIELD retry (AMS:964-985 — numbered per deployed
 *    source; the retry body-marker triple is the load-bearing part)
 *  - resolveTargetOrganizationId     (AMS:1013-1035)
 *  - doContractActivationCallouts    (PDQ:186-243)
 *  - the Phase-A ordering contract   (PDQ:22-27, :91-115)
 *
 * The load-bearing semantics, each verified against the Apex source:
 *  - SetupOwnerId for a hierarchy custom setting's Org Default IS the TARGET
 *    org's Organization Id — NOT the control org's. The historical
 *    '00D000000000000' placeholder was silently rejected by Salesforce, the
 *    guard record was never created, and every deploy hit 159+
 *    SBQQ.SubscriptionAfter errors. resolveTargetOrganizationId prefers the
 *    cached org Id (desktop: GuardedOrg.orgId ≙ Org_Connection__c.Org_Id__c)
 *    and falls back to a live `SELECT Id FROM Organization LIMIT 1`;
 *    unresolvable → warn + return false WITHOUT posting (AMS:947-952,
 *    :988-995).
 *  - TTL self-heal (N2b): arm sets Expires_At__c = now + 8h; disarm sets it
 *    to now (already-expired = OFF). RDS_CpqTriggerGuard on the target treats
 *    an expired/null-armed timestamp as OFF — fail-safe direction — so even a
 *    dead laptop can't leave CPQ triggers disabled past the TTL.
 *  - INVALID_FIELD retry: Expires_At__c is a connector-package field; an
 *    older target package rejects it. writeControl retries ONCE without
 *    Expires_At__c when the failure body mentions 'Expires_At__c',
 *    'INVALID_FIELD', or 'No such column' — falling back to
 *    armed-until-explicitly-disarmed rather than failing the guard write and
 *    re-introducing the SBQQ error storm.
 *  - Both flags flip TOGETHER: Disable_CPQ_Triggers__c (read by
 *    RDS_CpqTriggerGuard) + Deployment_In_Progress__c (read by
 *    RDS_DeploymentGuard for customer triggers).
 *  - Legacy SBQQ__TriggerDisabled__c branch (current CPQ versions removed the
 *    setting — discovery's hasCpqTriggerSetting probe gates it): PATCH the
 *    existing org-default record's SBQQ__IsDisabled__c, or POST a new one
 *    with the target SetupOwnerId. E4A.6's item dispatch calls this for
 *    'CPQTriggerSetting' ledger items.
 *  - ORDERING (PDQ:22-27): Contract activation runs BEFORE the guard disarm,
 *    while SBQQ.ContractAfter is still suppressed. Cancel mode SKIPS
 *    activation (a cancelled deploy must not finalize partial data) but
 *    still disarms. `runPostDeployFinalizeCallouts` encodes exactly that.
 *  - Contract activation (PDQ:186-243): Draft Contracts carrying our ExtId →
 *    PATCH to 'Activated' via composite sObjects in chunks of 200,
 *    allOrNone:false; per-record success counting; a failed batch callout
 *    adds the whole chunk to `failed`; ANY thrown error lands in
 *    ActivationResult.error (the method never throws).
 *  - PATCH success is `statusCode == 204 || success` everywhere (AMS:957,
 *    :892) — jsforce's 204→success:true satisfies it; the explicit 204 check
 *    is kept for raw-adapter parity.
 *
 * Documented micro-deviations (same class as E4A.2's, argued in-file where
 * they occur): malformed response CONTAINERS follow the Apex cast-throw
 * exactly where the Apex throw was observable (uncaught out of
 * setRdsDeploymentControl/setCpqTriggerDisabled → the driver's catch), and
 * degrade to the documented false/error paths where Apex caught them
 * (resolveTargetOrganizationId, doContractActivationCallouts).
 *
 * NOT here (E4A.6 driver concerns): when to arm (playbook-gated pre-deploy,
 * AutomationDisableQueueable:67-86), Bulk-job abort on cancel, all Phase-B
 * logging/DML, the ledger-driven restore dispatch.
 *
 * ENGINE-PURE: no jsforce/better-sqlite3 — all IO through CpqGuardIo (the
 * E4A.2 callout seam + a clock). The live adapter gates every callout with
 * GuardedOrg.assertWritable (target-only by construction).
 */
import type { AutomationToggleIo, ToggleCalloutResult } from './automationToggle'
import { urlEncode } from './automationToggle'
import { EXT_ID_FIELD } from './readiness'
import { buildDraftActivationQuery } from './deploy/transform/contracts'

/** Apex CPQ_GUARD_TTL_HOURS (AMS:928). */
export const CPQ_GUARD_TTL_HOURS = 8

const DATA = '/services/data/v66.0'

/** The E4A.2 callout seam plus the clock the TTL stamps need. */
export interface CpqGuardIo extends AutomationToggleIo {
  now(): Date
  /** The target org's 18-char Organization Id if the connection knows it
   *  (≙ the cached Org_Connection__c.Org_Id__c, AMS:1019-1023). */
  cachedTargetOrgId?: string | null
}

// ─────────────────────────────── pure helpers ────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const logIo = (io: CpqGuardIo, level: 'warn' | 'error', message: string): void => {
  io.log?.(level, message)
}

/**
 * Apex `(List<Object>) response.get('records')` after a successful query:
 * JSON.parse throws on non-JSON (≙ deserializeUntyped), a non-object body or
 * non-list records throws (≙ the casts) — uncaught here, caught by whichever
 * driver wraps the call, exactly like the Apex.
 */
function parseQueryRecords(body: string | null | undefined): Array<Record<string, unknown>> {
  const parsed = JSON.parse(body ?? '') as unknown
  const container = asRecord(parsed)
  if (container === null) throw new TypeError('Query response is not an object')
  const records = container.records
  if (records == null) return []
  if (!Array.isArray(records)) throw new TypeError('Query records is not a list')
  return records.map((r) => {
    const rec = asRecord(r)
    // Apex element casts THROW (AMS:951/:873, PDQ:217) — coercing to {}
    // would emit a live PATCH against recordId '' before failing (REVIEW-FIX)
    if (rec === null) throw new TypeError('Query record is not an object')
    return rec
  })
}

/** Apex DateTime.formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'') ≙ toISOString. */
const formatGmt = (d: Date): string => d.toISOString()

const addHours = (d: Date, hours: number): Date => new Date(d.getTime() + hours * 3_600_000)

// ─────────────────────── RDS_Deployment_Control__c guard ─────────────────────

/**
 * Port of AMS.writeControl (:964-985): write the control record with a
 * tolerant retry — when the target runs an older connector package that
 * rejects Expires_At__c, drop the field and retry once (pre-N2b behavior:
 * armed-until-explicitly-disarmed, no TTL self-heal).
 */
export async function writeControl(
  io: CpqGuardIo,
  endpoint: string,
  method: 'PATCH' | 'POST',
  payload: Record<string, unknown>
): Promise<ToggleCalloutResult> {
  let result = await io.callout(endpoint, method, JSON.stringify(payload))
  const ok = result.statusCode === 204 || result.success
  const body = result.body ?? ''
  if (
    !ok &&
    'Expires_At__c' in payload &&
    body.trim() !== '' &&
    (body.includes('Expires_At__c') ||
      body.includes('INVALID_FIELD') ||
      body.includes('No such column'))
  ) {
    const retry = { ...payload }
    delete retry.Expires_At__c
    result = await io.callout(endpoint, method, JSON.stringify(retry))
  }
  return result
}

/**
 * Port of AMS.setRdsDeploymentControl (:930-1005): arm (disabled=true) or
 * disarm (disabled=false) the packaged CPQ trigger guard on the TARGET.
 * Returns false when the setting doesn't exist / the write fails — the
 * driver logs the manual-flip warning (PDQ:152-155).
 */
export async function setRdsDeploymentControl(io: CpqGuardIo, disabled: boolean): Promise<boolean> {
  const soql = urlEncode(
    'SELECT Id, Disable_CPQ_Triggers__c, Deployment_In_Progress__c FROM RDS_Deployment_Control__c LIMIT 1'
  )
  const queryResult = await io.callout(`${DATA}/query/?q=${soql}`, 'GET', null)
  if (!queryResult.success) return false

  const records = parseQueryRecords(queryResult.body)

  // Arm → expires now + TTL; disarm → expires now (already-expired = OFF).
  const now = io.now()
  const expiry = disabled ? addHours(now, CPQ_GUARD_TTL_HOURS) : now
  const payload: Record<string, unknown> = {
    Disable_CPQ_Triggers__c: disabled,
    Deployment_In_Progress__c: disabled,
    Expires_At__c: formatGmt(expiry)
  }

  if (records.length > 0) {
    const recordId = String(records[0]?.Id ?? '')
    const result = await writeControl(
      io,
      `${DATA}/sobjects/RDS_Deployment_Control__c/${recordId}`,
      'PATCH',
      payload
    )
    return result.statusCode === 204 || result.success
  }

  // No Org Default record yet — create one with the TARGET org's Id as
  // SetupOwnerId (the '00D000000000000' placeholder bug — 159+ SBQQ errors).
  const targetOrgId = await resolveTargetOrganizationId(io)
  if (targetOrgId === null || targetOrgId.trim() === '') {
    logIo(io, 'warn', 'setRdsDeploymentControl: could not resolve target Org Id')
    return false
  }
  payload.SetupOwnerId = targetOrgId
  const result = await writeControl(
    io,
    `${DATA}/sobjects/RDS_Deployment_Control__c/`,
    'POST',
    payload
  )
  if (!result.success) {
    logIo(
      io,
      'warn',
      `setRdsDeploymentControl POST failed: ${result.errorMessage ?? 'null'} | body: ${result.body ?? 'null'}`
    )
  }
  return result.success
}

/**
 * Port of AMS.resolveTargetOrganizationId (:1013-1035): the cached org Id
 * when the connection carries one, else a live Organization query. Failures
 * degrade to null (the Apex catch/fall-through), never throw.
 */
export async function resolveTargetOrganizationId(io: CpqGuardIo): Promise<string | null> {
  const cached = io.cachedTargetOrgId
  if (typeof cached === 'string' && cached.trim() !== '') return cached

  const r = await io.callout(
    `${DATA}/query/?q=${urlEncode('SELECT Id FROM Organization LIMIT 1')}`,
    'GET',
    null
  )
  if (!r.success) return null
  try {
    const records = parseQueryRecords(r.body)
    if (records.length === 0) return null
    const id = records[0]?.Id
    return typeof id === 'string' ? id : null
  } catch {
    return null // AMS:1032-1034 — malformed body → null
  }
}

// ──────────────────── legacy SBQQ__TriggerDisabled__c setting ────────────────

/**
 * E4A.6 restore-to-ORIGINAL support (FINDING #18): read the CURRENT value of
 * the legacy setting — false when the org-default record is absent (no
 * record = not disabled). The disable driver enrolls the setting ONLY when
 * this is false, so its unconditional un-disable restore can never flip a
 * deliberately-true org. Query failure THROWS (callers treat the setting as
 * unreadable and skip enrollment rather than guessing).
 */
export async function readCpqTriggerDisabled(io: CpqGuardIo): Promise<boolean> {
  const soql = urlEncode('SELECT Id, SBQQ__IsDisabled__c FROM SBQQ__TriggerDisabled__c LIMIT 1')
  const queryResult = await io.callout(`${DATA}/query/?q=${soql}`, 'GET', null)
  if (!queryResult.success) {
    throw new Error(`SBQQ__TriggerDisabled__c read failed: ${queryResult.errorMessage ?? 'null'}`)
  }
  const records = parseQueryRecords(queryResult.body)
  return records.length > 0 && records[0]?.SBQQ__IsDisabled__c === true
}

/**
 * Port of AMS.setCpqTriggerDisabled (:855-912) — the LEGACY hierarchy custom
 * setting (removed on current CPQ versions; gate on discovery's
 * hasCpqTriggerSetting probe). E4A.6's item dispatch drives this for
 * 'CPQTriggerSetting' ledger items (disable=true on disable, false on
 * restore).
 */
export async function setCpqTriggerDisabled(io: CpqGuardIo, disabled: boolean): Promise<boolean> {
  const soql = urlEncode('SELECT Id FROM SBQQ__TriggerDisabled__c LIMIT 1')
  const queryResult = await io.callout(`${DATA}/query/?q=${soql}`, 'GET', null)
  if (!queryResult.success) return false

  const records = parseQueryRecords(queryResult.body)

  if (records.length > 0) {
    const recordId = String(records[0]?.Id ?? '')
    const result = await io.callout(
      `${DATA}/sobjects/SBQQ__TriggerDisabled__c/${recordId}`,
      'PATCH',
      JSON.stringify({ SBQQ__IsDisabled__c: disabled })
    )
    return result.statusCode === 204 || result.success
  }

  const targetOrgId = await resolveTargetOrganizationId(io)
  if (targetOrgId === null || targetOrgId.trim() === '') {
    logIo(io, 'warn', 'setCpqTriggerDisabled: could not resolve target Org Id')
    return false
  }
  const result = await io.callout(
    `${DATA}/sobjects/SBQQ__TriggerDisabled__c/`,
    'POST',
    JSON.stringify({ SBQQ__IsDisabled__c: disabled, SetupOwnerId: targetOrgId })
  )
  return result.success
}

// ─────────────────────────── contract activation ─────────────────────────────

/** Mirror of PDQ.ActivationResult (:283-288). */
export interface ActivationResult {
  attempted: boolean
  activated: number
  failed: number
  error: string | null
}

/**
 * Port of PDQ.doContractActivationCallouts (:186-243): PATCH the target's
 * Draft Contracts (ours — ExtId present) to Activated via composite sObjects
 * in chunks of 200, allOrNone:false. NEVER throws — any error lands in
 * `result.error` and the driver logs it as a Warning (PDQ:131-134).
 * MUST run BEFORE the guard disarm (SBQQ.ContractAfter still suppressed).
 *
 * `runExtIds` (E4A.6 → S46 E1, DESIGN-AUTHORIZED — deployDesign §4.3(2)):
 * when provided, activation is scoped to THIS RUN's written Contracts by the
 * ExtIds the run wrote — the query becomes `Status='Draft' AND ExtId IN (…)`
 * in 200-Id chunks (contracts.ts `buildDraftActivationQuery`), so a Draft
 * Contract from another run/source is never even selected. This is the
 * class-9 fix killing the Apex org-wide force-activation. An EMPTY list
 * activates nothing (zero callouts). Omitted/undefined keeps the verbatim
 * org-wide Apex query (PDQ:196).
 *
 * Why ExtIds and not target Ids (S46): the first-pass upsert path never
 * records target Ids (collections.ts discards success ids; only the junction
 * path writes them), so a target-Id scope matched nothing live — a structural
 * no-op that would have left every Contract Draft on the first sb1 run.
 */
export async function activateDraftContracts(
  io: CpqGuardIo,
  runExtIds?: ReadonlyArray<string>
): Promise<ActivationResult> {
  const r: ActivationResult = { attempted: false, activated: 0, failed: 0, error: null }
  try {
    const records: Array<Record<string, unknown>> = []
    if (runExtIds === undefined) {
      const soql = `SELECT Id, Status FROM Contract WHERE Status = 'Draft' AND ${EXT_ID_FIELD} != null`
      const queryResult = await io.callout(`${DATA}/query/?q=${urlEncode(soql)}`, 'GET', null)
      if (!queryResult.success) {
        r.error = `Query failed: ${queryResult.errorMessage ?? 'null'}`
        return r
      }
      records.push(...parseQueryRecords(queryResult.body))
    } else {
      // All chunks are queried BEFORE any PATCH so a failed chunk query lands
      // in r.error with nothing half-activated (never-throws contract kept).
      for (let i = 0; i < runExtIds.length; i += 200) {
        const soql = buildDraftActivationQuery(runExtIds.slice(i, i + 200))
        const queryResult = await io.callout(`${DATA}/query/?q=${urlEncode(soql)}`, 'GET', null)
        if (!queryResult.success) {
          r.error = `Query failed: ${queryResult.errorMessage ?? 'null'}`
          return r
        }
        records.push(...parseQueryRecords(queryResult.body))
      }
    }
    r.attempted = true
    if (records.length === 0) return r

    const patchRecords = records.map((rec) => ({
      attributes: { type: 'Contract' },
      Id: String(rec.Id ?? ''),
      Status: 'Activated'
    }))

    for (let i = 0; i < patchRecords.length; i += 200) {
      const batch = patchRecords.slice(i, i + 200)
      const result = await io.callout(
        `${DATA}/composite/sobjects/`,
        'PATCH',
        JSON.stringify({ allOrNone: false, records: batch })
      )
      if (result.success) {
        const parsed = JSON.parse(result.body ?? '') as unknown
        if (!Array.isArray(parsed)) throw new TypeError('Composite PATCH response is not a list')
        for (const x of parsed) {
          if (asRecord(x)?.success === true) r.activated++
          else r.failed++
        }
      } else {
        r.failed += batch.length
      }
    }
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e)
  }
  return r
}

// ──────────────────────────── finalize composition ───────────────────────────

/** What the driver needs for its Phase-B logging (PDQ:129-156). */
export interface PostDeployFinalizeResult {
  /** null when activation was skipped (cancel mode / Contract not in scope). */
  activation: ActivationResult | null
  /** setRdsDeploymentControl(false) outcome — false ⇒ the manual-flip warning. */
  guardDisarmed: boolean
  /** A THROWN guard error (≙ PDQ's cpqFlipError catch, :110-114). */
  guardError: string | null
}

/**
 * The Phase-A callout core of PDQ.execute (:91-115) with the ordering
 * contract encoded: Contract activation FIRST (only when not cancelled AND
 * Contract deployed records), THEN the CPQ guard disarm — activation must
 * happen while SBQQ.ContractAfter is still suppressed (PDQ:22-27). Cancel
 * mode skips activation but ALWAYS disarms. Bulk-job abort (cancel Phase A)
 * and all Phase-B logging/DML belong to the E4A.6 driver.
 */
export async function runPostDeployFinalizeCallouts(
  io: CpqGuardIo,
  opts: { isCancel: boolean; contractInScope: boolean; runExtIds?: ReadonlyArray<string> }
): Promise<PostDeployFinalizeResult> {
  let activation: ActivationResult | null = null
  if (!opts.isCancel && opts.contractInScope) {
    activation = await activateDraftContracts(io, opts.runExtIds)
  }

  let guardDisarmed = false
  let guardError: string | null = null
  try {
    guardDisarmed = await setRdsDeploymentControl(io, false)
  } catch (e) {
    guardError = e instanceof Error ? e.message : String(e)
  }

  return { activation, guardDisarmed, guardError }
}
