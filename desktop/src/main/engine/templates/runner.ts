/**
 * runTemplate — the one driver for a template run (plan §4.4 runner.ts):
 *
 *   preflight → automation → setting patches → safety check (apply)
 *   → [disable target automation] → seed tiers → second pass → relink
 *   → [restore target automation] → verify → summary
 *
 * Dry run reads and plans; nothing is written. Apply writes to the TARGET only,
 * and only after preflight passed: stored role 'target', live `IsSandbox`, a
 * distinct source with role 'source' when seeding, no org-level lock. Every
 * failure lands in the tally; the state is computed from the facts.
 *
 * Temporary automation disables are restored in a `finally` — a seed that
 * throws or is cancelled still puts the target's automation back.
 */
import type { TemplateReport, TemplateRunMode } from '../../../shared/templates/types'
import { attestationBlocked } from '../../../shared/wizard'
import { isProdOrg } from '../../services/salesforce'
import type { IdMapRow } from '../../services/templateStore'
import { resolve as resolvePolicy } from '../objectPolicy'
import type { ChangeLedger } from './automationApply'
import { runAutomationStep, runSafetyCheck, runSettingPatches } from './automationApply'
import type { TemplateIo } from './io'
import type { ResolvedRun } from './resolve'
import { SeedCancelledError, SeedRun, type SeedPreflight } from './seed/runSeed'
import { TargetAutomation, discoveryIoOver } from './seed/targetAutomation'
import { batchSizeSuggestions, decideNextAction, decideState, groupProblems, Tally } from './tally'

/** Everything the runner persists, bound to one run (TemplateStore + runId + targetOrgId). */
export interface RunLedger extends ChangeLedger {
  putIdMap(rows: ReadonlyArray<IdMapRow>): void
  idMapForTarget(): IdMapRow[]
  idMapCounts(): Record<string, number>
  deleteIdMap(objects: ReadonlyArray<string>): number
  confirmRestored(rowIds: ReadonlyArray<number>): void
  /** Persist the partial report (after each step) so a crash leaves evidence. */
  saveReport(report: TemplateReport): void
  unrestoredTemporaryCount(): number
}

export interface RunTemplateOptions {
  mode: Exclude<TemplateRunMode, 'restore'>
  disableTargetAutomation: boolean
  cpqAttestation: boolean
  purge: boolean
  resume: boolean
  /** The stored role of the target connection (the runner refuses anything but 'target'). */
  targetStoredRole: string
  /** The stored role of the source connection, when a source is in play. */
  sourceStoredRole: string | null
  /** Other work on the same target org found by the caller (deploy jobs, other template runs, unrestored rows). */
  lockConflict: string | null
  /** The runtime production pin (S64 P6, D6). Defaults to the compiled constant. */
  prodOrgIdPrefix?: string
}

export function emptyReport(mode: TemplateRunMode, startedAt: number): TemplateReport {
  return {
    schemaVersion: 1,
    mode,
    state: 'running',
    startedAt,
    finishedAt: null,
    preflight: { blockers: [], notes: [] },
    automation: [],
    settingPatches: [],
    safetyCheck: null,
    targetAutomation: null,
    purge: null,
    seed: [],
    secondPass: [],
    relink: [],
    verify: null,
    problems: [],
    summary: { unexpected: 0, expected: 0, unexpectedGroups: [], expectedGroups: [], nextAction: 'none', batchSizeSuggestions: [] }
  }
}

