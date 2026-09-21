/**
 * Analysis PARITY harness (ROADMAP Epic 3.7 — Phase-1 exit criterion).
 *
 * Proves the desktop analysis engine produces the same plan as the in-org
 * Apex engine on the SAME scope against the SAME data at the SAME time:
 *
 *   1. pick a template deployment in the org (most recent Planned/Completed
 *      V2 deployment, or --template <Id>);
 *   2. CLONE its object scope + user filters into a fresh Data_Deployment__c
 *      via anonymous Apex (never mutates historical records) and run the
 *      CURRENT in-org analysis on the clone (DataDeploymentService.startAnalysis);
 *   3. poll until the clone reaches 'Planned' (or fails);
 *   4. run the desktop engine (analyzeDeployment) on the identical scope;
 *   5. diff per object: presence, sort order, scoped filter, record count,
 *      API strategy, circular flags + deferred fields, and (from the plan
 *      JSON) gating tier + recommended batch size. Exit 1 on any mismatch.
 *
 * Modes:
 *   npm run parity                       — clone latest template + fresh in-org analysis + diff
 *   npm run parity -- --template a1X…    — clone THAT deployment's scope
 *   npm run parity -- --root Account     — keep the user filter ONLY on the named root
 *                                          object; children scope via materialization
 *                                          (exercises P2/P3/junction paths, and dodges
 *                                          template filters with nested semi-joins,
 *                                          which SOQL rejects at COUNT time)
 *   npm run parity -- --stale a1X…       — diff against an EXISTING deployment's stored
 *                                          plan without re-running (fast; counts may have
 *                                          drifted and pre-fix plans may order differently)
 *
 * All org WRITES (clone + startAnalysis) go through `sf apex run` — the
 * desktop connection stays role='source' (read-only) so the D1 guardrail is
 * never weakened, even in a dev-tool script. ldseed is the dev org; creating
 * test deployment records there is normal app testing.
 *
 * Session-29 FLS quirk: Gating_Tier__c / Recommended_Batch_Size__c /
 * Requires_*__c (Session-24 fields) have no FLS for the CLI user, so direct
 * SOQL can't read them — they are compared via the Deployment_Plan__c JSON
 * (written by finalizePlan in system mode) instead.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectCli } from '../src/main/services/salesforce'
import type { GuardedOrg } from '../src/main/services/salesforce'
import { listCliOrgs } from '../src/main/services/sfcli'
import { Store } from '../src/main/services/store'
import { makeAnalysisIo } from '../src/main/services/analysisIo'
import {
  analyzeDeployment,
  type AnalysisResult,
  type PlannedObject
} from '../src/main/engine/analysis'

const execFileAsync = promisify(execFile)

const ALIAS = process.env.RDS_PARITY_ALIAS ?? 'ldseed'
const POLL_INTERVAL_MS = 10_000
const POLL_TIMEOUT_MS = 15 * 60_000

// ─────────────────────────────── org record shapes ───────────────────────────

interface DeploymentRow {
  Id: string
  Name: string
  Status__c: string
  Source_Org__c: string
  Target_Org__c: string
  Deployment_Version__c: string | null
  Deployment_Plan__c: string | null
  Total_Objects__c: number | null
  Total_Records__c: number | null
  Error_Message__c: string | null
}

interface DeploymentObjectRow {
  Id: string
  Object_API_Name__c: string
  Filter_Clause__c: string | null
  Sort_Order__c: number | null
  Scoped_Filter__c: string | null
  Scoped_Record_Count__c: number | null
  API_Strategy__c: string | null
  Is_Junction__c: boolean
  Has_Circular_References__c: boolean
  Deferred_Fields__c: string | null
}

interface PlanEntry {
  objectName: string
  sortOrder: number
  recordCount: number
  apiStrategy: string
  scopedFilter: string | null
  hasCircularRef: boolean | null
  gatingTier: string | null
  recommendedBatchSize: number | null
}

// ────────────────────────────────── helpers ──────────────────────────────────

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null
}

async function runAnonymousApex(apex: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'rds-parity-'))
  const file = join(dir, 'parity.apex')
  writeFileSync(file, apex, 'utf8')
  const { stdout } = await execFileAsync(
    'sf',
    ['apex', 'run', '-o', ALIAS, '--file', file, '--json'],
    { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
  )
  const parsed = JSON.parse(stdout)
  if (parsed.status !== 0 || parsed.result?.success !== true) {
    throw new Error(
      `anonymous Apex failed: ${parsed.result?.exceptionMessage ?? parsed.message ?? 'unknown'} ` +
        `${parsed.result?.compileProblem ?? ''}`
    )
  }
  return (parsed.result?.logs as string) ?? ''
}

async function queryAll<T>(org: GuardedOrg, soql: string): Promise<T[]> {
  const out: T[] = []
  let res = await org.conn.query(soql)
  for (;;) {
    out.push(...(res.records as T[]))
    if (res.done || res.nextRecordsUrl == null) break
    res = await org.conn.queryMore(res.nextRecordsUrl)
  }
  return out
}

const DEP_FIELDS =
  'Id, Name, Status__c, Source_Org__c, Target_Org__c, Deployment_Version__c, ' +
  'Deployment_Plan__c, Total_Objects__c, Total_Records__c, Error_Message__c'

const DOBJ_FIELDS =
  'Id, Object_API_Name__c, Filter_Clause__c, Sort_Order__c, Scoped_Filter__c, ' +
  'Scoped_Record_Count__c, API_Strategy__c, Is_Junction__c, Has_Circular_References__c, ' +
  'Deferred_Fields__c'

async function fetchDeployment(org: GuardedOrg, id: string): Promise<DeploymentRow> {
  const rows = await queryAll<DeploymentRow>(
    org,
    `SELECT ${DEP_FIELDS} FROM Data_Deployment__c WHERE Id = '${id}'`
  )
  if (rows.length === 0) throw new Error(`deployment ${id} not found`)
  return rows[0]!
}

async function fetchObjects(org: GuardedOrg, depId: string): Promise<DeploymentObjectRow[]> {
  return queryAll<DeploymentObjectRow>(
    org,
    `SELECT ${DOBJ_FIELDS} FROM Deployment_Object__c WHERE Data_Deployment__c = '${depId}' ` +
      'ORDER BY Sort_Order__c ASC NULLS LAST, Object_API_Name__c ASC'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Normalize a scoped-filter string for comparison (whitespace + id order inside IN(...)). */
