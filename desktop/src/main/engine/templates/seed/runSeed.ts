/**
 * The DATA SEED engine (plan §4.4 runner, P2 + P3): copy configuration rows
 * from the source org into a sandbox in tier order with Id remapping, then
 * the second pass (deferred fields through the map), the relink of copied
 * objects, and verification. Resume continues from the persisted id map.
 *
 * Ported from the reference tool's Seeder with the engine's seams: every
 * org call goes through TemplateIo; the id map and problems are persisted
 * through the bound ledger after every tier, so a cancelled or crashed apply
 * leaves a usable resume point.
 *
 * NOT reused from the deploy engine (plan §4.2): retry.ts / passes.ts /
 * secondPass.ts are frozen-plan + External-Id-upsert shaped; the collections
 * helpers carry the CPQ tripwire that a config seed trips by design. The
 * writer here talks to `OrgWriter.collections` directly.
 */
import type {
  RelinkReport,
  SecondPassReport,
  SeedTemplate,
  SeedTier,
  SeedTierReport,
  VerifyReport,
  PurgeRow
} from '../../../../shared/templates/types'
import { BATCH_SIZE_DEFAULT, DEFAULT_TIER_GROUP } from '../../../../shared/templates/types'
import type { IdMapRow } from '../../../services/templateStore'
import type { OrgReader, TemplateIo } from '../io'
import type { Tally } from '../tally'
import {
  buildRecord,
  deferredFieldsFor,
  fieldPlan,
  plannerContext,
  sameValue,
  sourceSoql,
  type FieldPlan,
  type PlannerContext
} from './planner'
import { DRY_PREFIX, SeedIdMap, staleObjects } from './idMap'
import { KeptIds, scopeRows } from './parentScope'
import { deleteRows, SeedCancelledError, writeRows } from './writer'

export { SeedCancelledError }

/** The run-bound persistence the seed needs. */
export interface SeedLedger {
  putIdMap(rows: ReadonlyArray<IdMapRow>): void
  idMapForTarget(): IdMapRow[]
  idMapCounts(): Record<string, number>
  deleteIdMap(objects: ReadonlyArray<string>): number
}

export interface SeedRunInput {
  io: TemplateIo
  ledger: SeedLedger
  tally: Tally
  name: string
  template: SeedTemplate
  tiers: SeedTier[]
  dryRun: boolean
  purge: boolean
  resume: boolean
}

export type SeedPreflight = { blockers: string[]; existing: Record<string, number> }

export interface SeedRunOutput {
  blockers: string[]
  purge: PurgeRow[] | null
  seed: SeedTierReport[]
  secondPass: SecondPassReport[]
  relink: RelinkReport[]
  verify: VerifyReport | null
  cancelled: boolean
}

interface Deferred {
  object: string
  targetId: string
  later: Record<string, unknown>
}

interface TierState {
  tier: SeedTier
  plan: FieldPlan | null
  report: SeedTierReport
  /** Source rows after scoping (the parity + reconcile input). */
  sourceRows: Array<Record<string, unknown>>
}

function emptyTierReport(tier: SeedTier): SeedTierReport {
  return {
    object: tier.object,
    group: tier.group ?? DEFAULT_TIER_GROUP,
    source: 0,
    loaded: 0,
    failed: 0,
    skipped: 0,
    nulled: 0,
    fields: 0,
    resumed: 0,
    failures: [],
    skips: [],
    nulledFields: {},
    noAccess: [],
    missingOnTarget: [],
    savedOnSingleRetry: 0,
    bulkOnlyFailures: 0,
    skippedObject: null,
    note: null,
    pruned: null,
    bytes: null
  }
}

const inList = (ids: ReadonlyArray<string>): string => ids.map((i) => `'${i.replace(/'/g, "\\'")}'`).join(', ')

async function queryByIds(
  org: OrgReader,
  object: string,
  ids: ReadonlyArray<string>,
  fields = 'Id'
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const sorted = [...new Set(ids)].sort()
  for (let i = 0; i < sorted.length; i += 200) {
    out.push(...(await org.query(`SELECT ${fields} FROM ${object} WHERE Id IN (${inList(sorted.slice(i, i + 200))})`)))
  }
  return out
}

export class SeedRun {
  private readonly io: TemplateIo
  private readonly source: OrgReader
  private readonly ctx: PlannerContext
  private readonly idMap: SeedIdMap
  private readonly kept = new KeptIds()
  private readonly deferred: Deferred[] = []
  private readonly states = new Map<string, TierState>()
  private prefixMap: Map<string, string> | null = null
  private cancelled = false

