/**
 * Golden-CAPTURE harness (ROADMAP Epic 4 — E4X.2, deployDesign §3.2).
 *
 * Captures byte-faithful transform golden fixtures from the FROZEN Apex deploy
 * engine so the TS transform port (E4X.3) can be replayed and proven
 * bug-for-bug identical. It drives the engine's OWN `transformRecordV3` against
 * the EXACT `TransformContext` the queueable builds (via the behavior-neutral
 * `GoldenCaptureService` hook) — never a rebuilt context — which is the whole
 * point: a rebuilt context could silently diverge → "false green" goldens (G7).
 *
 * Capture is DRY — it writes NOTHING to the target org:
 *   1. clone a template deployment's scope into a fresh Draft (via `sf apex run`)
 *      and run the CURRENT in-org analysis so the per-object context (scoped
 *      filters, deferred fields, API strategy, mapping repairs) is EXACTLY what
 *      a real deploy would build;
 *   2. arm the clone (an "Info" Deployment_Log__c row) and, one object at a time
 *      (all others marked Completed so the analyzed topology is preserved for the
 *      A12 deferred computation but only the target object runs), call
 *      `enqueueFirstObject`. Each object reaches the capture hook AFTER its
 *      source/target describe + source query READS, serializes {input, context,
 *      outcome} to chunked throwaway Deployment_Log__c rows, and RETURNS before
 *      any upsert callout (no target write, no automation change);
 *   3. read the chunk rows back through the READ-ONLY desktop connection,
 *      reassemble (fail-loud), and land byte-stable fixtures under
 *      desktop/test/golden/<object>/<sourceId>.json;
 *   4. delete the throwaway rows + clone (unless --keep).
 *
 * PREREQUISITE (dev only): RDS_App_Setting__mdt.Default.Golden_Capture_Enabled__c
 * must be TRUE in the org. It is the hard production safety gate for the hook and
 * ships FALSE — flip it on for the capture session (Setup or a metadata deploy),
 * run this, flip it back off. This script aborts if it is not on.
 *
 * All org WRITES (clone, analysis kick, arm, per-object status, cleanup) go
 * through `sf apex run`; the desktop connection stays role='source' (read-only)
 * so the D1 guardrail is never weakened, even in a dev tool (mirrors
 * parity-ldseed.ts).
 *
 * Caveats (documented, not silent): capture is a sampling tool — at most
 * GoldenCaptureService.MAX_RECORDS_PER_OBJECT (300) records per object and only
 * the FIRST source page are captured (bound the scope with --root to stay
 * inside that). Objects with 0 scoped records are skipped.
 *
 * Modes:
 *   npm run golden:capture                      — clone latest V2 template, capture every object
 *   npm run golden:capture -- --template a1X…    — clone THAT deployment's scope
 *   npm run golden:capture -- --root Account     — keep the user filter ONLY on the named root
 *   npm run golden:capture -- --object Contract   — capture just one object
 *   npm run golden:capture -- --out <dir>        — fixture root (default desktop/test/golden)
 *   npm run golden:capture -- --keep             — leave the throwaway clone + rows in the org
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectCli } from '../src/main/services/salesforce'
import type { GuardedOrg } from '../src/main/services/salesforce'
import { reassembleChunks, parseChunkTag, type CaptureRow } from '../src/main/engine/deploy/golden/chunk'
import {
  fixturePath,
  serializeFixture,
  parseFixture,
  type GoldenFixture
} from '../src/main/engine/deploy/golden/fixture'

const execFileAsync = promisify(execFile)

const ALIAS = process.env.RDS_GOLDEN_ALIAS ?? process.env.RDS_PARITY_ALIAS ?? 'ldseed'
// npm scripts run from desktop/; keep fixtures under test/golden/.
const DEFAULT_OUT = resolve(process.cwd(), 'test', 'golden')
const POLL_INTERVAL_MS = 5_000
const ANALYSIS_TIMEOUT_MS = 15 * 60_000
const OBJECT_TIMEOUT_MS = 5 * 60_000

// ─────────────────────────────── helpers ──────────────────────────────────

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
/** SOQL string-literal safety for the values this script injects (Ids, API names, a UUID). */
function sanitizeToken(s: string): string {
  if (!/^[A-Za-z0-9_#.-]+$/.test(s)) throw new Error(`unsafe token for anonymous Apex: ${s}`)
  return s
}

async function runAnonymousApex(apex: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'rds-golden-'))
  const file = join(dir, 'capture.apex')
  writeFileSync(file, apex, 'utf8')
  const { stdout } = await execFileAsync(
    'sf',
    ['apex', 'run', '-o', ALIAS, '--file', file, '--json'],
    { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
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

interface DeploymentRow {
  Id: string
  Name: string
  Status__c: string
  Error_Message__c: string | null
}
interface DObjRow {
  Id: string
  Object_API_Name__c: string
  Sort_Order__c: number | null
  Scoped_Record_Count__c: number | null
  Is_Junction__c: boolean
}

async function fetchDeployment(org: GuardedOrg, id: string): Promise<DeploymentRow> {
  const rows = await queryAll<DeploymentRow>(
    org,
    `SELECT Id, Name, Status__c, Error_Message__c FROM Data_Deployment__c WHERE Id = '${sanitizeToken(id)}'`
  )
  if (rows.length === 0) throw new Error(`deployment ${id} not found`)
  return rows[0]!
}

/** Fetch this deployment's Debug capture rows through the read-only connection. */
async function fetchCaptureRows(org: GuardedOrg, depId: string): Promise<CaptureRow[]> {
  const rows = await queryAll<{ Message__c: string | null; Error_Details__c: string | null }>(
    org,
    `SELECT Message__c, Error_Details__c FROM Deployment_Log__c ` +
      `WHERE Data_Deployment__c = '${sanitizeToken(depId)}' AND Log_Level__c = 'Debug'`
  )
  return rows.map((r) => ({ message: r.Message__c, errorDetails: r.Error_Details__c }))
}

/** Distinct capture keys (per-fixture) matching this run, in first-seen order. */
function captureKeysForRun(rows: CaptureRow[], runId: string): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const row of rows) {
    const tag = parseChunkTag(row.message)
    if (tag == null) continue
    if (!tag.captureId.startsWith(runId + '#')) continue
    if (!seen.has(tag.captureId)) {
      seen.add(tag.captureId)
      keys.push(tag.captureId)
    }
  }
  return keys
}

/** Warning-level per-object cap markers for this clone (RDS_GOLDEN_CAPPED|…). */
async function fetchCapMarkers(org: GuardedOrg, depId: string): Promise<string[]> {
  const rows = await queryAll<{ Message__c: string | null }>(
    org,
    `SELECT Message__c FROM Deployment_Log__c ` +
      `WHERE Data_Deployment__c = '${sanitizeToken(depId)}' AND Log_Level__c = 'Warning'`
  )
  return rows
    .map((r) => r.Message__c)
    .filter((m): m is string => m != null && m.startsWith('RDS_GOLDEN_CAPPED|'))
}

/** Deployment_Object__c Status__c by object API name, for status-aware polling. */
async function fetchObjectStatuses(org: GuardedOrg, depId: string): Promise<Map<string, string>> {
  const rows = await queryAll<{ Object_API_Name__c: string; Status__c: string | null }>(
    org,
    `SELECT Object_API_Name__c, Status__c FROM Deployment_Object__c ` +
      `WHERE Data_Deployment__c = '${sanitizeToken(depId)}'`
  )
  return new Map(rows.map((r) => [r.Object_API_Name__c, r.Status__c ?? '']))
}

// ─────────────────────────────────── main ────────────────────────────────────

async function main(): Promise<void> {
  const outRoot = argValue('--out') ?? DEFAULT_OUT
  const keep = hasFlag('--keep')
  const onlyObject = argValue('--object')
  const rootOnly = argValue('--root')
  const templateId = argValue('--template')
  const runId = `gc-${randomUUID()}`

  if (onlyObject != null) sanitizeToken(onlyObject)
  if (rootOnly != null && !/^[A-Za-z0-9_]+$/.test(rootOnly)) {
    throw new Error(`--root must be an object API name, got: ${rootOnly}`)
  }

  console.log(`RDS Desktop golden-capture vs '${ALIAS}' (run ${runId})\n`)
  const org = await connectCli(ALIAS, 'source') // read-only on purpose (writes go via sf apex run)

  // 0. Prerequisite: the org master switch must be on.
  const settings = await queryAll<{ Golden_Capture_Enabled__c: boolean | null }>(
    org,
    `SELECT Golden_Capture_Enabled__c FROM RDS_App_Setting__mdt WHERE DeveloperName = 'Default'`
  )
  if (settings[0]?.Golden_Capture_Enabled__c !== true) {
    throw new Error(
      'RDS_App_Setting__mdt.Default.Golden_Capture_Enabled__c is not TRUE. Golden capture is a ' +
        'dev-only mode gated behind this switch (production safety). Enable it in Setup (Custom ' +
        'Metadata → RDS App Setting → Default) or via a metadata deploy, run the capture, then ' +
        'disable it again.'
    )
  }

  // 1. Resolve template + clone its scope + run the CURRENT in-org analysis.
  // Everything from here is wrapped so cleanup runs on EVERY exit path (a failed
  // run must never orphan an armed 'Deploying' clone for the watchdog to finalize).
  let cloneId: string | null = null
  try {
  const rootExpr = rootOnly != null ? `'${rootOnly}'` : 'null'
  const tmplExpr = templateId != null ? `'${sanitizeToken(templateId)}'` : 'null'
  console.log('Cloning template scope + starting analysis…')
  const cloneLogs = await runAnonymousApex(`
    String tmplId = ${tmplExpr};
    if (tmplId == null) {
      List<Data_Deployment__c> c = [SELECT Id FROM Data_Deployment__c
        WHERE Status__c IN ('Planned','Completed') AND Deployment_Version__c = '2'
        ORDER BY CreatedDate DESC LIMIT 1];
      if (c.isEmpty()) throw new AuraHandledException('no Planned/Completed V2 template found');
      tmplId = c[0].Id;
    }
    Data_Deployment__c t = [SELECT Source_Org__c, Target_Org__c, Deployment_Version__c
                            FROM Data_Deployment__c WHERE Id = :tmplId];
    if (t.Deployment_Version__c != '2') {
      throw new AuraHandledException('template ' + tmplId + ' is not a V2 deployment (version=' +
        t.Deployment_Version__c + '); golden capture only supports the V2 transform pipeline');
    }
    Data_Deployment__c clone = new Data_Deployment__c(
      Source_Org__c = t.Source_Org__c, Target_Org__c = t.Target_Org__c,
      Status__c = 'Draft', Deployment_Version__c = t.Deployment_Version__c);
    insert clone;
    String rootOnly = ${rootExpr};
    List<Deployment_Object__c> rows = new List<Deployment_Object__c>();
    for (Deployment_Object__c d : [SELECT Object_API_Name__c, Filter_Clause__c
                                   FROM Deployment_Object__c
                                   WHERE Data_Deployment__c = :tmplId AND Is_Junction__c = false]) {
      String fc = d.Filter_Clause__c;
      if (rootOnly != null && d.Object_API_Name__c != rootOnly) fc = null;
      rows.add(new Deployment_Object__c(Data_Deployment__c = clone.Id,
        Object_API_Name__c = d.Object_API_Name__c, Filter_Clause__c = fc, Status__c = 'Pending'));
    }
    insert rows;
    DataDeploymentService.startAnalysis(clone.Id);
    System.debug('GOLDEN_CLONE_ID=' + clone.Id);
  `)
  const idMatch = /GOLDEN_CLONE_ID=([a-zA-Z0-9]{15,18})/.exec(cloneLogs)
  if (idMatch == null) throw new Error('could not find GOLDEN_CLONE_ID in the anonymous Apex log')
  cloneId = idMatch[1]!
  const cid = cloneId
  console.log(`Clone ${cid} — waiting for analysis…`)

  // 2. Poll analysis to Planned.
  const analysisDeadline = Date.now() + ANALYSIS_TIMEOUT_MS
  for (;;) {
    await sleep(POLL_INTERVAL_MS)
    const dep = await fetchDeployment(org, cid)
    process.stdout.write(`  analysis: ${dep.Status__c}\r`)
    if (dep.Status__c === 'Planned') break
    if (['Failed', 'Stalled', 'Cancelled'].includes(dep.Status__c)) {
      throw new Error(`in-org analysis ended ${dep.Status__c}: ${dep.Error_Message__c ?? ''}`)
    }
    if (Date.now() > analysisDeadline) throw new Error('analysis timed out (15 min)')
  }

  // 3. Which objects to capture (non-junction, count > 0, in Sort_Order).
  let objects = await queryAll<DObjRow>(
    org,
    `SELECT Id, Object_API_Name__c, Sort_Order__c, Scoped_Record_Count__c, Is_Junction__c ` +
      `FROM Deployment_Object__c WHERE Data_Deployment__c = '${cid}' ` +
      `ORDER BY Sort_Order__c ASC NULLS LAST, Object_API_Name__c ASC`
  )
  objects = objects.filter((o) => !o.Is_Junction__c && (o.Scoped_Record_Count__c ?? 0) > 0)
  if (onlyObject != null) objects = objects.filter((o) => o.Object_API_Name__c === onlyObject)
  if (objects.length === 0) throw new Error('no record-bearing objects to capture in the analyzed scope')
  console.log(`\n  analysis Planned — capturing ${objects.length} object(s): ` +
    objects.map((o) => o.Object_API_Name__c).join(', '))

  // 4. Arm + baseline all objects Completed (only one goes Pending at a time so
  //    exactly the target object runs; topology stays intact for A12).
  await runAnonymousApex(`
    insert new Deployment_Log__c(Data_Deployment__c = '${cid}', Log_Level__c = 'Info',
      Message__c = 'RDS_GOLDEN_ARM|${runId}', Timestamp__c = System.now());
    Data_Deployment__c d = new Data_Deployment__c(Id = '${cid}', Status__c = 'Deploying',
      Cancel_Requested__c = false, Last_Heartbeat__c = System.now());
    update d;
    List<Deployment_Object__c> all = [SELECT Id FROM Deployment_Object__c
      WHERE Data_Deployment__c = '${cid}'];
    for (Deployment_Object__c o : all) o.Status__c = 'Completed';
    update all;
  `)

  // 5. Per-object dry capture (status-aware poll).
  for (const obj of objects) {
    const name = obj.Object_API_Name__c
    process.stdout.write(`  capturing ${name}…`)
    await runAnonymousApex(`
      Deployment_Object__c o = new Deployment_Object__c(Id = '${obj.Id}', Status__c = 'Pending');
      update o;
      Data_Deployment__c d = new Data_Deployment__c(Id = '${cid}', Status__c = 'Deploying',
        Cancel_Requested__c = false, Last_Heartbeat__c = System.now());
      update d;
      DataDeploymentService.enqueueFirstObject('${cid}');
    `)
    // The armed hook early-returns leaving the object Pending, so this object's
    // chunk rows appearing is the success signal. If instead the object goes
    // Failed/Retrying or the CLONE goes terminal, a capture hop reached the
    // deploy/finalize path — that must not happen with the guards deployed, so
    // treat it as a hard error rather than silently continuing.
    const deadline = Date.now() + OBJECT_TIMEOUT_MS
    let sawRows = false
    let anomaly: string | null = null
    for (;;) {
      await sleep(POLL_INTERVAL_MS)
      const rows = await fetchCaptureRows(org, cid)
      if (captureKeysForRun(rows, runId).some((k) => k.startsWith(`${runId}#${name}#`))) {
        sawRows = true
        break
      }
      const objStatus = (await fetchObjectStatuses(org, cid)).get(name) ?? ''
      if (objStatus === 'Failed' || objStatus === 'Retrying') {
        anomaly = `object went ${objStatus}`
        break
      }
      const dep = await fetchDeployment(org, cid)
      if (['Failed', 'Completed', 'Stalled', 'Cancelled'].includes(dep.Status__c)) {
        anomaly = `clone went ${dep.Status__c}`
        break
      }
      if (Date.now() > deadline) {
        anomaly = 'timeout'
        break
      }
    }
    // Re-mark Completed so the next enqueueFirstObject picks the following object.
    await runAnonymousApex(`
      update new Deployment_Object__c(Id = '${obj.Id}', Status__c = 'Completed');
    `)
    if (sawRows) {
      console.log(' ok')
    } else if (anomaly === 'timeout') {
      console.log(` (no rows after ${Math.round(OBJECT_TIMEOUT_MS / 1000)}s — 0 records at query time or a stuck hop)`)
    } else {
      throw new Error(
        `capture of ${name} aborted: ${anomaly}. A capture hop must never drive the clone to the ` +
          `deploy/finalize path — the target-write guards (GoldenCaptureService.isCaptureRun) are likely ` +
          `not deployed on '${ALIAS}'. Deploy the latest Apex and retry.`
      )
    }
  }

  // 6. Read back, reassemble, write fixtures.
  const rows = await fetchCaptureRows(org, cid)
  const keys = captureKeysForRun(rows, runId)
  console.log(`\nReassembling ${keys.length} fixture(s) → ${outRoot}`)
  let written = 0
  for (const key of keys) {
    const json = reassembleChunks(rows, key)
    const fixture: GoldenFixture = parseFixture(json)
    const rel = fixturePath(fixture.object, fixture.sourceId)
    const dest = join(outRoot, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, serializeFixture(fixture), 'utf8')
    written++
  }
  console.log(`  wrote ${written} fixture file(s).`)

  // Surface per-object capture caps (would otherwise be silent under-capture).
  const caps = await fetchCapMarkers(org, cid)
  for (const c of caps) console.warn(`  ⚠ CAPPED: ${c} — narrow the scope (--root) to capture the rest.`)

  console.log('\nGOLDEN CAPTURE DONE.')
  } finally {
    // Cleanup on EVERY exit path (unless --keep): a leftover armed 'Deploying'
    // clone could otherwise be resumed by the watchdog. (The PostDeploymentQueueable
    // capture-guard already blocks any target write even if that happens; this
    // just keeps the org clean.)
    if (cloneId != null && !keep) {
      try {
        await runAnonymousApex(`
          delete [SELECT Id FROM Deployment_Log__c WHERE Data_Deployment__c = '${cloneId}'];
          delete [SELECT Id FROM Deployment_Object__c WHERE Data_Deployment__c = '${cloneId}'];
          delete [SELECT Id FROM Data_Deployment__c WHERE Id = '${cloneId}'];
        `)
        console.log(`Cleaned up clone ${cloneId}.`)
      } catch (e) {
        console.error(`cleanup FAILED for clone ${cloneId}: ${e instanceof Error ? e.message : e} ` +
          `— delete it manually in '${ALIAS}'.`)
      }
    } else if (cloneId != null) {
      console.log(`\n--keep set: left clone ${cloneId} and its capture rows in ${ALIAS}.`)
    }
  }
}

main().catch((e) => {
  console.error(`\nGOLDEN CAPTURE ERROR: ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
})
