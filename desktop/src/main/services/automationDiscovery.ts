/**
 * Target-org automation discovery (5B.8 panel) — port of the Apex
 * `AutomationManagementService.discoverAutomation(orgConnectionId, scopeObjects)`
 * (AutomationManagementService.cls:57-266). READ-ONLY: discovery only; the
 * disable/restore engines land with Epic 4A.
 *
 * Fidelity notes (each verified against the Apex source):
 *  - Validation Rules are fetched ORG-WIDE then scope-filtered client-side —
 *    the `EntityDefinition.QualifiedApiName` relationship FILTER 500s on some
 *    orgs/API versions (AMS.cls:106-108). STRICT: a VR query failure fails the
 *    whole discovery (silently showing "no VRs" would misrepresent what a
 *    deploy will disable — Apex uses toolingQueryStrict for the same reason).
 *  - Flows: scoped to RECORD-TRIGGERED flows on the deployment objects via
 *    FlowDefinitionView (regular REST, N3); `id` is the ACTIVE-VERSION (301)
 *    Id and the active version number is captured at discovery for restore.
 *    A scoped-query failure falls back OPEN to the org-wide Tooling sweep
 *    (AMS.cls:187-191 — "over-disabling is safe, under-disabling is not");
 *    the fallback is surfaced via `flowScopeFallback` + the error text in
 *    `flowScopeFallbackReason`, never silent.
 *    S54 (L2): the scoped SOQL had selected `ActiveVersion.VersionNumber`,
 *    which is NOT a relationship on FlowDefinitionView (the view exposes the
 *    active version's number as its own `VersionNumber` field — verified live
 *    on sb3_912 and darkb_911 against FlowVersionView + Tooling Flow). The
 *    query therefore failed on EVERY org and every run silently took the
 *    org-wide sweep: 223 flows disabled on sb3 where 73 were in scope. The
 *    swallowed error was the reason it went unnoticed for 20+ sessions —
 *    hence the reason is now carried to the panel.
 *  - Apex Triggers: unmanaged only (managed source is read-only), scoped via
 *    TableEnumOrId IN (...), and the app's own RDS_*_CpqGuard triggers are
 *    HARD-EXCLUDED (disabling a guard re-arms SBQQ mid-deploy — verified live,
 *    AMS.cls:235-243). STRICT like VRs. Deliberate deviation from Apex (which
 *    silently returned [] on failure): the desktop has no callout-budget
 *    excuse, and a silent empty here would hide triggers from the panel.
 *  - Duplicate rules (desktop addition per uiDesign 5B.8): regular SOQL on
 *    DuplicateRule, UNMANAGED rules only, ORG-WIDE deliberately — the deploy
 *    path (`disableDuplicateRulesForDeployment`) disables all unmanaged rules
 *    org-wide, so a scoped list would misrepresent it. Fail-SOFT: the object
 *    is unqueryable on some editions → a `sectionErrors` entry, not a failure.
 *  - CPQ-gated objects resolve LOCALLY from the gating playbook (no callout),
 *    sorted (AMS.cls:76-85). The legacy `SBQQ__TriggerDisabled__c` probe fails
 *    toward `false` — the safe direction, because `false` is what SHOWS the
 *    manual Triggers-Disabled attestation.
 *
 * Query execution is injected so the port is unit-testable without a live org
 * (same pattern as mappingSuggest).
 */
import type { AutomationItem, AutomationSnapshot } from '../../shared/types'
import type { GuardedOrg } from './salesforce'
import type { WorkflowRule } from '../engine/workflowRules'
import { resolve } from '../engine/objectPolicy'

export interface AutomationDiscoveryIo {
  /** Tooling API query returning ALL records (adapter handles pagination). */
  toolingQuery(soql: string): Promise<Array<Record<string, unknown>>>
  /** Regular REST query returning ALL records (adapter handles pagination). */
  query(soql: string): Promise<Array<Record<string, unknown>>>
  /** Gating-playbook lookup (ObjectPolicyService.resolve(...).requiresTriggerBypass). */
  requiresTriggerBypass(objectName: string): boolean
}

