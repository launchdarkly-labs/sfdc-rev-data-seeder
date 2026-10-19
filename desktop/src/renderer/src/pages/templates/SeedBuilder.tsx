import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DeployableObject, FieldInfo } from '../../../../shared/types'
import {
  BATCH_SIZE_DEFAULT,
  BATCH_SIZE_MAX,
  BATCH_SIZE_MIN,
  DEFAULT_TIER_GROUP,
  SEED_HANDLERS,
  type SeedHandler,
  type SeedTemplate,
  type SeedTier
} from '../../../../shared/templates/types'
import { GLOSSARY } from '../../../../shared/labels'

/** Human labels for the seed handlers (ux T-10: the select used to show the schema key). */
export const HANDLER_LABELS: Record<SeedHandler, string> = {
  attachmentsViaJunction: 'Copy attachments through a junction'
}

type SeedTab = 'objects' | 'order' | 'settings'
const SEED_TABS: readonly SeedTab[] = ['objects', 'order', 'settings']
import { cpqConfigurationPreset } from '../../../../shared/templates/samples'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { ObjectPicker } from '../../ui/ObjectPicker'
import { Badge } from '../../ui/Badge'
import { useToast } from '../../ui/Toast'
import { FilterEditor } from '../wizard/FilterEditor'
import { namespaceOf, tokens } from './templateUi'

interface Props {
  value: SeedTemplate
  onChange: (next: SeedTemplate) => void
  connectionId: string
}

/**
 * The Data seed builder (S59 plan §2.2): Objects → Order (suggested, editable,
 * grouped) → per-tier settings → template settings. Every read is against the
 * read-from org; the CPQ configuration preset seeds the tiers + settings from
 * the shipped sample.
 */
