/**
 * Wizard draft model + pure state rules. Dependency-free (shared by main,
 * preload, renderer). The persisted `WizardConfig` IS the draft — main stores
 * it verbatim as JSON on the deployment row.
 */
import type { AutomationItem, AutomationSnapshot } from './types'
import { automationItemKey } from './types'

/**
 * S49 (UI-2a): 'objects' was split out of 'scope'. `scope` used to carry BOTH
 * the object picker and the filters; it now carries scope mode + filters only.
 *
 * WIZARD_STEPS is an ORDERED tuple and `stepIndex` derives position from it, so
 * inserting a step shifts every downstream index — `stepCapForStatus`, the nav
 * render, the `:step` route, and every `stepIndex` comparison move with it by
 * construction. That is exactly why the order lives in ONE place.
 */
export const WIZARD_STEPS = [
  'orgs',
  'objects',
  'scope',
  'readiness',
  'mappings',
  'fields',
  'summary',
  'plan'
] as const

export type WizardStep = (typeof WIZARD_STEPS)[number]

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step)
}

/**
 * A Stalled deployment may only be re-opened up to the Fields step — the sole
 * way forward is a fresh analysis (mirrors the Apex app's stalled-resume cap,
 * inventory 5.0.3). Everything else — including a Completed / Failed /
 * Cancelled deployment, which may be fixed up and re-deployed (upsert is
 * idempotent) — may reach the final Plan step. Statuses that mean a run is
 * LIVE (`isDeployBusy`) are not a cap question: the wizard shell refuses to
 * open them at all and main refuses draft writes (S46 D1).
 */
export function stepCapForStatus(status: string): WizardStep {
  return status === 'Stalled' ? 'fields' : 'plan'
}

/**
 * `deployments.status` values the deploy run MIRRORS while it is live (S46 D1
 * — the Apex Deployment__c.Status__c labels: Deployment_Status__c 'Deploying'
 * DDS:70, 'Retrying' DDQ:2992, and the two automation phases from ATB). While
 * a deployment is in one of these, no wizard edit, reorder, or second deploy
 * may touch it — the run owns it.
 */
export const DEPLOY_BUSY_STATUSES = [
  'Deploying',
  'Retrying',
  'Disabling Automation',
  'Restoring Automation'
] as const

export function isDeployBusy(status: string): boolean {
  return (DEPLOY_BUSY_STATUSES as readonly string[]).includes(status)
}

/**
 * Statuses in which an analyzed plan exists and no run is live, so the Plan
 * step may be reordered and Deploy pressed (again). 'Planned' is the fresh
 * analysis; the three terminal statuses allow a fix-and-redeploy. Draft has no
 * plan; Stalled needs a fresh analysis first (see stepCapForStatus); busy
 * statuses belong to the run.
 */
export const PLAN_EDITABLE_STATUSES = ['Planned', 'Completed', 'Failed', 'Cancelled'] as const

export function canEditPlan(status: string): boolean {
  return (PLAN_EDITABLE_STATUSES as readonly string[]).includes(status)
}

/** A deployment whose last run reached a terminal (or parked) state. */
export function isDeployFinished(status: string): boolean {
  return (
    status === 'Completed' || status === 'Failed' || status === 'Cancelled' || status === 'Stalled'
  )
}

/** Clamp a requested step to the cap for a deployment's status. */
export function clampStep(step: WizardStep, status: string): WizardStep {
  const cap = stepCapForStatus(status)
  // An unrecognised step (hand-edited URL, a stale bookmark from a wizard
  // shape that no longer exists) gives stepIndex === -1, which is not > cap —
  // so it used to be returned verbatim and the render switch matched nothing,
  // leaving a wizard with a header, a nav and an EMPTY body. Fall back to the
  // first step instead. S49 made this reachable in a new way by reshaping the
  // step list, so it is fixed here rather than left as a trap.
  if (stepIndex(step) < 0) return WIZARD_STEPS[0]
  return stepIndex(step) > stepIndex(cap) ? cap : step
}