/** Live adapter over a GuardedOrg (read-only — only query endpoints are touched). */
export function makeAutomationIo(org: GuardedOrg): AutomationDiscoveryIo {
  return {
    async toolingQuery(soql: string): Promise<Array<Record<string, unknown>>> {
      const out: Array<Record<string, unknown>> = []
      let res = await org.conn.tooling.query(soql)
      out.push(...((res.records ?? []) as Array<Record<string, unknown>>))
      while (!res.done && res.nextRecordsUrl) {
        res = await org.conn.tooling.queryMore(res.nextRecordsUrl)
        out.push(...((res.records ?? []) as Array<Record<string, unknown>>))
      }
      return out
    },
    async query(soql: string): Promise<Array<Record<string, unknown>>> {
      const out: Array<Record<string, unknown>> = []
      let res = await org.conn.query(soql)
      out.push(...((res.records ?? []) as Array<Record<string, unknown>>))
      while (!res.done && res.nextRecordsUrl) {
        res = await org.conn.queryMore(res.nextRecordsUrl)
        out.push(...((res.records ?? []) as Array<Record<string, unknown>>))
      }
      return out
    },
    requiresTriggerBypass: (objectName: string) =>
      resolve(objectName).requiresTriggerBypass === true
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Port of AMS.queryValidationRules (:103-133) — org-wide fetch, client-side scope filter. */
export async function queryValidationRules(
  io: AutomationDiscoveryIo,
  scopeObjects: readonly string[]
): Promise<AutomationItem[]> {
  const records = await io.toolingQuery(
    'SELECT Id, ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true'
  )
  const scope = new Set(scopeObjects)
  const items: AutomationItem[] = []
  for (const rec of records) {
    const entity = rec.EntityDefinition as Record<string, unknown> | null | undefined
    const objName = str(entity?.QualifiedApiName)
    // Client-side scope filter (mirrors Apex: a null objName fails a non-empty scope).
    if (scope.size > 0 && (objName === null || !scope.has(objName))) continue
    const name = str(rec.ValidationName) ?? ''
    items.push({
      id: str(rec.Id) ?? '',
      name,
      objectName: objName ?? 'Unknown',
      automationType: 'ValidationRule',
      isActive: true,
      processType: null,
      isManagedPackage: name.includes('__'),
      restoreVersionNumber: null
    })
  }
  return items
}

/** Port of AMS.queryFlows (:146-192) — scoped record-triggered flows, fail-OPEN org-wide. */
export async function queryFlows(
  io: AutomationDiscoveryIo,
  scopeObjects: readonly string[]
): Promise<{
  flows: AutomationItem[]
  flowScopeFallback: boolean
  flowScopeFallbackReason: string | null
}> {
  if (scopeObjects.length === 0) {
    return {
      flows: await queryFlowsOrgWide(io),
      flowScopeFallback: false,
      flowScopeFallbackReason: null
    }
  }
  try {
    // `VersionNumber` here IS the active version's number (FlowDefinitionView
    // has no `ActiveVersion` relationship — see the header note).
    const records = await io.query(
      'SELECT ApiName, ActiveVersionId, TriggerType, TriggerObjectOrEvent.QualifiedApiName, ' +
        'VersionNumber FROM FlowDefinitionView ' +
        "WHERE IsActive = true AND TriggerType IN ('RecordBeforeSave','RecordAfterSave')"
    )
    const scope = new Set(scopeObjects)
    const flows: AutomationItem[] = []
    for (const rec of records) {
      const ent = rec.TriggerObjectOrEvent as Record<string, unknown> | null | undefined
      const objName = str(ent?.QualifiedApiName)
      if (objName === null || !scope.has(objName)) continue
      const activeVersionId = str(rec.ActiveVersionId)
      if (activeVersionId === null) continue // no active version → nothing to disable
      const name = str(rec.ApiName) ?? ''
      const version = rec.VersionNumber
      flows.push({
        id: activeVersionId, // Flow (301) Id — deactivate/reactivate compatible
        name,
        objectName: objName,
        automationType: 'Flow',
        isActive: true,
        processType: str(rec.TriggerType),
        isManagedPackage: name.includes('__'),
        // Capture the active version NOW so restore re-activates exactly it.
        restoreVersionNumber: typeof version === 'number' ? version : null
      })
    }
    return { flows, flowScopeFallback: false, flowScopeFallbackReason: null }
  } catch (err) {
    // FlowDefinitionView unavailable/edition quirk → fail OPEN to the org-wide
    // sweep, and NAME the reason: a swallowed error here hid a broken query
    // for twenty sessions (L2).
    return {
      flows: await queryFlowsOrgWide(io),
      flowScopeFallback: true,
      flowScopeFallbackReason: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Port of AMS.queryFlowsOrgWide (:195-215) — the legacy "all active flows" sweep. */
async function queryFlowsOrgWide(io: AutomationDiscoveryIo): Promise<AutomationItem[]> {
  const records = await io.toolingQuery(
    "SELECT Id, Definition.DeveloperName, ProcessType FROM Flow WHERE Status = 'Active' " +
      'ORDER BY Definition.DeveloperName'
  )
  return records.map((rec) => {
    const defn = rec.Definition as Record<string, unknown> | null | undefined
    const name = str(defn?.DeveloperName) ?? 'Unknown'
    return {
      id: str(rec.Id) ?? '',
      name,
      objectName: '',
      automationType: 'Flow' as const,
      isActive: true,
      processType: str(rec.ProcessType),
      isManagedPackage: name.includes('__'),
      restoreVersionNumber: null
    }
  })
}

/** Port of AMS.queryTriggers (:217-258) — unmanaged, scoped, RDS_*_CpqGuard excluded. */
export async function queryTriggers(
  io: AutomationDiscoveryIo,
  scopeObjects: readonly string[]
): Promise<AutomationItem[]> {
  let soql =
    "SELECT Id, Name, TableEnumOrId, NamespacePrefix FROM ApexTrigger WHERE Status = 'Active' " +
    'AND NamespacePrefix = null'
  if (scopeObjects.length > 0) {
    const quoted = scopeObjects.map((obj) => `'${obj.replace(/'/g, "\\'")}'`)
    soql += ` AND TableEnumOrId IN (${quoted.join(',')})`
  }
  soql += ' ORDER BY TableEnumOrId'

  const records = await io.toolingQuery(soql)
  const items: AutomationItem[] = []
  for (const rec of records) {
    const triggerName = str(rec.Name)
    // NEVER list/disable the app's own CPQ-guard triggers: they are what calls
    // SBQQ.TriggerControl.disable() during the deploy (AMS.cls:235-243).
    if (
      triggerName !== null &&
      triggerName.startsWith('RDS_') &&
      triggerName.endsWith('_CpqGuard')
    ) {
      continue
    }
    items.push({
      id: str(rec.Id) ?? '',
      name: triggerName ?? '',
      objectName: str(rec.TableEnumOrId) ?? '',
      automationType: 'ApexTrigger',
      isActive: true,
      processType: null,
      isManagedPackage: false,
      restoreVersionNumber: null
    })
  }
  return items
}

/**
 * Desktop addition (uiDesign 5B.8): active UNMANAGED duplicate rules, org-wide
 * (matching what `disableDuplicateRulesForDeployment` actually disables).
 * `name` is the Metadata-API fullName (`Object.DeveloperName`) the E4A SOAP
 * toggle will key on. Callers treat a thrown error as a soft section failure.
 */
export async function queryDuplicateRules(io: AutomationDiscoveryIo): Promise<AutomationItem[]> {
  const records = await io.query(
    'SELECT Id, DeveloperName, SobjectType, NamespacePrefix FROM DuplicateRule WHERE IsActive = true ' +
      'ORDER BY SobjectType, DeveloperName'
  )
  const items: AutomationItem[] = []
  for (const rec of records) {
    if (str(rec.NamespacePrefix) !== null) continue // managed rules are untouchable
    const objectName = str(rec.SobjectType) ?? ''
    const devName = str(rec.DeveloperName) ?? ''
    items.push({
      id: str(rec.Id) ?? '',
      name: objectName ? `${objectName}.${devName}` : devName,
      objectName,
      automationType: 'DuplicateRule',
      isActive: true,
      processType: null,
      isManagedPackage: false,
      restoreVersionNumber: null
    })
  }
  return items
}

/**
 * S32 desktop-only extension (E4A.1 slice): classic Workflow Rule discovery via
 * Tooling `WorkflowRule.Metadata.active`. The frozen Apex NEVER handled
 * WorkflowRule — feed these through engine/workflowRules.selectWorkflowRulesToDisable
 * (relevance-scoped: active∩plan-objects only, Jack's caution rule; no-op when
 * the intersection is empty). Fail-OPEN TO EMPTY: an unsupported/failed query
 * degrades to exactly the Apex behavior (no rules proposed) — callers treat []
 * as "nothing to disable", never as an error.
 */
export async function queryWorkflowRules(io: AutomationDiscoveryIo): Promise<WorkflowRule[]> {
  let records: Array<Record<string, unknown>>
  try {
    records = await io.toolingQuery('SELECT Id, Name, TableEnumOrId, Metadata FROM WorkflowRule')
  } catch {
    return []
  }
  const rules: WorkflowRule[] = []
  for (const rec of records) {
    const id = str(rec.Id)
    if (id === null) continue
    const meta = rec.Metadata as Record<string, unknown> | null | undefined
    rules.push({
      id,
      name: str(rec.Name) ?? '',
      tableEnumOrId: str(rec.TableEnumOrId) ?? '',
      active: meta != null && meta.active === true
    })
  }
  return rules
}

/** Port of AMS.checkCpqTriggerSetting (:260-266) — probe fails toward `false`
 *  (false SHOWS the manual attestation — the safe direction). */
async function checkCpqTriggerSetting(io: AutomationDiscoveryIo): Promise<boolean> {
  try {
    const records = await io.toolingQuery(
      "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'SBQQ__TriggerDisabled__c'"
    )
    return records.length > 0
  } catch {
    return false
  }
}

/**
 * S54 (F2): what discovery found, as job-log lines. The wizard panel always
 * showed the flow fallback banner; the JOB LOG — the artefact read after every
 * run — never did, which is how a scoped flow query that failed on every org
 * (L2) stayed invisible for twenty sessions. One info line states the counts
 * and WHICH flow set is meant; the fallback and any section error are warns.
 */
export function discoverySummaryLines(
  s: AutomationSnapshot
): Array<{ level: 'info' | 'warn'; message: string }> {
  const n = (k: number, word: string): string => `${k} ${word}${k === 1 ? '' : 's'}`
  const flowSet = s.flowScopeFallback
    ? 'ORG-WIDE sweep — every active flow'
    : 'record-triggered flows on the plan objects only'
  const out: Array<{ level: 'info' | 'warn'; message: string }> = [
    {
      level: 'info',
      message:
        `Automation discovered on the target: ${n(s.flowCount, 'flow')} (${flowSet}), ` +
        `${n(s.validationRuleCount, 'validation rule')}, ${n(s.triggerCount, 'trigger')}, ` +
        `${n(s.duplicateRuleCount, 'duplicate rule')}.`
    }
  ]
  if (s.flowScopeFallback) {
    out.push({
      level: 'warn',
      message:
        `Scoped flow query failed on the target — the ORG-WIDE flow sweep (${n(s.flowCount, 'flow')}) ` +
        `will be disabled and restored instead. Target said: ${s.flowScopeFallbackReason ?? 'unknown error'}`
    })
  }
  for (const e of s.sectionErrors)
    out.push({ level: 'warn', message: `Automation discovery: ${e}` })
  return out
}

/** Port of AMS.discoverAutomation(orgConnectionId, scopeObjects) (:57-101). */
export async function discoverAutomation(
  io: AutomationDiscoveryIo,
  scopeObjects: readonly string[]
): Promise<AutomationSnapshot> {
  const sectionErrors: string[] = []
  const items: AutomationItem[] = []

  // 1. Validation Rules (strict).
  const valRules = await queryValidationRules(io, scopeObjects)
  items.push(...valRules)

  // 2. Flows — scoped record-triggered, fail-OPEN to org-wide.
  const { flows, flowScopeFallback, flowScopeFallbackReason } = await queryFlows(io, scopeObjects)
  items.push(...flows)

  // 3. Apex Triggers (strict).
  const triggers = await queryTriggers(io, scopeObjects)
  items.push(...triggers)

  // 4. Duplicate rules (fail-soft — unqueryable on some editions).
  let duplicateRules: AutomationItem[] = []
  try {
    duplicateRules = await queryDuplicateRules(io)
    items.push(...duplicateRules)
  } catch (err) {
    sectionErrors.push(
      `Duplicate rules could not be read: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 5. CPQ-gated plan objects — resolved locally from the gating playbook, no
  // callout. Drives the wizard's manual "Triggers Disabled" instruction.
  const cpqTriggerGatedObjects = scopeObjects.filter((o) => io.requiresTriggerBypass(o)).sort()

  // 6. Legacy CPQ trigger setting probe (+ synthetic toggle item, verbatim).
  const hasCpqTriggerSetting = await checkCpqTriggerSetting(io)
  if (hasCpqTriggerSetting) {
    items.push({
      id: 'CPQ_TRIGGER_SETTING',
      name: 'SBQQ Trigger Control',
      objectName: 'SBQQ__TriggerDisabled__c',
      automationType: 'CPQTriggerSetting',
      isActive: true,
      processType: null,
      isManagedPackage: false,
      restoreVersionNumber: null
    })
  }

  return {
    items,
    validationRuleCount: valRules.length,
    flowCount: flows.length,
    triggerCount: triggers.length,
    duplicateRuleCount: duplicateRules.length,
    hasCpqTriggerSetting,
    cpqTriggerGatedObjects,
    flowScopeFallback,
    flowScopeFallbackReason,
    sectionErrors
  }
}
