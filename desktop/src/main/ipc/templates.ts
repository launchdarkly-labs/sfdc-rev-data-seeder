/**
 * IPC handlers for the S59 TEMPLATES feature — definitions, import/export,
 * the automation catalog, the seed-order suggestion, the read-only trigger
 * probe (P1 spike), and the run surface (dry run / apply / restore jobs).
 * Kept out of ipc.ts so the deploy wizard's surface stays readable.
 *
 * Every org read here is READ-ONLY and may hit any connection. Writes happen
 * only inside a template APPLY job, against a connection whose STORED role is
 * 'target' and whose live Organization row says IsSandbox — see
 * engine/templates/runner.ts preflight.
 */
import { app, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC } from '../../shared/types'
import type { OrgRole, TriggerProbeResult } from '../../shared/types'
import type {
  RunnableTemplateKind,
  SeedTemplate,
  TemplateDetail,
  TemplateExportFile,
  TemplateRunInput,
  TemplateSummary
} from '../../shared/templates/types'
import { TEMPLATE_SCHEMA_VERSION, isRunnableKind } from '../../shared/templates/types'
import { validateTemplate } from '../../shared/templates/validate'
import { migrateTemplate, TemplateVersionError } from '../../shared/templates/migrate'
import {
  SAMPLE_POST_REFRESH_NAME,
  SAMPLE_POST_REFRESH_TEMPLATE,
  SAMPLE_SEED_NAME,
  SAMPLE_SEED_TEMPLATE
} from '../../shared/templates/samples'
import { wrapHandler } from '../ipcError'
import { RdsHandlerError } from '../errors'
import type { Store } from '../services/store'
import type { JobManager } from '../jobs'
import type { GuardedOrg } from '../services/salesforce'
import { describeObject } from '../services/describe'
import { makeOrgReader } from '../services/templateIo'
import { buildAutomationCatalog } from '../engine/templates/automationCatalog'
import { resolve as resolveDependencies } from '../engine/dependencyResolver'
import { bodyState } from '../engine/templates/triggerStub'
import { startTemplateRun, startTemplateRestore, buildRunStateView } from './templateRuns'

export interface TemplateIpcDeps {
  store: Store
  jobs: JobManager
  connectById(connectionId: string, roleOverride?: OrgRole): Promise<GuardedOrg>
}

/** The payload a template row holds, lifted to the current schema (throws INVALID_STATE on a bad file). */
export function migratedPayload(kind: RunnableTemplateKind, raw: unknown): Record<string, unknown> {
  try {
    return migrateTemplate(kind, raw)
  } catch (e) {
    if (e instanceof TemplateVersionError) throw new RdsHandlerError('INVALID_STATE', e.message)
    throw e
  }
}

function assertValid(kind: RunnableTemplateKind, payload: unknown, context: string): void {
  const r = validateTemplate(kind, payload)
  if (!r.ok) {
    const lines = r.errors.slice(0, 12).map((e) => `${e.path || '(root)'}: ${e.message}`)
    const more = r.errors.length > 12 ? ` …and ${r.errors.length - 12} more` : ''
    throw new RdsHandlerError('INVALID_STATE', `${context} is not valid — ${lines.join('; ')}${more}`, lines.join('\n'))
  }
}

/** A name that is free within `kind`: "Name", "Name (2)", "Name (3)" … */
export function freeName(store: Store, kind: RunnableTemplateKind, wanted: string): string {
  if (!store.templates.getTemplateByName(kind, wanted)) return wanted
  for (let i = 2; ; i++) {
    const candidate = `${wanted} (${i})`
    if (!store.templates.getTemplateByName(kind, candidate)) return candidate
  }
}

