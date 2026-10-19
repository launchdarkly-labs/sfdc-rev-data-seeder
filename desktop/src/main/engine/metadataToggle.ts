/**
 * E4A.4 — Metadata-API active-flag toggles: Duplicate Rules + the classic
 * Workflow-Rule disable slice. Port of `DuplicateRuleService.cls` (DRS):
 *
 *  - listRuleNames                   (DRS:19-62)
 *  - deactivateRules/reactivateRules (DRS:67-76)
 *  - toggleRules                     (DRS:80-113)
 *  - buildUpdateFromRead flip        (DRS:141-188)
 *  - countSuccesses                  (DRS:192-210)
 *
 * The load-bearing semantics, each verified against the Apex source:
 *  - Batches of METADATA_BATCH_MAX=10 (the Metadata API readMetadata/
 *    updateMetadata component limit, DRS:85-90): read the CURRENT full
 *    metadata, flip the active flag, write the ENTIRE record back
 *    (updateMetadata REPLACES the component — a partial record would wipe the
 *    rule's match/action config, which is why Apex round-trips the raw XML).
 *  - SILENT-ZERO hazard preserved for RECEIVED failure responses: a SOAP
 *    fault / non-200 on a batch's read or update is logged and contributes
 *    count 0 — toggleRules swallows any response Salesforce actually
 *    returned (`getStatusCode() != 200`, DRS:95-98, 106-110). Callers MUST
 *    treat `count > 0` as the outcome, exactly like
 *    `AutomationToggleBatch.cls:409-416, 435-444` — the per-item helpers
 *    below bake that in.
 *  - NO-RESPONSE transport failures (DNS, refused connection, timeout — the
 *    Apex CalloutException class) THROW (REVIEW-FIX #1): DRS.callSoap is a
 *    raw `new Http().send()` with no try/catch (DRS:214-222), so that class
 *    aborted the remaining batches and escaped the org-wide entry point
 *    loudly (DataSeederController:2691-2693). The adapter rethrows it;
 *    nothing in the batch paths here catches it. Only the per-item helpers
 *    catch→false, mirroring AutomationToggleBatch.disableItem/restoreItem's
 *    catch(Exception) (:412-415, :441-444).
 *  - listRuleNames DOES throw on failure (`listMetadata failed`, DRS:38-40)
 *    and skips managed rules (namespacePrefix present, DRS:54-58) and blank
 *    fullNames (DRS:53).
 *  - An empty read result skips the update call for that batch
 *    (buildUpdateFromRead → null → continue, DRS:102, 173).
 *  - countSuccesses counts `<success>true</success>` results only; malformed
 *    results are simply not counted, never thrown on (DRS:202-208).
 *
 * Design-authorized divergences (briefing/automationMap §1.4 — "jsforce
 * metadata.read/update, typed isActive flip"), each argued in place:
 *  - TYPED FLIP replaces the Apex raw-XML string substitution
 *    (`<isActive>false</isActive>` swap, DRS:161-162): we set the flag
 *    property unconditionally on the read record. Behavior-identical: the
 *    Apex substitution only rewrites when current == source, but an
 *    already-target-state record round-trips unchanged and its update still
 *    succeeds and is still counted — the final org state and the returned
 *    count match in every case.
 *  - Records with a missing/blank fullName (readMetadata's xsi:nil results
 *    for unknown names) are filtered before update. NOT count-equivalent in
 *    the mixed corner (REVIEW-FIX #3): Apex's string scan fused a
 *    self-closing nil record with the NEXT real record into a malformed
 *    envelope, failing the WHOLE updateMetadata call — the batch counted 0
 *    (DRS:148-171). The desktop salvages the surviving records and counts
 *    them: a rule deleted between list and read no longer poisons its batch.
 *  - The SOAP transport itself (session header, envelope XML, /Soap/m/66.0)
 *    is jsforce's Metadata API client, pinned to the same v66.0 via
 *    services/salesforce API_VERSION.
 *
 * WORKFLOW-RULE SLICE (desktop-only extension — S32 decision, 2026-07-24; the
 * frozen Apex NEVER handled classic WorkflowRule): the S32-decided mechanism
 * is `metadata.update('WorkflowRule')` with `active=false` on the
 * relevance-scoped intersection from `engine/workflowRules.
 * selectWorkflowRulesToDisable` — i.e. exactly this module's machinery with
 * type 'WorkflowRule' and flag field 'active'. Restore rides the E4A.6
 * ledger. There is no Apex oracle for this slice; its contract is the S32
 * decision record (ROADMAP 2026-07-24 entry) + the DuplicateRule semantics it
 * reuses.
 *
 * IO-seam contract: a failure response Salesforce RETURNED (SOAP fault,
 * non-200) RESOLVES `{ success: false }` — the silent-zero ladder depends on
 * it — while NO-RESPONSE transport errors (CalloutException parity) and
 * write-gate violations (ReadOnlyOrgError — a structural bug that must
 * surface loudly) THROW. The batch paths catch neither; the per-item
 * helpers catch the former and rethrow the latter.
 *
 * ENGINE-PURE: no jsforce/better-sqlite3 — all IO through MetadataToggleIo.
 * The live adapter (services/metadataToggleIo.ts) gates EVERY call with
 * GuardedOrg.assertWritable: these toggles only ever run against the TARGET.
 */
