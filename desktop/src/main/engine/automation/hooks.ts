/**
 * E4A.6 — the automation subsystem's deploy-run driver: the three optional
 * PassExecutors hooks (disableAutomation / finalize / restoreAutomation) that
 * the orchestrator already calls (orchestrator.ts:169-173, :490, :496-498),
 * wired over the E4A.2–E4A.5 toggle engines and the SQLite ledger mirror.
 *
 * Port surface (frozen Apex):
 *  - AutomationDisableQueueable.cls (ADQ)   — arm gate + disable orchestration
 *  - AutomationToggleBatch.cls (ATB)        — partition/fold, attempted-not-
 *    confirmed trigger recording (:216-231), write-ahead discipline (:137-147),
 *    finish() summary levels (:313-325, :376-381)
 *  - AutomationManagementService.loadRestoreItems/restoreAutomation (:384-482)
 *    — restoreKey dedupe + per-type replay
 *  - PostDeploymentQueueable.cls (PDQ)      — Phase-B log lines (:129-156)
 *
 * D4 design (deployDesign.md §4.1/§4.3 — the design-authorized divergences):
 *  - The DESKTOP SQLite mirror is the (current) authoritative ledger; the
 *    target-org RDS_Restore_Ledger__c write-ahead awaits connector-package
 *    v-next (Jack's call) — `AutomationLedgerStore` is the seam it will slot
 *    behind. WRITE-AHEAD IS FAIL-LOUD: no ledger, no toggle — a ledger write
 *    failure ABORTS the run before any automation is touched.
 *  - Restore stamps confirmation PER ITEM on that item's verified success
 *    (§4.1 "desktop can verify deterministically — better than the Apex
 *    all-or-nothing batch stamp"); ANY unconfirmed row survives for the
 *    recovery sweep (E4E.6) — the ATB `failedCount == 0` gate's intent, made
 *    finer-grained.
 *  - Ledger rows are written for EVERY selected item BEFORE outcomes are
 *    known (Apex wrote per-scope after toggles only because callouts must
 *    precede DML). Restore replays every unconfirmed row — over-recording is
 *    safe because every per-type restore is idempotent (ATB:25-31).
 *  - Contract activation is scoped to THIS RUN's written Contract ExtIds
 *    (deployedSourceIds → generateExternalId; S46 E1 — §4.3(2) kills the
 *    org-wide force-activation bug, class 9). Cancel
 *    Bulk-abort is a documented no-op: the desktop transport is REST-only
 *    (E4T.1); the slot revives with the E4T.3 Bulk decision.
 *  - The 45-item direct/batch split (ADQ MAX_DIRECT_DISABLES), scope-10
 *    batching, and the blob mirror are DEAD by design (automationMap §5) —
 *    one driver path, ledger only.
 *  - Terminal-status preservation (ATB start/finish Cancelled/Stalled
 *    guards) lives in the ORCHESTRATOR's teardown-outcome machinery
 *    (orchestrator.ts:476-511) — the hooks never flip phases.
 *  - Workflow Rules ride the same ledger/restore path with the S32
 *    relevance-scoped selection (desktop-only extension; no Apex oracle).
 *
 * ENGINE-PURE: all IO through the injected toggle seams + AutomationLedgerStore
 * + DeployIo. The 5B.9 binding constructs the seams (services/) and merges
 * these hooks over makePassExecutors(plan).
 */
import type { AutomationItem } from '../../../shared/types'
import type { DeployIo, RunOutcome } from '../deploy/types'
import type { DeployPlan } from '../deploy/planFreeze'
import type { AutomationToggleIo } from '../automationToggle'
import { setValidationRulesActiveComposite, setFlowsActiveComposite } from '../automationToggle'
import type { TriggerToggleIo } from '../triggerBodyToggle'
import { toggleTriggersDetailed } from '../triggerBodyToggle'
import type { MetadataToggleIo } from '../metadataToggle'
import {
  disableDuplicateRule,
  restoreDuplicateRule,
  disableWorkflowRules,
  restoreWorkflowRule,
  workflowRuleFullName
} from '../metadataToggle'
import type { CpqGuardIo } from '../cpqGuard'
import {
  setRdsDeploymentControl,
  setCpqTriggerDisabled,
  readCpqTriggerDisabled,
  runPostDeployFinalizeCallouts
} from '../cpqGuard'
import type { WorkflowRule } from '../workflowRules'
import { selectWorkflowRulesToDisable } from '../workflowRules'
import { generateExternalId } from '../deploy/transform/sfid'

