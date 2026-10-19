/**
 * TemplateStore — the SQLite facade behind the S59 templates feature
 * (migration 011): template runs + their reports, per-run problems, the
 * template automation-change table (NOT the deploy restore ledger — see plan
 * §6), and the reuse of `id_map` for the seed's source→target Id map.
 *
 * Definitions themselves live in the existing `templates` table (Store owns
 * `saveTemplate` / `listTemplates` / `renameTemplate` / `deleteTemplate`);
 * this class adds the whole-list read with last-run info and everything
 * run-shaped. Synchronous better-sqlite3, same as DeployStore.
 */
import type Database from 'better-sqlite3'
import type {
  OrgHint,
  RunnableTemplateKind,
  TemplateDetail,
  TemplateLastRun,
  TemplateProblem,
  TemplateReport,
  TemplateRunMode,
  TemplateRunOptions,
  TemplateRunState,
  TemplateRunSteps,
  TemplateRunSummary,
  TemplateSummary
} from '../../shared/templates/types'
import { seedGroups, templateDetailLine, type SeedTier } from '../../shared/templates/types'
import { resolve as resolvePolicy } from '../engine/objectPolicy'
import type { TemplateKind } from '../../shared/types'
import { RdsHandlerError } from '../errors'

export type ChangeMode = 'persistent' | 'temporary'

export interface AutomationChangeInput {
  itemType: string
  itemName: string
  itemId: string | null
  action: string
  beforeState: Record<string, unknown> | null
}

export interface AutomationChangeRow extends AutomationChangeInput {
  id: number
  runId: number
  targetOrgId: string
  mode: ChangeMode
  appliedAt: number
  restoreConfirmed: boolean
}

export interface IdMapRow {
  objectApiName: string
  sourceId: string
  targetId: string
}

const str = (v: unknown): string | null => (v == null ? null : String(v))
const num = (v: unknown): number | null => (v == null ? null : Number(v))

function builtFromOf(payload: unknown): OrgHint | null {
  const p = (payload ?? {}) as { builtFrom?: unknown }
  const b = p.builtFrom as { orgId?: unknown; label?: unknown } | undefined
  if (b && typeof b.orgId === 'string' && typeof b.label === 'string') return { orgId: b.orgId, label: b.label }
  return null
}

export class TemplateStore {
  constructor(private db: Database.Database) {}

  // ── Definitions (reads beyond Store's kind-scoped list) ─────────────────────

  getTemplate(id: number): TemplateDetail | null {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return { ...this.toSummary(row), payload: JSON.parse(String(row.payload)) as unknown }
  }

  getTemplateByName(kind: TemplateKind, name: string): TemplateDetail | null {
    const row = this.db
      .prepare('SELECT * FROM templates WHERE kind = ? AND name = ?')
      .get(kind, name.trim()) as Record<string, unknown> | undefined
    if (!row) return null
    return { ...this.toSummary(row), payload: JSON.parse(String(row.payload)) as unknown }
  }