export function SeedBuilder({ value, onChange, connectionId }: Props): React.JSX.Element {
  const toast = useToast()
  const [tab, setTab] = useState<SeedTab>('objects')
  // A-8: a complete tabs pattern — roving tabindex, arrow keys, aria-controls ↔ tabpanel.
  const tabRefs = useRef<Record<SeedTab, HTMLButtonElement | null>>({ objects: null, order: null, settings: null })
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, key: SeedTab): void => {
    const i = SEED_TABS.indexOf(key)
    let next: SeedTab | undefined
    if (e.key === 'ArrowRight') next = SEED_TABS[(i + 1) % SEED_TABS.length]
    else if (e.key === 'ArrowLeft') next = SEED_TABS[(i - 1 + SEED_TABS.length) % SEED_TABS.length]
    else if (e.key === 'Home') next = SEED_TABS[0]
    else if (e.key === 'End') next = SEED_TABS[SEED_TABS.length - 1]
    if (!next) return
    e.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }
  const [openTier, setOpenTier] = useState<string | null>(null)
  const [hints, setHints] = useState<Record<string, string[]>>({})
  const [suggesting, setSuggesting] = useState(false)

  const globalQ = useIpcQuery(() => (connectionId ? window.rds.describeGlobal(connectionId) : Promise.resolve([])), [connectionId])
  const objects: DeployableObject[] = useMemo(
    () =>
      (globalQ.data ?? []).map((o) => ({
        apiName: o.apiName,
        label: o.label,
        custom: o.custom,
        namespace: namespaceOf(o.apiName),
        inSource: true,
        inTarget: true
      })),
    [globalQ.data]
  )

  const selected = value.tiers.map((t) => t.object)

  const setTiers = (tiers: SeedTier[]): void => onChange({ ...value, tiers })
  const patchTier = (object: string, patch: Partial<SeedTier>): void =>
    setTiers(value.tiers.map((t) => (t.object === object ? pruneUndefined({ ...t, ...patch }) : t)))

  const setSelected = (next: string[]): void => {
    const keep = new Set(next)
    const kept = value.tiers.filter((t) => keep.has(t.object))
    const added = next.filter((o) => !value.tiers.some((t) => t.object === o)).map((object) => ({ object }))
    setTiers([...kept, ...added])
  }

  const move = (index: number, delta: number): void => {
    const next = [...value.tiers]
    const j = index + delta
    if (j < 0 || j >= next.length) return
    const [t] = next.splice(index, 1)
    next.splice(j, 0, t!)
    setTiers(next)
  }

  const suggestOrder = async (): Promise<void> => {
    if (!connectionId || selected.length === 0) return
    setSuggesting(true)
    try {
      const r = await callIpc(() => window.rds.templateSeedOrder({ connectionId, objects: selected }))
      const byName = new Map(value.tiers.map((t) => [t.object, t]))
      const ordered = r.order.map((o) => byName.get(o)!).filter(Boolean)
      for (const t of value.tiers) if (!r.order.includes(t.object)) ordered.push(t)
      setTiers(ordered)
      setHints(r.deferredHints)
      const deferred = Object.keys(r.deferredHints).length
      toast(`Order suggested from the read-from org’s describes${deferred ? ` — ${deferred} object${deferred === 1 ? '' : 's'} have lookups that must defer` : ''}.`, 'success')
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    } finally {
      setSuggesting(false)
    }
  }

  const applyPreset = (): void => {
    const p = cpqConfigurationPreset()
    const existing = new Set(value.tiers.map((t) => t.object))
    const tiers = [...value.tiers, ...p.tiers.filter((t) => !existing.has(t.object))]
    onChange({
      ...value,
      tiers,
      keepIdTargets: [...new Set([...value.keepIdTargets, ...p.keepIdTargets])],
      copiedObjectsMustMatchSource: [...new Set([...value.copiedObjectsMustMatchSource, ...p.copiedObjectsMustMatchSource])],
      relinkCopiedObjects: value.relinkCopiedObjects.length ? value.relinkCopiedObjects : p.relinkCopiedObjects,
      deferredFields: { ...p.deferredFields, ...value.deferredFields },
      deferredPlaceholders: { ...p.deferredPlaceholders, ...value.deferredPlaceholders }
    })
    toast(`CPQ configuration preset applied — ${tiers.length} objects in the template.`, 'success')
  }

  const groups = useMemo(() => {
    const g: string[] = []
    for (const t of value.tiers) {
      const name = t.group ?? DEFAULT_TIER_GROUP
      if (!g.includes(name)) g.push(name)
    }
    return g
  }, [value.tiers])

  return (
    <section className="seed-builder">
      <div className="builder-tabs" role="tablist" aria-label="Seed template sections">
        {(
          [
            ['objects', `Objects (${selected.length})`],
            ['order', 'Order & load groups'],
            ['settings', 'Settings']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            ref={(el) => {
              tabRefs.current[key] = el
            }}
            id={`seed-tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`seed-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            className={`btn ${tab === key ? 'primary' : ''}`}
            onClick={() => setTab(key)}
            onKeyDown={(e) => onTabKey(e, key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`seed-panel-${tab}`} aria-labelledby={`seed-tab-${tab}`}>
      {tab === 'objects' && (
        <>
          <div className="toolbar">
            <button className="btn" onClick={applyPreset}>
              CPQ configuration preset
            </button>
            <span className="muted">
              Adds the sample’s CPQ + Advanced Approvals objects, shared-Id set, deferred fields and placeholders. Pick any other
              object below.
            </span>
          </div>
          {!connectionId && <p className="muted">Pick a read-from org to list its objects.</p>}
          {globalQ.loading && <p className="muted">Describing the org…</p>}
          {globalQ.error && <div className="banner">{globalQ.error.message}</div>}
          {objects.length > 0 && <ObjectPicker objects={objects} selected={selected} onChange={setSelected} deployableOnly={false} />}
        </>
      )}

      {tab === 'order' && (
        <>
          <div className="toolbar">
            <button className="btn" onClick={() => void suggestOrder()} disabled={suggesting || !connectionId || selected.length === 0}>
              {suggesting ? 'Suggesting…' : 'Suggest order'}
            </button>
            <span className="muted">
              Parents before children from the read-from org’s lookups. Self and forward references defer to the second pass
              automatically. Load groups let part of a template run alone.
            </span>
          </div>
          {value.tiers.length === 0 && <p className="muted">No objects yet — pick them on the Objects tab.</p>}
          {value.tiers.length > 0 && (
            <table className="orgs tiers-table" aria-label="Load order">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Object</th>
                  <th title={GLOSSARY.loadGroup}>Load group</th>
                  <th title="Rows per save call (1–200); lower it when a trigger-heavy object only saves one row at a time">Batch size</th>
                  <th title="Source rows to copy — a WHERE clause without the keyword">Where</th>
                  <th>Flags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {value.tiers.map((t, i) => (
                  <TierRow
                    key={t.object}
                    tier={t}
                    index={i}
                    total={value.tiers.length}
                    open={openTier === t.object}
                    hints={hints[t.object] ?? []}
                    template={value}
                    connectionId={connectionId}
                    onToggle={() => setOpenTier(openTier === t.object ? null : t.object)}
                    onMove={(d) => move(i, d)}
                    onPatch={(p) => patchTier(t.object, p)}
                    onTemplate={onChange}
                  />
                ))}
              </tbody>
            </table>
          )}
          {groups.length > 1 && (
            <p className="muted">
              Load groups: {groups.join(', ')} — {GLOSSARY.loadGroup}
            </p>
          )}
        </>
      )}

      {tab === 'settings' && <SeedSettings value={value} onChange={onChange} />}
      </div>
    </section>
  )
}

function pruneUndefined<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as T
}

function TierRow({
  tier,
  index,
  total,
  open,
  hints,
  template,
  connectionId,
  onToggle,
  onMove,
  onPatch,
  onTemplate
}: {
  tier: SeedTier
  index: number
  total: number
  open: boolean
  hints: string[]
  template: SeedTemplate
  connectionId: string
  onToggle: () => void
  onMove: (delta: number) => void
  onPatch: (patch: Partial<SeedTier>) => void
  onTemplate: (next: SeedTemplate) => void
}): React.JSX.Element {
  const flags: string[] = []
  if (tier.handler) flags.push(HANDLER_LABELS[tier.handler])
  if (tier.pruneUnloadedUnder) flags.push('prunes extras')
  if (tier.parentScope) flags.push('parent scope')
  const deferred = template.deferredFields[tier.object] ?? []
  if (deferred.length) flags.push(`${deferred.length} deferred`)
  return (
    <>
      <tr className="tier-row" data-testid={`tier-${tier.object}`}>
        <td className="muted">{index + 1}</td>
        <td>
          <button className="btn subtle tier-name" onClick={onToggle} aria-expanded={open}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {tier.object}
          </button>
        </td>
        <td>
          <input
            className="map-matchfield"
            aria-label={`Load group for ${tier.object}`}
            value={tier.group ?? ''}
            placeholder={DEFAULT_TIER_GROUP}
            onChange={(e) => onPatch({ group: e.target.value.trim() || undefined })}
          />
        </td>
        <td>
          <input
            className="map-matchfield batch-input"
            type="number"
            min={BATCH_SIZE_MIN}
            max={BATCH_SIZE_MAX}
            aria-label={`Batch size for ${tier.object}`}
            value={tier.batchSize ?? BATCH_SIZE_DEFAULT}
            onChange={(e) => {
              const n = Number(e.target.value)
              onPatch({ batchSize: Number.isFinite(n) && n !== BATCH_SIZE_DEFAULT ? n : undefined })
            }}
          />
        </td>
        <td className="muted where-cell">{tier.where ? <code>{tier.where}</code> : '—'}</td>
        <td>
          {flags.map((f) => (
            <Badge key={f} tone="neutral">
              {f}
            </Badge>
          ))}
          {hints.length > 0 && (
            <Badge tone="accent">defers {hints.join(', ')}</Badge>
          )}
        </td>
        <td className="tier-move">
          <button className="btn icon" aria-label={`Move ${tier.object} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button className="btn icon" aria-label={`Move ${tier.object} down`} disabled={index === total - 1} onClick={() => onMove(1)}>
            ↓
          </button>
        </td>
      </tr>
      {open && (
        <tr className="tier-detail">
          <td colSpan={7}>
            <TierDetail tier={tier} index={index} template={template} connectionId={connectionId} onPatch={onPatch} onTemplate={onTemplate} />
          </td>
        </tr>
      )}
    </>
  )
}

function TierDetail({
  tier,
  index,
  template,
  connectionId,
  onPatch,
  onTemplate
}: {
  tier: SeedTier
  index: number
  template: SeedTemplate
  connectionId: string
  onPatch: (patch: Partial<SeedTier>) => void
  onTemplate: (next: SeedTemplate) => void
}): React.JSX.Element {
  const fieldsQ = useIpcQuery<FieldInfo[]>(
    () => (connectionId ? window.rds.describeObject(connectionId, tier.object) : Promise.resolve([])),
    [connectionId, tier.object]
  )
  const createable = useMemo(() => (fieldsQ.data ?? []).filter((f) => f.isCreateable && !f.isCalculated && !f.isAutoNumber), [fieldsQ.data])
  const deferred = template.deferredFields[tier.object] ?? []
  const earlier = template.tiers.slice(0, index).map((t) => t.object)
  const [whereDraft, setWhereDraft] = useState(tier.where ?? '')

  const setDeferred = (next: string[]): void => {
    const deferredFields = { ...template.deferredFields }
    if (next.length === 0) delete deferredFields[tier.object]
    else deferredFields[tier.object] = next
    onTemplate({ ...template, deferredFields })
  }
  const setPlaceholder = (field: string, raw: string): void => {
    const deferredPlaceholders = { ...template.deferredPlaceholders }
    if (raw === '') delete deferredPlaceholders[field]
    else deferredPlaceholders[field] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
    onTemplate({ ...template, deferredPlaceholders })
  }

  return (
    <div className="tier-detail-body">
      <div className="field">
        <span>Where (source rows; leave out the WHERE keyword)</span>
        {connectionId ? (
          <FilterEditor
            connectionId={connectionId}
            objectName={tier.object}
            value={whereDraft}
            onChange={(v) => {
              setWhereDraft(v)
              onPatch({ where: v.trim() ? v.replace(/^\s*WHERE\s+/i, '') : undefined })
            }}
          />
        ) : (
          <input className="text-input" value={whereDraft} onChange={(e) => {
            setWhereDraft(e.target.value)
            onPatch({ where: e.target.value.trim() || undefined })
          }} />
        )}
      </div>

      <details className="tier-section" open={deferred.length > 0}>
        <summary>Deferred fields ({deferred.length}) — written in the second pass; booleans load false, others take a placeholder</summary>
        {fieldsQ.loading && <p className="muted">Describing {tier.object}…</p>}
        {fieldsQ.error && <p className="muted">Fields unavailable: {fieldsQ.error.message}</p>}
        <div className="deferred-grid">
          {createable.map((f) => {
            const on = deferred.includes(f.apiName)
            return (
              <label key={f.apiName} className="deferred-field">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => setDeferred(e.target.checked ? [...deferred, f.apiName] : deferred.filter((x) => x !== f.apiName))}
                />{' '}
                {f.apiName} <span className="muted">{f.type}</span>
                {on && f.type !== 'boolean' && (
                  <input
                    className="map-matchfield"
                    aria-label={`Placeholder for ${f.apiName}`}
                    placeholder="e.g. 0 or TBD"
                    value={template.deferredPlaceholders[f.apiName] == null ? '' : String(template.deferredPlaceholders[f.apiName])}
                    onChange={(e) => setPlaceholder(f.apiName, e.target.value)}
                  />
                )}
              </label>
            )
          })}
          {!fieldsQ.loading && createable.length === 0 && <span className="muted">No createable fields described.</span>}
        </div>
      </details>

      <details className="tier-section" open={tier.pruneUnloadedUnder != null}>
        <summary>Delete rows the target created on its own under a parent {tier.pruneUnloadedUnder ? '(on)' : ''}</summary>
        <div className="row-inputs">
          <select
            className="map-strategy"
            aria-label={`Prune parent for ${tier.object}`}
            value={tier.pruneUnloadedUnder?.parent ?? ''}
            onChange={(e) =>
              onPatch({
                pruneUnloadedUnder: e.target.value ? { parent: e.target.value, field: tier.pruneUnloadedUnder?.field ?? '' } : undefined
              })
            }
          >
            <option value="">— none —</option>
            {earlier.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {tier.pruneUnloadedUnder && (
            <select
              className="map-strategy"
              aria-label={`Prune lookup field for ${tier.object}`}
              value={tier.pruneUnloadedUnder.field}
              onChange={(e) => onPatch({ pruneUnloadedUnder: { ...tier.pruneUnloadedUnder!, field: e.target.value } })}
            >
              <option value="">— lookup field —</option>
              {createable
                .filter((f) => f.isReference && f.referenceTo.includes(tier.pruneUnloadedUnder!.parent))
                .map((f) => (
                  <option key={f.apiName} value={f.apiName}>
                    {f.apiName}
                  </option>
                ))}
            </select>
          )}
          <span className="muted">After the load, rows under the loaded parents that did not come from the source are deleted (CPQ adds default line columns to a new template).</span>
        </div>
      </details>

      <details className="tier-section" open={tier.parentScope != null}>
        <summary>Parent scope (advanced) {tier.parentScope ? `(${tier.parentScope.anyOf.length} lookups)` : ''}</summary>
        <p className="muted">Keep only rows whose lookup points at a parent kept in an EARLIER tier. Several lookups = any of them.</p>
        {(tier.parentScope?.anyOf ?? []).map((p, i) => (
          <div className="row-inputs" key={i}>
            <select
              className="map-strategy"
              aria-label={`Parent scope field ${i + 1}`}
              value={p.field}
              onChange={(e) => {
                const anyOf = [...tier.parentScope!.anyOf]
                const f = createable.find((x) => x.apiName === e.target.value)
                anyOf[i] = { field: e.target.value, object: f?.referenceTo[0] ?? p.object }
                onPatch({ parentScope: { anyOf } })
              }}
            >
              <option value="">— lookup —</option>
              {createable.filter((f) => f.isReference).map((f) => (
                <option key={f.apiName} value={f.apiName}>
                  {f.apiName} → {f.referenceTo.join('/')}
                </option>
              ))}
            </select>
            <select
              className="map-strategy"
              aria-label={`Parent scope object ${i + 1}`}
              value={p.object}
              onChange={(e) => {
                const anyOf = [...tier.parentScope!.anyOf]
                anyOf[i] = { ...p, object: e.target.value }
                onPatch({ parentScope: { anyOf } })
              }}
            >
              <option value="">— earlier tier —</option>
              {earlier.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <button
              className="btn btn-small"
              onClick={() => {
                const anyOf = tier.parentScope!.anyOf.filter((_, j) => j !== i)
                onPatch({ parentScope: anyOf.length ? { anyOf } : undefined })
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button className="btn btn-small" onClick={() => onPatch({ parentScope: { anyOf: [...(tier.parentScope?.anyOf ?? []), { field: '', object: '' }] } })}>
          Add lookup
        </button>
      </details>

      <details className="tier-section" open={tier.handler != null}>
        <summary>Special handling {tier.handler ? `(${HANDLER_LABELS[tier.handler]})` : ''}</summary>
        <div className="row-inputs">
          <select
            className="map-strategy"
            aria-label={`Handler for ${tier.object}`}
            value={tier.handler ?? ''}
            onChange={(e) =>
              onPatch(
                e.target.value
                  ? { handler: e.target.value as SeedTier['handler'], handlerConfig: tier.handlerConfig ?? { fileIdField: '', parentField: '' } }
                  : { handler: undefined, handlerConfig: undefined }
              )
            }
          >
            <option value="">— none —</option>
            {SEED_HANDLERS.map((h) => (
              <option key={h} value={h}>
                {HANDLER_LABELS[h]}
              </option>
            ))}
          </select>
          {tier.handler === 'attachmentsViaJunction' && (
            <>
              <select
                className="map-strategy"
                aria-label="File Id field"
                value={tier.handlerConfig?.fileIdField ?? ''}
                onChange={(e) => onPatch({ handlerConfig: { ...tier.handlerConfig!, fileIdField: e.target.value } })}
              >
                <option value="">— field holding the source Attachment Id —</option>
                {createable.map((f) => (
                  <option key={f.apiName} value={f.apiName}>
                    {f.apiName}
                  </option>
                ))}
              </select>
              <select
                className="map-strategy"
                aria-label="Parent field"
                value={tier.handlerConfig?.parentField ?? ''}
                onChange={(e) => onPatch({ handlerConfig: { ...tier.handlerConfig!, parentField: e.target.value } })}
              >
                <option value="">— parent lookup (the new Attachment’s ParentId) —</option>
                {createable.filter((f) => f.isReference).map((f) => (
                  <option key={f.apiName} value={f.apiName}>
                    {f.apiName}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="muted">Copies the classic Attachment a junction row points at, then the row itself.</span>
        </div>
      </details>
    </div>
  )
}

function SeedSettings({ value, onChange }: { value: SeedTemplate; onChange: (next: SeedTemplate) => void }): React.JSX.Element {
  const [keepText, setKeepText] = useState(value.keepIdTargets.join(', '))
  const [matchText, setMatchText] = useState(value.copiedObjectsMustMatchSource.join(', '))
  const tierObjects = value.tiers.map((t) => t.object)
  // T-10 / T-15: the everyday settings stay in view; the ones that need the engine's
  // vocabulary sit under "Advanced", open when any of them is already set.
  const advancedInUse =
    value.keepIdTargets.length + value.copiedObjectsMustMatchSource.length + value.relinkCopiedObjects.length + value.subsets.length > 0

  return (
    <div className="seed-settings">
      <label className="master-toggle">
        <input
          type="checkbox"
          checked={value.runDefaults.disableTargetAutomation}
          onChange={(e) => onChange({ ...value, runDefaults: { disableTargetAutomation: e.target.checked } })}
        />{' '}
        Disable the target’s own automation on the seeded objects during the seed, restore after (default on)
      </label>

      <h3>Verify after the seed</h3>
      <p className="muted">Each check adds a section to the run report.</p>
      {(
        [
          ['counts', 'Counts per object (source vs loaded vs target)'],
          ['danglingLookups', 'Dangling lookups on relinked objects'],
          ['secondPassParity', 'Second-pass values, record by record']
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="master-toggle">
          <input type="checkbox" checked={value.verify[k]} onChange={(e) => onChange({ ...value, verify: { ...value.verify, [k]: e.target.checked } })} /> {label}
        </label>
      ))}

      <h3>Expected failures</h3>
      <p className="muted">Known failures are listed in the report with their reason instead of counting as unexpected. Matched by message text; leave the object blank for any object.</p>
      {value.expectedFailures.map((f, i) => (
        <div className="row-inputs" key={i}>
          <input
            className="map-matchfield"
            aria-label={`Expected failure object ${i + 1}`}
            value={f.object ?? ''}
            placeholder="Any object"
            onChange={(e) => {
              const next = [...value.expectedFailures]
              next[i] = { ...f, object: e.target.value.trim() || null }
              onChange({ ...value, expectedFailures: next })
            }}
          />
          <input
            className="text-input"
            aria-label={`Expected failure contains ${i + 1}`}
            value={f.contains}
            placeholder="Message contains…"
            onChange={(e) => {
              const next = [...value.expectedFailures]
              next[i] = { ...f, contains: e.target.value }
              onChange({ ...value, expectedFailures: next })
            }}
          />
          <input
            className="text-input"
            aria-label={`Expected failure why ${i + 1}`}
            value={f.why}
            placeholder="Why it is expected"
            onChange={(e) => {
              const next = [...value.expectedFailures]
              next[i] = { ...f, why: e.target.value }
              onChange({ ...value, expectedFailures: next })
            }}
          />
          <button className="btn btn-small" onClick={() => onChange({ ...value, expectedFailures: value.expectedFailures.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <button className="btn btn-small" onClick={() => onChange({ ...value, expectedFailures: [...value.expectedFailures, { object: null, contains: '', why: '' }] })}>
        Add expected failure
      </button>

      <details className="tier-section seed-advanced" open={advancedInUse} data-testid="seed-advanced">
        <summary>Advanced — shared Ids, pre-seed checks, relinking and subsets</summary>

        <label className="field">
          <span>Objects whose Ids the sandbox already shares with the source</span>
          <input
            className="text-input"
            aria-label="Keep-Id objects"
            value={keepText}
            placeholder="e.g. Product2, Pricebook2"
            onChange={(e) => setKeepText(e.target.value)}
            onBlur={() => onChange({ ...value, keepIdTargets: tokens(keepText) })}
          />
          <span className="field-help muted">
            Lookups to these keep the source Id instead of being remapped — a sandbox copied from the source has the same records.
          </span>
        </label>
        <label className="field">
          <span>Objects that must already match the source before seeding</span>
          <input
            className="text-input"
            aria-label="Copied objects that must match"
            value={matchText}
            placeholder="e.g. Product2"
            onChange={(e) => setMatchText(e.target.value)}
            onBlur={() => onChange({ ...value, copiedObjectsMustMatchSource: tokens(matchText) })}
          />
          <span className="field-help muted">
            Their row counts are compared source vs target before anything loads; a difference beyond the tolerance blocks the run.
          </span>
        </label>
        <div className="row-inputs">
          <label className="field">
            <span>Allowed count difference (rows)</span>
            <input
              className="map-matchfield"
              type="number"
              min={0}
              aria-label="Allowed count difference in rows"
              value={value.copiedMatchTolerance?.absolute ?? 5}
              onChange={(e) => onChange({ ...value, copiedMatchTolerance: { absolute: Number(e.target.value), fraction: value.copiedMatchTolerance?.fraction ?? 0.02 } })}
            />
          </label>
          <label className="field">
            <span>Allowed difference as a fraction (0–1)</span>
            <input
              className="map-matchfield"
              type="number"
              min={0}
              max={1}
              step={0.01}
              aria-label="Allowed count difference as a fraction"
              value={value.copiedMatchTolerance?.fraction ?? 0.02}
              onChange={(e) => onChange({ ...value, copiedMatchTolerance: { absolute: value.copiedMatchTolerance?.absolute ?? 5, fraction: Number(e.target.value) } })}
            />
          </label>
        </div>
        <p className="field-help muted">The larger of the two is allowed — a few rows on a small object, a small share on a big one.</p>

        <h3>Relink shared objects after the seed</h3>
        <p className="muted">
          Their lookups to seeded objects are repointed at the new rows. They must be in the shared-Ids list above. Optional fields are
          dropped on a retry when a validation rule rejects them.
        </p>
        {value.relinkCopiedObjects.map((r, i) => (
          <div className="row-inputs" key={i}>
            <input
              className="map-matchfield"
              aria-label={`Relink object ${i + 1}`}
              value={r.object}
              placeholder="e.g. Product2"
              onChange={(e) => {
                const next = [...value.relinkCopiedObjects]
                next[i] = { ...r, object: e.target.value.trim() }
                onChange({ ...value, relinkCopiedObjects: next })
              }}
            />
            <input
              className="text-input"
              aria-label={`Relink optional fields ${i + 1}`}
              value={r.optionalFields.join(', ')}
              placeholder="Optional fields, comma-separated"
              onChange={(e) => {
                const next = [...value.relinkCopiedObjects]
                next[i] = { ...r, optionalFields: tokens(e.target.value) }
                onChange({ ...value, relinkCopiedObjects: next })
              }}
            />
            <button className="btn btn-small" onClick={() => onChange({ ...value, relinkCopiedObjects: value.relinkCopiedObjects.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn btn-small" onClick={() => onChange({ ...value, relinkCopiedObjects: [...value.relinkCopiedObjects, { object: '', optionalFields: [] }] })}>
          Add relink object
        </button>

        <h3>Only these source records</h3>
        <p className="muted">Copy just the listed records of an object; its children follow through parent scope.</p>
        {value.subsets.map((s, i) => (
          <div className="row-inputs" key={i}>
            <select
              className="map-strategy"
              aria-label={`Subset object ${i + 1}`}
              value={s.object}
              onChange={(e) => {
                const next = [...value.subsets]
                next[i] = { ...s, object: e.target.value }
                onChange({ ...value, subsets: next })
              }}
            >
              <option value="">— object —</option>
              {tierObjects.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <input
              className="text-input"
              aria-label={`Subset ids ${i + 1}`}
              value={s.ids.join(', ')}
              placeholder="Record Ids, comma-separated"
              onChange={(e) => {
                const next = [...value.subsets]
                next[i] = { ...s, ids: tokens(e.target.value) }
                onChange({ ...value, subsets: next })
              }}
            />
            <button className="btn btn-small" onClick={() => onChange({ ...value, subsets: value.subsets.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn btn-small" onClick={() => onChange({ ...value, subsets: [...value.subsets, { object: '', ids: [] }] })}>
          Add subset
        </button>
      </details>
    </div>
  )
}
