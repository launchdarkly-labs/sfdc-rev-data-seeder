/**
 * The post-refresh AUTOMATION step (plan §4.4 / §6): execute the desired-state
 * plan against the target, with the template's own change record written
 * BEFORE each toggle (write-ahead, mode 'persistent'), then re-read the org
 * for the safety check.
 *
 *  Flows     deactivate → FlowDefinition.Metadata.activeVersionNumber = 0
 *            activate   → … = the LATEST version (resolved live from Tooling)
 *            Both through `setFlowActiveVersionFull` (GET-then-PATCH-full).
 *  Triggers  deactivate / activate → trigger STATUS via triggerStatus.ts
 *            (container, then file-based deploy). When BOTH refuse a status
 *            change and the action was deactivate, fall back to the comment-out
 *            stub (D2: "Comment out is the alternative and the fallback") and
 *            SAY SO in the report + record the action actually taken.
 *            commentOut / uncomment → the template stub convention
 *            (triggerStub.ts) through the deploy's MetadataContainer path.
 *
 * ENGINE-PURE over OrgWriter + a bound ledger.
 */
import type { AutomationItemReport, FlowAction, SettingPatchReport, TriggerAction } from '../../../shared/templates/types'
import type { SettingPatch } from '../../../shared/templates/types'
import { setFlowActiveVersionFull, urlEncode } from '../automationToggle'
import { deployBodiesWithFallback } from '../triggerBodyToggle'
import { escapeSingleQuotes, ciEquals } from '../deploy/transform/apexSemantics'
import { planAutomation, planItemToReport, type PlanItem } from './automationPlan'
import { buildAutomationCatalog, flowStateLabel, triggerStateLabel } from './automationCatalog'
import { fetchTriggerRecords, setTriggerStatus, type TriggerRecord } from './triggerStatus'
import { stubBody, unstubBody, isTemplateStubbed } from './triggerStub'
import { planSettingPatch, settingPatchSoql } from './settingPatch'
import { writeRows } from './seed/writer'
import type { OrgWriter, TemplateIo } from './io'
import type { Tally } from './tally'
import { TOOLING_QUERY_PATH } from '../../../shared/apiVersion'

const TOOLING_QUERY = TOOLING_QUERY_PATH

/** The run-bound subset of TemplateStore the automation step needs. */
export interface ChangeLedger {
  recordChange(mode: 'persistent' | 'temporary', c: {
    itemType: string
    itemName: string
    itemId: string | null
    action: string
    beforeState: Record<string, unknown> | null
  }): number
  deleteChange(rowId: number): void
}

export interface AutomationStepInput {
  io: TemplateIo
  ledger: ChangeLedger
  tally: Tally
  templateName: string
  flows: Array<{ apiName: string; action: FlowAction }>
  triggers: Array<{ name: string; action: TriggerAction }>
  dryRun: boolean
}

/** Tooling FlowDefinition by DeveloperName → { id, latestVersionNumber }. */
async function resolveFlowDefinition(
  target: OrgWriter,
  apiName: string
): Promise<{ defId: string; latestVersion: number | null } | null> {
  // Namespaced flows arrive as "ns.Name" in the catalog; FlowDefinition splits them.
  const dot = apiName.indexOf('.')
  const dev = dot >= 0 ? apiName.slice(dot + 1) : apiName
  const ns = dot >= 0 ? apiName.slice(0, dot) : null
  const rows = await target.toolingQuery(
    `SELECT Id, LatestVersionId FROM FlowDefinition WHERE DeveloperName = '${escapeSingleQuotes(dev)}'` +
      (ns ? ` AND NamespacePrefix = '${escapeSingleQuotes(ns)}'` : ' AND NamespacePrefix = null')
  )
  const r = rows[0]
  if (!r || typeof r.Id !== 'string') return null
  let latestVersion: number | null = null
  if (typeof r.LatestVersionId === 'string') {
    const v = await target.toolingQuery(
      `SELECT VersionNumber FROM Flow WHERE Id = '${escapeSingleQuotes(r.LatestVersionId)}'`
    )
    const n = v[0]?.VersionNumber
    if (typeof n === 'number') latestVersion = n
  }
  return { defId: r.Id, latestVersion }
}