function normalizeFilter(f: string | null | undefined): string {
  if (f == null || f.trim() === '') return ''
  let s = f.trim().replace(/\s+/g, ' ')
  // Sort quoted-id lists inside IN (...) so row-storage order can't flake the diff.
  s = s.replace(/IN \(([^()]+)\)/gi, (m, inner: string) => {
    const parts = inner.split(',').map((p) => p.trim())
    if (parts.every((p) => /^'[^']*'$/.test(p))) {
      return `IN (${[...parts].sort().join(',')})`
    }
    return m
  })
  return s
}

function normalizeDeferred(json: string | null, arr: string[]): { org: string; desktop: string } {
  const orgArr: string[] = json == null || json.trim() === '' ? [] : (JSON.parse(json) as string[])
  return { org: [...orgArr].sort().join(','), desktop: [...arr].sort().join(',') }
}

// ────────────────────────────────── diffing ──────────────────────────────────

interface Diff {
  objectName: string
  field: string
  inOrg: unknown
  desktop: unknown
  note?: string
}

function diffPlans(
  orgRows: DeploymentObjectRow[],
  planEntries: Map<string, PlanEntry>,
  desktop: AnalysisResult,
  countsAdvisoryOnly: boolean
): { diffs: Diff[]; advisories: Diff[] } {
  const diffs: Diff[] = []
  const advisories: Diff[] = []
  const desktopByName = new Map<string, PlannedObject>(
    desktop.objects.map((o) => [o.objectName, o])
  )

  // presence
  for (const row of orgRows) {
    if (!desktopByName.has(row.Object_API_Name__c)) {
      diffs.push({
        objectName: row.Object_API_Name__c,
        field: 'presence',
        inOrg: 'present',
        desktop: 'MISSING'
      })
    }
  }
  for (const o of desktop.objects) {
    if (!orgRows.some((r) => r.Object_API_Name__c === o.objectName)) {
      diffs.push({
        objectName: o.objectName,
        field: 'presence',
        inOrg: 'MISSING',
        desktop: 'present'
      })
    }
  }

  // deploy ORDER (sequence, not absolute Sort_Order__c values — template-applied
  // plans in stale mode carry 0-based/rearranged orders)
  const orgOrder = orgRows.map((r) => r.Object_API_Name__c)
  const desktopOrder = desktop.objects
    .filter((o) => orgOrder.includes(o.objectName))
    .map((o) => o.objectName)
  const orgOrderShared = orgOrder.filter((n) => desktopByName.has(n))
  if (JSON.stringify(orgOrderShared) !== JSON.stringify(desktopOrder)) {
    diffs.push({
      objectName: '(deploy order)',
      field: 'order',
      inOrg: orgOrderShared.join(' → '),
      desktop: desktopOrder.join(' → ')
    })
  }

  for (const row of orgRows) {
    const name = row.Object_API_Name__c
    const d = desktopByName.get(name)
    if (d == null) continue
    const plan = planEntries.get(name)

    const orgFilter = normalizeFilter(row.Scoped_Filter__c)
    const dFilter = normalizeFilter(d.scopedFilterDisplay)
    // finalizePlan summarizes >255-char filters in the plan JSON, but
    // Deployment_Object__c keeps the full text — compare against the row.
    if (orgFilter !== dFilter) {
      diffs.push({
        objectName: name,
        field: 'scopedFilter',
        inOrg: orgFilter || '(none)',
        desktop: dFilter || '(none)'
      })
    }

    const orgCount = row.Scoped_Record_Count__c ?? 0
    if (orgCount !== d.recordCount) {
      const diff: Diff = {
        objectName: name,
        field: 'recordCount',
        inOrg: orgCount,
        desktop: d.recordCount
      }
      if (countsAdvisoryOnly) {
        diff.note = 'stale mode: source data may have changed since the stored plan'
        advisories.push(diff)
      } else {
        diffs.push(diff)
      }
    }

    if ((row.API_Strategy__c ?? '') !== d.apiStrategy) {
      diffs.push({
        objectName: name,
        field: 'apiStrategy',
        inOrg: row.API_Strategy__c,
        desktop: d.apiStrategy
      })
    }

    if (row.Is_Junction__c !== d.isJunction) {
      diffs.push({
        objectName: name,
        field: 'isJunction',
        inOrg: row.Is_Junction__c,
        desktop: d.isJunction
      })
    }

    if (row.Has_Circular_References__c !== d.hasCircularReference) {
      diffs.push({
        objectName: name,
        field: 'hasCircularReference',
        inOrg: row.Has_Circular_References__c,
        desktop: d.hasCircularReference
      })
    }

    const deferred = normalizeDeferred(row.Deferred_Fields__c, d.deferredFields)
    if (deferred.org !== deferred.desktop) {
      diffs.push({
        objectName: name,
        field: 'deferredFields',
        inOrg: deferred.org || '(none)',
        desktop: deferred.desktop || '(none)'
      })
    }

    if (plan != null) {
      if (plan.gatingTier != null && plan.gatingTier !== d.gatingTier) {
        diffs.push({
          objectName: name,
          field: 'gatingTier',
          inOrg: plan.gatingTier,
          desktop: d.gatingTier
        })
      }
      if (
        plan.recommendedBatchSize != null &&
        plan.recommendedBatchSize !== d.recommendedBatchSize
      ) {
        diffs.push({
          objectName: name,
          field: 'recommendedBatchSize',
          inOrg: plan.recommendedBatchSize,
          desktop: d.recommendedBatchSize
        })
      }
    }
  }

  return { diffs, advisories }
}