import type { WorkflowRule } from './workflowRules'

/** Metadata API readMetadata/updateMetadata component limit (DRS:85). */
export const METADATA_BATCH_MAX = 10

/**
 * RECEIVED failure responses (SOAP fault / non-200) resolve `success:false`
 * with the fault text. NO-RESPONSE transport errors (CalloutException
 * parity) and write-gate violations REJECT instead — see the IO-seam
 * contract in the module header. An implementer that resolves the transport
 * class would silently recreate the pre-REVIEW-FIX-#1 parity bug.
 */
export type MetadataIoResult<T> = { success: true; result: T } | { success: false; errorMessage: string }

/**
 * The injected Metadata-API seam. `list`/`read` results and `update` inputs
 * are opaque records — the engine only reads `fullName`/`namespacePrefix`
 * and writes the one active-flag field, so the full rule config round-trips
 * untouched (the typed equivalent of Apex shipping the raw read XML back).
 */
export interface MetadataToggleIo {
  list(type: string): Promise<MetadataIoResult<Array<Record<string, unknown>>>>
  read(
    type: string,
    fullNames: readonly string[]
  ): Promise<MetadataIoResult<Array<Record<string, unknown>>>>
  update(
    type: string,
    records: ReadonlyArray<Record<string, unknown>>
  ): Promise<MetadataIoResult<Array<Record<string, unknown>>>>
  /** System.debug parity channel — the silent-zero paths log here. */
  log?(level: 'warn' | 'error', message: string): void
}

// ─────────────────────────────── pure helpers ────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const isBlank = (v: string | null): boolean => v === null || v.trim() === ''

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const logIo = (io: MetadataToggleIo, level: 'warn' | 'error', message: string): void => {
  io.log?.(level, message)
}

/**
 * The per-item `count > 0` outcome with AutomationToggleBatch's
 * catch(Exception)→false parity (:412-415, :441-444): a thrown transport
 * failure reads as item failure — the ledger row stays unconfirmed for the
 * watchdog's idempotent re-attempt. Write-gate violations are EXCLUDED from
 * the catch (matched by name — the engine can't import the class): a role
 * violation is structural and must stay loud (E4A.2 contract; the Apex had
 * no equivalent guard to swallow).
 */
async function countAsOutcome(
  io: MetadataToggleIo,
  label: string,
  run: () => Promise<number>
): Promise<boolean> {
  try {
    return (await run()) > 0
  } catch (e) {
    if (e instanceof Error && e.name === 'ReadOnlyOrgError') throw e
    logIo(io, 'error', `${label} failed: ${errText(e)}`)
    return false
  }
}

/** DRS:192-210 — count `<success>true</success>` results; jsforce may parse
 *  the leaf as boolean or leave the string, so accept both. Anything else
 *  (false, missing, malformed) is simply not counted. */
export function countSaveSuccesses(results: ReadonlyArray<Record<string, unknown>>): number {
  let count = 0
  for (const r of results) {
    if (r.success === true || r.success === 'true') count++
  }
  return count
}

// ─────────────────────────────── duplicate rules ─────────────────────────────

