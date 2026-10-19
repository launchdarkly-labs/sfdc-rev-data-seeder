import { useMemo, useState } from 'react'
import type {
  AutomationCatalog,
  CatalogFlow,
  CatalogTrigger,
  FlowAction,
  PostRefreshTemplate,
  SettingPatch,
  TriggerAction
} from '../../../../shared/templates/types'
import type { TriggerProbeResult } from '../../../../shared/types'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { Badge } from '../../ui/Badge'
import { SearchInput } from '../../ui/SearchInput'

interface Props {
  value: PostRefreshTemplate
  onChange: (next: PostRefreshTemplate) => void
  connectionId: string
}

const FLOW_ACTION_LABELS: Record<FlowAction, string> = { deactivate: 'Deactivate', activate: 'Activate' }
const TRIGGER_ACTION_LABELS: Record<TriggerAction, string> = {
  deactivate: 'Deactivate',
  commentOut: 'Comment out',
  activate: 'Activate',
  uncomment: 'Restore body'
}

/**
 * The Post-refresh builder (S59 plan §2.2): the read-from org's automation
 * catalog (flows + triggers with search and filters, an Action per row,
 * managed rows not actionable, chosen rows floated to the top), the optional
 * setting patches, and the seed templates to run afterwards.
 */
export function PostRefreshBuilder({ value, onChange, connectionId }: Props): React.JSX.Element {
  const catalogQ = useIpcQuery<AutomationCatalog | null>(
    () => (connectionId ? window.rds.templateAutomationCatalog({ connectionId }) : Promise.resolve(null)),
    [connectionId]
  )
  const seedsQ = useIpcQuery(() => window.rds.templateListAll(), [])
  const seedTemplates = useMemo(() => (seedsQ.data ?? []).filter((t) => t.kind === 'seed'), [seedsQ.data])

  const [search, setSearch] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [flowFilter, setFlowFilter] = useState<'all' | 'triggered' | 'active'>('all')
  const [objectFilter, setObjectFilter] = useState('')

  const flowAction = new Map(value.automation.flows.map((f) => [f.apiName, f.action]))
  const triggerAction = new Map(value.automation.triggers.map((t) => [t.name, t.action]))

  const setFlow = (apiName: string, action: FlowAction | ''): void => {
    const flows = value.automation.flows.filter((f) => f.apiName !== apiName)
    if (action) flows.push({ apiName, action })
    onChange({ ...value, automation: { ...value.automation, flows } })
  }
  const setTrigger = (name: string, action: TriggerAction | ''): void => {
    const triggers = value.automation.triggers.filter((t) => t.name !== name)
    if (action) triggers.push({ name, action })
    onChange({ ...value, automation: { ...value.automation, triggers } })
  }

  const q = search.trim().toLowerCase()
  const matches = (...parts: Array<string | null>): boolean => q === '' || parts.some((p) => p != null && p.toLowerCase().includes(q))

  // Items the template names that the catalog does not have (built elsewhere / not in this org).
  const catalogFlowNames = new Set((catalogQ.data?.flows ?? []).map((f) => f.apiName))
  const catalogTriggerNames = new Set((catalogQ.data?.triggers ?? []).map((t) => t.name))
  const orphanFlows = value.automation.flows.filter((f) => !catalogFlowNames.has(f.apiName))
  const orphanTriggers = value.automation.triggers.filter((t) => !catalogTriggerNames.has(t.name))

  const flows: CatalogFlow[] = useMemo(() => {
    let list = catalogQ.data?.flows ?? []
    if (flowFilter === 'triggered') list = list.filter((f) => f.triggerType != null)
    if (flowFilter === 'active') list = list.filter((f) => f.isActive)
    if (objectFilter) list = list.filter((f) => f.object === objectFilter)
    list = list.filter((f) => matches(f.apiName, f.label, f.object))
    if (selectedOnly) list = list.filter((f) => flowAction.has(f.apiName))
    return [...list].sort((a, b) => Number(flowAction.has(b.apiName)) - Number(flowAction.has(a.apiName)) || a.apiName.localeCompare(b.apiName))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogQ.data, flowFilter, objectFilter, q, selectedOnly, value.automation.flows])

  const triggers: CatalogTrigger[] = useMemo(() => {
    let list = catalogQ.data?.triggers ?? []
    if (objectFilter) list = list.filter((t) => t.object === objectFilter)
    list = list.filter((t) => matches(t.name, t.object))
    if (selectedOnly) list = list.filter((t) => triggerAction.has(t.name))
    return [...list].sort((a, b) => Number(triggerAction.has(b.name)) - Number(triggerAction.has(a.name)) || a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogQ.data, objectFilter, q, selectedOnly, value.automation.triggers])

  const objects = useMemo(() => {
    const s = new Set<string>()
    for (const f of catalogQ.data?.flows ?? []) if (f.object) s.add(f.object)
    for (const t of catalogQ.data?.triggers ?? []) if (t.object) s.add(t.object)
    return [...s].sort()
  }, [catalogQ.data])

  const selectedCount = value.automation.flows.length + value.automation.triggers.length

  return (
    <section className="post-refresh-builder">
      <h2>Automation</h2>
      <p className="muted">
        Desired state: an item already in the wanted state is left alone, never reversed. Managed-package items are shown
        but cannot be changed here. Deactivate is the default for unmanaged triggers; Comment out is the alternative and the
        fallback when a sandbox refuses the status change.
      </p>
      {!connectionId && <p className="muted">Pick a read-from org to list its flows and triggers.</p>}
      {catalogQ.loading && <p className="muted">Reading the org’s flows and triggers…</p>}
      {catalogQ.error && <div className="banner">{catalogQ.error.message}</div>}
      {catalogQ.data?.errors.map((e) => (
        <div key={e} className="banner warn">
          {e}
        </div>
      ))}

      {(orphanFlows.length > 0 || orphanTriggers.length > 0) && catalogQ.data && (
        <div className="banner warn">
          Named in this template but not in the read-from org:{' '}
          {[...orphanFlows.map((f) => `flow ${f.apiName}`), ...orphanTriggers.map((t) => `trigger ${t.name}`)].join(', ')}.
          They stay in the template (the target may have them) and report “not found” when it does not.
          {orphanFlows.map((f) => (
            <button key={f.apiName} className="btn btn-small" onClick={() => setFlow(f.apiName, '')}>
              Remove {f.apiName}
            </button>
          ))}
          {orphanTriggers.map((t) => (
            <button key={t.name} className="btn btn-small" onClick={() => setTrigger(t.name, '')}>
              Remove {t.name}
            </button>
          ))}
        </div>
      )}

      {catalogQ.data && (
        <>
          <div className="toolbar catalog-toolbar">
            <SearchInput value={search} onChange={setSearch} placeholder="Search flows and triggers…" />
            <select className="map-strategy" aria-label="Flow filter" value={flowFilter} onChange={(e) => setFlowFilter(e.target.value as typeof flowFilter)}>
              <option value="all">All flows</option>
              <option value="triggered">Record-triggered only</option>
              <option value="active">Active only</option>
            </select>
            <select className="map-strategy" aria-label="Object filter" value={objectFilter} onChange={(e) => setObjectFilter(e.target.value)}>
              <option value="">Any object</option>
              {objects.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <button className={`btn ${selectedOnly ? 'primary' : ''}`} aria-pressed={selectedOnly} onClick={() => setSelectedOnly((s) => !s)}>
              Selected ({selectedCount})
            </button>
          </div>

          <h3>Flows ({flows.length})</h3>
          <div className="automation-table-wrap catalog-table-wrap">
            <table className="automation-table" aria-label="Flows">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>API name</th>
                  <th>Label</th>
                  <th>Type</th>
                  <th>Object</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => (
                  <tr key={f.apiName} className={flowAction.has(f.apiName) ? 'chosen' : ''}>
                    <td>
                      {f.managed ? (
                        <span className="muted" title="managed package — cannot be changed here">
                          managed
                        </span>
                      ) : (
                        <select
                          className="map-strategy"
                          aria-label={`Action for flow ${f.apiName}`}
                          value={flowAction.get(f.apiName) ?? ''}
                          onChange={(e) => setFlow(f.apiName, e.target.value as FlowAction | '')}
                        >
                          <option value="">none</option>
                          {(Object.keys(FLOW_ACTION_LABELS) as FlowAction[]).map((a) => (
                            <option key={a} value={a}>
                              {FLOW_ACTION_LABELS[a]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>{f.apiName}</td>
                    <td className="muted">{f.label}</td>
                    <td className="muted">{f.triggerType ?? f.processType ?? '—'}</td>
                    <td className="muted">{f.object ?? '—'}</td>
                    <td>
                      {f.isActive ? <Badge tone="success">active v{f.activeVersionNumber ?? '?'}</Badge> : <Badge tone="neutral">inactive</Badge>}
                      {f.latestVersionNumber != null && (!f.isActive || f.latestVersionNumber !== f.activeVersionNumber) && (
                        <span className="muted"> latest v{f.latestVersionNumber}</span>
                      )}
                      {f.managed && <Badge tone="neutral">Managed</Badge>}
                    </td>
                  </tr>
                ))}
                {flows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No flows match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h3>Triggers ({triggers.length})</h3>
          <div className="automation-table-wrap catalog-table-wrap">
            <table className="automation-table" aria-label="Triggers">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Name</th>
                  <th>Object</th>
                  <th>Status</th>
                  <th>Body</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((t) => (
                  <tr key={t.name} className={triggerAction.has(t.name) ? 'chosen' : ''}>
                    <td>
                      {t.managed ? (
                        <span className="muted" title="managed package — cannot be changed here">
                          managed
                        </span>
                      ) : (
                        <select
                          className="map-strategy"
                          aria-label={`Action for trigger ${t.name}`}
                          value={triggerAction.get(t.name) ?? ''}
                          onChange={(e) => setTrigger(t.name, e.target.value as TriggerAction | '')}
                        >
                          <option value="">none</option>
                          {(Object.keys(TRIGGER_ACTION_LABELS) as TriggerAction[]).map((a) => (
                            <option key={a} value={a}>
                              {TRIGGER_ACTION_LABELS[a]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>{t.name}</td>
                    <td className="muted">{t.object}</td>
                    <td>
                      <Badge tone={t.status === 'Active' ? 'success' : 'neutral'}>{t.status}</Badge>
                      {t.managed && <Badge tone="neutral">Managed</Badge>}
                    </td>
                    <td className="muted">
                      {t.bodyState === 'live' ? 'live' : t.bodyState === 'templateStub' ? 'commented out' : 'wrapped by a deploy'}
                    </td>
                  </tr>
                ))}
                {triggers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No triggers match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {connectionId && <TriggerProbe connectionId={connectionId} />}

      <details className="tier-section" open={value.automation.settingPatches.length > 0}>
        <summary>
          <h2 className="inline-h2">Settings patches ({value.automation.settingPatches.length})</h2>
        </summary>
        <p className="muted">
          object → field → prefix or set, over the rows a WHERE fragment selects. Opt-in patches are unchecked on the run
          form by default. Re-running leaves rows already patched alone.
        </p>
        {value.automation.settingPatches.map((p, i) => (
          <PatchRow
            key={i}
            patch={p}
            onChange={(next) => {
              const settingPatches = [...value.automation.settingPatches]
              settingPatches[i] = next
              onChange({ ...value, automation: { ...value.automation, settingPatches } })
            }}
            onRemove={() =>
              onChange({ ...value, automation: { ...value.automation, settingPatches: value.automation.settingPatches.filter((_, j) => j !== i) } })
            }
          />
        ))}
        <button
          className="btn btn-small"
          onClick={() =>
            onChange({
              ...value,
              automation: {
                ...value.automation,
                settingPatches: [...value.automation.settingPatches, { label: '', object: '', field: '', transform: { kind: 'prefix', value: 'SBOFF_' } }]
              }
            })
          }
        >
          Add setting patch
        </button>
      </details>

      <h2>Then seed with</h2>
      <p className="muted">Data seed templates to run after the automation step, in this order. Pick the groups per template.</p>
      {seedTemplates.length === 0 && <p className="muted">No Data seed templates yet — build one first; it can be added here later.</p>}
      {value.seedTemplates.map((s, i) => {
        const def = seedTemplates.find((t) => t.name === s.name)
        const groups = def?.seedGroups ?? []
        return (
          <div className="row-inputs seed-ref" key={`${s.name}-${i}`} data-testid={`seed-ref-${i}`}>
            <select
              className="map-strategy"
              aria-label={`Seed template ${i + 1}`}
              value={s.name}
              onChange={(e) => {
                const next = [...value.seedTemplates]
                next[i] = { name: e.target.value, groups: undefined }
                onChange({ ...value, seedTemplates: next })
              }}
            >
              <option value="">— seed template —</option>
              {seedTemplates.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
              {!def && s.name && <option value={s.name}>{s.name} (missing)</option>}
            </select>
            {groups.length > 1 && (
              <span className="group-picks">
                {groups.map((g) => {
                  const on = s.groups == null || s.groups.includes(g)
                  return (
                    <label key={g} className="group-pick">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const current = s.groups ?? groups
                          const nextGroups = e.target.checked ? [...new Set([...current, g])] : current.filter((x) => x !== g)
                          const next = [...value.seedTemplates]
                          next[i] = { ...s, groups: nextGroups.length === groups.length ? undefined : nextGroups }
                          onChange({ ...value, seedTemplates: next })
                        }}
                      />{' '}
                      {g}
                    </label>
                  )
                })}
              </span>
            )}
            <button className="btn icon" aria-label="Move seed up" disabled={i === 0} onClick={() => {
              const next = [...value.seedTemplates]
              ;[next[i - 1], next[i]] = [next[i]!, next[i - 1]!]
              onChange({ ...value, seedTemplates: next })
            }}>
              ↑
            </button>
            <button className="btn btn-small" onClick={() => onChange({ ...value, seedTemplates: value.seedTemplates.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        )
      })}
      <button className="btn btn-small" onClick={() => onChange({ ...value, seedTemplates: [...value.seedTemplates, { name: seedTemplates[0]?.name ?? '' }] })}>
        Add seed template
      </button>
    </section>
  )
}

/**
 * P1 spike, read-only half: what the Tooling API exposes on an ApexTrigger
 * record's Metadata on THIS org. If `status` is there, the MetadataContainer
 * path is the one to click on a scratch sandbox; if not, the file-based deploy
 * is the fallback the runner tries second. Reads only — any connection.
 */
function TriggerProbe({ connectionId }: { connectionId: string }): React.JSX.Element {
  const [name, setName] = useState('')
  const [result, setResult] = useState<TriggerProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const probe = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResult(await callIpc(() => window.rds.templateTriggerProbe({ connectionId, triggerName: name.trim() })))
    } catch (e) {
      setError(toRdsError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="tier-section">
      <summary>Probe a trigger (read-only) — what this org exposes for a status change</summary>
      <div className="row-inputs">
        <input className="map-matchfield" aria-label="Trigger name to probe" placeholder="e.g. AccountTrigger" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-small" onClick={() => void probe()} disabled={busy || !name.trim()}>
          {busy ? 'Probing…' : 'Probe'}
        </button>
      </div>
      {error && <p className="status-err">{error}</p>}
      {result && (
        <div className="probe-result" data-testid="trigger-probe">
          {result.found ? (
            <>
              <p>
                <strong>{name.trim()}</strong> · Status {result.status ?? '?'} · API v{result.apiVersion ?? '?'} · body{' '}
                {result.bodyState === 'live' ? 'live' : result.bodyState === 'templateStub' ? 'commented out' : 'wrapped by a deploy'}
              </p>
              <p className="muted">
                Metadata keys: {result.metadataKeys.length ? result.metadataKeys.join(', ') : '(none)'}
                {result.metadataStatus != null && ` · Metadata.status = ${result.metadataStatus}`}
              </p>
            </>
          ) : null}
          <p className="muted">{result.note}</p>
        </div>
      )}
    </details>
  )
}

function PatchRow({ patch, onChange, onRemove }: { patch: SettingPatch; onChange: (p: SettingPatch) => void; onRemove: () => void }): React.JSX.Element {
  const kind = patch.transform.kind
  const setValue = (raw: string): void => {
    if (kind === 'prefix') onChange({ ...patch, transform: { kind: 'prefix', value: raw } })
    else {
      const v = raw === '' || raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
      onChange({ ...patch, transform: { kind: 'set', value: v } })
    }
  }
  return (
    <div className="patch-row">
      <input className="text-input" aria-label="Patch label" placeholder="Label" value={patch.label} onChange={(e) => onChange({ ...patch, label: e.target.value })} />
      <input className="map-matchfield" aria-label="Patch object" placeholder="e.g. Acme_Settings__c" value={patch.object} onChange={(e) => onChange({ ...patch, object: e.target.value.trim() })} />
      <input className="map-matchfield" aria-label="Patch field" placeholder="e.g. Key__c" value={patch.field} onChange={(e) => onChange({ ...patch, field: e.target.value.trim() })} />
      <select
        className="map-strategy"
        aria-label="Patch transform"
        value={kind}
        onChange={(e) =>
          onChange({ ...patch, transform: e.target.value === 'prefix' ? { kind: 'prefix', value: kind === 'prefix' ? patch.transform.value : 'SBOFF_' } : { kind: 'set', value: null } })
        }
      >
        <option value="prefix">prefix</option>
        <option value="set">set</option>
      </select>
      <input
        className="map-matchfield"
        aria-label="Patch value"
        placeholder={kind === 'prefix' ? 'e.g. SBOFF_' : 'Value, or null to clear'}
        value={patch.transform.value == null ? '' : String(patch.transform.value)}
        onChange={(e) => setValue(e.target.value)}
      />
      <input className="text-input" aria-label="Patch where" placeholder="Where clause (optional, without WHERE)" value={patch.where ?? ''} onChange={(e) => onChange({ ...patch, where: e.target.value || undefined })} />
      <label className="master-toggle">
        <input type="checkbox" checked={patch.optIn === true} onChange={(e) => onChange({ ...patch, optIn: e.target.checked || undefined })} /> opt-in
      </label>
      <button className="btn btn-small" onClick={onRemove}>
        Remove
      </button>
    </div>
  )
}