// ─────────────────────────────────── main ────────────────────────────────────

async function main(): Promise<void> {
  const staleId = argValue('--stale')
  const templateId = argValue('--template')

  console.log(`RDS Desktop analysis-parity harness vs '${ALIAS}'\n`)
  const org = await connectCli(ALIAS, 'source') // read-only on purpose (see header)

  // 1. Resolve the deployment to diff against.
  let dep: DeploymentRow
  if (staleId != null) {
    dep = await fetchDeployment(org, staleId)
    console.log(
      `Stale mode: diffing stored plan of ${dep.Name} (${dep.Id}), status ${dep.Status__c}`
    )
  } else {
    let tmplId = templateId
    if (tmplId == null) {
      const candidates = await queryAll<DeploymentRow>(
        org,
        `SELECT ${DEP_FIELDS} FROM Data_Deployment__c ` +
          `WHERE Status__c IN ('Planned', 'Completed') AND Deployment_Version__c = '2' ` +
          'ORDER BY CreatedDate DESC LIMIT 1'
      )
      if (candidates.length === 0)
        throw new Error('no Planned/Completed V2 deployment to use as template')
      tmplId = candidates[0]!.Id
      console.log(`Template: ${candidates[0]!.Name} (${tmplId})`)
    }

    // 2. Clone scope + run the CURRENT in-org analysis (writes via sf CLI only).
    const rootOnly = argValue('--root')
    if (rootOnly != null && !/^[A-Za-z0-9_]+$/.test(rootOnly)) {
      throw new Error(`--root must be an object API name, got: ${rootOnly}`)
    }
    console.log(
      `Cloning template scope${rootOnly != null ? ` (filters kept only on ${rootOnly})` : ''} + starting in-org analysis…`
    )
    const logs = await runAnonymousApex(`
      Data_Deployment__c t = [SELECT Id, Source_Org__c, Target_Org__c, Deployment_Version__c
                              FROM Data_Deployment__c WHERE Id = '${tmplId}'];
      Data_Deployment__c c = new Data_Deployment__c(
        Source_Org__c = t.Source_Org__c, Target_Org__c = t.Target_Org__c,
        Status__c = 'Draft', Deployment_Version__c = t.Deployment_Version__c);
      insert c;
      String rootOnly = ${rootOnly != null ? `'${rootOnly}'` : 'null'};
      List<Deployment_Object__c> rows = new List<Deployment_Object__c>();
      for (Deployment_Object__c d : [SELECT Object_API_Name__c, Filter_Clause__c
                                     FROM Deployment_Object__c
                                     WHERE Data_Deployment__c = :t.Id AND Is_Junction__c = false]) {
        String fc = d.Filter_Clause__c;
        if (rootOnly != null && d.Object_API_Name__c != rootOnly) fc = null;
        rows.add(new Deployment_Object__c(
          Data_Deployment__c = c.Id,
          Object_API_Name__c = d.Object_API_Name__c,
          Filter_Clause__c = fc,
          Status__c = 'Pending'));
      }
      insert rows;
      DataDeploymentService.startAnalysis(c.Id);
      System.debug('PARITY_CLONE_ID=' + c.Id);
    `)

    const idMatch = /PARITY_CLONE_ID=([a-zA-Z0-9]{15,18})/.exec(logs)
    if (idMatch == null) {
      throw new Error('could not find PARITY_CLONE_ID in the anonymous Apex debug log')
    }
    dep = await fetchDeployment(org, idMatch[1]!)
    console.log(`Clone: ${dep.Name} (${dep.Id}) — waiting for in-org analysis…`)

    // 3. Poll to terminal state (observe only — standing rule).
    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      await sleep(POLL_INTERVAL_MS)
      dep = await fetchDeployment(org, dep.Id)
      process.stdout.write(`  status: ${dep.Status__c}\r`)
      if (dep.Status__c === 'Planned') break
      if (['Failed', 'Stalled', 'Cancelled'].includes(dep.Status__c)) {
        throw new Error(`in-org analysis ended ${dep.Status__c}: ${dep.Error_Message__c ?? ''}`)
      }
      if (Date.now() > deadline) throw new Error('in-org analysis timed out (15 min)')
    }
    console.log(
      `\n  in-org analysis Planned — ${dep.Total_Objects__c} objects, ${dep.Total_Records__c} records`
    )
  }

  // 4. Read the in-org result.
  const orgRows = await fetchObjects(org, dep.Id)
  const planEntries = new Map<string, PlanEntry>()
  if (dep.Deployment_Plan__c != null && dep.Deployment_Plan__c.trim() !== '') {
    for (const e of JSON.parse(dep.Deployment_Plan__c) as PlanEntry[]) {
      planEntries.set(e.objectName, e)
    }
  }

  // 5. Resolve source/target orgs → CLI connections; read live thresholds.
  // The deployment's Org_Connection__c records name the real source/target
  // orgs (e.g. darkbox → sb1); the desktop engine queries them through
  // read-only CLI-auth connections matched by org id (username fallback for
  // freshly-refreshed sandboxes whose stored org id is stale).
  const orgConns = await queryAll<{
    Id: string
    Org_Id__c: string | null
    Username__c: string | null
  }>(
    org,
    `SELECT Id, Org_Id__c, Username__c FROM Org_Connection__c ` +
      `WHERE Id IN ('${dep.Source_Org__c}', '${dep.Target_Org__c}')`
  )
  const bySfid = new Map(orgConns.map((c) => [c.Id, c]))
  const harnessOrg15 = org.orgId.slice(0, 15)
  const cliOrgs = await listCliOrgs()
  const resolveOrg = async (connId: string, label: string): Promise<GuardedOrg> => {
    const rec = bySfid.get(connId)
    if (rec == null) throw new Error(`${label} Org_Connection__c ${connId} not found`)
    const org15 = (rec.Org_Id__c ?? '').slice(0, 15)
    if (org15 !== '' && org15 === harnessOrg15) return org
    const match =
      cliOrgs.find((o) => o.alias !== '' && o.orgId.slice(0, 15) === org15) ??
      cliOrgs.find(
        (o) => o.alias !== '' && rec.Username__c != null && o.username === rec.Username__c
      )
    if (match == null) {
      throw new Error(
        `${label} org of ${dep.Name} is ${rec.Org_Id__c} (${rec.Username__c}) and is not ` +
          'authenticated in the sf CLI. `sf org login web` it first.'
      )
    }
    console.log(`  ${label} org → CLI alias '${match.alias}' (${match.username})`)
    // read-only on purpose: desktop analysis never writes to source OR target
    return connectCli(match.alias, 'source')
  }
  const source = await resolveOrg(dep.Source_Org__c, 'source')
  const target = await resolveOrg(dep.Target_Org__c, 'target')

  const settings = await queryAll<{
    Source_Query_Record_Threshold__c: number | null
    Source_Query_Object_Threshold__c: number | null
  }>(
    org,
    'SELECT Source_Query_Record_Threshold__c, Source_Query_Object_Threshold__c ' +
      "FROM RDS_App_Setting__mdt WHERE DeveloperName = 'Default'"
  )
  const recordThreshold = settings[0]?.Source_Query_Record_Threshold__c ?? undefined
  const objectThreshold = settings[0]?.Source_Query_Object_Threshold__c ?? undefined

  // 6. Run the desktop engine on the identical scope.
  const input = {
    objects: orgRows
      .filter((r) => !r.Is_Junction__c)
      .map((r) => ({ objectName: r.Object_API_Name__c, userFilter: r.Filter_Clause__c })),
    ...(recordThreshold != null ? { recordThreshold } : {}),
    ...(objectThreshold != null ? { objectThreshold } : {})
  }
  console.log(`\nDesktop analysis on ${input.objects.length} user objects…`)
  const dir = mkdtempSync(join(tmpdir(), 'rds-parity-store-'))
  const store = new Store(join(dir, 'parity.db'))
  const io = makeAnalysisIo({
    source,
    target,
    store,
    log: (level, message) => console.log(`  [engine ${level}] ${message}`)
  })
  const started = Date.now()
  const desktop = await analyzeDeployment(input, io)
  console.log(
    `  desktop analysis done in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
      `${desktop.totalObjects} objects, ${desktop.totalRecords} records`
  )

  // 7. Diff.
  const { diffs, advisories } = diffPlans(orgRows, planEntries, desktop, staleId != null)

  console.log('\n── Parity result ──────────────────────────────────────────')
  console.log(` in-org:  ${orgRows.length} objects, ${dep.Total_Records__c ?? '?'} records`)
  console.log(` desktop: ${desktop.totalObjects} objects, ${desktop.totalRecords} records`)
  for (const a of advisories) {
    console.log(
      ` ~ ADVISORY ${a.objectName}.${a.field}: in-org=${a.inOrg} desktop=${a.desktop} (${a.note})`
    )
  }
  if (diffs.length === 0) {
    console.log('\nPARITY PASSED — desktop plan matches the in-org analysis.')
    return
  }
  console.log(`\nPARITY FAILED — ${diffs.length} difference(s):`)
  for (const d of diffs) {
    console.log(`  ✗ ${d.objectName} · ${d.field}`)
    console.log(`      in-org : ${String(d.inOrg)}`)
    console.log(`      desktop: ${String(d.desktop)}`)
  }
  process.exitCode = 1
}

main().catch((e) => {
  console.error(`\nPARITY HARNESS ERROR: ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
})
