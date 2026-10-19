/**
 * D3a — the target's OWN unmanaged automation on the seeded objects, disabled
 * for the seed and restored after it: the deploy's temporary semantics re-done
 * on the template's own change rows (mode 'temporary'), written BEFORE each
 * toggle and confirmed PER ITEM on restore. Until every row is confirmed, the
 * org is locked for both deploys and template applies (plan §6.4).
 *
 * Discovery reuses the deploy's query functions (validation rules, record-
 * triggered flows, unmanaged triggers) over an adapter on OrgReader. Toggles
 * reuse the pure engines: VR + flow composites, the trigger body wrap (the
 * deploy's RDS_BYPASS marker — if a crash strands one, the orphan sweep
 * restores it, which is the safe direction).
 */
import type { AutomationItem } from '../../../../shared/types'
import type { TargetAutomationReport } from '../../../../shared/templates/types'
import type { AutomationDiscoveryIo } from '../../../services/automationDiscovery'
import { queryFlows, queryTriggers, queryValidationRules } from '../../../services/automationDiscovery'
import { resolve as resolvePolicy } from '../../objectPolicy'
import { setFlowsActiveComposite, setValidationRulesActiveComposite } from '../../automationToggle'
import { toggleTriggersDetailed } from '../../triggerBodyToggle'
import type { TemplateIo } from '../io'
import type { ChangeLedger } from '../automationApply'
import type { Tally } from '../tally'

export function discoveryIoOver(target: TemplateIo['target']): AutomationDiscoveryIo {
  return {
    toolingQuery: (soql) => target.toolingQuery(soql),
    query: (soql) => target.query(soql),
    requiresTriggerBypass: (objectName) => resolvePolicy(objectName).requiresTriggerBypass === true
  }
}

export interface TemporaryItem {
  rowId: number
  item: AutomationItem
}

export class TargetAutomation {
  private items: TemporaryItem[] = []
  readonly report: TargetAutomationReport = { planned: 0, disabled: 0, restored: 0, unconfirmed: 0, items: [] }

  constructor(
    private readonly io: TemplateIo,
    private readonly ledger: ChangeLedger,
    private readonly tally: Tally
  ) {}

  /** Discover the target's unmanaged automation on the seeded objects. */
  async discover(objects: ReadonlyArray<string>): Promise<AutomationItem[]> {
    const dio = discoveryIoOver(this.io.target)
    const out: AutomationItem[] = []
    out.push(...(await queryValidationRules(dio, objects)).filter((i) => !i.isManagedPackage))
    const f = await queryFlows(dio, objects)
    if (f.flowScopeFallback) {
      // The org-wide sweep is the deploy's fail-OPEN; for a seed that is far too wide — scope it ourselves.
      this.io.log('warn', `scoped flow query failed (${f.flowScopeFallbackReason ?? 'unknown'}); flows on the seeded objects could not be listed and are NOT disabled`)
      this.tally.add('targetAutomation', null, null, `flows could not be listed: ${f.flowScopeFallbackReason ?? 'unknown'}`)
    } else {
      out.push(...f.flows.filter((i) => !i.isManagedPackage))
    }
    out.push(...(await queryTriggers(dio, objects)))
    return out
  }