// ─────────────────────────────── ledger seam ─────────────────────────────────

/** One automation_ledger_mirror row as the driver reads/writes it. */
export interface LedgerRow {
  id: number
  itemType: string
  itemId: string | null
  itemName: string
  restoreVersionNumber: number | null
  /** JSON — the full AutomationItem snapshot (objectName, processType, …). */
  detail: string | null
  /** Epoch ms stamped when the toggle was attempted/confirmed (bookkeeping
   *  for the E4E.6 recovery UI; null = write-ahead row never toggled). */
  disabledAt: number | null
}

export interface LedgerRowInput {
  itemType: string
  itemId: string | null
  itemName: string
  restoreVersionNumber: number | null
  detail: string | null
}

/**
 * The SQLite mirror seam (services/deployStore.ts implements it; the
 * connector-v-next target-org write-ahead will layer behind the same shape).
 * writeAhead MUST be transactional and MUST throw on failure — fail-loud is
 * the D4 contract.
 */
export interface AutomationLedgerStore {
  ledgerWriteAhead(deploymentId: number, runUuid: string, rows: LedgerRowInput[]): number[]
  /** Stamp disabled_at on rows whose toggle was attempted/confirmed. */
  ledgerMarkDisabled(rowIds: number[]): void
  /** All rows for the run still awaiting a confirmed restore. */
  ledgerUnconfirmed(runUuid: string): LedgerRow[]
  /** Per-item confirmation stamps (§4.1). */
  ledgerConfirmRestored(rowIds: number[]): void
  /**
   * This run's successfully-written SOURCE Ids for one object (current-truth
   * success rows) — the §4.3(2) Contract-activation scope is
   * `generateExternalId(sourceId)` over these (S46 E1; the target-Id variant
   * was a structural no-op: the upsert path never records target Ids).
   */
  deployedSourceIds(runId: number, objectApiName: string): string[]
}

/** Apex AMS.restoreKey (:434-436) — `type|id-or-name` dedupe key. */
export function restoreKey(
  type: string | null,
  itemId: string | null,
  name: string | null
): string {
  const id = itemId != null && itemId.trim() !== '' ? itemId : (name ?? '')
  return `${type ?? ''}|${id}`
}

// ─────────────────────────────── hook factory ────────────────────────────────

/**
 * The toggle layer as the driver consumes it — injectable so the driver's
 * own tests exercise partition/fold/ledger logic directly (each function's
 * real implementation carries its own exhaustive suite). Production callers
 * never pass `fns`; the defaults are the E4A.2–E4A.5 engines.
 */
export interface DriverToggleFns {
  vrComposite: typeof setValidationRulesActiveComposite
  flowComposite: typeof setFlowsActiveComposite
  triggersDetailed: typeof toggleTriggersDetailed
  disableDupRule: typeof disableDuplicateRule
  restoreDupRule: typeof restoreDuplicateRule
  disableWfrs: typeof disableWorkflowRules
  restoreWfr: typeof restoreWorkflowRule
  setCpqSetting: typeof setCpqTriggerDisabled
  readCpqSetting: typeof readCpqTriggerDisabled
  setRdsControl: typeof setRdsDeploymentControl
  finalizeCallouts: typeof runPostDeployFinalizeCallouts
}

/** Exported ONLY for the identity-pin test (a typo'd default mapping must
 *  fail a test, not a live deploy) — production never touches this. */
