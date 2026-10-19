/**
 * S59 — migration 011 + the TemplateStore facade, on the real better-sqlite3
 * Store (node ABI; `npm run rebuild:node && npm run test:store`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store, MIGRATIONS } from '../../src/main/services/store'
import { SAMPLE_POST_REFRESH_TEMPLATE, SAMPLE_SEED_TEMPLATE } from '../../src/shared/templates/samples'
import type { TemplateReport, TemplateRunSteps } from '../../src/shared/templates/types'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
  store.upsertConnections([
    {
      alias: 'sb',
      username: 'u@sb',
      orgId: '00D000000000SB1AAA',
      instanceUrl: 'https://sb.example',
      connectedStatus: 'Connected',
      isSandbox: true
    },
    {
      alias: 'src',
      username: 'u@src',
      orgId: '00D000000000SRCAAA',
      instanceUrl: 'https://src.example',
      connectedStatus: 'Connected',
      isSandbox: false
    }
  ])
})
afterEach(() => store.close())

const STEPS: TemplateRunSteps = { automation: true, seeds: [], optInPatches: [] }

function report(state: TemplateReport['state']): TemplateReport {
  return {
    schemaVersion: 1,
    mode: 'apply',
    state,
    startedAt: 1,
    finishedAt: 2,
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
    summary: {
      unexpected: 0,
      expected: 0,
      unexpectedGroups: [],
      expectedGroups: [],
      nextAction: 'none',
      batchSizeSuggestions: []
    }
  }
}

describe('TemplateStore — definitions', () => {
  it('saveRunnable upserts on (kind, name), keeps the description, and listAll spans every kind', () => {
    const seed = store.templates.saveRunnable({
      kind: 'seed',
      name: 'Acme CPQ configuration',
      description: 'd1',
      payload: SAMPLE_SEED_TEMPLATE
    })
    expect(seed.id).toBeGreaterThan(0)
    expect(seed.description).toBe('d1')
    expect(seed.detail).toBe('36 objects in 2 groups')
    expect(seed.lastRun).toBeNull()
    const again = store.templates.saveRunnable({
      kind: 'seed',
      name: 'Acme CPQ configuration',
      description: 'd2',
      payload: SAMPLE_SEED_TEMPLATE
    })
    expect(again.id).toBe(seed.id)
    expect(again.description).toBe('d2')
    store.saveTemplate('objects', 'Wizard one', { objects: ['Account'] })
    store.templates.saveRunnable({
      kind: 'postRefresh',
      name: 'Acme dev sandbox',
      description: null,
      payload: SAMPLE_POST_REFRESH_TEMPLATE
    })
    const all = store.templates.listAllTemplates()
    expect(all.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'seed:Acme CPQ configuration',
      'postRefresh:Acme dev sandbox',
      'objects:Wizard one'
    ])
    expect(all[2]!.description).toBeNull()
    expect(all[2]!.detail).toBe('1 object (wizard)')
    // The wizard-era reader sees the new column too.
    expect(store.listTemplates('objects')[0]!.description).toBeNull()
  })

  it('saveRunnable with an id renames in place, refuses a kind change and a taken name', () => {
    const a = store.templates.saveRunnable({ kind: 'seed', name: 'A', description: null, payload: SAMPLE_SEED_TEMPLATE })
    store.templates.saveRunnable({ kind: 'seed', name: 'B', description: null, payload: SAMPLE_SEED_TEMPLATE })
    const renamed = store.templates.saveRunnable({
      id: a.id,
      kind: 'seed',
      name: 'A2',
      description: 'x',
      payload: SAMPLE_SEED_TEMPLATE
    })
    expect(renamed.id).toBe(a.id)
    expect(renamed.name).toBe('A2')
    expect(() =>
      store.templates.saveRunnable({ id: a.id, kind: 'seed', name: 'B', description: null, payload: {} })
    ).toThrow(/already exists/)
    expect(() =>
      store.templates.saveRunnable({ id: a.id, kind: 'postRefresh', name: 'A2', description: null, payload: {} })
    ).toThrow(/type cannot change/)
    expect(() =>
      store.templates.saveRunnable({ id: 999, kind: 'seed', name: 'Z', description: null, payload: {} })
    ).toThrow(/not found/)
    expect(() =>
      store.templates.saveRunnable({ kind: 'seed', name: '  ', description: null, payload: {} })
    ).toThrow(/blank/)
  })

  it('getTemplate / getTemplateByName / seedTemplatesByName', () => {
    const t = store.templates.saveRunnable({ kind: 'seed', name: 'S', description: null, payload: SAMPLE_SEED_TEMPLATE })
    expect(store.templates.getTemplate(t.id)?.payload).toEqual(SAMPLE_SEED_TEMPLATE)
    expect(store.templates.getTemplate(4242)).toBeNull()
    expect(store.templates.getTemplateByName('seed', ' S ')?.id).toBe(t.id)
    expect([...store.templates.seedTemplatesByName().keys()]).toEqual(['S'])
    expect(store.templates.listAllTemplates()[0]!.builtFrom).toBeNull()
    const withHint = store.templates.saveRunnable({
      kind: 'seed',
      name: 'H',
      description: null,
      payload: { ...SAMPLE_SEED_TEMPLATE, builtFrom: { orgId: '00D1', label: 'src' } }
    })
    expect(withHint.builtFrom).toEqual({ orgId: '00D1', label: 'src' })
  })
})

describe('TemplateStore — runs, problems, changes, id map', () => {
  it('createRun → finishRun round-trips the report; the template shows its last run', () => {
    const t = store.templates.saveRunnable({
      kind: 'postRefresh',
      name: 'P',
      description: null,
      payload: SAMPLE_POST_REFRESH_TEMPLATE
    })
    const run = store.templates.createRun({
      templateId: t.id,
      templateKind: 'postRefresh',
      templateName: 'P',
      snapshot: { x: 1 },
      mode: 'apply',
      steps: STEPS,
      options: { disableTargetAutomation: true, cpqAttestation: false, purge: false, resume: false },
      sourceConnectionId: 'src',
      targetConnectionId: 'sb',
      targetOrgId: '00D000000000SB1AAA',
      jobId: null
    })
    expect(run.state).toBe('running')
    expect(run.targetLabel).toBe('sb')
    expect(run.sourceLabel).toBe('src')
    store.templates.setRunJob(run.id, 'job-9')
    store.templates.finishRun(run.id, 'clean', report('clean'))
    const detail = store.templates.getRunDetail(run.id)!
    expect(detail.run.state).toBe('clean')
    expect(detail.run.jobId).toBe('job-9')
    expect(detail.run.finishedAt).not.toBeNull()
    expect(detail.snapshot).toEqual({ x: 1 })
    expect(detail.steps).toEqual(STEPS)
    expect(detail.report?.state).toBe('clean')
    expect(store.templates.listRuns(t.id).map((r) => r.id)).toEqual([run.id])
    const last = store.templates.listAllTemplates()[0]!.lastRun
    expect(last).toEqual({ runId: run.id, mode: 'apply', state: 'clean', targetLabel: 'sb', startedAt: run.startedAt })
    expect(() => store.templates.finishRun(777, 'failed', report('failed'))).toThrow(/not found/)
  })

  it('deleting a template keeps its runs (template_id → NULL)', () => {
    const t = store.templates.saveRunnable({ kind: 'seed', name: 'S', description: null, payload: SAMPLE_SEED_TEMPLATE })
    const run = store.templates.createRun({
      templateId: t.id,
      templateKind: 'seed',
      templateName: 'S',
      snapshot: {},
      mode: 'dry-run',
      steps: STEPS,
      options: null,
      sourceConnectionId: null,
      targetConnectionId: 'sb',
      targetOrgId: '00D000000000SB1AAA',
      jobId: null
    })
    store.deleteTemplate(t.id)
    expect(store.templates.getRun(run.id)?.templateId).toBeNull()
    expect(store.templates.getRun(run.id)?.templateName).toBe('S')
  })

  it('problems persist with their expected flag', () => {
    const run = mkRun(store, 'apply')
    store.templates.addProblems(run.id, [
      { step: 'seed', object: 'A__c', recordId: 'a01', message: 'boom', expected: false, why: null },
      { step: 'seed', object: 'A__c', recordId: 'a02', message: 'known', expected: true, why: 'because' }
    ])
    const p = store.templates.problemsForRun(run.id)
    expect(p).toHaveLength(2)
    expect(p[1]).toEqual({ step: 'seed', object: 'A__c', recordId: 'a02', message: 'known', expected: true, why: 'because' })
  })

  it('automation changes: write-ahead rows, temporary gating, confirm, delete', () => {
    const run = mkRun(store, 'apply')
    const persistent = store.templates.recordChange(run.id, '00D000000000SB1AAA', 'persistent', {
      itemType: 'Flow',
      itemName: 'F',
      itemId: '300x',
      action: 'deactivate',
      beforeState: { activeVersion: 3 }
    })
    const temp1 = store.templates.recordChange(run.id, '00D000000000SB1AAA', 'temporary', {
      itemType: 'ApexTrigger',
      itemName: 'T',
      itemId: '01qx',
      action: 'disable',
      beforeState: { status: 'Active', bodyState: 'live' }
    })
    const temp2 = store.templates.recordChange(run.id, '00D000000000SB1AAA', 'temporary', {
      itemType: 'ValidationRule',
      itemName: 'V',
      itemId: '03dx',
      action: 'disable',
      beforeState: null
    })
    expect(store.templates.changesForRun(run.id).map((c) => c.id)).toEqual([persistent, temp1, temp2])
    // Persistent rows never count as "unrestored".
    expect(store.templates.unrestoredTemporary('00D000000000SB1AAA').map((c) => c.itemName)).toEqual(['T', 'V'])
    store.templates.confirmRestored([temp1])
    expect(store.templates.unrestoredTemporary('00D000000000SB1AAA').map((c) => c.itemName)).toEqual(['V'])
    expect(store.templates.unrestoredTemporaryForRun(run.id)).toHaveLength(1)
    store.templates.deleteChange(temp2)
    expect(store.templates.unrestoredTemporary('00D000000000SB1AAA')).toEqual([])
    expect(store.templates.unrestoredTemporary('00DOTHER')).toEqual([])
    const row = store.templates.changesForRun(run.id)[0]!
    expect(row.beforeState).toEqual({ activeVersion: 3 })
    expect(row.restoreConfirmed).toBe(false)
  })

  it('id map: template rows ride beside deploy rows; counts, resume read, purge delete', () => {
    const run = mkRun(store, 'apply')
    // A deploy-era row on the same target (deployment_id set, template_run_id NULL).
    const raw = (store as unknown as { db: Database.Database }).db
    raw
      .prepare(
        `INSERT INTO id_map (target_org_id, object_api_name, source_id, target_id, deployment_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run('00D000000000SB1AAA', 'Account', '001src', '001tgt', 1)
    store.templates.putIdMap(run.id, '00D000000000SB1AAA', [
      { objectApiName: 'A__c', sourceId: 'a1', targetId: 'b1' },
      { objectApiName: 'A__c', sourceId: 'a2', targetId: 'b2' },
      { objectApiName: 'C__c', sourceId: 'c1', targetId: 'd1' }
    ])
    // Re-putting a source id replaces the target id (INSERT OR REPLACE on the PK).
    store.templates.putIdMap(run.id, '00D000000000SB1AAA', [{ objectApiName: 'A__c', sourceId: 'a2', targetId: 'b2x' }])
    const map = store.templates.idMapForTarget('00D000000000SB1AAA')
    expect(map.find((r) => r.sourceId === 'a2')?.targetId).toBe('b2x')
    expect(map.map((r) => r.sourceId).sort()).toEqual(['a1', 'a2', 'c1']) // deploy row excluded
    expect(store.templates.idMapCounts('00D000000000SB1AAA')).toEqual({ A__c: 2, C__c: 1 })
    expect(store.templates.deleteIdMap('00D000000000SB1AAA', ['A__c'])).toBe(2)
    expect(store.templates.idMapCounts('00D000000000SB1AAA')).toEqual({ C__c: 1 })
    // The deploy row survived.
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM id_map WHERE deployment_id = 1`).get()).toEqual({ n: 1 })
  })

  it('reconcileOnStartup closes running runs as failed with a note', () => {
    const run = mkRun(store, 'apply')
    store.templates.saveReport(run.id, report('running'))
    const dry = mkRun(store, 'dry-run')
    expect(store.templates.runningRunsForTarget('00D000000000SB1AAA').map((r) => r.id)).toEqual([run.id])
    expect(store.templates.reconcileOnStartup()).toBe(2)
    const d = store.templates.getRunDetail(run.id)!
    expect(d.run.state).toBe('failed')
    expect(d.report?.preflight.notes).toEqual(['The app closed while this run was in progress.'])
    expect(store.templates.getRun(dry.id)?.state).toBe('failed')
    expect(store.templates.runningRunsForTarget('00D000000000SB1AAA')).toEqual([])
    // Store.reconcileOnStartup runs it too.
    mkRun(store, 'apply')
    store.reconcileOnStartup()
    expect(store.templates.runningRunsForTarget('00D000000000SB1AAA')).toEqual([])
  })

  it('lastApplyForTarget returns the newest apply, ignoring dry runs and other targets', () => {
    const t = store.templates.saveRunnable({ kind: 'seed', name: 'S', description: null, payload: SAMPLE_SEED_TEMPLATE })
    const a1 = mkRun(store, 'apply', t.id)
    mkRun(store, 'dry-run', t.id)
    const a2 = mkRun(store, 'apply', t.id)
    expect(store.templates.lastApplyForTarget(t.id, '00D000000000SB1AAA')?.id).toBe(a2.id)
    expect(a1.id).toBeLessThan(a2.id)
    expect(store.templates.lastApplyForTarget(t.id, '00DOTHER')).toBeNull()
  })

  it('migration 011 applies cleanly on top of 010', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rds-tmpl011-'))
    const dbPath = join(dir, 'db.sqlite')
    try {
      const raw = new Database(dbPath)
      raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )`)
      for (const m of MIGRATIONS) {
        if (m.id === '011-templates') break
        raw.exec(m.sql)
        raw.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id)
      }
      // A pre-011 wizard template must survive with description NULL.
      raw.prepare(`INSERT INTO templates (kind, name, payload) VALUES ('mappings', 'old', '{}')`).run()
      raw.close()
      const upgraded = new Store(dbPath)
      expect(upgraded.listTemplates('mappings')[0]!.description).toBeNull()
      expect(upgraded.templates.listAllTemplates()).toHaveLength(1)
      upgraded.close()
      const check = new Database(dbPath)
      expect(check.pragma('foreign_key_check') as unknown[]).toEqual([])
      const cols = (check.prepare('PRAGMA table_info(id_map)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('template_run_id')
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function mkRun(s: Store, mode: 'apply' | 'dry-run', templateId: number | null = null) {
  return s.templates.createRun({
    templateId,
    templateKind: 'seed',
    templateName: 'S',
    snapshot: {},
    mode,
    steps: STEPS,
    options: null,
    sourceConnectionId: 'src',
    targetConnectionId: 'sb',
    targetOrgId: '00D000000000SB1AAA',
    jobId: null
  })
}

describe('S62 — a template run started as a deployment stage carries deployment_id', () => {
  it('round-trips the link; runs from the Templates tab have none', () => {
    const t = store.templates.saveRunnable({ kind: 'postRefresh', name: 'P2', description: null, payload: SAMPLE_POST_REFRESH_TEMPLATE })
    const deploymentId = store.createDeployment({ name: 'Acme', sourceConnectionId: 'src', targetConnectionId: 'sb' })
    const base = {
      templateId: t.id,
      templateKind: 'postRefresh' as const,
      templateName: 'P2',
      snapshot: { x: 1 },
      mode: 'apply' as const,
      steps: STEPS,
      options: { disableTargetAutomation: true, cpqAttestation: false, purge: false, resume: false },
      sourceConnectionId: 'src',
      targetConnectionId: 'sb',
      targetOrgId: '00D000000000SB1AAA',
      jobId: null
    }
    const staged = store.templates.createRun({ ...base, deploymentId })
    const plain = store.templates.createRun(base)
    expect(store.templates.getRun(staged.id)!.deploymentId).toBe(deploymentId)
    expect(store.templates.getRun(plain.id)!.deploymentId).toBeNull()
    expect(store.templates.listRuns(t.id).map((r) => r.deploymentId).sort()).toEqual([deploymentId, null].sort())
  })
})