/** Build the self-contained export envelope for a template (post-refresh embeds its seeds). */
export function buildExportFile(store: Store, t: TemplateDetail): TemplateExportFile {
  if (!isRunnableKind(t.kind)) throw new RdsHandlerError('INVALID_STATE', 'Only Data seed and Post-refresh templates export to a file')
  const payload = migratedPayload(t.kind, t.payload)
  const file: TemplateExportFile = {
    rdsTemplate: TEMPLATE_SCHEMA_VERSION,
    kind: t.kind,
    name: t.name,
    description: t.description ?? undefined,
    payload: payload as unknown as TemplateExportFile['payload']
  }
  if (t.kind === 'postRefresh') {
    const seeds = store.templates.seedTemplatesByName()
    const names = ((payload.seedTemplates as Array<{ name: string }> | undefined) ?? []).map((s) => s.name)
    const embedded: TemplateExportFile['embeddedSeedTemplates'] = []
    for (const n of names) {
      const s = seeds.get(n)
      if (s) embedded.push({ name: n, payload: migratedPayload('seed', s.payload) as unknown as SeedTemplate })
    }
    file.embeddedSeedTemplates = embedded
  }
  return file
}

/** Parse + validate an import file; returns the templates to save (embedded seeds first). */
export function parseImportFile(text: string): Array<{ kind: RunnableTemplateKind; name: string; description: string | null; payload: unknown }> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RdsHandlerError('INVALID_STATE', 'That file is not JSON')
  }
  const f = raw as Partial<TemplateExportFile> | null
  if (!f || typeof f !== 'object' || f.rdsTemplate == null) {
    throw new RdsHandlerError('INVALID_STATE', 'That file is not an RDS template export (missing "rdsTemplate")')
  }
  if (typeof f.rdsTemplate !== 'number' || f.rdsTemplate > TEMPLATE_SCHEMA_VERSION) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      `This file was written by a newer app (rdsTemplate ${String(f.rdsTemplate)}); this app understands up to ${TEMPLATE_SCHEMA_VERSION}.`
    )
  }
  if (f.kind !== 'seed' && f.kind !== 'postRefresh') throw new RdsHandlerError('INVALID_STATE', `Unknown template kind "${String(f.kind)}"`)
  if (typeof f.name !== 'string' || f.name.trim() === '') throw new RdsHandlerError('INVALID_STATE', 'The template has no name')
  const out: Array<{ kind: RunnableTemplateKind; name: string; description: string | null; payload: unknown }> = []
  for (const e of f.embeddedSeedTemplates ?? []) {
    if (!e || typeof e.name !== 'string') continue
    const p = migratedPayload('seed', e.payload)
    assertValid('seed', p, `Embedded seed template "${e.name}"`)
    out.push({ kind: 'seed', name: e.name, description: null, payload: p })
  }
  const payload = migratedPayload(f.kind, f.payload)
  assertValid(f.kind, payload, `Template "${f.name}"`)
  out.push({ kind: f.kind, name: f.name.trim(), description: typeof f.description === 'string' ? f.description : null, payload })
  return out
}

/** Which field names the dependency order says to defer, per object (the builder's deferred-field hint). */
export function seedOrderFor(
  objects: readonly string[],
  fieldsByObject: ReadonlyMap<string, readonly import('../../shared/types').FieldInfo[]>
): { order: string[]; deferredHints: Record<string, string[]> } {
  const infos = resolveDependencies(new Set(objects), fieldsByObject)
  const order = infos.map((i) => i.objectName)
  const deferredHints: Record<string, string[]> = {}
  for (const i of infos) if (i.deferredFields.length > 0) deferredHints[i.objectName] = [...new Set(i.deferredFields)]
  return { order, deferredHints }
}