  /** Every template of every kind, name order, with its most recent run. */
  listAllTemplates(): TemplateSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE, kind')
      .all() as Record<string, unknown>[]
    return rows.map((r) => this.toSummary(r))
  }

  /**
   * Create-or-update a runnable template. With `id`, the row is updated in
   * place (name changes allowed, uniqueness within the kind enforced); without
   * it, upsert on (kind, name) like the wizard templates.
   */
  saveRunnable(input: {
    id?: number
    kind: RunnableTemplateKind
    name: string
    description: string | null
    payload: unknown
  }): TemplateDetail {
    const name = input.name.trim()
    if (!name) throw new RdsHandlerError('INVALID_STATE', 'Template name cannot be blank')
    const payload = JSON.stringify(input.payload)
    if (input.id != null) {
      const existing = this.db.prepare('SELECT kind FROM templates WHERE id = ?').get(input.id) as
        | { kind: string }
        | undefined
      if (!existing) throw new RdsHandlerError('NOT_FOUND', `Template ${input.id} not found`)
      if (existing.kind !== input.kind) {
        throw new RdsHandlerError('INVALID_STATE', 'A template’s type cannot change after it is saved')
      }
      try {
        this.db
          .prepare(
            `UPDATE templates SET name = ?, description = ?, payload = ?, updated_at = unixepoch('now') * 1000
             WHERE id = ?`
          )
          .run(name, input.description, payload, input.id)
      } catch (e) {
        if (e instanceof Error && /UNIQUE/i.test(e.message)) {
          throw new RdsHandlerError('INVALID_STATE', `A ${input.kind} template named "${name}" already exists`)
        }
        throw e
      }
      const out = this.getTemplate(input.id)
      if (!out) throw new RdsHandlerError('NOT_FOUND', 'saveRunnable failed to persist')
      return out
    }
    this.db
      .prepare(
        `INSERT INTO templates (kind, name, description, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, name) DO UPDATE SET payload = excluded.payload,
           description = excluded.description, updated_at = unixepoch('now') * 1000`
      )
      .run(input.kind, name, input.description, payload)
    const out = this.getTemplateByName(input.kind, name)
    if (!out) throw new RdsHandlerError('NOT_FOUND', 'saveRunnable failed to persist')
    return out
  }

  /** Seed templates (kind 'seed') by name — the post-refresh resolver's lookup. */
  seedTemplatesByName(): Map<string, TemplateDetail> {
    const rows = this.db.prepare(`SELECT * FROM templates WHERE kind = 'seed'`).all() as Record<
      string,
      unknown
    >[]
    const out = new Map<string, TemplateDetail>()
    for (const r of rows) {
      out.set(String(r.name), { ...this.toSummary(r), payload: JSON.parse(String(r.payload)) as unknown })
    }
    return out
  }

  private toSummary(r: Record<string, unknown>): TemplateSummary {
    const kind = String(r.kind) as TemplateKind
    const payload = JSON.parse(String(r.payload)) as unknown
    const id = Number(r.id)
    return {
      id,
      kind,
      name: String(r.name),
      description: str(r.description),
      builtFrom: builtFromOf(payload),
      detail: templateDetailLine(kind, payload),
      seedGroups:
        kind === 'seed' && Array.isArray((payload as { tiers?: unknown })?.tiers)
          ? seedGroups(payload as Parameters<typeof seedGroups>[0])
          : [],
      cpqGatedObjects:
        kind === 'seed' && Array.isArray((payload as { tiers?: unknown })?.tiers)
          ? cpqGatedObjects((payload as { tiers: SeedTier[] }).tiers)
          : [],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastRun: this.lastRunFor(id)
    }
  }

  private lastRunFor(templateId: number): TemplateLastRun | null {
    const row = this.db
      .prepare(
        `SELECT r.id, r.mode, r.state, r.started_at, COALESCE(c.label, r.target_connection_id) AS target_label
         FROM template_runs r LEFT JOIN connections c ON c.id = r.target_connection_id
         WHERE r.template_id = ? ORDER BY r.started_at DESC, r.id DESC LIMIT 1`
      )
      .get(templateId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      runId: Number(row.id),
      mode: String(row.mode) as TemplateRunMode,
      state: String(row.state) as TemplateRunState,
      targetLabel: String(row.target_label),
      startedAt: Number(row.started_at)
    }
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  createRun(input: {
    templateId: number | null
    templateKind: RunnableTemplateKind
    templateName: string
    snapshot: unknown
    mode: TemplateRunMode
    steps: TemplateRunSteps
    options: TemplateRunOptions | null
    sourceConnectionId: string | null
    targetConnectionId: string
    targetOrgId: string
    jobId: string | null
    /** S62: the deployment this run is a stage of (null for a run from the Templates tab). */
    deploymentId?: number | null
  }): TemplateRunSummary {
    const info = this.db
      .prepare(
        `INSERT INTO template_runs
           (template_id, template_kind, template_name, snapshot, mode, steps, options,
            source_connection_id, target_connection_id, target_org_id, job_id, state, started_at, deployment_id)
         VALUES (@templateId, @templateKind, @templateName, @snapshot, @mode, @steps, @options,
                 @sourceConnectionId, @targetConnectionId, @targetOrgId, @jobId, 'running', @now, @deploymentId)`
      )
      .run({
        deploymentId: input.deploymentId ?? null,
        templateId: input.templateId,
        templateKind: input.templateKind,
        templateName: input.templateName,
        snapshot: JSON.stringify(input.snapshot),
        mode: input.mode,
        steps: JSON.stringify(input.steps),
        options: input.options == null ? null : JSON.stringify(input.options),
        sourceConnectionId: input.sourceConnectionId,
        targetConnectionId: input.targetConnectionId,
        targetOrgId: input.targetOrgId,
        jobId: input.jobId,
        now: Date.now()
      })
    const run = this.getRun(Number(info.lastInsertRowid))
    if (!run) throw new RdsHandlerError('NOT_FOUND', 'createRun failed to persist')
    return run
  }

  setRunJob(runId: number, jobId: string): void {
    this.db.prepare('UPDATE template_runs SET job_id = ? WHERE id = ?').run(jobId, runId)
  }

  /** Persist the (partial or final) report without changing the state. */
  saveReport(runId: number, report: TemplateReport): void {
    this.db.prepare('UPDATE template_runs SET report = ? WHERE id = ?').run(JSON.stringify(report), runId)
  }

  finishRun(runId: number, state: Exclude<TemplateRunState, 'running'>, report: TemplateReport): void {
    const info = this.db
      .prepare('UPDATE template_runs SET state = ?, finished_at = ?, report = ? WHERE id = ?')
      .run(state, Date.now(), JSON.stringify(report), runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Template run ${runId} not found`)
  }

  getRun(runId: number): TemplateRunSummary | null {
    const row = this.db
      .prepare(
        `SELECT r.*, sc.label AS source_label, tc.label AS target_label
         FROM template_runs r
         LEFT JOIN connections sc ON sc.id = r.source_connection_id
         LEFT JOIN connections tc ON tc.id = r.target_connection_id
         WHERE r.id = ?`
      )
      .get(runId) as Record<string, unknown> | undefined
    return row ? this.toRunSummary(row) : null
  }

  getRunDetail(
    runId: number
  ): {
    run: TemplateRunSummary
    snapshot: unknown
    steps: TemplateRunSteps
    options: TemplateRunOptions | null
    report: TemplateReport | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT r.*, sc.label AS source_label, tc.label AS target_label
         FROM template_runs r
         LEFT JOIN connections sc ON sc.id = r.source_connection_id
         LEFT JOIN connections tc ON tc.id = r.target_connection_id
         WHERE r.id = ?`
      )
      .get(runId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      run: this.toRunSummary(row),
      snapshot: JSON.parse(String(row.snapshot)) as unknown,
      steps: JSON.parse(String(row.steps)) as TemplateRunSteps,
      options: row.options == null ? null : (JSON.parse(String(row.options)) as TemplateRunOptions),
      report: row.report == null ? null : (JSON.parse(String(row.report)) as TemplateReport)
    }
  }

  listRuns(templateId: number): TemplateRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, sc.label AS source_label, tc.label AS target_label
         FROM template_runs r
         LEFT JOIN connections sc ON sc.id = r.source_connection_id
         LEFT JOIN connections tc ON tc.id = r.target_connection_id
         WHERE r.template_id = ? ORDER BY r.started_at DESC, r.id DESC`
      )
      .all(templateId) as Record<string, unknown>[]
    return rows.map((r) => this.toRunSummary(r))
  }

  /** Runs still marked running (app died mid-run) → failed, with a note in the report. */
  reconcileOnStartup(): number {
    const rows = this.db
      .prepare(`SELECT id, report FROM template_runs WHERE state = 'running'`)
      .all() as Array<{ id: number; report: string | null }>
    const upd = this.db.prepare(
      `UPDATE template_runs SET state = 'failed', finished_at = ?, report = ? WHERE id = ?`
    )
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        let report: Record<string, unknown> = {}
        if (r.report) {
          try {
            report = JSON.parse(r.report) as Record<string, unknown>
          } catch {
            report = {}
          }
        }
        const preflight = (report.preflight as { blockers?: string[]; notes?: string[] } | undefined) ?? {
          blockers: [],
          notes: []
        }
        preflight.notes = [...(preflight.notes ?? []), 'The app closed while this run was in progress.']
        report.preflight = preflight
        report.state = 'failed'
        upd.run(Date.now(), JSON.stringify(report), r.id)
      }
    })
    tx()
    return rows.length
  }

  /** Apply/restore runs recorded as running for a target org (cross-session lock input). */
  runningRunsForTarget(targetOrgId: string): TemplateRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, sc.label AS source_label, tc.label AS target_label
         FROM template_runs r
         LEFT JOIN connections sc ON sc.id = r.source_connection_id
         LEFT JOIN connections tc ON tc.id = r.target_connection_id
         WHERE r.target_org_id = ? AND r.state = 'running' AND r.mode != 'dry-run'
         ORDER BY r.id`
      )
      .all(targetOrgId) as Record<string, unknown>[]
    return rows.map((r) => this.toRunSummary(r))
  }

  /** The newest APPLY run of a template against a target org (resume reads its id map). */
  lastApplyForTarget(templateId: number, targetOrgId: string): TemplateRunSummary | null {
    const row = this.db
      .prepare(
        `SELECT r.*, sc.label AS source_label, tc.label AS target_label
         FROM template_runs r
         LEFT JOIN connections sc ON sc.id = r.source_connection_id
         LEFT JOIN connections tc ON tc.id = r.target_connection_id
         WHERE r.template_id = ? AND r.target_org_id = ? AND r.mode = 'apply'
         ORDER BY r.started_at DESC, r.id DESC LIMIT 1`
      )
      .get(templateId, targetOrgId) as Record<string, unknown> | undefined
    return row ? this.toRunSummary(row) : null
  }

  private toRunSummary(r: Record<string, unknown>): TemplateRunSummary {
    return {
      id: Number(r.id),
      templateId: num(r.template_id),
      templateKind: String(r.template_kind) as RunnableTemplateKind,
      templateName: String(r.template_name),
      mode: String(r.mode) as TemplateRunMode,
      state: String(r.state) as TemplateRunState,
      sourceConnectionId: str(r.source_connection_id),
      sourceLabel: str(r.source_label) ?? str(r.source_connection_id),
      targetConnectionId: String(r.target_connection_id),
      targetLabel: str(r.target_label) ?? String(r.target_connection_id),
      targetOrgId: String(r.target_org_id),
      jobId: str(r.job_id),
      startedAt: Number(r.started_at),
      finishedAt: num(r.finished_at),
      deploymentId: num(r.deployment_id)
    }
  }

  // ── Problems ───────────────────────────────────────────────────────────────

  addProblems(runId: number, problems: ReadonlyArray<TemplateProblem>): void {
    if (problems.length === 0) return
    const ins = this.db.prepare(
      `INSERT INTO template_run_problems (run_id, step, object, record_id, message, expected, why)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const tx = this.db.transaction(() => {
      for (const p of problems) {
        ins.run(runId, p.step, p.object, p.recordId, p.message, p.expected ? 1 : 0, p.why)
      }
    })
    tx()
  }

  problemsForRun(runId: number): TemplateProblem[] {
    const rows = this.db
      .prepare('SELECT * FROM template_run_problems WHERE run_id = ? ORDER BY id')
      .all(runId) as Record<string, unknown>[]
    return rows.map((r) => ({
      step: String(r.step) as TemplateProblem['step'],
      object: str(r.object),
      recordId: str(r.record_id),
      message: String(r.message),
      expected: Number(r.expected) === 1,
      why: str(r.why)
    }))
  }

  // ── Automation changes (own table — plan §6) ───────────────────────────────

  /** Write-ahead: the row exists BEFORE the toggle is attempted. Returns the row id. */
  recordChange(runId: number, targetOrgId: string, mode: ChangeMode, c: AutomationChangeInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO template_automation_changes
           (run_id, target_org_id, mode, item_type, item_name, item_id, action, before_state, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        targetOrgId,
        mode,
        c.itemType,
        c.itemName,
        c.itemId,
        c.action,
        c.beforeState == null ? null : JSON.stringify(c.beforeState),
        Date.now()
      )
    return Number(info.lastInsertRowid)
  }

  confirmRestored(rowIds: ReadonlyArray<number>): void {
    if (rowIds.length === 0) return
    const upd = this.db.prepare('UPDATE template_automation_changes SET restore_confirmed = 1 WHERE id = ?')
    const tx = this.db.transaction(() => {
      for (const id of rowIds) upd.run(id)
    })
    tx()
  }

  /** A write-ahead row whose toggle never happened — remove it so nothing tries to "restore" it. */
  deleteChange(rowId: number): void {
    this.db.prepare('DELETE FROM template_automation_changes WHERE id = ?').run(rowId)
  }

  changesForRun(runId: number): AutomationChangeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM template_automation_changes WHERE run_id = ? ORDER BY id')
      .all(runId) as Record<string, unknown>[]
    return rows.map((r) => this.toChange(r))
  }

  /** TEMPORARY rows on an org not yet confirmed restored — the lock + Restore-now input. */
  unrestoredTemporary(targetOrgId: string): AutomationChangeRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM template_automation_changes
         WHERE target_org_id = ? AND mode = 'temporary' AND restore_confirmed = 0 ORDER BY id`
      )
      .all(targetOrgId) as Record<string, unknown>[]
    return rows.map((r) => this.toChange(r))
  }

  unrestoredTemporaryForRun(runId: number): AutomationChangeRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM template_automation_changes
         WHERE run_id = ? AND mode = 'temporary' AND restore_confirmed = 0 ORDER BY id`
      )
      .all(runId) as Record<string, unknown>[]
    return rows.map((r) => this.toChange(r))
  }

  private toChange(r: Record<string, unknown>): AutomationChangeRow {
    return {
      id: Number(r.id),
      runId: Number(r.run_id),
      targetOrgId: String(r.target_org_id),
      mode: String(r.mode) as ChangeMode,
      itemType: String(r.item_type),
      itemName: String(r.item_name),
      itemId: str(r.item_id),
      action: String(r.action),
      beforeState:
        r.before_state == null ? null : (JSON.parse(String(r.before_state)) as Record<string, unknown>),
      appliedAt: Number(r.applied_at),
      restoreConfirmed: Number(r.restore_confirmed) === 1
    }
  }

  // ── Id map (reused `id_map`, template rows carry template_run_id) ──────────

  /** One transaction per tier: INSERT OR REPLACE every (target org, source id) pair. */
  putIdMap(runId: number, targetOrgId: string, rows: ReadonlyArray<IdMapRow>): void {
    if (rows.length === 0) return
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO id_map (target_org_id, object_api_name, source_id, target_id, deployment_id, template_run_id, mapped_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const r of rows) ins.run(targetOrgId, r.objectApiName, r.sourceId, r.targetId, runId, now)
    })
    tx()
  }

  /** Every template-written mapping on a target org (resume input), oldest first. */
  idMapForTarget(targetOrgId: string): IdMapRow[] {
    const rows = this.db
      .prepare(
        `SELECT object_api_name, source_id, target_id FROM id_map
         WHERE target_org_id = ? AND template_run_id IS NOT NULL ORDER BY mapped_at, rowid`
      )
      .all(targetOrgId) as Record<string, unknown>[]
    return rows.map((r) => ({
      objectApiName: String(r.object_api_name),
      sourceId: String(r.source_id),
      targetId: String(r.target_id)
    }))
  }

  /** Per-object mapping counts on a target (the resume stale guard). */
  idMapCounts(targetOrgId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT object_api_name, COUNT(*) AS n FROM id_map
         WHERE target_org_id = ? AND template_run_id IS NOT NULL GROUP BY object_api_name`
      )
      .all(targetOrgId) as Array<{ object_api_name: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.object_api_name, Number(r.n)]))
  }

  /** Purge: drop the template mappings for the given objects on a target. */
  deleteIdMap(targetOrgId: string, objects: ReadonlyArray<string>): number {
    if (objects.length === 0) return 0
    const del = this.db.prepare(
      `DELETE FROM id_map WHERE target_org_id = ? AND template_run_id IS NOT NULL AND object_api_name = ?`
    )
    let n = 0
    const tx = this.db.transaction(() => {
      for (const o of objects) n += del.run(targetOrgId, o).changes
    })
    tx()
    return n
  }
}

/** Seeded objects whose policy needs the CPQ "Triggers Disabled" bypass — the same test the runner's preflight applies. */
export function cpqGatedObjects(tiers: ReadonlyArray<SeedTier>): string[] {
  const objects = [...new Set(tiers.map((t) => t.object).filter((o): o is string => typeof o === 'string'))]
  return objects.filter((o) => resolvePolicy(o).requiresTriggerBypass === true).sort()
}