async function applyFlow(
  input: AutomationStepInput,
  item: Extract<PlanItem, { kind: 'flow' }>
): Promise<AutomationItemReport> {
  const { io, ledger, tally } = input
  const base = planItemToReport(item, false)
  const def = await resolveFlowDefinition(io.target, item.apiName)
  if (!def) {
    tally.add('automation', 'Flow', item.apiName, `${item.apiName}: FlowDefinition not found via Tooling`)
    return { ...base, result: 'failed', detail: 'FlowDefinition not found via Tooling' }
  }
  const targetVersion = item.action === 'deactivate' ? 0 : def.latestVersion
  if (targetVersion == null) {
    tally.add('automation', 'Flow', item.apiName, `${item.apiName}: no version to activate`)
    return { ...base, result: 'failed', detail: 'no latest version to activate' }
  }
  const rowId = ledger.recordChange('persistent', {
    itemType: 'Flow',
    itemName: item.apiName,
    itemId: def.defId,
    action: item.action,
    beforeState: { activeVersion: item.found?.activeVersionNumber ?? null, isActive: item.found?.isActive ?? null }
  })
  const ok = await setFlowActiveVersionFull(io.target.toggle, def.defId, targetVersion)
  if (!ok) {
    ledger.deleteChange(rowId)
    const why = `${item.apiName}: setting activeVersionNumber=${targetVersion} did not succeed`
    tally.add('automation', 'Flow', item.apiName, why)
    return { ...base, result: 'failed', detail: item.action === 'activate' ? `${why} — the latest version may not be activatable (invalid draft, missing dependency)` : why }
  }
  return { ...base, result: 'changed', detail: item.action === 'activate' ? `activated v${targetVersion}` : 'deactivated' }
}

async function applyTrigger(
  input: AutomationStepInput,
  item: Extract<PlanItem, { kind: 'trigger' }>,
  records: Map<string, TriggerRecord>
): Promise<AutomationItemReport> {
  const { io, ledger, tally } = input
  const base = planItemToReport(item, false)
  const rec = records.get(item.name)
  if (!rec) {
    tally.add('automation', 'ApexTrigger', item.name, `${item.name}: trigger record not found`)
    return { ...base, result: 'failed', detail: 'trigger record not found' }
  }
  const before = { status: rec.status, bodyState: item.found?.bodyState ?? null }

  if (item.action === 'deactivate' || item.action === 'activate') {
    const wanted = item.action === 'deactivate' ? 'Inactive' : 'Active'
    const rowId = ledger.recordChange('persistent', {
      itemType: 'ApexTrigger',
      itemName: item.name,
      itemId: rec.id,
      action: item.action,
      beforeState: before
    })
    const r = await setTriggerStatus(io.target, rec, wanted)
    const tried = r.attempts.map((a) => `${a.mechanism}: ${a.ok ? 'ok' : (a.detail ?? 'no change')}`).join(' | ')
    if (r.ok) {
      const by = r.attempts.find((a) => a.ok)!.mechanism
      io.log('info', `${item.name}: status → ${wanted} via ${by}`)
      return { ...base, result: 'changed', detail: `status ${wanted} (via ${by === 'container' ? 'MetadataContainer' : 'Metadata API deploy'})` }
    }
    ledger.deleteChange(rowId)
    if (item.action === 'activate') {
      tally.add('automation', 'ApexTrigger', item.name, `${item.name}: could not set status Active — ${tried}`)
      return { ...base, result: 'failed', detail: `status change refused — ${tried}` }
    }
    // D2 fallback: comment the body out instead, and say so.
    io.log('warn', `${item.name}: status change refused (${tried}) — commenting the body out instead`)
    const stub = await applyStub(input, rec, item, before)
    return stub.result === 'changed'
      ? { ...stub, wanted: 'deactivate', detail: `status change refused (${tried}); commented out instead` }
      : { ...stub, wanted: 'deactivate', detail: `status change refused (${tried}); comment-out fallback also failed: ${stub.detail ?? ''}` }
  }

  if (item.action === 'commentOut') return applyStub(input, rec, item, before)

  // uncomment
  if (!isTemplateStubbed(rec.body)) return { ...base, result: 'alreadyThere', detail: 'body is live' }
  const rowId = ledger.recordChange('persistent', {
    itemType: 'ApexTrigger',
    itemName: item.name,
    itemId: rec.id,
    action: 'uncomment',
    beforeState: before
  })
  const restored = unstubBody(rec.body)
  const ok = await deployBodiesWithFallback(io.target.triggerIo, new Map([[rec.id, restored]]))
  if (ok.size === 0) {
    ledger.deleteChange(rowId)
    tally.add('automation', 'ApexTrigger', item.name, `${item.name}: body restore did not confirm`)
    return { ...base, result: 'failed', detail: 'MetadataContainer deploy did not confirm' }
  }
  return { ...base, result: 'changed', detail: 'body restored' }
}