/**
 * Port of DRS.listRuleNames (:19-62): all UNMANAGED duplicate-rule fullNames
 * on the target (e.g. 'Account.Standard_Account_Duplicate_Rule'). Skips
 * managed rules (namespacePrefix present) and blank fullNames. THROWS on a
 * failed listMetadata call — the one path in this module that does (DRS:38-40).
 */
export async function listDuplicateRuleNames(io: MetadataToggleIo): Promise<string[]> {
  const res = await io.list('DuplicateRule')
  if (!res.success) {
    throw new Error(`listMetadata failed: ${res.errorMessage}`)
  }
  const fullNames: string[] = []
  for (const item of res.result) {
    const fullName = str(item.fullName)
    if (isBlank(fullName)) continue
    if (!isBlank(str(item.namespacePrefix))) continue
    fullNames.push(fullName as string)
  }
  return fullNames
}

/**
 * Port of DRS.toggleRules (:80-113) generalized over the metadata type and
 * active-flag field name ('isActive' for DuplicateRule, 'active' for
 * WorkflowRule). Batches of 10: read → typed flip → update, accumulating
 * counted successes. RECEIVED failure responses (io result success:false)
 * are logged and contribute 0 — never thrown (the silent-zero contract
 * callers must respect). NO-RESPONSE transport rejections are NOT caught
 * here: they propagate and abort the remaining batches, CalloutException
 * parity.
 */
export async function toggleMetadataActiveFlag(
  io: MetadataToggleIo,
  type: string,
  fullNames: readonly string[],
  doActivate: boolean,
  flagField: string
): Promise<number> {
  let successCount = 0

  for (let i = 0; i < fullNames.length; i += METADATA_BATCH_MAX) {
    const batch = fullNames.slice(i, i + METADATA_BATCH_MAX)

    // 1. Read current metadata (DRS:93-98 — failure logged, batch skipped).
    const readRes = await io.read(type, batch)
    if (!readRes.success) {
      logIo(io, 'error', `readMetadata failed (${type}): ${readRes.errorMessage}`)
      continue
    }

    // 2. Typed flip on the full read records; nil results (blank fullName)
    //    are dropped (DRS buildUpdateFromRead extracts only real <records>).
    const flipped: Array<Record<string, unknown>> = []
    for (const rec of readRes.result) {
      if (isBlank(str(rec.fullName))) continue
      flipped.push({ ...rec, [flagField]: doActivate })
    }
    if (flipped.length === 0) continue // DRS:102 — null envelope, skip update

    // 3. Send update; count per-component successes (DRS:105-110).
    const updateRes = await io.update(type, flipped)
    if (updateRes.success) {
      successCount += countSaveSuccesses(updateRes.result)
    } else {
      logIo(io, 'error', `updateMetadata failed (${type}): ${updateRes.errorMessage}`)
    }
  }
  return successCount
}

/** DRS.deactivateRules (:67-69) — returns the count of confirmed successes. */
export function deactivateDuplicateRules(
  io: MetadataToggleIo,
  fullNames: readonly string[]
): Promise<number> {
  return toggleMetadataActiveFlag(io, 'DuplicateRule', fullNames, false, 'isActive')
}

/** DRS.reactivateRules (:74-76) — returns the count of confirmed successes. */
export function reactivateDuplicateRules(
  io: MetadataToggleIo,
  fullNames: readonly string[]
): Promise<number> {
  return toggleMetadataActiveFlag(io, 'DuplicateRule', fullNames, true, 'isActive')
}

/**
 * Per-item disable, `count > 0` AS the outcome — the exact
 * `AutomationToggleBatch.disableItem` MetadataDuplicateRule branch (:406-416):
 * a silent zero (swallowed failure response) MUST read as failure so the
 * item's ledger row stays unconfirmed for the watchdog. E4A.6's restore
 * driver dispatches `AutomationItem.name` (the fullName) here.
 */
export function disableDuplicateRule(io: MetadataToggleIo, fullName: string): Promise<boolean> {
  return countAsOutcome(io, 'Dup-rule disable', () => deactivateDuplicateRules(io, [fullName]))
}

/** Per-item restore — `AutomationToggleBatch.restoreItem` branch (:430-445). */
export function restoreDuplicateRule(io: MetadataToggleIo, fullName: string): Promise<boolean> {
  return countAsOutcome(io, 'Dup-rule restore', () => reactivateDuplicateRules(io, [fullName]))
}