export async function runTemplate(io: TemplateIo, resolved: ResolvedRun, ledger: RunLedger, opts: RunTemplateOptions): Promise<TemplateReport> {
  const dryRun = opts.mode === 'dry-run'
  const report = emptyReport(opts.mode, io.now())
  const tally = new Tally()
  let cancelled = false
  const save = (): void => {
    report.problems = [...tally.items]
    ledger.saveReport(report)
  }

  // ── preflight ──
  io.phase('Preflight')
  const blockers = report.preflight.blockers
  blockers.push(...resolved.blockers)
  if (opts.targetStoredRole !== 'target') blockers.push(`The target connection's stored role is '${opts.targetStoredRole}' — set it to Target on the Connections page`)
  if (isProdOrg(io.target.orgId, opts.prodOrgIdPrefix)) blockers.push('The target is the pinned production org — read-only')
  try {
    const org = await io.target.organization()
    if (!org.isSandbox) blockers.push(`${io.target.label} (${org.name}) is not a sandbox — templates only write to sandboxes`)
    else report.preflight.notes.push(`target ${io.target.label}: ${org.name} (sandbox, ${org.id.slice(0, 15)})`)
  } catch (e) {
    blockers.push(`Could not read the target's Organization row: ${e instanceof Error ? e.message : String(e)}`)
  }
  const seeding = resolved.seeds.length > 0
  if (seeding) {
    if (!io.source) blockers.push('A seed step needs a source org — pick one on the run form')
    else {
      if (opts.sourceStoredRole !== 'source') blockers.push(`The source connection's stored role is '${opts.sourceStoredRole ?? 'unknown'}' — set it to Source`)
      if (io.source.orgId.slice(0, 15) === io.target.orgId.slice(0, 15)) blockers.push('Source and target are the same org')
      for (const s of resolved.seeds) {
        const want = s.template.source.expectedOrgId
        if (want && want.slice(0, 15) !== io.source.orgId.slice(0, 15)) {
          blockers.push(`Seed template "${s.name}" expects source org ${want.slice(0, 15)}; ${io.source.label} is ${io.source.orgId.slice(0, 15)}`)
        }
      }
    }
  }
  if (opts.lockConflict) blockers.push(opts.lockConflict)
  // D3b — the CPQ "Triggers Disabled" attestation when a seeded object needs the package bypass.
  if (seeding) {
    const seeded = resolved.seeds.flatMap((s) => SeedRun.seededObjects(s.tiers))
    const gated = seeded.filter((o) => resolvePolicy(o).requiresTriggerBypass === true).sort()
    if (gated.length > 0) {
      // The legacy CPQ setting probe fails toward `false` — the direction that SHOWS the attestation.
      const hasSetting = await io.target
        .toolingQuery("SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'SBQQ__TriggerDisabled__c'")
        .then((rows) => rows.length > 0)
        .catch(() => false)
      const snapshot = { hasCpqTriggerSetting: hasSetting, cpqTriggerGatedObjects: gated } as Parameters<typeof attestationBlocked>[0]
      if (attestationBlocked(snapshot, false, opts.cpqAttestation)) {
        const msg = `CPQ "Triggers Disabled" attestation is required: ${gated.length} seeded object${gated.length === 1 ? '' : 's'} (${gated.slice(0, 6).join(', ')}${gated.length > 6 ? '…' : ''}) react to the managed package's triggers`
        if (dryRun) report.preflight.notes.push(`${msg} — confirm it before Apply`)
        else blockers.push(msg)
      }
    }
  }
  for (const b of blockers) tally.add('preflight', null, null, b)
  save()
  if (blockers.length > 0 && !dryRun) {
    report.state = 'blocked'
    report.finishedAt = io.now()
    finish(report, tally, ledger, { blocked: true, cancelled: false, completed: false, unrestored: 0 })
    return report
  }
  if (blockers.length > 0) io.log('warn', `dry run is BLOCKED (${blockers.length}) — showing the plan anyway`)

  // ── automation + patches (post-refresh) ──
  if (resolved.kind === 'postRefresh' && resolved.postRefresh && resolved.automation) {
    const pr = resolved.postRefresh
    report.automation = await runAutomationStep({ io, ledger, tally, templateName: resolved.name, flows: pr.automation.flows, triggers: pr.automation.triggers, dryRun })
    save()
    report.settingPatches = await runSettingPatches({ io, ledger, tally, patches: resolved.settingPatches, dryRun })
    save()
    if (!dryRun) {
      report.safetyCheck = await runSafetyCheck({ io, tally, flows: pr.automation.flows, triggers: pr.automation.triggers, patches: resolved.settingPatches, automationRows: report.automation })
      save()
    }
  }

  // ── seeds ──
  const targetAutomation = new TargetAutomation(io, ledger, tally)
  targetAutomation.onRestored = (rowIds) => ledger.confirmRestored(rowIds)
  let seedBlocked = false
  let threw = false
  if (seeding && io.source && !io.cancelled()) {
    const seeded = [...new Set(resolved.seeds.flatMap((s) => SeedRun.seededObjects(s.tiers)))]
    // S61 U-11: every seed's own preflight (copied-object match, existing rows, stale id map)
    // runs BEFORE the target's automation is touched — a run that is going to be blocked must
    // not toggle 43 rules off and on first.
    const seedRuns = resolved.seeds.map((s) => ({
      s,
      run: new SeedRun({ io, ledger, tally, name: s.name, template: s.template, tiers: s.tiers, dryRun, purge: opts.purge, resume: opts.resume })
    }))
    const pres: SeedPreflight[] = []
    for (const { run } of seedRuns) {
      const pre = await run.preflight()
      pres.push(pre)
      for (const b of pre.blockers) {
        report.preflight.blockers.push(b)
        tally.add('preflight', null, null, b)
      }
    }
    save()
    if (pres.some((p) => p.blockers.length > 0) && !dryRun) seedBlocked = true
    try {
      if (!seedBlocked && opts.disableTargetAutomation) {
        await targetAutomation.disable(seeded, dryRun)
        report.targetAutomation = targetAutomation.report
        save()
      }
      for (let i = 0; i < seedRuns.length && !seedBlocked; i++) {
        const { s, run } = seedRuns[i]!
        const pre = pres[i]!
        io.log('info', `seed template "${s.name}": ${s.tiers.length} tier${s.tiers.length === 1 ? '' : 's'}${s.groups.length ? ` (groups ${s.groups.join(', ')})` : ''}`)
        const out = await run.run(pre)
        for (const b of out.blockers) {
          if (pre.blockers.includes(b)) continue // already recorded above
          report.preflight.blockers.push(b)
          tally.add('preflight', null, null, b)
        }
        if (out.purge) report.purge = [...(report.purge ?? []), ...out.purge]
        report.seed.push(...out.seed)
        report.secondPass.push(...out.secondPass)
        report.relink.push(...out.relink)
        if (out.verify) {
          report.verify = report.verify
            ? { counts: [...report.verify.counts, ...out.verify.counts], dangling: [...report.verify.dangling, ...out.verify.dangling], parity: [...report.verify.parity, ...out.verify.parity] }
            : out.verify
        }
        save()
        if (out.cancelled) {
          cancelled = true
          break
        }
        if (out.blockers.length > 0 && !dryRun) {
          seedBlocked = true
          break
        }
      }
    } catch (e) {
      if (e instanceof SeedCancelledError) cancelled = true
      else {
        threw = true
        const why = e instanceof Error ? e.message : String(e)
        io.log('error', `seed failed: ${why}`)
        tally.add('seed', null, null, why)
      }
    } finally {
      if (!dryRun && opts.disableTargetAutomation && report.targetAutomation) {
        await targetAutomation.restore()
        report.targetAutomation = targetAutomation.report
        save()
      }
    }
  }
  if (io.cancelled()) cancelled = true

  report.finishedAt = io.now()
  finish(report, tally, ledger, {
    blocked: seedBlocked || (dryRun && blockers.length > 0),
    cancelled,
    completed: !threw,
    unrestored: dryRun ? 0 : ledger.unrestoredTemporaryCount()
  })
  return report
}

function finish(
  report: TemplateReport,
  tally: Tally,
  ledger: RunLedger,
  f: { blocked: boolean; cancelled: boolean; completed: boolean; unrestored: number }
): void {
  const unexpected = tally.unexpected()
  report.problems = [...tally.items]
  report.state = decideState({ blocked: f.blocked, cancelled: f.cancelled, unexpected: unexpected.length, completed: f.completed })
  report.summary = {
    unexpected: unexpected.length,
    expected: tally.expected().length,
    unexpectedGroups: groupProblems(unexpected),
    expectedGroups: groupProblems(tally.expected()),
    nextAction: decideNextAction({ state: report.state, unexpected, mode: report.mode, unrestoredTemporary: f.unrestored }),
    batchSizeSuggestions: batchSizeSuggestions(report.seed, report.secondPass)
  }
  if (report.finishedAt == null) report.finishedAt = Date.now()
  ledger.saveReport(report)
}

export { discoveryIoOver }
