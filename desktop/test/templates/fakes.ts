/**
 * Scripted TemplateIo for the engine suites: an in-memory "source" and
 * "target" with describes, rows, collections writes that assign ids, and a
 * recording of every write so a dry run can be proven to write nothing.
 */
import type {
  GlobalObjectInfo,
  OrgWriter,
  RowResult,
  TemplateDescribe,
  TemplateDescribeField,
  TemplateIo
} from '../../src/main/engine/templates/io'
import type { AutomationToggleIo, ToggleCalloutResult } from '../../src/main/engine/automationToggle'
import type { TriggerToggleIo } from '../../src/main/engine/triggerBodyToggle'
import type { RunLedger } from '../../src/main/engine/templates/runner'
import type { IdMapRow } from '../../src/main/services/templateStore'
import type { TemplateReport } from '../../src/shared/templates/types'

export function fld(name: string, over: Partial<TemplateDescribeField> = {}): TemplateDescribeField {
  return {
    name,
    type: 'string',
    createable: true,
    updateable: true,
    nillable: true,
    defaultedOnCreate: false,
    calculated: false,
    autoNumber: false,
    referenceTo: [],
    relationshipName: null,
    length: null,
    cascadeDelete: false,
    ...over
  }
}

export function ref(name: string, to: string, over: Partial<TemplateDescribeField> = {}): TemplateDescribeField {
  return fld(name, { type: 'reference', referenceTo: [to], relationshipName: name.replace(/__c$/, '__r').replace(/Id$/, ''), ...over })
}

export interface FakeOrgOpts {
  orgId: string
  label?: string
  describes?: Record<string, TemplateDescribeField[]>
  /** object → rows (with Id). `query` filters by a naive `WHERE Id IN (...)` / where-less match. */
  rows?: Record<string, Array<Record<string, unknown>>>
  isSandbox?: boolean
  keyPrefixes?: Record<string, string>
  /** Scripted answers: soql substring → rows (checked before the row store). */
  onQuery?: (soql: string) => Array<Record<string, unknown>> | undefined
  onToolingQuery?: (soql: string) => Array<Record<string, unknown>> | undefined
  /** Scripted per-row write outcomes: (method, object, record, callIndex) → RowResult | undefined (= success). */
  onWrite?: (method: 'POST' | 'PATCH', object: string, record: Record<string, unknown>, call: number) => RowResult | undefined
  onCallout?: (path: string, method: string, body: string | null) => ToggleCalloutResult | undefined
  /** Scripted delete outcomes: id → RowResult | undefined (= success). */
  onDelete?: (id: string) => RowResult | undefined
}

export interface WriteCall {
  method: 'POST' | 'PATCH' | 'DELETE' | 'CREATE'
  object: string
  records: Array<Record<string, unknown>>
}

export class FakeOrg implements OrgWriter {
  readonly orgId: string
  readonly label: string
  readonly writes: WriteCall[] = []
  readonly soqls: string[] = []
  readonly callouts: Array<{ path: string; method: string; body: string | null }> = []
  readonly deployed: Uint8Array[] = []
  private seq = 0
  private calls = 0
  readonly rows: Record<string, Array<Record<string, unknown>>>
  readonly describes: Record<string, TemplateDescribeField[]>

  constructor(readonly opts: FakeOrgOpts) {
    this.orgId = opts.orgId
    this.label = opts.label ?? opts.orgId
    this.rows = structuredClone(opts.rows ?? {})
    this.describes = opts.describes ?? {}
  }