/**
 * Port of `DataSeederController.disableDuplicateRulesForDeployment`
 * (:2623-2695) minus the org-side persistence: list ALL unmanaged rules
 * org-wide, record them, deactivate them, report the count. The ledger/blob
 * writes are the E4A.6 driver's job — it plugs in via `writeAhead`.
 *
 * DESIGN-AUTHORIZED REORDER (D4 write-ahead, automationMap §2.2): the
 * write-ahead hook runs BEFORE the deactivation callouts. The Apex wrote the
 * ledger after the SOAP callout only because Apex callouts must precede DML
 * in a transaction; the intent — a durable restore record that survives a
 * crash mid-toggle — is strictly better served by recording first. Rules
 * recorded but never deactivated restore idempotently (reactivate of an
 * active rule succeeds), matching the "over-record, never under-record"
 * trigger discipline (AutomationToggleBatch.cls:25-31).
 *
 * FAIL-CLOSED (REVIEW-FIX #2): a rejecting `writeAhead` ABORTS the disable —
 * it propagates and ZERO deactivation callouts are made. The Apex
 * Warning-and-continue on a failed ledger insert (:2652-2657) was tied to
 * its post-callout ordering: the rules were already deactivated, so
 * continuing was the only non-lossy option. Pre-callout, proceeding without
 * a durable restore record would recreate the Session-26 stranded-automation
 * bug class; the throw is the designed behavior, pinned by test.
 */
export async function disableAllUnmanagedDuplicateRules(
  io: MetadataToggleIo,
  writeAhead?: (fullNames: readonly string[]) => Promise<void> | void
): Promise<{ attempted: string[]; disabledCount: number }> {
  const fullNames = await listDuplicateRuleNames(io)
  if (fullNames.length === 0) {
    return { attempted: [], disabledCount: 0 }
  }
  await writeAhead?.(fullNames)
  const disabledCount = await deactivateDuplicateRules(io, fullNames)
  // The Apex logs 'Disabled X/Y' at Info to the deployment log (:2688-2689) —
  // that channel belongs to the E4A.6 driver. Here only the silent-zero
  // hazard surfaces: a shortfall means some rules stayed active.
  if (disabledCount < fullNames.length) {
    logIo(
      io,
      'error',
      `Disabled only ${disabledCount}/${fullNames.length} duplicate rules via Metadata API`
    )
  }
  return { attempted: fullNames, disabledCount }
}

// ─────────────────────────────── workflow rules ──────────────────────────────

/**
 * Metadata-API fullName for a classic Workflow Rule:
 * `<TableEnumOrId>.<Name>` (the .workflow XML's per-rule fullName, which is
 * the rule's unique Name verbatim — spaces allowed). LIVE-VERIFY NOTE: sb1's
 * relevance intersection is empty today (S32 live proof), so this derivation
 * has no live exercise yet — confirm against a real rule during E4V.
 */
export function workflowRuleFullName(rule: Pick<WorkflowRule, 'tableEnumOrId' | 'name'>): string {
  return `${rule.tableEnumOrId}.${rule.name}`
}

/**
 * The S32 WFR disable slice: `metadata.update('WorkflowRule')` with
 * `active=false` on the relevance-scoped selection
 * (`selectWorkflowRulesToDisable(...).toDisable` → `workflowRuleFullName`).
 * Same batching + silent-zero contract as duplicate rules.
 */
export function disableWorkflowRules(
  io: MetadataToggleIo,
  fullNames: readonly string[]
): Promise<number> {
  return toggleMetadataActiveFlag(io, 'WorkflowRule', fullNames, false, 'active')
}

/** Restore path for the E4A.6 ledger driver — reactivates by fullName. */
export function restoreWorkflowRules(
  io: MetadataToggleIo,
  fullNames: readonly string[]
): Promise<number> {
  return toggleMetadataActiveFlag(io, 'WorkflowRule', fullNames, true, 'active')
}

/** Per-item WFR restore, count>0 semantics (symmetric with duplicate rules). */
export function restoreWorkflowRule(io: MetadataToggleIo, fullName: string): Promise<boolean> {
  return countAsOutcome(io, 'Workflow-rule restore', () => restoreWorkflowRules(io, [fullName]))
}