  async disable(objects: ReadonlyArray<string>, dryRun: boolean): Promise<void> {
    this.io.phase('Disabling target automation')
    const found = await this.discover(objects)
    this.report.planned = found.length
    this.io.log('info', `target automation on the seeded objects: ${found.length} item${found.length === 1 ? '' : 's'} (${found.filter((i) => i.automationType === 'ValidationRule').length} validation rules, ${found.filter((i) => i.automationType === 'Flow').length} flows, ${found.filter((i) => i.automationType === 'ApexTrigger').length} triggers)`)
    for (const i of found) {
      this.report.items.push({ itemType: i.automationType, name: i.name, object: i.objectName, disabled: false, restored: false, detail: dryRun ? 'would be disabled for the seed' : null })
    }
    if (dryRun || found.length === 0) return
    // Write-ahead: every row exists before any toggle.
    this.items = found.map((item) => ({
      rowId: this.ledger.recordChange('temporary', {
        itemType: item.automationType,
        itemName: item.name,
        itemId: item.id,
        action: 'disable',
        beforeState: { restoreVersionNumber: item.restoreVersionNumber, objectName: item.objectName, processType: item.processType }
      }),
      item
    }))
    const vrs = found.filter((i) => i.automationType === 'ValidationRule')
    const flows = found.filter((i) => i.automationType === 'Flow')
    const triggers = found.filter((i) => i.automationType === 'ApexTrigger')
    const doneVr = new Set((await setValidationRulesActiveComposite(this.io.target.toggle, vrs, false)).map((i) => i.id))
    const doneFlow = new Set((await setFlowsActiveComposite(this.io.target.toggle, flows, true)).map((i) => i.id))
    const trig = await toggleTriggersDetailed(this.io.target.triggerIo, triggers.map((t) => t.id), true)
    for (const row of this.report.items) {
      const it = found.find((f) => f.name === row.name && f.automationType === row.itemType)
      if (!it) continue
      const ok =
        it.automationType === 'ValidationRule'
          ? doneVr.has(it.id)
          : it.automationType === 'Flow'
            ? doneFlow.has(it.id)
            : trig.succeededIds.has(it.id) || trig.alreadyInStateIds.has(it.id)
      row.disabled = ok
      if (!ok) {
        row.detail = it.automationType === 'ApexTrigger' ? (trig.failReasons.get(it.id) ?? 'not confirmed') : 'toggle did not confirm'
        this.io.log('warn', `${it.automationType} ${it.name}: disable not confirmed — ${row.detail}`)
      }
    }
    this.report.disabled = this.report.items.filter((r) => r.disabled).length
  }

  /** Restore every temporary item; confirm per item. Never throws. */
  async restore(): Promise<void> {
    if (this.items.length === 0) return
    this.io.phase('Restoring target automation')
    const vrs = this.items.filter((i) => i.item.automationType === 'ValidationRule')
    const flows = this.items.filter((i) => i.item.automationType === 'Flow')
    const triggers = this.items.filter((i) => i.item.automationType === 'ApexTrigger')
    const confirmed: number[] = []
    try {
      const done = new Set((await setValidationRulesActiveComposite(this.io.target.toggle, vrs.map((i) => i.item), true)).map((i) => i.id))
      for (const i of vrs) if (done.has(i.item.id)) confirmed.push(i.rowId)
    } catch (e) {
      this.io.log('error', `VR restore failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const done = new Set((await setFlowsActiveComposite(this.io.target.toggle, flows.map((i) => i.item), false)).map((i) => i.id))
      for (const i of flows) if (done.has(i.item.id)) confirmed.push(i.rowId)
    } catch (e) {
      this.io.log('error', `flow restore failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const r = await toggleTriggersDetailed(this.io.target.triggerIo, triggers.map((i) => i.item.id), false)
      for (const i of triggers) if (r.succeededIds.has(i.item.id) || r.alreadyInStateIds.has(i.item.id)) confirmed.push(i.rowId)
    } catch (e) {
      this.io.log('error', `trigger restore failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    const set = new Set(confirmed)
    for (const i of this.items) {
      const row = this.report.items.find((r) => r.name === i.item.name && r.itemType === i.item.automationType)
      if (row) row.restored = set.has(i.rowId)
    }
    this.report.restored = confirmed.length
    this.report.unconfirmed = this.items.length - confirmed.length
    if (this.report.unconfirmed > 0) {
      this.tally.add('targetAutomation', null, null, `${this.report.unconfirmed} temporary automation item(s) not confirmed restored — use Restore now on the run page`)
    }
    this.onRestored?.(confirmed)
  }

  /** Set by the runner: persist the confirmations. */
  onRestored: ((rowIds: number[]) => void) | null = null
}