async function applyStub(
  input: AutomationStepInput,
  rec: TriggerRecord,
  item: Extract<PlanItem, { kind: 'trigger' }>,
  before: Record<string, unknown>
): Promise<AutomationItemReport> {
  const { io, ledger, tally, templateName } = input
  const base = { ...planItemToReport(item, false), wanted: 'commentOut' as const }
  let stubbed: string
  try {
    stubbed = stubBody(rec.body, templateName, new Date(io.now()).toISOString().slice(0, 10))
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    tally.add('automation', 'ApexTrigger', item.name, `${item.name}: ${why}`)
    return { ...base, result: 'failed', detail: why }
  }
  if (ciEquals(stubbed, rec.body)) return { ...base, result: 'alreadyThere', detail: 'already commented out' }
  const rowId = ledger.recordChange('persistent', {
    itemType: 'ApexTrigger',
    itemName: item.name,
    itemId: rec.id,
    action: 'commentOut',
    beforeState: before
  })
  const ok = await deployBodiesWithFallback(io.target.triggerIo, new Map([[rec.id, stubbed]]))
  if (ok.size === 0) {
    ledger.deleteChange(rowId)
    tally.add('automation', 'ApexTrigger', item.name, `${item.name}: comment-out deploy did not confirm`)
    return { ...base, result: 'failed', detail: 'MetadataContainer deploy did not confirm' }
  }
  return { ...base, result: 'changed', detail: 'body commented out' }
}

/**
 * Plan against the live catalog, then (apply only) execute the changes. The
 * returned rows are the report's Automation table.
 */
export async function runAutomationStep(input: AutomationStepInput): Promise<AutomationItemReport[]> {
  const { io, dryRun } = input
  io.phase('Automation')
  const catalog = await buildAutomationCatalog(io.target)
  for (const e of catalog.errors) {
    io.log('warn', e)
    input.tally.add('automation', null, null, e)
  }
  const plan = planAutomation({ automation: { flows: input.flows, triggers: input.triggers, settingPatches: [] } }, catalog)
  io.log('info', `Automation: ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} in the template, ${plan.changes} to change`)
  for (const i of plan.items) {
    if (i.decision === 'notFound') {
      const name = i.kind === 'flow' ? i.apiName : i.name
      input.tally.add('automation', i.kind === 'flow' ? 'Flow' : 'ApexTrigger', name, `${name}: not in this org`)
    }
  }
  if (dryRun) return plan.items.map((i) => planItemToReport(i, true))

  const out: AutomationItemReport[] = []
  const changeTriggers = plan.items.filter((i): i is Extract<PlanItem, { kind: 'trigger' }> => i.kind === 'trigger' && i.decision === 'change')
  let records = new Map<string, TriggerRecord>()
  if (changeTriggers.length > 0) {
    try {
      records = await fetchTriggerRecords(io.target.triggerIo, changeTriggers.map((t) => t.name))
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      input.tally.add('automation', 'ApexTrigger', null, `trigger bodies could not be read: ${why}`)
    }
  }
  let n = 0
  for (const item of plan.items) {
    io.progress(n++, plan.items.length, item.kind === 'flow' ? item.apiName : item.name)
    if (item.decision !== 'change') {
      out.push(planItemToReport(item, false))
      continue
    }
    if (io.cancelled()) {
      out.push({ ...planItemToReport(item, false), result: 'failed', detail: 'cancelled before this item' })
      continue
    }
    out.push(item.kind === 'flow' ? await applyFlow(input, item) : await applyTrigger(input, item, records))
  }
  io.progress(plan.items.length, plan.items.length)
  return out
}

// ───────────────────────────── setting patches ─────────────────────────────