export const DEFAULT_FNS: DriverToggleFns = {
  vrComposite: setValidationRulesActiveComposite,
  flowComposite: setFlowsActiveComposite,
  triggersDetailed: toggleTriggersDetailed,
  disableDupRule: disableDuplicateRule,
  restoreDupRule: restoreDuplicateRule,
  disableWfrs: disableWorkflowRules,
  restoreWfr: restoreWorkflowRule,
  setCpqSetting: setCpqTriggerDisabled,
  readCpqSetting: readCpqTriggerDisabled,
  setRdsControl: setRdsDeploymentControl,
  finalizeCallouts: runPostDeployFinalizeCallouts
}

export interface AutomationHookDeps {
  deploymentId: number
  /** Correlates this run's ledger rows (`run-<runId>` today; a real UUID when
   *  the target-org ledger lands). */
  runUuid: string
  /** The frozen plan — gated-object detection reads its per-object
   *  requiresTriggerBypass flags (resolved from the playbook at freeze). */
  plan: DeployPlan
  /** Items the user selected for disable (effectiveDisable already applied
   *  by the caller over the FRESH discovery snapshot). */
  items: readonly AutomationItem[]
  /** Target org's classic workflow rules (S32 slice) — the driver applies the
   *  relevance scoping itself so an irrelevant rule can never slip through. */
  workflowRules: readonly WorkflowRule[]
  /** The S32 per-run WFR toggle ANDed with the master disableAutomations
   *  switch (the caller computes it from WizardConfig) — false skips the
   *  whole WFR slice. */
  workflowRulesEnabled: boolean
  ledger: AutomationLedgerStore
  toggleIo: AutomationToggleIo
  triggerIo: TriggerToggleIo
  metadataIo: MetadataToggleIo
  guardIo: CpqGuardIo
  /** Test seam — production omits it. */
  fns?: Partial<DriverToggleFns>
}

export interface AutomationHooks {
  disableAutomation(runId: number, io: DeployIo): Promise<void>
  finalize(runId: number, io: DeployIo, reason: RunOutcome): Promise<void>
  restoreAutomation(runId: number, io: DeployIo, reason: RunOutcome): Promise<void>
}