/** Deployments in these statuses may be deleted from the UI. */
export const DELETABLE_STATUSES = ['Draft', 'Planned', 'Stalled'] as const

/**
 * S52 F4: these are deletable ONLY when the deployment has no deploy run — a
 * pre-run refusal (connect / gates / freeze, e.g. "cannot be a deploy target")
 * never touched the target, so there is no evidence to keep. A Failed or
 * Cancelled deployment WITH a run keeps its record_results / ledger and stays.
 */
export const PRE_RUN_DELETABLE_STATUSES = ['Failed', 'Cancelled'] as const

export interface DeleteGuardResult {
  ok: boolean
  reason?: string
}

/**
 * A deployment is deletable only in a non-running status, and a Stalled one is
 * blocked while it still has unconfirmed automation-restore ledger rows (its
 * target org may have automation disabled — deleting would strand the restore).
 * `hasRun` defaults to true so an unaware caller gets the conservative answer
 * for Failed / Cancelled.
 */
export function canDeleteDeployment(
  status: string,
  hasUnconfirmedLedger: boolean,
  hasRun = true
): DeleteGuardResult {
  const preRun = PRE_RUN_DELETABLE_STATUSES.includes(
    status as (typeof PRE_RUN_DELETABLE_STATUSES)[number]
  )
  if (preRun && hasRun) {
    return {
      ok: false,
      reason: `A ${status} deployment that ran against the target keeps its run history and cannot be deleted.`
    }
  }
  if (!preRun && !DELETABLE_STATUSES.includes(status as (typeof DELETABLE_STATUSES)[number])) {
    return { ok: false, reason: `A ${status} deployment cannot be deleted.` }
  }
  if (hasUnconfirmedLedger) {
    return {
      ok: false,
      reason: 'Automation restore is not confirmed on the target — restore before deleting.'
    }
  }
  return { ok: true }
}

/** Per-object field-mapping strategy. */
export type MappingStrategy =
  'externalId' | 'nameMatch' | 'directId' | 'customId' | 'setToMe' | 'skip'

/**
 * One reference field's mapping override (mirrors Apex `Field_Mappings__c` JSON:
 * `{strategy, matchField, customValue}`). Only the strategy is required; matchField
 * applies to `nameMatch`, customValue to `customId`. Defaults + lock rules are NOT
 * stored — they are derived from `mappingPolicy` + current scope, so a config only
 * holds fields the user explicitly overrode (staleness-proof across scope changes).
 */
export interface FieldMapping {
  strategy: MappingStrategy
  matchField?: string
  customValue?: string
}

export interface WizardConfig {
  /** Object API names selected for the deployment scope. */
  selectedObjects: string[]
  /** Parent-scoped vs all-records filtering. */
  /** objectApiName → user WHERE clause. */
  filters: Record<string, string>
  /** objectApiName → (fieldApiName → explicit mapping override). Sparse: unset = policy default. */
  mappings: Record<string, Record<string, FieldMapping>>
  /** objectApiName → excluded field API names. */
  excludedFields: Record<string, string[]>
  /** Global namespace exclusions (e.g. SBQQSC). */
  excludedNamespaces: string[]
  /** Deploy only fields populated in a source sample. */
  populatedOnly: boolean
  /** Auto-injected junction objectName → included. */
  junctionIncludes: Record<string, boolean>
  /**
   * Per-item disable overrides, keyed by `automationItemKey` (type|id-or-name).
   * SPARSE: only user opt-OUTs are stored (`key → false`) — every discovered
   * item defaults to "disable for deployment", so a fresh discovery never
   * inherits stale approvals.
   */
  automationToggles: Record<string, boolean>
  /** Master toggle: disable target-org automation while deploying (LWC default ON).
   *  Optional — drafts saved before 5B.8 lack it; readers default `?? true`. */
  disableAutomations?: boolean
  /** Master toggle: disable duplicate rules while deploying (LWC default OFF).
   *  Optional — pre-5B.8 drafts lack it; readers default `?? false`. */
  disableDuplicateRules?: boolean
  /** S32 per-run toggle: disable the relevance-scoped classic Workflow Rules
   *  while deploying (desktop-only extension, default ON per the S32
   *  decision). Optional — older drafts lack it; readers default `?? true`.
   *  ANDed with disableAutomations at deploy time. */
  disableWorkflowRules?: boolean
  /** CPQ "Triggers Disabled" attestation (gates Deploy when required). */
  cpqAttestation: boolean
  /**
   * S54 (L1): the last Readiness check, persisted with the draft so the gate
   * survives navigation and re-arms on a scope change. `scopeKey` is
   * `readinessScopeKey(config)` at check time — a different key means the
   * check is for another scope and counts as NOT checked. Optional: drafts
   * saved before S54 lack it and are treated as unchecked (one visit to the
   * Readiness step clears that).
   */
  readiness?: ReadinessRecord
}