  async describeGlobal(): Promise<GlobalObjectInfo[]> {
    return Object.keys(this.describes).map((name) => ({ name, keyPrefix: this.opts.keyPrefixes?.[name] ?? null, queryable: true }))
  }
  async describe(object: string): Promise<TemplateDescribe | null> {
    const f = this.describes[object]
    return f ? { name: object, fields: f } : null
  }
  async query(soql: string): Promise<Array<Record<string, unknown>>> {
    this.soqls.push(soql)
    const scripted = this.opts.onQuery?.(soql)
    if (scripted) return scripted
    const m = /FROM\s+(\w+)(?:\s+WHERE\s+(.*))?$/is.exec(soql)
    if (!m) return []
    const object = m[1]!
    let rows = this.rows[object] ?? []
    const where = m[2]
    if (where) {
      // A naive WHERE: `<field> IN (...)`, `<field> = '…'`, `<field> != null`, `<field> = null`,
      // AND-joined. Anything else matches nothing — tests pass `onQuery` when a clause matters.
      const clauses = where.split(/\s+AND\s+/i)
      for (const c of clauses) {
        const inList = /^\s*(\w+) IN \(([^)]*)\)\s*$/i.exec(c)
        const eq = /^\s*([\w.]+) = '([^']*)'\s*$/i.exec(c)
        const notNull = /^\s*([\w.]+) != null\s*$/i.exec(c)
        const relNull = /^\s*(\w+)\.Id = null\s*$/i.exec(c)
        const isNull = /^\s*([\w.]+) = null\s*$/i.exec(c)
        if (relNull) {
          // `Rel__r.Id = null` — the dangling-lookup probe: the lookup holds an Id no row in this org has.
          const field = relNull[1]!.endsWith('__r') ? relNull[1]!.replace(/__r$/, '__c') : `${relNull[1]}Id`
          const allIds = new Set(Object.values(this.rows).flat().map((r) => String(r.Id)))
          rows = rows.filter((r) => r[field] != null && !allIds.has(String(r[field])))
        } else if (inList) {
          const ids = new Set(inList[2]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')))
          rows = rows.filter((r) => ids.has(String(r[inList[1]!])))
        } else if (eq) rows = rows.filter((r) => String(r[eq[1]!]) === eq[2])
        else if (notNull) rows = rows.filter((r) => r[notNull[1]!] != null && r[notNull[1]!] !== '')
        else if (isNull) rows = rows.filter((r) => r[isNull[1]!] == null)
        else rows = []
      }
    }
    const sel = /SELECT\s+(.*?)\s+FROM/is.exec(soql)?.[1] ?? 'Id'
    if (sel.trim().toUpperCase() === 'COUNT()') return rows
    const cols = sel.split(',').map((s) => s.trim())
    return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))
  }
  async toolingQuery(soql: string): Promise<Array<Record<string, unknown>>> {
    this.soqls.push(`tooling:${soql}`)
    return this.opts.onToolingQuery?.(soql) ?? []
  }
  async count(object: string, where?: string | null): Promise<number> {
    const w = (where ?? '').trim()
    return (await this.query(`SELECT Id FROM ${object}${w ? ` WHERE ${w}` : ''}`)).length
  }
  async attachmentBody(attachmentId: string): Promise<Uint8Array> {
    return new TextEncoder().encode(`PDF:${attachmentId}`)
  }
  async organization(): Promise<{ id: string; name: string; isSandbox: boolean }> {
    return { id: this.orgId, name: this.label, isSandbox: this.opts.isSandbox ?? true }
  }
  async collections(method: 'POST' | 'PATCH', object: string, records: ReadonlyArray<Record<string, unknown>>): Promise<RowResult[]> {
    this.writes.push({ method, object, records: records.map((r) => ({ ...r })) })
    const call = this.calls++
    return records.map((r) => {
      const scripted = this.opts.onWrite?.(method, object, r, call)
      if (scripted) return scripted
      if (method === 'POST') {
        const id = `${object.slice(0, 3)}${String(++this.seq).padStart(12, '0')}`
        this.rows[object] = [...(this.rows[object] ?? []), { ...r, Id: id }]
        return { success: true, id, error: '', statusCode: null }
      }
      const list = this.rows[object] ?? []
      const idx = list.findIndex((x) => x.Id === r.Id)
      if (idx >= 0) list[idx] = { ...list[idx], ...r }
      return { success: true, id: String(r.Id), error: '', statusCode: null }
    })
  }
  async deleteIds(ids: ReadonlyArray<string>): Promise<RowResult[]> {
    this.writes.push({ method: 'DELETE', object: '', records: ids.map((Id) => ({ Id })) })
    const results = ids.map((id) => this.opts.onDelete?.(id) ?? { success: true, id, error: '', statusCode: null })
    const gone = new Set(ids.filter((_, i) => results[i]!.success))
    // Like the platform: deleting a parent deletes rows whose master-detail (cascadeDelete) field points at it.
    for (;;) {
      let more = false
      for (const [obj, fields] of Object.entries(this.describes)) {
        const md = fields.filter((f) => f.type === 'reference' && f.cascadeDelete)
        for (const r of this.rows[obj] ?? []) {
          if (gone.has(String(r.Id))) continue
          if (md.some((f) => r[f.name] != null && gone.has(String(r[f.name])))) {
            gone.add(String(r.Id))
            more = true
          }
        }
      }
      if (!more) break
    }
    for (const obj of Object.keys(this.rows)) this.rows[obj] = this.rows[obj]!.filter((r) => !gone.has(String(r.Id)))
    return results
  }
  async createRecord(object: string, record: Record<string, unknown>): Promise<string> {
    this.writes.push({ method: 'CREATE', object, records: [{ ...record }] })
    const id = `${object.slice(0, 3)}${String(++this.seq).padStart(12, '0')}`
    this.rows[object] = [...(this.rows[object] ?? []), { ...record, Id: id }]
    return id
  }
  get toggle(): AutomationToggleIo {
    return {
      callout: async (path, method, body) => {
        this.callouts.push({ path, method, body })
        return this.opts.onCallout?.(path, method, body) ?? { success: true, statusCode: 200, body: '{}' }
      }
    }
  }
  get triggerIo(): TriggerToggleIo {
    return { ...this.toggle, sleep: async () => undefined, now: () => new Date(0) }
  }
  async metadataDeploy(zip: Uint8Array): Promise<{ success: boolean; problems: string[] }> {
    this.deployed.push(zip)
    return { success: true, problems: [] }
  }
}