const log = (io: DeployIo, level: 'Info' | 'Warning' | 'Error', message: string): void => {
  io.emit({ kind: 'log', data: { level, message } })
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Ledger row payload for one AutomationItem (full snapshot in detail). */
function toLedgerInput(item: AutomationItem): LedgerRowInput {
  return {
    itemType: item.automationType,
    itemId: item.id ?? null,
    itemName: item.name,
    restoreVersionNumber: item.restoreVersionNumber ?? null,
    detail: JSON.stringify(item)
  }
}

/** Rebuild the AutomationItem a ledger row recorded (detail JSON preferred). */
export function itemFromLedgerRow(row: LedgerRow): AutomationItem {
  if (row.detail != null) {
    try {
      const parsed = JSON.parse(row.detail) as AutomationItem
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* fall through to the column reconstruction */
    }
  }
  return {
    id: row.itemId ?? '',
    name: row.itemName,
    objectName: '',
    automationType: row.itemType as AutomationItem['automationType'],
    isActive: true,
    processType: null,
    isManagedPackage: false,
    restoreVersionNumber: row.restoreVersionNumber
  }
}

export function makeAutomationHooks(deps: AutomationHookDeps): AutomationHooks {
  const fns: DriverToggleFns = { ...DEFAULT_FNS, ...deps.fns }
  return {
    // ── Disable (ADQ + ATB.execute, one driver path) ──────────────────────
    async disableAutomation(_runId: number, io: DeployIo): Promise<void> {
      // GATE 1 (ADQ:49-86, N6 playbook): arm the CPQ guard ONLY when the plan
      // contains trigger-bypass-gated objects. Runs BEFORE everything else so
      // the guard is armed whether or not any items were selected.
      const gatedObjs = deps.plan.objects
        .filter((o) => o.requiresTriggerBypass)
        .map((o) => o.objectName)
      if (gatedObjs.length > 0) {
        try {
          if (await fns.setRdsControl(deps.guardIo, true)) {
            log(
              io,
              'Info',
              `Enabled CPQ trigger guard on target org — managed-package-gated objects in scope: ${gatedObjs.join(', ')}`
            )
          } else {
            log(
              io,
              'Warning',
              'CPQ trigger guard NOT enabled: RDS_Deployment_Control__c could not be set on target. ' +
                'Check that the RDS_Admin permset is assigned to the connected user on the target org ' +
                'and that the custom setting is deployed.'
            )
          }
        } catch (e) {
          log(io, 'Warning', `Could not enable CPQ trigger guard: ${errText(e)}`)
        }
      } else {
        log(
          io,
          'Info',
          'CPQ trigger guard skipped — no managed-package-gated objects in this deployment.'
        )
      }

      // S32 workflow-rule slice: relevance-scope HERE (defense in depth — the
      // driver never trusts a pre-computed selection). GATED by the per-run
      // toggle (S32 decision: "per-run toggle default ON" — the caller ANDs
      // it with the master disableAutomations switch, REVIEW-FIX).
      const wfrSelection = deps.workflowRulesEnabled
        ? selectWorkflowRulesToDisable(
            deps.workflowRules,
            deps.plan.objects.map((o) => o.objectName)
          )
        : { toDisable: [] as WorkflowRule[], skippedOutOfScope: [], skippedInactive: [] }
      const wfrItems: AutomationItem[] = wfrSelection.toDisable.map((r) => ({
        id: r.id,
        name: workflowRuleFullName(r),
        objectName: r.tableEnumOrId,
        automationType: 'WorkflowRule' as AutomationItem['automationType'],
        isActive: true,
        processType: null,
        isManagedPackage: false,
        restoreVersionNumber: null
      }))

      // FINDING #18 (the E4A.6-spec'd restore-to-ORIGINAL, minimal-safe
      // variant): enroll the legacy CPQ setting ONLY when it is currently
      // false. The restore path un-disables unconditionally, so an org whose
      // admin deliberately keeps SBQQ__IsDisabled__c=true must never be
      // enrolled — its pre-deploy state IS the deploy-time state, nothing to
      // do in either direction. Unreadable → skip with a warning, never
      // guess. Runs BEFORE the write-ahead so a skipped setting never gets a
      // ledger row (a row would read as phantom un-restored work to E4E.6).
      const selectedItems: AutomationItem[] = []
      for (const item of deps.items) {
        if (item.automationType !== 'CPQTriggerSetting') {
          selectedItems.push(item)
          continue
        }
        try {
          if (await fns.readCpqSetting(deps.guardIo)) {
            log(
              io,
              'Info',
              'SBQQ__TriggerDisabled__c is already true on the target — left untouched (restore-to-original).'
            )
          } else {
            selectedItems.push(item)
          }
        } catch (e) {
          log(
            io,
            'Warning',
            `Could not read SBQQ__TriggerDisabled__c — skipping the legacy CPQ setting toggle: ${errText(e)}`
          )
        }
      }

      const allItems = [...selectedItems, ...wfrItems]
      if (allItems.length === 0) {
        log(io, 'Info', 'No automation items selected for disable.')
        return
      }

      // D4 WRITE-AHEAD, FAIL-LOUD: no ledger, no toggle. A throw here aborts
      // the run before ANY automation is touched (nothing to restore yet).
      const rowIds = deps.ledger.ledgerWriteAhead(
        deps.deploymentId,
        deps.runUuid,
        allItems.map(toLedgerInput)
      )
      const rowIdByKey = new Map<string, number>()
      allItems.forEach((item, i) => {
        const rid = rowIds[i]
        if (rid !== undefined)
          rowIdByKey.set(restoreKey(item.automationType, item.id, item.name), rid)
      })

      log(
        io,
        'Info',
        `Found ${allItems.length} automation items on target org — disabling before deploy`
      )

      // ATB.execute partition (:94-103): VR/Flow composite, triggers via ONE
      // MetadataContainer, dup rules + CPQ setting per-item, WFR metadata.
      const vrItems: AutomationItem[] = []
      const flowItems: AutomationItem[] = []
      const triggerItems: AutomationItem[] = []
      const dupRuleItems: AutomationItem[] = []
      const cpqSettingItems: AutomationItem[] = []
      for (const item of selectedItems) {
        if (item.automationType === 'ValidationRule') vrItems.push(item)
        else if (item.automationType === 'Flow') flowItems.push(item)
        else if (item.automationType === 'ApexTrigger') triggerItems.push(item)
        else if (item.automationType === 'DuplicateRule') dupRuleItems.push(item)
        else if (item.automationType === 'CPQTriggerSetting') cpqSettingItems.push(item)
      }

      let succeeded = 0
      let failedCount = 0
      const failureDetails: string[] = []
      const disabledRowIds: number[] = []
      const markDisabled = (item: AutomationItem): void => {
        const rid = rowIdByKey.get(restoreKey(item.automationType, item.id, item.name))
        if (rid !== undefined) disabledRowIds.push(rid)
      }
      const fold = (items: AutomationItem[], doneIds: ReadonlySet<string>, what: string): void => {
        for (const item of items) {
          if (doneIds.has(item.id)) {
            succeeded++
            markDisabled(item)
          } else {
            failedCount++
            failureDetails.push(
              `${item.automationType} "${item.name}" — ${what} returned no success`
            )
          }
        }
      }

      // VR + Flow composite (ATB.processComposite :175-193): toggledIds
      // accumulates PROGRESSIVELY across both calls inside ONE try — a flow
      // throw after the VR composite succeeded still folds those VRs as
      // succeeded (REVIEW-FIX: a block-scoped done-set lost them).
      const compositeDone = new Set<string>()
      try {
        for (const it of await fns.vrComposite(deps.toggleIo, vrItems, false)) {
          compositeDone.add(it.id)
        }
        for (const it of await fns.flowComposite(deps.toggleIo, flowItems, true)) {
          compositeDone.add(it.id)
        }
      } catch (e) {
        failureDetails.push(`Composite flow/VR toggle error — ${errText(e)}`)
      }
      fold(vrItems, compositeDone, 'composite toggle')
      fold(flowItems, compositeDone, 'composite toggle')

      // Triggers (ATB.processScopeTriggers :205-231): record on ATTEMPTED
      // change regardless of confirmation; alreadyInState neither succeeds
      // nor fails.
      if (triggerItems.length > 0) {
        try {
          const r = await fns.triggersDetailed(
            deps.triggerIo,
            triggerItems.map((t) => t.id),
            true
          )
          for (const t of triggerItems) {
            if (r.changedIds.has(t.id)) markDisabled(t)
            if (r.succeededIds.has(t.id) && !r.alreadyInStateIds.has(t.id)) {
              succeeded++
            } else if (!r.alreadyInStateIds.has(t.id)) {
              failedCount++
              failureDetails.push(
                `ApexTrigger "${t.name}" — ${r.failReasons.get(t.id) ?? 'no success'}`
              )
            }
          }
        } catch (e) {
          failureDetails.push(`ApexTrigger batch toggle error — ${errText(e)}`)
        }
      }

      // Dup rules per-item, count>0 semantics (ATB.disableItem :406-416).
      for (const item of dupRuleItems) {
        try {
          if (await fns.disableDupRule(deps.metadataIo, item.name)) {
            succeeded++
            markDisabled(item)
          } else {
            failedCount++
            failureDetails.push(
              `${item.automationType} "${item.name}" — API returned no success (org may not permit toggling this item)`
            )
          }
        } catch (e) {
          failedCount++
          failureDetails.push(`${item.automationType} "${item.name}" — ${errText(e)}`)
        }
      }

      // Legacy CPQ setting (synthetic discovery item).
      for (const item of cpqSettingItems) {
        try {
          if (await fns.setCpqSetting(deps.guardIo, true)) {
            succeeded++
            markDisabled(item)
          } else {
            failedCount++
            failureDetails.push(
              `${item.automationType} "${item.name}" — API returned no success (org may not permit toggling this item)`
            )
          }
        } catch (e) {
          failedCount++
          failureDetails.push(`${item.automationType} "${item.name}" — ${errText(e)}`)
        }
      }

      // WFR slice (S32): batch metadata flip; per-item fold by count parity
      // is unavailable (count only), so fold all-or-nothing per the count.
      if (wfrItems.length > 0) {
        try {
          const count = await fns.disableWfrs(
            deps.metadataIo,
            wfrItems.map((w) => w.name)
          )
          if (count >= wfrItems.length) {
            for (const w of wfrItems) {
              succeeded++
              markDisabled(w)
            }
          } else {
            // Shortfall: which rules failed is unknown (count-only API) —
            // mark ALL attempted (over-record safe; restore is idempotent)
            // and report the shortfall.
            for (const w of wfrItems) markDisabled(w)
            succeeded += count
            failedCount += wfrItems.length - count
            failureDetails.push(
              `WorkflowRule disable shortfall — ${count}/${wfrItems.length} confirmed (all recorded for restore)`
            )
          }
        } catch (e) {
          failureDetails.push(`WorkflowRule disable error — ${errText(e)}`)
          failedCount += wfrItems.length
          for (const w of wfrItems) markDisabled(w)
        }
      }

      if (disabledRowIds.length > 0) deps.ledger.ledgerMarkDisabled(disabledRowIds)

      // ATB.finish disable summary (:313-325) — level escalates on failures.
      const level = failedCount === 0 ? 'Info' : succeeded === 0 ? 'Error' : 'Warning'
      log(
        io,
        level,
        `Disabled ${succeeded} automation items on target org${failedCount > 0 ? ` (${failedCount} failed)` : ''}` +
          (failureDetails.length > 0 ? `\n${failureDetails.join('\n')}` : '')
      )
    },

    // ── Finalize (PDQ Phase A ordering + Phase B logging) ─────────────────
    async finalize(runId: number, io: DeployIo, reason: RunOutcome): Promise<void> {
      // PDQ pre-flight (:75-87): Contract in scope with deployed records?
      const contractCounters = io.store
        .objectCounters(runId)
        .find((c) => c.objectApiName === 'Contract')
      const contractInScope = (contractCounters?.recordsDeployed ?? 0) > 0

      // §4.3(2): activation scoped to THIS RUN's written Contracts — BY EXTID
      // (S46 E1). The first-pass upsert never records target Ids (collections
      // discards success ids; only the junction path writes target_id), so the
      // earlier target-Id scope selected nothing and every Contract this run
      // wrote stayed Draft. `deployedSourceIds` is the current-truth success
      // set and generateExternalId(sourceId) is byte-for-byte the ExtId the
      // transform wrote (sfid.ts), so the activation query
      // `Status='Draft' AND ExtId IN (...)` (contracts.ts) selects exactly
      // ours — the scoping deployDesign §4.3(2) literally prescribes.
      const runExtIds = contractInScope
        ? deps.ledger.deployedSourceIds(runId, 'Contract').map((id) => generateExternalId(id))
        : []

      // Cancel-mode Bulk abort (PDQ:91-99) is a documented NO-OP: the desktop
      // transport is REST-only (E4T.1); revisit with the E4T.3 Bulk decision.

      const result = await fns.finalizeCallouts(deps.guardIo, {
        // S50 (A1 ride-along): was `reason === 'cancelled'`. A FAILED run is
        // just as partial as a cancelled one, so activating the Contracts it
        // happened to write is the same mistake. Today a root-failure abort is
        // safe only by accident — the root sits at the lowest sortOrder, so
        // Contract has zero deployed rows and `runExtIds` is empty — but that
        // stops being true the moment the abort generalises to any object.
        isCancel: reason !== 'completed',
        contractInScope,
        runExtIds
      })

      // PDQ Phase B log lines (:129-156), verbatim.
      const a = result.activation
      if (a !== null) {
        if (a.error !== null) {
          log(io, 'Warning', `Contract activation failed: ${a.error}`)
        } else if (a.attempted) {
          log(
            io,
            a.failed === 0 ? 'Info' : 'Warning',
            `Contract activation: ${a.activated} activated, ${a.failed} failed`
          )
        }
      }
      if (result.guardError !== null) {
        log(io, 'Warning', `Could not disable CPQ trigger guard: ${result.guardError}`)
      } else if (result.guardDisarmed) {
        log(io, 'Info', 'Disabled CPQ trigger guard on target org (RDS_Deployment_Control__c)')
      } else {
        log(
          io,
          'Warning',
          'CPQ trigger guard NOT disabled at deploy end — flip RDS_Deployment_Control__c.Disable_CPQ_Triggers__c to false manually if needed.'
        )
      }
    },

    // ── Restore (AMS.restoreAutomation + ATB restore semantics) ───────────
    async restoreAutomation(_runId: number, io: DeployIo, _reason: RunOutcome): Promise<void> {
      // Ledger is the single restore source (blob mirror is dead by design).
      // A throw HERE (ledger unreadable) propagates: the orchestrator parks
      // the run Stalled — deliberately recoverable, never terminal-Failed.
      const rows = deps.ledger.ledgerUnconfirmed(deps.runUuid)
      if (rows.length === 0) {
        log(io, 'Info', 'No automation to restore.')
        return
      }

      // AMS.loadRestoreItems dedupe (:395, :434-436): first row per
      // restoreKey wins; duplicates confirm alongside the winner.
      const byKey = new Map<string, LedgerRow[]>()
      for (const row of rows) {
        const key = restoreKey(row.itemType, row.itemId, row.itemName)
        const bucket = byKey.get(key)
        if (bucket) bucket.push(row)
        else byKey.set(key, [row])
      }

      let succeeded = 0
      let failedCount = 0
      const failureDetails: string[] = []
      const confirmedRowIds: number[] = []
      const confirm = (bucket: LedgerRow[]): void => {
        succeeded++
        for (const r of bucket) confirmedRowIds.push(r.id)
      }
      const fail = (row: LedgerRow, reason: string): void => {
        failedCount++
        failureDetails.push(`${row.itemType} "${row.itemName}" — ${reason}`)
      }

      // Partition by type (AMS.restoreAutomation :442-460).
      const buckets = [...byKey.values()]

      /**
       * Restore progress (UI-4 companion). This was the longest and most
       * anxious stretch of a run and it was completely invisible: the monitor
       * showed a finished "Deploy data" bar while ~340 items re-enabled.
       *
       * STAGE-weighted, not per-item, because that is the real shape of the
       * work — VRs, Flows and Triggers each go out as ONE composite call, so
       * their whole bucket count advances in a single step, while the dup-rule
       * / CPQ / WFR loops genuinely advance per item. Announcing before a
       * composite matters most: that await is where the run sits longest.
       *
       * Emission only. No restore decision reads these values.
       */
      const totalItems = buckets.length
      let restoredItems = 0
      const progress = (label: string, add = 0): void => {
        restoredItems += add
        io.emit({ kind: 'progress', data: { value: restoredItems, max: totalItems, label } })
      }
      const vr: LedgerRow[][] = []
      const flow: LedgerRow[][] = []
      const trigger: LedgerRow[][] = []
      const dupRule: LedgerRow[][] = []
      const cpqSetting: LedgerRow[][] = []
      const wfr: LedgerRow[][] = []
      for (const bucket of buckets) {
        const t = bucket[0]!.itemType
        if (t === 'ValidationRule') vr.push(bucket)
        else if (t === 'Flow') flow.push(bucket)
        else if (t === 'ApexTrigger') trigger.push(bucket)
        else if (t === 'DuplicateRule') dupRule.push(bucket)
        else if (t === 'CPQTriggerSetting') cpqSetting.push(bucket)
        else if (t === 'WorkflowRule') wfr.push(bucket)
        else fail(bucket[0]!, 'unknown automation type')
      }

      // VRs — composite re-activate (per-item fallback inside).
      if (vr.length > 0) {
        progress(`Validation rules (${vr.length})`)
        try {
          const items = vr.map((b) => itemFromLedgerRow(b[0]!))
          const done = new Set((await fns.vrComposite(deps.toggleIo, items, true)).map((i) => i.id))
          vr.forEach((b, i) => {
            if (done.has(items[i]!.id)) confirm(b)
            else fail(b[0]!, 'composite toggle returned no success')
          })
        } catch (e) {
          for (const b of vr) fail(b[0]!, errText(e))
        }
        // Advances whether the composite succeeded or failed: the items are
        // accounted for either way, and a bar that stalls on failure would
        // read as a hang.
        progress(`Validation rules (${vr.length})`, vr.length)
      }

      // Flows — composite to the DISABLE-TIME version (row column wins over
      // any stale detail JSON — N3 wrong-version-on-restore race).
      if (flow.length > 0) {
        progress(`Flows (${flow.length})`)
        try {
          const items = flow.map((b) => {
            const item = itemFromLedgerRow(b[0]!)
            return {
              ...item,
              restoreVersionNumber: b[0]!.restoreVersionNumber ?? item.restoreVersionNumber
            }
          })
          const done = new Set(
            (await fns.flowComposite(deps.toggleIo, items, false)).map((i) => i.id)
          )
          flow.forEach((b, i) => {
            if (done.has(items[i]!.id)) confirm(b)
            else fail(b[0]!, 'composite toggle returned no success')
          })
        } catch (e) {
          for (const b of flow) fail(b[0]!, errText(e))
        }
        progress(`Flows (${flow.length})`, flow.length)
      }

      // Triggers — one MetadataContainer unwrap; alreadyInState counts as
      // restored (the body is already clean — the desired end state).
      if (trigger.length > 0) {
        progress(`Apex triggers (${trigger.length})`)
        try {
          const ids = trigger.map((b) => b[0]!.itemId ?? '')
          const r = await fns.triggersDetailed(deps.triggerIo, ids, false)
          trigger.forEach((b, i) => {
            const id = ids[i]!
            if (r.succeededIds.has(id) || r.alreadyInStateIds.has(id)) confirm(b)
            else fail(b[0]!, r.failReasons.get(id) ?? 'no success')
          })
        } catch (e) {
          for (const b of trigger) fail(b[0]!, errText(e))
        }
        progress(`Apex triggers (${trigger.length})`, trigger.length)
      }

      // Dup rules — per-item count>0 (ATB.restoreItem :430-445).
      for (const b of dupRule) {
        try {
          if (await fns.restoreDupRule(deps.metadataIo, b[0]!.itemName)) confirm(b)
          else fail(b[0]!, 'API returned no success')
        } catch (e) {
          fail(b[0]!, errText(e))
        }
        progress(`Duplicate rule ${b[0]!.itemName}`, 1)
      }

      // Legacy CPQ setting — un-disable.
      for (const b of cpqSetting) {
        try {
          if (await fns.setCpqSetting(deps.guardIo, false)) confirm(b)
          else fail(b[0]!, 'API returned no success')
        } catch (e) {
          fail(b[0]!, errText(e))
        }
        progress('CPQ trigger setting', 1)
      }

      // WFRs — per-item reactivate (count>0 each) so confirmation stays
      // per-item even though the disable side batched.
      for (const b of wfr) {
        try {
          if (await fns.restoreWfr(deps.metadataIo, b[0]!.itemName)) confirm(b)
          else fail(b[0]!, 'API returned no success')
        } catch (e) {
          fail(b[0]!, errText(e))
        }
        progress(`Workflow rule ${b[0]!.itemName}`, 1)
      }

      if (confirmedRowIds.length > 0) deps.ledger.ledgerConfirmRestored(confirmedRowIds)

      // ATB.finish restore summary (:376-381). Per-item failures do NOT
      // throw — unconfirmed rows are the recovery sweep's work list.
      const level = failedCount === 0 ? 'Info' : succeeded === 0 ? 'Error' : 'Warning'
      log(
        io,
        level,
        `Restored ${succeeded} automation items on target org${failedCount > 0 ? ` (${failedCount} could not be re-enabled)` : ''}` +
          (failureDetails.length > 0 ? `\n${failureDetails.join('\n')}` : '')
      )
    }
  }
}
