/**
 * The template runner's IO seam (S59 plan §4.4). ENGINE-PURE: every module
 * under engine/templates/ talks to an org only through these interfaces; the
 * live binding is services/templateIo.ts, the tests use scripted fakes.
 *
 * Read side (`OrgReader`) is role-agnostic — the source org and the target
 * both expose it. Write side (`OrgWriter`) exists only for the target and the
 * live adapter gates every call with `GuardedOrg.assertWritable` (rule 4: the
 * app never writes to a source org, and production is pinned read-only).
 */
import type { AutomationToggleIo } from '../automationToggle'
import type { TriggerToggleIo } from '../triggerBodyToggle'

/** The describe projection the seed planner needs (a slice of jsforce's Field). */
export interface TemplateDescribeField {
  name: string
  type: string
  createable: boolean
  updateable: boolean
  nillable: boolean
  defaultedOnCreate: boolean
  calculated: boolean
  autoNumber: boolean
  referenceTo: string[]
  relationshipName: string | null
  length: number | null
  /** Master-detail (or cascade-delete lookup): deleting the parent deletes this row. */
  cascadeDelete: boolean
}

export interface TemplateDescribe {
  name: string
  fields: TemplateDescribeField[]
}

export interface GlobalObjectInfo {
  name: string
  keyPrefix: string | null
  queryable: boolean
}

/** One row of a composite/sobjects response, aligned with the submitted records. */
export interface RowResult {
  success: boolean
  id: string | null
  /** Rendered "CODE: message" joined with "; " — empty on success. */
  error: string
  /** The raw statusCode of the first error (retry classification). */
  statusCode: string | null
}

export interface OrgReader {
  readonly orgId: string
  readonly label: string
  describeGlobal(): Promise<GlobalObjectInfo[]>
  /** Null when the object does not exist or is not visible in this org. */
  describe(object: string): Promise<TemplateDescribe | null>
  /** Every page of a regular SOQL query (attributes stripped). */
  query(soql: string): Promise<Array<Record<string, unknown>>>
  /** Every page of a Tooling SOQL query. */
  toolingQuery(soql: string): Promise<Array<Record<string, unknown>>>
  count(object: string, where?: string | null): Promise<number>
  /** Raw bytes of a classic Attachment's Body (the blob API, not the JSON request helper — R5). */
  attachmentBody(attachmentId: string): Promise<Uint8Array>
  /** `SELECT Id, Name, IsSandbox FROM Organization` — the live sandbox check. */
  organization(): Promise<{ id: string; name: string; isSandbox: boolean }>
}

export interface MetadataDeployResult {
  success: boolean
  /** componentFailures rendered "fullName: problem", or the top-level error. */
  problems: string[]
}

export interface OrgWriter extends OrgReader {
  /**
   * ONE composite/sobjects call (allOrNone=false), results aligned with
   * `records`. A whole-call HTTP failure resolves every row failed with the
   * transport error — never rejects — so the writer's retry ladder can decide.
   * `records` carry no `attributes`; the adapter adds `{ type: object }`.
   */
  collections(
    method: 'POST' | 'PATCH',
    object: string,
    records: ReadonlyArray<Record<string, unknown>>
  ): Promise<RowResult[]>
  /** `DELETE /composite/sobjects?ids=…&allOrNone=false` — ≤200 ids per call. */
  deleteIds(ids: ReadonlyArray<string>): Promise<RowResult[]>
  /** `POST /sobjects/{object}` — one record (Attachment with a base64 body). Returns the new Id. */
  createRecord(object: string, record: Record<string, unknown>): Promise<string>
  /** The E4A.2 callout seam, write-gated — flow + VR toggles. */
  readonly toggle: AutomationToggleIo
  /** The E4A.3 trigger seam (callout + sleep + now), write-gated. */
  readonly triggerIo: TriggerToggleIo
  /** Metadata API deploy of a zip (file-based trigger status) — spike #2 fallback. */
  metadataDeploy(zip: Uint8Array): Promise<MetadataDeployResult>
}

export interface TemplateIo {
  /** Null when no seed step runs. */
  source: OrgReader | null
  target: OrgWriter
  now(): number
  sleep(ms: number): Promise<void>
  log(level: 'info' | 'warn' | 'error', message: string): void
  phase(name: string): void
  progress(value: number, max: number, label?: string): void
  /** Cooperative cancel — checked at tier and batch boundaries. */
  cancelled(): boolean
}

/** Render composite `errors[]` the way the seed report shows them. */
export function renderRowErrors(errors: unknown): { error: string; statusCode: string | null } {
  if (!Array.isArray(errors) || errors.length === 0) return { error: '', statusCode: null }
  const parts: string[] = []
  let statusCode: string | null = null
  for (const e of errors) {
    const m = (e ?? {}) as Record<string, unknown>
    const code = m.statusCode == null ? 'null' : String(m.statusCode)
    const msg = m.message == null ? 'null' : String(m.message)
    const fields = Array.isArray(m.fields) && m.fields.length > 0 ? ` fields=${JSON.stringify(m.fields)}` : ''
    parts.push(`${code}: ${msg}${fields}`)
    if (statusCode === null && m.statusCode != null) statusCode = String(m.statusCode)
  }
  return { error: parts.join('; '), statusCode }
}
