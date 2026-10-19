/**
 * Desired-state planner for a post-refresh template's automation step (S59
 * plan §4.4). wanted action × found state → one of:
 *
 *   change       the org differs from what the template wants → a toggle runs
 *   alreadyThere the org already matches → nothing is touched, never reversed
 *   notFound     the item is not in the org (a refreshed sandbox may lack it)
 *   managed      a namespaced item — shown, never actionable
 *   unsupported  the action does not apply to the item's state (e.g. uncomment
 *                a trigger that a DEPLOY wrapped — that is the deploy's to undo)
 *
 * Pure: takes the catalog, returns the plan. The apply step (automationApply)
 * executes `change` entries and reports per item.
 */
import type {
  AutomationItemReport,
  CatalogFlow,
  CatalogTrigger,
  FlowAction,
  PostRefreshTemplate,
  TriggerAction
} from '../../../shared/templates/types'
import { flowStateLabel, triggerStateLabel } from './automationCatalog'

export type PlanDecision = 'change' | 'alreadyThere' | 'notFound' | 'managed' | 'unsupported'

export interface FlowPlanItem {
  kind: 'flow'
  apiName: string
  action: FlowAction
  decision: PlanDecision
  found: CatalogFlow | null
  detail: string | null
}

export interface TriggerPlanItem {
  kind: 'trigger'
  name: string
  action: TriggerAction
  decision: PlanDecision
  found: CatalogTrigger | null
  detail: string | null
}

export type PlanItem = FlowPlanItem | TriggerPlanItem

export interface AutomationPlan {
  items: PlanItem[]
  changes: number
}

export function planFlow(apiName: string, action: FlowAction, found: CatalogFlow | undefined): FlowPlanItem {
  if (!found) return { kind: 'flow', apiName, action, decision: 'notFound', found: null, detail: 'not in this org' }
  if (found.managed) {
    return { kind: 'flow', apiName, action, decision: 'managed', found, detail: 'managed package — cannot be changed here' }
  }
  if (action === 'deactivate') {
    return found.isActive
      ? { kind: 'flow', apiName, action, decision: 'change', found, detail: null }
      : { kind: 'flow', apiName, action, decision: 'alreadyThere', found, detail: 'already inactive' }
  }
  // activate → the LATEST version; already active at the latest version = no-op.
  if (found.isActive && (found.latestVersionNumber == null || found.activeVersionNumber === found.latestVersionNumber)) {
    return { kind: 'flow', apiName, action, decision: 'alreadyThere', found, detail: 'already active' }
  }
  return {
    kind: 'flow',
    apiName,
    action,
    decision: 'change',
    found,
    detail:
      found.isActive && found.latestVersionNumber != null
        ? `active v${found.activeVersionNumber ?? '?'} → latest v${found.latestVersionNumber}`
        : null
  }
}

export function planTrigger(name: string, action: TriggerAction, found: CatalogTrigger | undefined): TriggerPlanItem {
  if (!found) return { kind: 'trigger', name, action, decision: 'notFound', found: null, detail: 'not in this org' }
  if (found.managed) {
    return { kind: 'trigger', name, action, decision: 'managed', found, detail: 'managed package — cannot be changed here' }
  }
  const active = found.status === 'Active'
  switch (action) {
    case 'deactivate':
      return active
        ? { kind: 'trigger', name, action, decision: 'change', found, detail: null }
        : { kind: 'trigger', name, action, decision: 'alreadyThere', found, detail: 'already Inactive' }
    case 'activate':
      return active
        ? { kind: 'trigger', name, action, decision: 'alreadyThere', found, detail: 'already Active' }
        : { kind: 'trigger', name, action, decision: 'change', found, detail: null }
    case 'commentOut':
      if (found.bodyState === 'templateStub')
        return { kind: 'trigger', name, action, decision: 'alreadyThere', found, detail: 'already commented out' }
      if (found.bodyState === 'deployWrapped')
        return {
          kind: 'trigger',
          name,
          action,
          decision: 'unsupported',
          found,
          detail: 'wrapped by a deploy’s bypass marker — restore that deploy first'
        }
      return { kind: 'trigger', name, action, decision: 'change', found, detail: null }
    case 'uncomment':
      if (found.bodyState === 'templateStub')
        return { kind: 'trigger', name, action, decision: 'change', found, detail: null }
      if (found.bodyState === 'deployWrapped')
        return {
          kind: 'trigger',
          name,
          action,
          decision: 'unsupported',
          found,
          detail: 'wrapped by a deploy’s bypass marker, not a template stub — restore that deploy instead'
        }
      return { kind: 'trigger', name, action, decision: 'alreadyThere', found, detail: 'body is live' }
  }
}

export function planAutomation(
  template: Pick<PostRefreshTemplate, 'automation'>,
  catalog: { flows: ReadonlyArray<CatalogFlow>; triggers: ReadonlyArray<CatalogTrigger> }
): AutomationPlan {
  const flowsByName = new Map(catalog.flows.map((f) => [f.apiName, f]))
  const triggersByName = new Map(catalog.triggers.map((t) => [t.name, t]))
  const items: PlanItem[] = []
  for (const f of template.automation.flows) items.push(planFlow(f.apiName, f.action, flowsByName.get(f.apiName)))
  for (const t of template.automation.triggers) items.push(planTrigger(t.name, t.action, triggersByName.get(t.name)))
  return { items, changes: items.filter((i) => i.decision === 'change').length }
}

/** The dry-run / pre-apply rendering of a plan item as a report row. */
export function planItemToReport(item: PlanItem, dryRun: boolean): AutomationItemReport {
  const result: AutomationItemReport['result'] =
    item.decision === 'change' ? (dryRun ? 'planned' : 'changed') : item.decision
  if (item.kind === 'flow') {
    return {
      itemType: 'Flow',
      name: item.apiName,
      object: item.found?.object ?? null,
      wanted: item.action,
      found: item.found ? flowStateLabel(item.found) : 'not found',
      result,
      detail: item.detail
    }
  }
  return {
    itemType: 'ApexTrigger',
    name: item.name,
    object: item.found?.object ?? null,
    wanted: item.action,
    found: item.found ? triggerStateLabel(item.found) : 'not found',
    result,
    detail: item.detail
  }
}