export interface FakeIoOpts {
  source?: FakeOrg | null
  target: FakeOrg
  cancelAfterLogs?: number
}

export function fakeIo(opts: FakeIoOpts): TemplateIo & { logs: string[]; phases: string[]; cancel: () => void } {
  const logs: string[] = []
  const phases: string[] = []
  let cancelled = false
  return {
    source: opts.source ?? null,
    target: opts.target,
    now: () => 1_000_000,
    sleep: async () => undefined,
    log: (level, m) => {
      logs.push(`${level}: ${m}`)
      if (opts.cancelAfterLogs != null && logs.length >= opts.cancelAfterLogs) cancelled = true
    },
    phase: (n) => phases.push(n),
    progress: () => undefined,
    cancelled: () => cancelled,
    logs,
    phases,
    cancel: () => {
      cancelled = true
    }
  }
}

export class FakeLedger implements RunLedger {
  changes: Array<{ id: number; mode: string; itemType: string; itemName: string; action: string; deleted: boolean; confirmed: boolean }> = []
  idMap: IdMapRow[] = []
  reports: TemplateReport[] = []
  private seq = 0
  constructor(resume: IdMapRow[] = []) {
    this.idMap = [...resume]
  }
  recordChange(mode: 'persistent' | 'temporary', c: { itemType: string; itemName: string; action: string }): number {
    const id = ++this.seq
    this.changes.push({ id, mode, itemType: c.itemType, itemName: c.itemName, action: c.action, deleted: false, confirmed: false })
    return id
  }
  deleteChange(rowId: number): void {
    const c = this.changes.find((x) => x.id === rowId)
    if (c) c.deleted = true
  }
  confirmRestored(rowIds: ReadonlyArray<number>): void {
    for (const c of this.changes) if (rowIds.includes(c.id)) c.confirmed = true
  }
  putIdMap(rows: ReadonlyArray<IdMapRow>): void {
    for (const r of rows) {
      const i = this.idMap.findIndex((x) => x.sourceId === r.sourceId)
      if (i >= 0) this.idMap[i] = r
      else this.idMap.push(r)
    }
  }
  idMapForTarget(): IdMapRow[] {
    return [...this.idMap]
  }
  idMapCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.idMap) out[r.objectApiName] = (out[r.objectApiName] ?? 0) + 1
    return out
  }
  deleteIdMap(objects: ReadonlyArray<string>): number {
    const before = this.idMap.length
    this.idMap = this.idMap.filter((r) => !objects.includes(r.objectApiName))
    return before - this.idMap.length
  }
  saveReport(report: TemplateReport): void {
    this.reports.push(structuredClone(report))
  }
  unrestoredTemporaryCount(): number {
    return this.changes.filter((c) => c.mode === 'temporary' && !c.deleted && !c.confirmed).length
  }
}
