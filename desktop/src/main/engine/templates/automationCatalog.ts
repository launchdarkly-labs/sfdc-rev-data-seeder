/**
 * The automation CATALOG the post-refresh builder reads from an org (S59 plan
 * §4.4): every flow definition and every Apex trigger, with state and a
 * managed badge. READ-ONLY (query endpoints only) — runs against a source org
 * as readily as a target; the builder's "Read from" picker decides which.
 *
 * Flows come from FlowDefinitionView (regular SOQL — label, process type,
 * trigger type, object, active version) plus FlowVersionView for the LATEST
 * version number (what Activate would turn on). Triggers come from Tooling
 * ApexTrigger with Body, so the catalog can say whether a body is live, a
 * template stub, or still wrapped by a deploy's bypass marker. The app's own
 * RDS_*_CpqGuard triggers are excluded as in discovery (AMS:235-243).
 *
 * Section failures are soft: one list that cannot be read becomes an entry in
 * `errors` and the other list still renders.
 */
import type { AutomationCatalog, CatalogFlow, CatalogTrigger } from '../../../shared/templates/types'
import { isGuardTriggerName } from '../triggerBodyToggle'
import { bodyState } from './triggerStub'
import type { OrgReader } from './io'

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : null

export const FLOW_DEFINITION_VIEW_SOQL =
  'SELECT DurableId, ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEvent.QualifiedApiName, ' +
  'IsActive, ActiveVersionId, VersionNumber, NamespacePrefix, ManageableState FROM FlowDefinitionView ' +
  'ORDER BY ApiName'

export const FLOW_VERSION_VIEW_SOQL = 'SELECT FlowDefinitionViewId, VersionNumber FROM FlowVersionView'

export const APEX_TRIGGER_SOQL =
  'SELECT Id, Name, TableEnumOrId, Status, NamespacePrefix, Body FROM ApexTrigger ORDER BY TableEnumOrId, Name'

/** A flow's one-line state for the catalog and the report ("active v3" / "inactive (latest v4)"). */
export function flowStateLabel(f: Pick<CatalogFlow, 'isActive' | 'activeVersionNumber' | 'latestVersionNumber'>): string {
  if (f.isActive) return f.activeVersionNumber != null ? `active v${f.activeVersionNumber}` : 'active'
  return f.latestVersionNumber != null ? `inactive (latest v${f.latestVersionNumber})` : 'inactive'
}

export function triggerStateLabel(t: Pick<CatalogTrigger, 'status' | 'bodyState'>): string {
  const body =
    t.bodyState === 'templateStub' ? ', commented out' : t.bodyState === 'deployWrapped' ? ', wrapped by a deploy' : ''
  return `${t.status}${body}`
}

export async function queryFlowCatalog(org: OrgReader): Promise<{ flows: CatalogFlow[]; error: string | null }> {
  let defs: Array<Record<string, unknown>>
  try {
    defs = await org.query(FLOW_DEFINITION_VIEW_SOQL)
  } catch (e) {
    return { flows: [], error: `Flows could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  // Latest version per definition — fail-soft: a missing view leaves latest null
  // and Activate resolves the latest version at apply time instead.
  const latest = new Map<string, number>()
  try {
    for (const v of await org.query(FLOW_VERSION_VIEW_SOQL)) {
      const defId = str(v.FlowDefinitionViewId)
      const n = int(v.VersionNumber)
      if (defId === null || n === null) continue
      const cur = latest.get(defId)
      if (cur === undefined || n > cur) latest.set(defId, n)
    }
  } catch {
    /* latest stays unknown */
  }
  const flows: CatalogFlow[] = []
  for (const d of defs) {
    const apiName = str(d.ApiName)
    if (apiName === null) continue
    const ns = str(d.NamespacePrefix)
    const ent = d.TriggerObjectOrEvent as Record<string, unknown> | null | undefined
    const durable = str(d.DurableId)
    flows.push({
      apiName,
      label: str(d.Label) ?? apiName,
      processType: str(d.ProcessType),
      triggerType: str(d.TriggerType),
      object: str(ent?.QualifiedApiName),
      isActive: d.IsActive === true,
      activeVersionNumber: d.IsActive === true ? int(d.VersionNumber) : null,
      latestVersionNumber: durable ? (latest.get(durable) ?? null) : null,
      managed: ns !== null || d.ManageableState === 'installed',
      namespace: ns
    })
  }
  return { flows, error: null }
}

export async function queryTriggerCatalog(
  org: OrgReader
): Promise<{ triggers: CatalogTrigger[]; error: string | null }> {
  let rows: Array<Record<string, unknown>>
  try {
    rows = await org.toolingQuery(APEX_TRIGGER_SOQL)
  } catch (e) {
    return { triggers: [], error: `Triggers could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  const triggers: CatalogTrigger[] = []
  for (const r of rows) {
    const name = str(r.Name)
    const id = str(r.Id)
    if (name === null || id === null) continue
    if (isGuardTriggerName(name)) continue
    const ns = str(r.NamespacePrefix)
    triggers.push({
      id,
      name,
      object: str(r.TableEnumOrId) ?? '',
      status: str(r.Status) ?? 'Unknown',
      bodyState: bodyState(str(r.Body)),
      managed: ns !== null,
      namespace: ns
    })
  }
  return { triggers, error: null }
}

export async function buildAutomationCatalog(org: OrgReader): Promise<AutomationCatalog> {
  const [f, t] = await Promise.all([queryFlowCatalog(org), queryTriggerCatalog(org)])
  const errors: string[] = []
  if (f.error) errors.push(f.error)
  if (t.error) errors.push(t.error)
  return { orgId: org.orgId, flows: f.flows, triggers: t.triggers, errors }
}