/** The persisted outcome of one Readiness check (S54 L1). */
export interface ReadinessRecord {
  scopeKey: string
  /** Every non-junction in-scope object has a usable ExtId field AND described. */
  ready: boolean
  /** Objects that block: missing / not-External-Id / FLS-hidden field, or undescribable. */
  blockingObjects: string[]
  checkedAt: string
}

/** Order-independent identity of the scope a Readiness check was made for. */
export function readinessScopeKey(config: Pick<WizardConfig, 'selectedObjects'>): string {
  return [...config.selectedObjects].sort().join(',')
}

/** The objects a readiness report says the deploy cannot key (junctions never block). */
export function readinessBlockingObjects(report: {
  objects: ReadonlyArray<{ objectName: string; needsExtIdField: boolean; describeError?: string }>
}): string[] {
  return report.objects
    .filter((o) => o.needsExtIdField || o.describeError != null)
    .map((o) => o.objectName)
}

/** S57 (B4): the blocking objects that can NEVER be fixed by provisioning (deselect is the only way). */
export function readinessUnfixableObjects(report: {
  objects: ReadonlyArray<{ objectName: string; cannotHostCustomField?: boolean }>
}): string[] {
  return report.objects.filter((o) => o.cannotHostCustomField === true).map((o) => o.objectName)
}

export type ReadinessGateReason = 'unchecked' | 'stale' | 'blocked'

export interface ReadinessGate {
  /** True → the wizard must not go past the Readiness step, analyze, or deploy. */
  blocked: boolean
  reason: ReadinessGateReason | null
  /** The blocking objects when `reason === 'blocked'`; otherwise empty. */
  objects: string[]
}

/**
 * S54 (L1): the ONE predicate behind "Next" on the Readiness step, the step
 * nav, Analyze on the Summary step and Deploy on the Plan step. Jack's T0
 * verdict: the freeze gate refusing 10 objects is correct but the user must
 * never get there — every step before it spent describes, an analysis job and
 * a full freeze on a plan that could not deploy. The plan-freeze own-key gate
 * (S53 item 3) stays as the last line; this is the first.
 *
 *  - no record, or a record for a different scope → blocked ('unchecked' /
 *    'stale'): a green from another scope must not leak through an added object.
 *  - record for this scope, not ready → blocked ('blocked'), naming the objects.
 *  - record for this scope, ready → open.
 * An empty scope is not this gate's question (the Objects step owns it).
 */
export function readinessGate(config: WizardConfig): ReadinessGate {
  if (config.selectedObjects.length === 0) return { blocked: false, reason: null, objects: [] }
  const rec = config.readiness
  if (!rec) return { blocked: true, reason: 'unchecked', objects: [] }
  if (rec.scopeKey !== readinessScopeKey(config)) {
    return { blocked: true, reason: 'stale', objects: [] }
  }
  if (!rec.ready) return { blocked: true, reason: 'blocked', objects: [...rec.blockingObjects] }
  return { blocked: false, reason: null, objects: [] }
}

/** Steps the readiness gate closes (everything after Readiness). */
export function stepClosedByReadiness(step: WizardStep): boolean {
  return stepIndex(step) > stepIndex('readiness')
}