  constructor(private readonly input: SeedRunInput) {
    if (!input.io.source) throw new Error('A seed run needs a source org')
    this.io = input.io
    this.source = input.io.source
    this.ctx = plannerContext(input.template, input.tiers)
    this.idMap = new SeedIdMap(input.resume ? input.ledger.idMapForTarget() : [])
    input.tally.configure(input.template.expectedFailures)
  }

  // ───────────────────────────── preflight ─────────────────────────────

  async preflight(): Promise<SeedPreflight> {
    const { io, template, tiers } = this.input
    const blockers: string[] = []
    io.phase('Preflight')
    // Copied objects must look like a fresh copy of the source (tolerance absolute / fraction).
    const tol = template.copiedMatchTolerance ?? { absolute: 5, fraction: 0.02 }
    for (const obj of template.copiedObjectsMustMatchSource) {
      try {
        const s = new Set((await this.source.query(`SELECT Id FROM ${obj}`)).map((r) => String(r.Id)))
        const t = new Set((await io.target.query(`SELECT Id FROM ${obj}`)).map((r) => String(r.Id)))
        let missing = 0
        for (const id of s) if (!t.has(id)) missing++
        io.log('info', `${obj}: source ${s.size}, target ${t.size}, source Ids missing from the target: ${missing}`)
        if (missing > Math.max(tol.absolute, Math.floor(s.size * tol.fraction))) {
          blockers.push(`${obj}: ${missing} of ${s.size} source records are missing from the target — this does not look like a fresh copy of the source`)
        }
      } catch (e) {
        blockers.push(`${obj}: could not compare source and target (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    // Existing rows in the seed objects (full seed into empty objects unless purge / resume).
    const existing: Record<string, number> = {}
    for (const t of tiers) {
      if (!(await io.target.describe(t.object))) continue
      try {
        const n = await io.target.count(t.object, t.where)
        if (n > 0) existing[t.object] = n
      } catch (e) {
        io.log('warn', `${t.object}: could not count target rows (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    if (this.input.resume) {
      if (this.input.purge) blockers.push('Resume and purge do not mix — pick one')
      const counts = this.input.ledger.idMapCounts()
      const stale = staleObjects(
        tiers.map((t) => ({ object: t.object, target: existing[t.object] ?? 0, mapped: counts[t.object] ?? 0 }))
      )
      if (stale.length > 0) {
        blockers.push(
          `The id map does not match the target (an older map would insert duplicates): ${stale.join('; ')}. Purge and reseed, or seed a fresh sandbox.`
        )
      }
      io.log('info', `resume: ${this.idMap.resumed.size} rows already loaded per the id map; loading only the rest`)
    } else if (Object.keys(existing).length > 0 && !this.input.purge) {
      const list = Object.entries(existing)
        .map(([o, n]) => `${o} (${n})`)
        .join(', ')
      blockers.push(`The target already holds rows in ${Object.keys(existing).length} seed object${Object.keys(existing).length === 1 ? '' : 's'}: ${list}. This is a full seed into empty objects — purge first, resume the last apply, or seed a fresh sandbox.`)
    }
    return { blockers, existing }
  }

  // ───────────────────────────── purge ─────────────────────────────

  async purge(existing: Record<string, number>): Promise<PurgeRow[]> {
    const { io, tiers, tally, ledger, dryRun } = this.input
    io.phase('Purge')
    const out: PurgeRow[] = []
    // S61 U-12 (revised after run 12 on tgt_a): rows are deleted directly, bottom tier first,
    // exactly as before. A managed-package delete trigger may REFUSE some child deletes (Advanced
    // Approvals: "Condition Index Number … does not exist"); when the parent's own delete then
    // removes those rows by master-detail cascade, the refusals were never a problem — so each
    // object's refusals are HELD until the purge is over and the object is re-counted. (The first
    // version skipped the child delete and trusted the cascade; CPQ refuses to delete a quote
    // template WHILE it has line columns — "associated with the following line columns" — so a
    // child must always be tried first, and only a refusal the cascade cured is forgiven.)
    const held: Array<{ object: string; row: PurgeRow; total: number; failures: Array<{ id: string; error: string }> }> = []
    for (const t of [...tiers].reverse()) {
      if (!(t.object in existing)) continue
      if (dryRun) {
        out.push({ object: t.object, deleted: existing[t.object]!, failed: 0 })
        continue
      }
      const where = (t.where ?? '').trim()
      const ids = (await io.target.query(`SELECT Id FROM ${t.object}${where ? ` WHERE ${where}` : ''}`)).map((r) => String(r.Id))
      if (ids.length === 0) {
        out.push({ object: t.object, deleted: 0, failed: 0 })
        continue
      }
      const res = await deleteRows(io, ids)
      const failures: Array<{ id: string; error: string }> = []
      res.forEach((r, i) => {
        if (!r.success) failures.push({ id: ids[i]!, error: r.error })
      })
      ledger.deleteIdMap([t.object])
      const row: PurgeRow = { object: t.object, deleted: ids.length - failures.length, failed: failures.length }
      out.push(row)
      if (failures.length > 0) held.push({ object: t.object, row, total: ids.length, failures })
      io.log('info', `purge ${t.object}: deleted ${ids.length - failures.length} of ${ids.length}${failures.length ? ` (${failures.length} refused — re-checked after the parents are purged)` : ''}`)
    }
    // Settle the held refusals: gone by a parent's cascade → not a problem; still there → the real failures.
    for (const h of held) {
      const tier = tiers.find((t) => t.object === h.object)!
      const left = await io.target.count(h.object, tier.where)
      if (left === 0) {
        h.row.deleted = h.total
        h.row.failed = 0
        h.row.via = `${h.failures.length} direct delete${h.failures.length === 1 ? '' : 's'} refused by a trigger; removed by the parent’s cascade`
        io.log('info', `purge ${h.object}: ${h.row.via}`)
      } else {
        for (const f of h.failures) tally.add('purge', h.object, f.id, f.error)
      }
    }
    return out
  }

  // ───────────────────────────── tiers ─────────────────────────────

  private async targetOf(ref: { kind: string; to: string[] }, value: string): Promise<string | null> {
    if (ref.kind === 'check') return ref.to[0] ?? null
    if (this.prefixMap === null) {
      this.prefixMap = new Map()
      for (const o of await this.io.target.describeGlobal()) if (o.keyPrefix) this.prefixMap.set(o.keyPrefix, o.name)
    }
    return this.prefixMap.get(value.slice(0, 3)) ?? null
  }

  /** Which `check`/`poly` referenced source Ids exist on the target (kept as-is); the rest get nulled. */
  private async existingIds(plan: FieldPlan, rows: ReadonlyArray<Record<string, unknown>>): Promise<Set<string>> {
    const want = new Map<string, Set<string>>()
    for (const [n, ref] of Object.entries(plan.refs)) {
      if (ref.kind !== 'check' && ref.kind !== 'poly') continue
      for (const r of rows) {
        const v = r[n]
        if (typeof v !== 'string' || v === '' || this.idMap.has(v)) continue
        const t = await this.targetOf(ref, v)
        if (t === null) continue
        let s = want.get(t)
        if (!s) {
          s = new Set()
          want.set(t, s)
        }
        s.add(v)
      }
    }
    const found = new Set<string>()
    for (const [t, ids] of want) {
      if (this.ctx.keepIdTargets.has(t)) {
        for (const id of ids) found.add(id)
        continue
      }
      try {
        for (const r of await queryByIds(this.io.target, t, [...ids])) found.add(String(r.Id))
      } catch {
        /* not queryable → treated as absent */
      }
    }
    return found
  }

  private recordLoad(object: string, sourceId: string, targetId: string, later: Record<string, unknown>): void {
    this.idMap.set(object, sourceId, targetId)
    if (Object.keys(later).length > 0) this.deferred.push({ object, targetId, later })
  }

  async seedTier(tier: SeedTier): Promise<SeedTierReport> {
    const { io, template, tally, dryRun } = this.input
    const report = emptyTierReport(tier)
    const state: TierState = { tier, plan: null, report, sourceRows: [] }
    this.states.set(tier.object, state)
    io.phase(`Seed: ${tier.object}`)

    const [sd, td] = await Promise.all([this.source.describe(tier.object), io.target.describe(tier.object)])
    if (!sd || !td) {
      report.skippedObject = !sd ? 'object not in the source org' : 'object missing in the target'
      io.log('warn', `${tier.object}: SKIPPED (${report.skippedObject})`)
      tally.add('seed', tier.object, null, `skipped object: ${report.skippedObject}`)
      return report
    }
    const plan = fieldPlan(this.ctx, tier.object, sd, td)
    state.plan = plan
    report.fields = plan.cols.length
    report.noAccess = plan.noAccess
    report.missingOnTarget = plan.missing

    let rows = await this.source.query(sourceSoql(tier, plan))
    const scoped = scopeRows(template, tier, rows, this.kept)
    rows = scoped.rows
    for (const id of scoped.missingSubsetIds) {
      io.log('warn', `${tier.object}: subset record ${id} not found in the source`)
      tally.add('seed', tier.object, id, `subset record ${id} not found in the source`)
    }
    state.sourceRows = rows
    report.source = rows.length
    if (scoped.droppedByParent > 0) report.note = `${scoped.droppedByParent} row${scoped.droppedByParent === 1 ? '' : 's'} outside the parent scope`

    if (this.input.resume) {
      const done = rows.filter((r) => this.idMap.has(String(r.Id)))
      report.resumed = done.length
      await this.reconcile(tier.object, plan, done, report)
      rows = rows.filter((r) => !this.idMap.has(String(r.Id)))
    }

    const exists = await this.existingIds(plan, rows)
    if (tier.handler === 'attachmentsViaJunction') {
      await this.seedAttachments(tier, plan, rows, exists, report)
      return report
    }

    const deferredFields = new Set(template.deferredFields[tier.object] ?? [])
    const payloads: Array<Record<string, unknown>> = []
    const keys: string[] = []
    const laters: Array<Record<string, unknown>> = []
    for (const r of rows) {
      const b = buildRecord(r, plan, { deferredFields, placeholders: template.deferredPlaceholders, idMap: this.idMap.readonly, exists })
      if (b.error !== null || b.payload === null) {
        report.skips.push({ recordId: String(r.Id), message: b.error ?? 'no payload' })
        tally.add('seed', tier.object, String(r.Id), `skipped: ${b.error ?? 'no payload'}`)
        continue
      }
      for (const n of b.nulled) report.nulledFields[n] = (report.nulledFields[n] ?? 0) + 1
      payloads.push(b.payload)
      keys.push(String(r.Id))
      laters.push(b.later)
    }
    report.skipped = report.skips.length
    report.nulled = Object.values(report.nulledFields).reduce((a, b) => a + b, 0)

    if (dryRun) {
      keys.forEach((k, i) => this.recordLoad(tier.object, k, DRY_PREFIX + k, laters[i]!))
      report.loaded = payloads.length
    } else if (payloads.length > 0) {
      const w = await writeRows(io, 'POST', tier.object, payloads, tier.batchSize ?? BATCH_SIZE_DEFAULT)
      report.savedOnSingleRetry = w.savedOnSingleRetry
      report.bulkOnlyFailures = w.bulkOnlyFailures
      w.results.forEach((r, i) => {
        if (r.success && r.id) {
          this.recordLoad(tier.object, keys[i]!, r.id, laters[i]!)
          report.loaded++
        } else {
          report.failures.push({ recordId: keys[i]!, message: r.error })
          tally.add('seed', tier.object, keys[i]!, r.error)
        }
      })
      report.failed = report.failures.length
      if (w.savedOnSingleRetry > 0) io.log('warn', `${tier.object}: ${w.savedOnSingleRetry} row(s) saved only on the single-record retry — consider batchSize 1`)
    }
    this.persistTier(tier.object)
    io.log(
      'info',
      `${tier.object}: source ${report.source}, loaded ${report.loaded}, failed ${report.failed}, skipped ${report.skipped}, nulled ${report.nulled}, fields ${report.fields}` +
        (report.resumed > 0 ? `, resumed ${report.resumed}` : '')
    )
    if (tier.pruneUnloadedUnder) await this.prune(tier, report)
    return report
  }

  /** Resume only: rows an earlier run loaded can still lack their second-pass values. Queue the fixes. */
  private async reconcile(object: string, plan: FieldPlan, done: ReadonlyArray<Record<string, unknown>>, report: SeedTierReport): Promise<void> {
    const fields = deferredFieldsFor(plan, this.input.template.deferredFields[object] ?? [])
    if (fields.length === 0 || done.length === 0) return
    const bad = await this.mismatches(object, plan, done, fields)
    const fixes = new Map<string, Record<string, unknown>>()
    const byId = new Map(done.map((r) => [String(r.Id), r]))
    for (const m of bad) {
      if (m.field === '(row missing on target)') {
        this.input.tally.add('resume', object, m.sourceId, `id map points at ${m.targetId}, which is not on the target`)
        continue
      }
      const f = fixes.get(m.targetId) ?? {}
      f[m.field] = byId.get(m.sourceId)?.[m.field]
      fixes.set(m.targetId, f)
    }
    for (const [targetId, later] of fixes) this.deferred.push({ object, targetId, later })
    if (fixes.size > 0) {
      report.note = `resume: ${fixes.size} earlier row${fixes.size === 1 ? '' : 's'} still need second-pass values`
      this.io.log('info', `${object}: ${report.note}`)
    }
  }

  private persistTier(object: string): void {
    if (this.input.dryRun) return
    this.input.ledger.putIdMap(this.idMap.persistable(object))
  }

  private async seedAttachments(
    tier: SeedTier,
    plan: FieldPlan,
    rows: ReadonlyArray<Record<string, unknown>>,
    exists: Set<string>,
    report: SeedTierReport
  ): Promise<void> {
    const { io, template, tally, dryRun } = this.input
    const cfg = tier.handlerConfig!
    const fileIds = rows.map((r) => r[cfg.fileIdField]).filter((v): v is string => typeof v === 'string' && v !== '')
    const atts = new Map<string, Record<string, unknown>>()
    if (fileIds.length > 0) {
      for (const a of await queryByIds(this.source, 'Attachment', fileIds, 'Id, Name, ContentType, Description, IsPrivate, BodyLength')) {
        atts.set(String(a.Id), a)
      }
    }
    const deferredFields = new Set(template.deferredFields[tier.object] ?? [])
    let bytes = 0
    for (const r of rows) {
      if (io.cancelled()) throw new SeedCancelledError()
      const id = String(r.Id)
      const att = typeof r[cfg.fileIdField] === 'string' ? atts.get(String(r[cfg.fileIdField])) : undefined
      if (!att) {
        report.skips.push({ recordId: id, message: 'attachment missing in source (orphan row)' })
        tally.add('seed', tier.object, id, 'skipped: attachment missing in source (orphan row)')
        continue
      }
      const b = buildRecord(r, plan, { deferredFields, placeholders: template.deferredPlaceholders, idMap: this.idMap.readonly, exists })
      const parent = b.payload?.[cfg.parentField]
      if (b.error !== null || b.payload === null || typeof parent !== 'string') {
        const why = b.error ?? 'parent record was not loaded'
        report.skips.push({ recordId: id, message: why })
        tally.add('seed', tier.object, id, `skipped: ${why}`)
        continue
      }
      if (dryRun) {
        this.recordLoad(tier.object, id, DRY_PREFIX + id, b.later)
        report.loaded++
        bytes += typeof att.BodyLength === 'number' ? att.BodyLength : 0
        continue
      }
      try {
        const raw = await this.source.attachmentBody(String(att.Id))
        const newAttId = await io.target.createRecord('Attachment', {
          Name: att.Name,
          ParentId: parent,
          ContentType: att.ContentType ?? null,
          Description: att.Description ?? null,
          IsPrivate: att.IsPrivate === true,
          Body: Buffer.from(raw).toString('base64')
        })
        b.payload[cfg.fileIdField] = newAttId
        const w = await writeRows(io, 'POST', tier.object, [b.payload], 1)
        const res = w.results[0]!
        if (res.success && res.id) {
          this.recordLoad(tier.object, id, res.id, b.later)
          report.loaded++
          bytes += raw.length
        } else {
          report.failures.push({ recordId: id, message: res.error })
          tally.add('seed', tier.object, id, res.error)
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        report.failures.push({ recordId: id, message: why })
        tally.add('seed', tier.object, id, why)
      }
    }
    report.failed = report.failures.length
    report.skipped = report.skips.length
    report.bytes = bytes
    report.note = `${report.loaded} file${report.loaded === 1 ? '' : 's'}, ${(bytes / 1048576).toFixed(1)} MB`
    this.persistTier(tier.object)
    io.log('info', `${tier.object}: ${report.note}; loaded ${report.loaded}, failed ${report.failed}, skipped ${report.skipped}`)
  }

  /** Delete rows the TARGET's automation created under the loaded parents that did not come from the source. */
  private async prune(tier: SeedTier, report: SeedTierReport): Promise<void> {
    const spec = tier.pruneUnloadedUnder!
    const { io, dryRun, tally } = this.input
    if (dryRun) {
      report.pruned = 0
      return
    }
    const parents = this.idMap.targetIds(spec.parent)
    const mine = new Set(this.idMap.targetIds(tier.object))
    const rows: string[] = []
    for (let i = 0; i < parents.length; i += 200) {
      const chunk = parents.slice(i, i + 200)
      rows.push(...(await io.target.query(`SELECT Id FROM ${tier.object} WHERE ${spec.field} IN (${inList(chunk)})`)).map((r) => String(r.Id)))
    }
    const extra = rows.filter((id) => !mine.has(id))
    if (extra.length === 0) {
      report.pruned = 0
      return
    }
    const res = await deleteRows(io, extra)
    let failed = 0
    res.forEach((r, i) => {
      if (r.success) return
      failed++
      tally.add('seed', tier.object, extra[i]!, `prune: ${r.error}`)
    })
    report.pruned = extra.length - failed
    io.log('info', `${tier.object}: pruned ${report.pruned} auto-created row(s)${failed ? `, ${failed} failed` : ''}`)
  }

  // ───────────────────────────── second pass ─────────────────────────────

  async secondPass(): Promise<SecondPassReport[]> {
    const { io, dryRun, tally, tiers } = this.input
    const byObject = new Map<string, Array<Record<string, unknown>>>()
    for (const d of this.deferred) {
      const plan = this.states.get(d.object)?.plan
      if (!plan) continue
      const rec: Record<string, unknown> = { Id: d.targetId }
      for (const [n, v] of Object.entries(d.later)) {
        if (n in plan.refs) {
          const nv = typeof v === 'string' ? this.idMap.get(v) : undefined
          if (nv !== undefined && !nv.startsWith(DRY_PREFIX)) rec[n] = nv
          else if (nv !== undefined && dryRun) rec[n] = nv
        } else rec[n] = v
      }
      if (Object.keys(rec).length > 1) {
        const list = byObject.get(d.object) ?? []
        list.push(rec)
        byObject.set(d.object, list)
      }
    }
    const out: SecondPassReport[] = []
    if (byObject.size === 0) return out
    io.phase('Second pass')
    const order = new Map(tiers.map((t, i) => [t.object, i]))
    for (const object of [...byObject.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
      const recs = byObject.get(object)!
      const fields = [...new Set(recs.flatMap((r) => Object.keys(r).filter((k) => k !== 'Id')))].sort()
      const rep: SecondPassReport = { object, updates: recs.length, updated: 0, failed: 0, fields, failures: [], savedOnSingleRetry: 0 }
      if (dryRun) {
        out.push(rep)
        continue
      }
      // Real rows only (a dry marker cannot be updated).
      const real = recs.filter((r) => !String(r.Id).startsWith(DRY_PREFIX))
      const tier = tiers.find((t) => t.object === object)
      const w = await writeRows(io, 'PATCH', object, real, tier?.batchSize ?? BATCH_SIZE_DEFAULT)
      rep.savedOnSingleRetry = w.savedOnSingleRetry
      w.results.forEach((r, i) => {
        if (r.success) rep.updated++
        else {
          rep.failures.push({ recordId: String(real[i]!.Id), message: r.error })
          tally.add('secondPass', object, String(real[i]!.Id), r.error)
        }
      })
      rep.failed = rep.failures.length
      io.log('info', `second pass ${object}: ${rep.updated} of ${rep.updates} updated (${fields.join(', ')})${rep.savedOnSingleRetry ? ` (${rep.savedOnSingleRetry} on single-record retry)` : ''}`)
      out.push(rep)
    }
    return out
  }

  // ───────────────────────────── relink ─────────────────────────────

  async relink(): Promise<RelinkReport[]> {
    const { io, template, dryRun, tally } = this.input
    const out: RelinkReport[] = []
    if (template.relinkCopiedObjects.length === 0) return out
    io.phase('Relink')
    for (const spec of template.relinkCopiedObjects) {
      const d = await io.target.describe(spec.object)
      if (!d) {
        tally.add('relink', spec.object, null, `${spec.object} is not in the target`)
        continue
      }
      const fields = d.fields
        .filter((f) => f.type === 'reference' && f.updateable && f.referenceTo.length === 1 && this.ctx.seedSet.has(f.referenceTo[0]!))
        .map((f) => f.name)
      if (fields.length === 0) continue
      const ups: Array<Record<string, unknown>> = []
      for (const r of await this.source.query(`SELECT Id, ${fields.join(', ')} FROM ${spec.object}`)) {
        const u: Record<string, unknown> = { Id: r.Id }
        for (const f of fields) {
          const v = r[f]
          const nv = typeof v === 'string' ? this.idMap.get(v) : undefined
          if (nv !== undefined) u[f] = nv
        }
        if (Object.keys(u).length > 1) ups.push(u)
      }
      const rep: RelinkReport = { object: spec.object, records: ups.length, updated: 0, alreadyCorrect: 0, partial: 0, failed: 0, fields, failures: [] }
      // Skip records that already point at the right rows (a resume).
      let todo = ups
      if (ups.length > 0 && !dryRun) {
        const cur = new Map(
          (await queryByIds(io.target, spec.object, ups.map((u) => String(u.Id)), ['Id', ...fields].join(', '))).map((r) => [String(r.Id), r])
        )
        todo = ups.filter((u) => {
          const c = cur.get(String(u.Id))
          const same = c != null && Object.entries(u).every(([f, v]) => f === 'Id' || c[f] === v)
          if (same) rep.alreadyCorrect++
          return !same
        })
        rep.records = todo.length
      }
      if (dryRun || todo.length === 0) {
        out.push(rep)
        continue
      }
      const w = await writeRows(io, 'PATCH', spec.object, todo, BATCH_SIZE_DEFAULT)
      const optional = new Set(spec.optionalFields)
      for (let i = 0; i < todo.length; i++) {
        const r = w.results[i]!
        if (r.success) {
          rep.updated++
          continue
        }
        const u = todo[i]!
        const rest = Object.fromEntries(Object.entries(u).filter(([k]) => !optional.has(k)))
        if (Object.keys(rest).length > 1 && Object.keys(rest).length < Object.keys(u).length) {
          const w2 = await writeRows(io, 'PATCH', spec.object, [rest], 1)
          if (w2.results[0]?.success) rep.partial++
        }
        rep.failures.push({ recordId: String(u.Id), message: r.error })
        tally.add('relink', spec.object, String(u.Id), r.error)
      }
      rep.failed = rep.failures.length
      io.log('info', `relink ${spec.object}: ${rep.updated} of ${todo.length} updated${rep.partial ? `; ${rep.partial} more without ${[...optional].join(', ')}` : ''}`)
      out.push(rep)
    }
    return out
  }

  // ───────────────────────────── verify ─────────────────────────────

  private async mismatches(
    object: string,
    plan: FieldPlan,
    sourceRows: ReadonlyArray<Record<string, unknown>>,
    fields: ReadonlyArray<string>
  ): Promise<Array<{ sourceId: string; targetId: string; field: string; expected: unknown; actual: unknown }>> {
    const loaded = this.idMap.loaded(object)
    const pairs = sourceRows
      .map((r) => [String(r.Id), loaded.get(String(r.Id))] as const)
      .filter((p): p is readonly [string, string] => p[1] !== undefined && !p[1].startsWith(DRY_PREFIX))
    if (pairs.length === 0 || fields.length === 0) return []
    const target = new Map(
      (await queryByIds(this.io.target, object, pairs.map((p) => p[1]), ['Id', ...fields].join(', '))).map((r) => [String(r.Id), r])
    )
    const bySource = new Map(sourceRows.map((r) => [String(r.Id), r]))
    const out: Array<{ sourceId: string; targetId: string; field: string; expected: unknown; actual: unknown }> = []
    for (const [sid, tid] of pairs) {
      const t = target.get(tid)
      if (!t) {
        out.push({ sourceId: sid, targetId: tid, field: '(row missing on target)', expected: null, actual: null })
        continue
      }
      const s = bySource.get(sid)!
      for (const f of fields) {
        const sv = s[f]
        const expected = f in plan.refs ? (typeof sv === 'string' ? (this.idMap.get(sv) ?? null) : null) : sv
        if (!sameValue(expected, t[f])) out.push({ sourceId: sid, targetId: tid, field: f, expected, actual: t[f] })
      }
    }
    return out
  }

  async verify(): Promise<VerifyReport> {
    const { io, template, tiers, tally } = this.input
    io.phase('Verify')
    const report: VerifyReport = { counts: [], dangling: [], parity: [] }
    if (template.verify.counts) {
      for (const t of tiers) {
        const st = this.states.get(t.object)
        if (!st || st.report.skippedObject) continue
        const now = await io.target.count(t.object, t.where)
        const loadedTotal = this.idMap.loadedCount(t.object)
        const gap = st.report.source !== loadedTotal
        report.counts.push({ object: t.object, source: st.report.source, loaded: loadedTotal, target: now, gap })
        if (gap && !tally.hasObjectProblem(t.object)) {
          tally.add('verify', t.object, null, `source ${st.report.source}, loaded ${loadedTotal}, target ${now}`)
        }
      }
    }
    if (template.verify.danglingLookups) {
      for (const spec of template.relinkCopiedObjects) {
        const d = await io.target.describe(spec.object)
        if (!d) continue
        for (const f of d.fields) {
          if (f.type !== 'reference' || f.referenceTo.length !== 1 || !this.ctx.seedSet.has(f.referenceTo[0]!) || !f.relationshipName) continue
          try {
            const ids = (await io.target.query(`SELECT Id FROM ${spec.object} WHERE ${f.name} != null AND ${f.relationshipName}.Id = null`)).map((r) => String(r.Id))
            // S61 U-6: a row whose relink failed for a KNOWN reason still points at the source's id.
            // That dangling lookup descends from the expected failure — it is not a second problem.
            const knownRelink = new Map(
              tally.items.filter((q) => q.step === 'relink' && q.expected && q.object === spec.object && q.recordId != null).map((q) => [q.recordId!, q.why])
            )
            const known = ids.filter((id) => knownRelink.has(id))
            const fresh = ids.length - known.length
            report.dangling.push({ object: spec.object, field: f.name, count: ids.length, known: known.length })
            if (fresh > 0) tally.add('verify', spec.object, null, `${f.name}: ${fresh} dangling lookup${fresh === 1 ? '' : 's'}`)
            if (known.length > 0) {
              tally.addKnown(
                'verify',
                spec.object,
                null,
                `${f.name}: ${known.length} dangling lookup${known.length === 1 ? '' : 's'} left by known relink failures`,
                knownRelink.get(known[0]!) ?? 'a known relink failure'
              )
            }
          } catch (e) {
            io.log('warn', `${spec.object}.${f.name}: dangling check skipped (${e instanceof Error ? e.message : String(e)})`)
          }
        }
      }
    }
    if (template.verify.secondPassParity) {
      for (const t of tiers) {
        const st = this.states.get(t.object)
        if (!st?.plan) continue
        const fields = deferredFieldsFor(st.plan, template.deferredFields[t.object] ?? [])
        if (fields.length === 0 || this.idMap.loadedCount(t.object) === 0) continue
        const loaded = this.idMap.loaded(t.object)
        const sourceRows =
          st.sourceRows.length > 0
            ? st.sourceRows
            : await queryByIds(this.source, t.object, [...loaded.keys()], ['Id', ...fields].join(', '))
        const bad = await this.mismatches(t.object, st.plan, sourceRows, fields)
        report.parity.push({ object: t.object, checked: sourceRows.length, mismatches: bad.length, fields, samples: bad.slice(0, 5) })
        for (const m of bad) tally.add('verify', t.object, m.sourceId, `${m.field}: expected ${JSON.stringify(m.expected)}, found ${JSON.stringify(m.actual)}`)
      }
    }
    return report
  }

  // ───────────────────────────── drive ─────────────────────────────

  /** `pre` — a preflight the caller already ran (the runner runs it BEFORE touching target automation, S61 U-11). */
  async run(pre?: SeedPreflight): Promise<SeedRunOutput> {
    const { io, tiers, dryRun } = this.input
    const out: SeedRunOutput = { blockers: [], purge: null, seed: [], secondPass: [], relink: [], verify: null, cancelled: false }
    pre ??= await this.preflight()
    out.blockers = [...pre.blockers]
    if (out.blockers.length > 0 && !dryRun) return out
    if (out.blockers.length > 0) io.log('warn', `dry run is BLOCKED (${out.blockers.length}); showing the plan anyway`)
    try {
      if (Object.keys(pre.existing).length > 0 && this.input.purge && !this.input.resume) {
        out.purge = await this.purge(pre.existing)
        if (!dryRun) {
          const left: string[] = []
          for (const t of tiers) {
            if (!(t.object in pre.existing)) continue
            const n = await io.target.count(t.object, t.where)
            if (n > 0) left.push(`${t.object} (${n})`)
          }
          if (left.length > 0) {
            out.blockers.push(`Rows still present after the purge, so seeding would duplicate them: ${left.join(', ')}`)
            return out
          }
        }
      }
      let n = 0
      for (const t of tiers) {
        if (io.cancelled()) throw new SeedCancelledError()
        io.progress(n++, tiers.length, t.object)
        out.seed.push(await this.seedTier(t))
      }
      io.progress(tiers.length, tiers.length)
      out.secondPass = await this.secondPass()
      out.relink = await this.relink()
      if (!dryRun) out.verify = await this.verify()
    } catch (e) {
      if (e instanceof SeedCancelledError) {
        this.cancelled = true
        out.cancelled = true
        io.log('warn', 'cancelled — the id map is saved per tier; Resume continues from here')
      } else throw e
    }
    return out
  }

  get wasCancelled(): boolean {
    return this.cancelled
  }

  /** Objects this run seeded (for the D3a automation scope). */
  static seededObjects(tiers: ReadonlyArray<SeedTier>): string[] {
    return [...new Set(tiers.map((t) => t.object))]
  }
}