export function registerTemplateIpc(deps: TemplateIpcDeps): void {
  const { store, jobs, connectById } = deps

  ipcMain.handle(
    IPC.templateGet,
    wrapHandler((_e, id: number): TemplateDetail => {
      const t = store.templates.getTemplate(id)
      if (!t) throw new RdsHandlerError('NOT_FOUND', `Template ${id} not found`)
      return isRunnableKind(t.kind) ? { ...t, payload: migratedPayload(t.kind, t.payload) } : t
    })
  )

  ipcMain.handle(
    IPC.templateListAll,
    wrapHandler((): TemplateSummary[] => store.templates.listAllTemplates())
  )

  ipcMain.handle(
    IPC.templateSaveRunnable,
    wrapHandler(
      (
        _e,
        input: { id?: number; kind: RunnableTemplateKind; name: string; description?: string | null; payload: unknown }
      ): TemplateDetail => {
        if (!isRunnableKind(input.kind)) throw new RdsHandlerError('INVALID_STATE', 'Only Data seed and Post-refresh templates save here')
        const payload = migratedPayload(input.kind, input.payload)
        assertValid(input.kind, payload, 'The template')
        return store.templates.saveRunnable({
          id: input.id,
          kind: input.kind,
          name: input.name,
          description: input.description?.trim() ? input.description.trim() : null,
          payload
        })
      }
    )
  )

  ipcMain.handle(
    IPC.templateSample,
    wrapHandler((_e, kind: RunnableTemplateKind): TemplateSummary => {
      if (kind === 'seed') {
        return store.templates.saveRunnable({
          kind,
          name: freeName(store, kind, SAMPLE_SEED_NAME),
          description: 'Shipped sample — a CPQ + Advanced Approvals configuration seed with an Acme forms group.',
          payload: SAMPLE_SEED_TEMPLATE
        })
      }
      if (kind === 'postRefresh') {
        return store.templates.saveRunnable({
          kind,
          name: freeName(store, kind, SAMPLE_POST_REFRESH_NAME),
          description: 'Shipped sample — flows and triggers to quiet in a dev sandbox, two setting patches, then the sample seed.',
          payload: SAMPLE_POST_REFRESH_TEMPLATE
        })
      }
      throw new RdsHandlerError('INVALID_STATE', `No sample for kind "${String(kind)}"`)
    })
  )

  ipcMain.handle(
    IPC.templateExport,
    wrapHandler(async (_e, id: number): Promise<string | null> => {
      const t = store.templates.getTemplate(id)
      if (!t) throw new RdsHandlerError('NOT_FOUND', `Template ${id} not found`)
      const file = buildExportFile(store, t)
      const safe = t.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'template'
      const res = await dialog.showSaveDialog({
        title: 'Export template',
        defaultPath: join(app.getPath('documents'), `${t.kind}-${safe}.rds-template.json`),
        filters: [{ name: 'RDS template', extensions: ['json'] }]
      })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, JSON.stringify(file, null, 2) + '\n', 'utf8')
      return res.filePath
    })
  )

  ipcMain.handle(
    IPC.templateImport,
    wrapHandler(async (): Promise<TemplateSummary[] | null> => {
      const res = await dialog.showOpenDialog({
        title: 'Import template',
        properties: ['openFile'],
        filters: [{ name: 'RDS template', extensions: ['json'] }]
      })
      if (res.canceled || res.filePaths.length === 0) return null
      const path = res.filePaths[0]!
      const text = await readFile(path, 'utf8')
      let items
      try {
        items = parseImportFile(text)
      } catch (e) {
        if (e instanceof RdsHandlerError) throw new RdsHandlerError(e.code, `${basename(path)}: ${e.message}`, e.detail)
        throw e
      }
      const saved: TemplateSummary[] = []
      for (const it of items) {
        // Embedded seeds a post-refresh file brings along are created only when
        // MISSING — an existing seed template of that name is the user's own.
        if (it.kind === 'seed' && items.length > 1 && it !== items[items.length - 1]) {
          if (store.templates.getTemplateByName('seed', it.name)) continue
        }
        saved.push(store.templates.saveRunnable({ ...it }))
      }
      return saved
    })
  )

  // READ-ONLY: the builder's automation catalog from any connection (source orgs by default).
  ipcMain.handle(
    IPC.templateAutomationCatalog,
    wrapHandler(async (_e, input: { connectionId: string }) => {
      const org = await connectById(input.connectionId)
      return buildAutomationCatalog(makeOrgReader(org))
    })
  )

  // READ-ONLY: dependency order for a set of objects from the read-from org's describes.
  ipcMain.handle(
    IPC.templateSeedOrder,
    wrapHandler(async (_e, input: { connectionId: string; objects: string[] }) => {
      const objects = Array.from(new Set((input.objects ?? []).filter((o) => typeof o === 'string' && o !== '')))
      if (objects.length === 0) return { order: [], deferredHints: {} }
      const org = await connectById(input.connectionId)
      const fields = new Map<string, import('../../shared/types').FieldInfo[]>()
      for (const o of objects) {
        try {
          fields.set(o, await describeObject(org, store, o))
        } catch {
          fields.set(o, []) // undescribable → no edges; it lands wherever ties put it
        }
      }
      return seedOrderFor(objects, fields)
    })
  )

  // P1 spike, read-only half: what the Tooling API exposes on an ApexTrigger
  // record's Metadata (is `status` there?) plus the live Status and body state.
  ipcMain.handle(
    IPC.templateTriggerProbe,
    wrapHandler(async (_e, input: { connectionId: string; triggerName: string }): Promise<TriggerProbeResult> => {
      const org = await connectById(input.connectionId)
      const name = input.triggerName.trim()
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new RdsHandlerError('INVALID_STATE', `"${name}" is not a trigger name`)
      const rows = (await org.conn.tooling.query(
        `SELECT Id, Name, Status, ApiVersion, Body FROM ApexTrigger WHERE Name = '${name}' LIMIT 1`
      )) as { records?: Array<Record<string, unknown>> }
      const rec = rows.records?.[0]
      if (!rec) {
        return { found: false, triggerId: null, status: null, apiVersion: null, metadataKeys: [], metadataStatus: null, bodyState: null, note: `No trigger named ${name} on ${org.alias}.` }
      }
      const id = String(rec.Id)
      let metadataKeys: string[] = []
      let metadataStatus: string | null = null
      let note: string
      try {
        const full = (await org.conn.request(`/services/data/v66.0/tooling/sobjects/ApexTrigger/${id}`)) as Record<string, unknown>
        const md = full.Metadata as Record<string, unknown> | null | undefined
        if (md && typeof md === 'object') {
          metadataKeys = Object.keys(md).sort()
          metadataStatus = typeof md.status === 'string' ? md.status : null
          note =
            metadataStatus != null
              ? 'Metadata.status is exposed — a MetadataContainer save with status Inactive is the spike to click (Apply on a scratch sandbox).'
              : 'Metadata has no status key — expect the container path to ignore status; the file-based deploy is the fallback.'
        } else {
          note = 'The ApexTrigger record carries no Metadata block on this API version — the file-based deploy is the fallback.'
        }
      } catch (e) {
        note = `Could not read the ApexTrigger record: ${e instanceof Error ? e.message : String(e)}`
      }
      return {
        found: true,
        triggerId: id,
        status: typeof rec.Status === 'string' ? rec.Status : null,
        apiVersion: typeof rec.ApiVersion === 'number' ? rec.ApiVersion : null,
        metadataKeys,
        metadataStatus,
        bodyState: bodyState(typeof rec.Body === 'string' ? rec.Body : null),
        note
      }
    })
  )

  // ── Runs ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC.templateRun,
    wrapHandler((_e, input: TemplateRunInput) => startTemplateRun({ store, jobs, connectById }, input))
  )
  ipcMain.handle(
    IPC.templateRuns,
    wrapHandler((_e, templateId: number) => store.templates.listRuns(templateId))
  )
  ipcMain.handle(
    IPC.templateRunState,
    wrapHandler((_e, runId: number) => buildRunStateView(store, jobs, runId))
  )
  ipcMain.handle(
    IPC.templateRestoreAutomation,
    wrapHandler((_e, runId: number) => startTemplateRestore({ store, jobs, connectById }, runId))
  )
}