/** Operator-facing line for a closed gate — one wording, four surfaces. */
export function readinessGateMessage(gate: ReadinessGate): string {
  switch (gate.reason) {
    case 'blocked':
      return (
        `You can't proceed — ${gate.objects.length} object${gate.objects.length === 1 ? '' : 's'} ` +
        `(${gate.objects.join(', ')}) ${gate.objects.length === 1 ? 'has' : 'have'} no usable ` +
        `Data_Deployment_External_Id__c on the target. Provision the External ID fields on the Readiness step first.`
      )
    case 'stale':
      return 'The scope changed since the last Readiness check — re-check the target on the Readiness step first.'
    case 'unchecked':
      return 'The target has not been checked for this scope — run the Readiness step first.'
    default:
      return ''
  }
}

export function emptyWizardConfig(): WizardConfig {
  return {
    selectedObjects: [],
    filters: {},
    mappings: {},
    excludedFields: {},
    excludedNamespaces: [],
    populatedOnly: false,
    junctionIncludes: {},
    automationToggles: {},
    disableAutomations: true,
    disableDuplicateRules: false,
    disableWorkflowRules: true,
    cpqAttestation: false
  }
}

// ── Automation-disable selection + CPQ attestation gate (shared: the panel
//    renders these and 5B.9's MAIN-side deploy kickoff enforces them — one
//    predicate, two callers, no drift) ──────────────────────────────────────

export function masterFor(item: AutomationItem, config: WizardConfig): boolean {
  return item.automationType === 'DuplicateRule'
    ? (config.disableDuplicateRules ?? false)
    : (config.disableAutomations ?? true)
}

/** Will this item actually be disabled at deploy time? */
export function effectiveDisable(item: AutomationItem, config: WizardConfig): boolean {
  if (!masterFor(item, config)) return false
  if (item.automationType === 'ApexTrigger') return true // non-toggleable
  return config.automationToggles[automationItemKey(item)] ?? true
}

/**
 * The CPQ attestation gate — verbatim port of the LWC `step4Disabled` CPQ term:
 * `showCpqManualTriggerNotice && !cpqTriggersConfirmed`. The wizard's Deploy
 * button AND the rds:deploy.start handler both refuse while this is true.
 */
export function attestationBlocked(
  snapshot: AutomationSnapshot | undefined,
  discovering: boolean,
  cpqAttestation: boolean
): boolean {
  const showNotice =
    !discovering &&
    !!snapshot &&
    !snapshot.hasCpqTriggerSetting &&
    snapshot.cpqTriggerGatedObjects.length > 0
  return showNotice && !cpqAttestation
}

/** Payload of an `objects`-kind template: just the selected object API names. */
export interface ObjectsTemplatePayload {
  objects: string[]
}

export interface ObjectsTemplateReconcileResult {
  /** Template entries that are selectable in BOTH orgs. */
  objects: string[]
  /** Entries dropped because they are not deployable in both orgs. */
  dropped: string[]
}

/**
 * Reconcile an `objects` template against what is actually selectable now.
 *
 * A template is a saved list of API names and org schemas drift — a managed
 * package gets uninstalled, an object is added to one side only. The picker
 * only ever offers objects present in BOTH orgs (`deployableOnly`), so a stale
 * entry MUST be dropped and reported rather than selected: a selection the
 * picker itself would refuse would otherwise ride silently into analysis and
 * fail there, with nothing pointing back at the template that introduced it.
 *
 * Mirrors `reconcileTemplateMappings` / `reconcileFieldsTemplate`: apply what
 * still holds, count what didn't, never fail closed on a stale template.
 */
export function reconcileObjectsTemplate(
  payload: unknown,
  availableObjects: readonly string[]
): ObjectsTemplateReconcileResult {
  const p = (payload ?? {}) as { objects?: unknown }
  const raw = Array.isArray(p.objects)
    ? p.objects.filter((o): o is string => typeof o === 'string')
    : []
  const available = new Set(availableObjects)
  const objects: string[] = []
  const dropped: string[] = []
  // De-duped so a hand-edited template can't select the same object twice.
  for (const name of [...new Set(raw)]) {
    if (available.has(name)) objects.push(name)
    else dropped.push(name)
  }
  return { objects, dropped }
}