export async function runSettingPatches(input: {
  io: TemplateIo
  ledger: ChangeLedger
  tally: Tally
  patches: ReadonlyArray<SettingPatch>
  dryRun: boolean
}): Promise<SettingPatchReport[]> {
  const { io, ledger, tally, dryRun } = input
  const out: SettingPatchReport[] = []
  if (input.patches.length === 0) return out
  io.phase('Setting patches')
  for (const p of input.patches) {
    const base: SettingPatchReport = {
      label: p.label,
      object: p.object,
      field: p.field,
      rows: 0,
      alreadyPatched: 0,
      updated: 0,
      failed: 0,
      result: dryRun ? 'planned' : 'applied',
      detail: null
    }
    const desc = await io.target.describe(p.object)
    if (!desc) {
      out.push({ ...base, result: 'objectMissing', detail: `${p.object} is not in this org` })
      continue
    }
    const field = desc.fields.find((f) => f.name === p.field)
    if (!field) {
      tally.add('settingPatch', p.object, null, `${p.object}.${p.field} is not in this org`)
      out.push({ ...base, result: 'failed', detail: `${p.field} is not a field of ${p.object}` })
      continue
    }
    let rows: Array<Record<string, unknown>>
    try {
      rows = await io.target.query(settingPatchSoql(p))
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      tally.add('settingPatch', p.object, null, `${p.label}: ${why}`)
      out.push({ ...base, result: 'failed', detail: why })
      continue
    }
    const plan = planSettingPatch(rows, p, field.length)
    base.rows = rows.length
    base.alreadyPatched = plan.alreadyPatched
    if (plan.updates.length === 0) {
      out.push({ ...base, result: dryRun ? 'planned' : 'skipped', detail: rows.length === 0 ? 'no rows match' : 'every row already patched' })
      continue
    }
    if (dryRun) {
      out.push({ ...base, detail: `${plan.updates.length} row${plan.updates.length === 1 ? '' : 's'} would be updated` })
      continue
    }
    const rowIds = plan.undo.map((u) =>
      ledger.recordChange('persistent', {
        itemType: 'SettingPatch',
        itemName: `${p.object}.${p.field}`,
        itemId: u.id,
        action: 'patch',
        beforeState: { field: p.field, original: u.original, label: p.label }
      })
    )
    const res = await writeRows(io, 'PATCH', p.object, plan.updates, 200)
    let failed = 0
    res.results.forEach((r, i) => {
      if (r.success) return
      failed++
      ledger.deleteChange(rowIds[i]!)
      tally.add('settingPatch', p.object, String(plan.updates[i]!.Id), `${p.label}: ${r.error}`)
    })
    out.push({
      ...base,
      updated: plan.updates.length - failed,
      failed,
      result: failed > 0 ? 'failed' : 'applied',
      detail: failed > 0 ? `${failed} of ${plan.updates.length} failed` : null
    })
  }
  return out
}

// ───────────────────────────── safety check ─────────────────────────────

/** After apply: re-read every automation item and patch; anything not in the wanted state is a problem. */
export async function runSafetyCheck(input: {
  io: TemplateIo
  tally: Tally
  flows: Array<{ apiName: string; action: FlowAction }>
  triggers: Array<{ name: string; action: TriggerAction }>
  patches: ReadonlyArray<SettingPatch>
  automationRows: ReadonlyArray<AutomationItemReport>
}): Promise<{ ran: boolean; problems: string[] }> {
  const { io, tally } = input
  io.phase('Safety check')
  const problems: string[] = []
  const catalog = await buildAutomationCatalog(io.target)
  const plan = planAutomation({ automation: { flows: input.flows, triggers: input.triggers, settingPatches: [] } }, catalog)
  // A deactivate that fell back to a stub is "in the wanted state" when the body is stubbed.
  const fellBack = new Set(
    input.automationRows
      .filter((r) => r.itemType === 'ApexTrigger' && r.wanted === 'deactivate' && r.result === 'changed' && /commented out instead/.test(r.detail ?? ''))
      .map((r) => r.name)
  )
  for (const i of plan.items) {
    if (i.decision !== 'change') continue
    if (i.kind === 'trigger' && i.action === 'deactivate' && fellBack.has(i.name) && i.found?.bodyState === 'templateStub') continue
    const name = i.kind === 'flow' ? i.apiName : i.name
    const state = i.kind === 'flow' ? flowStateLabel(i.found!) : triggerStateLabel(i.found!)
    const msg = `${name}: still ${state} after apply (wanted ${i.action})`
    problems.push(msg)
    tally.add('safety', i.kind === 'flow' ? 'Flow' : 'ApexTrigger', name, msg)
  }
  for (const p of input.patches) {
    try {
      const rows = await io.target.query(settingPatchSoql(p))
      const desc = await io.target.describe(p.object)
      const len = desc?.fields.find((f) => f.name === p.field)?.length ?? null
      const again = planSettingPatch(rows, p, len)
      if (again.updates.length > 0) {
        const msg = `${p.label}: ${again.updates.length} row${again.updates.length === 1 ? '' : 's'} still unpatched after apply`
        problems.push(msg)
        tally.add('safety', p.object, null, msg)
      }
    } catch (e) {
      const msg = `${p.label}: could not re-read (${e instanceof Error ? e.message : String(e)})`
      problems.push(msg)
      tally.add('safety', p.object, null, msg)
    }
  }
  return { ran: true, problems }
}

/** Exported for tests: the Tooling path the flow resolver reads. */
export const _internal = { TOOLING_QUERY, urlEncode }
