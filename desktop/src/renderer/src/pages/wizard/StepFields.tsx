import { useMemo, useState } from 'react'
import {
  fieldExclusion,
  fieldNamespace,
  isDeployableField,
  isFieldLocked,
  reconcileFieldsTemplate,
  suggestExcludedNamespaces,
  type FieldsTemplatePayload
} from '../../../../shared/fieldPolicy'
import type { Template, TemplateKind } from '../../../../shared/types'
import type { MappingStrategy } from '../../../../shared/wizard'
import { targetKeyProbeCandidates, type TargetKeyInfo } from '../../../../shared/mappingPolicy'
import { useIpcQuery } from '../../ipc/hooks'
import { callIpc, toRdsError } from '../../ipc/client'
import { useWizard } from './WizardShell'
import { useTargetKeys } from './useTargetKeys'
import { OutcomeNote, errNote, okNote, type Note } from '../../ui/OutcomeNote'

const FIELDS_KIND: TemplateKind = 'fields'

interface DeployableField {
  apiName: string
  label: string
  namespace: string | null
  /** First referenced object for reference fields (drives the out-of-scope-ref lock). */
  refTo: string | null
}

/** Describe both orgs (cached) and return each object's deployable (source∩target) fields. */
async function loadAllDeployableFields(
  sourceConnectionId: string,
  targetConnectionId: string,
  objects: string[]
): Promise<Record<string, DeployableField[]>> {
  const result: Record<string, DeployableField[]> = {}
  for (const obj of objects) {
    const [src, tgt] = await Promise.all([
      callIpc(() => window.rds.describeObject(sourceConnectionId, obj)),
      callIpc(() => window.rds.describeObject(targetConnectionId, obj))
    ])
    // Intersect source-deployable ∩ target-DEPLOYABLE (not just name-present): a field
    // writable on source but read-only/formula/auto-number on the target must be
    // dropped, else the upsert fails for every record (SchemaService.cls:294-298).
    const targetDeployable = new Set(tgt.filter(isDeployableField).map((f) => f.apiName))
    result[obj] = src
      .filter(isDeployableField)
      .filter((f) => targetDeployable.has(f.apiName))
      .map((f) => ({
        apiName: f.apiName,
        label: f.label || f.apiName,
        namespace: fieldNamespace(f.apiName),
        refTo: f.isReference && f.referenceTo.length > 0 ? (f.referenceTo[0] ?? null) : null
      }))
  }
  return result
}

/** Probe which fields are non-blank in a source sample per object (fail-open → all populated). */
async function loadPopulated(
  sourceConnectionId: string,
  targetConnectionId: string,
  objects: string[]
): Promise<Record<string, string[]>> {
  const byObject = await loadAllDeployableFields(sourceConnectionId, targetConnectionId, objects)
  const out: Record<string, string[]> = {}
  for (const [obj, fields] of Object.entries(byObject)) {
    const names = fields.map((f) => f.apiName)
    const res = await window.rds.fieldsPopulated({
      connectionId: sourceConnectionId,
      objectName: obj,
      fieldNames: names
    })
    out[obj] = res.ok ? (res.populated ?? []) : names // fail-open: don't exclude on probe failure
  }
  return out
}

/**
 * Wizard Step 5 — Fields. Per-object include/exclude over the deployable
 * (source∩target createable, non-formula/auto-number) field set. Exclusions are
 * three-layered and all derived from the single-source `fieldPolicy`: an explicit
 * per-field toggle (`excludedFields`), a global namespace exclusion
 * (`excludedNamespaces` — locks the field), and a populated-only gate
 * (`populatedOnly` — locks unpopulated fields). Suggest Exclusions drops every
 * managed namespace except the ones this tool deploys (SBQQ/sbaa).
 *
 * 5B.6-b adds: fields templates (kind 'fields' — Save/Apply with scope
 * re-validation via `reconcileFieldsTemplate`) and out-of-scope-ref locks (a
 * ref field whose mapping is policy-locked to Skip is stripped by the
 * transform regardless of selection, so its include checkbox is locked too).
 */
export function StepFields(): React.JSX.Element {
  const { config, updateConfig, goToStep, sourceConnectionId, targetConnectionId } = useWizard()
  const objects = config.selectedObjects
  const scopeKey = objects.join(',')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState<Record<string, string>>({})

  // ── Fields templates (5B.6-b) ──
  const templates = useIpcQuery(() => window.rds.templateList(FIELDS_KIND), [])
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | ''>('')
  const [templateName, setTemplateName] = useState('')
  const [templateBusy, setTemplateBusy] = useState(false)
  const [note, setNote] = useState<Note | undefined>(undefined)
  const ok = (text: string): void => setNote(okNote(text))
  const err = (text: string): void => setNote(errNote(text))

  const selectedTemplate = (): Template | undefined =>
    templates.data?.find((t) => t.id === selectedTemplateId)

  const saveCurrentAsTemplate = async (): Promise<void> => {
    const name = templateName.trim()
    if (!name) return
    setTemplateBusy(true)
    try {
      const payload: FieldsTemplatePayload = {
        excludedFields: config.excludedFields,
        excludedNamespaces: config.excludedNamespaces,
        populatedOnly: config.populatedOnly
      }
      // saveTemplate is an upsert on (kind, name) — say so instead of silently clobbering.
      const overwriting = templates.data?.some((t) => t.name === name) ?? false
      const saved = await callIpc(() =>
        window.rds.templateSave({ kind: FIELDS_KIND, name, payload })
      )
      setTemplateName('')
      templates.refetch()
      setSelectedTemplateId(saved.id)
      ok(overwriting ? `Overwrote template "${saved.name}".` : `Saved template "${saved.name}".`)
    } catch (e) {
      err(`Save failed: ${toRdsError(e).message}`)
    } finally {
      setTemplateBusy(false)
    }
  }

  // Apply re-validates against the CURRENT scope: exclusions for out-of-scope
  // objects are dropped and counted, never silently carried along. Per-object
  // MERGE (like the sibling mappings apply): the template replaces only the
  // objects it covers — exclusions you already made on objects the template
  // doesn't mention are preserved, not wiped.
  const applyTemplate = (): void => {
    const t = selectedTemplate()
    if (!t) return
    const r = reconcileFieldsTemplate(t.payload, objects)
    updateConfig({
      excludedFields: { ...config.excludedFields, ...r.excludedFields },
      excludedNamespaces: r.excludedNamespaces,
      populatedOnly: r.populatedOnly
    })
    ok(
      r.droppedObjects > 0
        ? `Applied "${t.name}" — exclusions for ${r.droppedObjects} out-of-scope object${
            r.droppedObjects === 1 ? '' : 's'
          } dropped.`
        : `Applied template "${t.name}".`
    )
  }

  const renameSelectedTemplate = async (): Promise<void> => {
    const t = selectedTemplate()
    const name = templateName.trim()
    if (!t || !name) return
    setTemplateBusy(true)
    try {
      await callIpc(() => window.rds.templateRename({ id: t.id, name }))
      setTemplateName('')
      templates.refetch()
      ok(`Renamed template to "${name}".`)
    } catch (e) {
      err(`Rename failed: ${toRdsError(e).message}`)
    } finally {
      setTemplateBusy(false)
    }
  }

  const deleteSelectedTemplate = async (): Promise<void> => {
    const t = selectedTemplate()
    if (!t) return
    setTemplateBusy(true)
    try {
      await callIpc(() => window.rds.templateDelete(t.id))
      setSelectedTemplateId('')
      templates.refetch()
      ok(`Deleted template "${t.name}".`)
    } catch (e) {
      err(`Delete failed: ${toRdsError(e).message}`)
    } finally {
      setTemplateBusy(false)
    }
  }

  const scan = useIpcQuery(
    () => loadAllDeployableFields(sourceConnectionId, targetConnectionId, objects),
    [sourceConnectionId, targetConnectionId, scopeKey]
  )

  // S57 (B1): parents outside the plan the target may be able to key — this step
  // must agree with the Mappings step on which refs are "skipped by mapping".
  const probeCandidates = useMemo(() => {
    const out: string[] = []
    for (const [obj, fields] of Object.entries(scan.data ?? {})) {
      for (const c of targetKeyProbeCandidates(
        fields.map((f) => f.refTo),
        obj,
        objects
      )) {
        if (!out.includes(c)) out.push(c)
      }
    }
    return out
  }, [scan.data, objects])
  const { keys: targetKeys } = useTargetKeys(targetConnectionId, probeCandidates)
  const populated = useIpcQuery(
    () =>
      config.populatedOnly
        ? loadPopulated(sourceConnectionId, targetConnectionId, objects)
        : Promise.resolve<Record<string, string[]>>({}),
    [config.populatedOnly, sourceConnectionId, targetConnectionId, scopeKey]
  )

  const namespaces = useMemo(() => {
    const set = new Set<string>()
    for (const fields of Object.values(scan.data ?? {})) {
      for (const f of fields) if (f.namespace) set.add(f.namespace)
    }
    return [...set].sort()
  }, [scan.data])

  const toggle = (obj: string): void => setExpanded((e) => ({ ...e, [obj]: !e[obj] }))

  const setExcludedFields = (obj: string, names: string[]): void => {
    // An empty list DELETES the key — a stored `obj: []` excludes nothing and
    // would only pollute templates/drop-counts.
    const next = { ...config.excludedFields }
    if (names.length === 0) delete next[obj]
    else next[obj] = names
    updateConfig({ excludedFields: next })
  }

  const toggleField = (obj: string, field: string, locked: boolean): void => {
    if (locked) return // double-defense: a namespace/unpopulated lock is not user-toggleable
    const current = config.excludedFields[obj] ?? []
    const next = current.includes(field) ? current.filter((f) => f !== field) : [...current, field]
    setExcludedFields(obj, next)
  }

  const toggleNamespace = (ns: string): void => {
    const current = config.excludedNamespaces
    updateConfig({
      excludedNamespaces: current.includes(ns) ? current.filter((n) => n !== ns) : [...current, ns]
    })
  }

  const suggestExclusions = (): void =>
    updateConfig({ excludedNamespaces: suggestExcludedNamespaces(namespaces, objects) })

  // Degrade OPEN: only apply the populated gate once the probe has SUCCESSFULLY
  // loaded for this toggle. While loading or errored (data may be a stale {} from
  // when the toggle was off — the hook keeps the last value on error), return null
  // so fieldExclusion excludes nothing — never a fail-closed "all fields excluded".
  const populatedSet = (obj: string): ReadonlySet<string> | null => {
    if (!config.populatedOnly || populated.loading || populated.error || !populated.data) {
      return null
    }
    return new Set(populated.data[obj] ?? [])
  }

  return (
    <>
      <h2>Fields</h2>
      <p className="sub">
        Pick which fields deploy on each object. Everything deployable is included by default;
        exclude individual fields, whole managed namespaces, or unpopulated fields.
      </p>

      {scan.loading && <p className="muted">Loading fields…</p>}
      {scan.error && (
        <div className="banner">
          {scan.error.message}{' '}
          <button className="btn" onClick={scan.refetch}>
            Retry
          </button>
        </div>
      )}

      {scan.data && (
        <>
          <div className="toolbar">
            <label className="map-detail">
              <input
                type="checkbox"
                checked={config.populatedOnly}
                onChange={(e) => updateConfig({ populatedOnly: e.target.checked })}
              />{' '}
              Populated fields only (20-record sample)
            </label>
            {namespaces.length > 0 && (
              <button className="btn" onClick={suggestExclusions}>
                Suggest exclusions
              </button>
            )}
          </div>

          <div className="toolbar">
            <select
              className="map-strategy"
              aria-label="Saved fields template"
              value={selectedTemplateId === '' ? '' : String(selectedTemplateId)}
              onChange={(e) =>
                setSelectedTemplateId(e.target.value === '' ? '' : Number(e.target.value))
              }
            >
              <option value="">— saved templates —</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={templateBusy || selectedTemplateId === ''}
              onClick={applyTemplate}
            >
              Apply
            </button>
            <button
              className="btn"
              disabled={templateBusy || selectedTemplateId === '' || !templateName.trim()}
              onClick={() => void renameSelectedTemplate()}
            >
              Rename
            </button>
            <button
              className="btn"
              disabled={templateBusy || selectedTemplateId === ''}
              onClick={() => void deleteSelectedTemplate()}
            >
              Delete
            </button>
            <input
              className="map-matchfield"
              aria-label="Fields template name"
              placeholder="template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <button
              className="btn"
              disabled={templateBusy || !templateName.trim()}
              onClick={() => void saveCurrentAsTemplate()}
            >
              Save as
            </button>
          </div>
          <OutcomeNote note={note} />

          {namespaces.length > 0 && (
            <p className="footprint">
              Exclude namespaces:{' '}
              {namespaces.map((ns) => (
                <label key={ns} className="map-detail" style={{ marginRight: 10 }}>
                  <input
                    type="checkbox"
                    aria-label={`Exclude namespace ${ns}`}
                    checked={config.excludedNamespaces.includes(ns)}
                    onChange={() => toggleNamespace(ns)}
                  />{' '}
                  {ns}
                </label>
              ))}
            </p>
          )}
          {config.populatedOnly && populated.loading && (
            <p className="muted">Sampling populated fields…</p>
          )}

          {objects.map((obj) => {
            const fields = scan.data?.[obj] ?? []
            const q = (search[obj] ?? '').toLowerCase()
            const shown = q
              ? fields.filter(
                  (f) => f.apiName.toLowerCase().includes(q) || f.label.toLowerCase().includes(q)
                )
              : fields
            const popSet = populatedSet(obj)
            const refCtx = (
              f: DeployableField
            ): {
              refTo: string | null
              selectedObjects: string[]
              overrideStrategy?: MappingStrategy
              targetKeys?: TargetKeyInfo
            } => ({
              refTo: f.refTo,
              selectedObjects: objects,
              // A user-chosen 'skip' on the Mappings step strips the field too.
              overrideStrategy: config.mappings[obj]?.[f.apiName]?.strategy,
              targetKeys
            })
            const includedCount = fields.filter(
              (f) => !fieldExclusion(f.apiName, obj, config, popSet, refCtx(f)).excluded
            ).length
            return (
              <div key={obj} className="map-object">
                <button
                  className="map-object-hdr btn"
                  aria-expanded={!!expanded[obj]}
                  onClick={() => toggle(obj)}
                >
                  {expanded[obj] ? '▾' : '▸'} {obj}{' '}
                  <span className="muted">
                    ({includedCount}/{fields.length} included)
                  </span>
                </button>
                {expanded[obj] && (
                  <div>
                    <div className="toolbar">
                      <input
                        className="map-matchfield"
                        aria-label={`Search fields in ${obj}`}
                        placeholder="search fields"
                        value={search[obj] ?? ''}
                        onChange={(e) => setSearch((s) => ({ ...s, [obj]: e.target.value }))}
                      />
                      <button className="btn" onClick={() => setExcludedFields(obj, [])}>
                        Include all
                      </button>
                      <button
                        className="btn"
                        onClick={() =>
                          // EVERY deployable field goes into the explicit list — an entry on
                          // a currently-locked field is inert while locked (derived reasons
                          // win) but preserves the user's exclude-all intent if the lock
                          // later lifts (namespace un-excluded, ref back in scope).
                          setExcludedFields(
                            obj,
                            fields.map((f) => f.apiName)
                          )
                        }
                      >
                        Exclude all
                      </button>
                    </div>
                    <table className="orgs">
                      <thead>
                        <tr>
                          <th>Include</th>
                          <th>Field</th>
                          <th>Namespace</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((f) => {
                          const ex = fieldExclusion(f.apiName, obj, config, popSet, refCtx(f))
                          const locked = isFieldLocked(ex.reason)
                          return (
                            <tr key={f.apiName}>
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={`Include ${f.apiName}`}
                                  checked={!ex.excluded}
                                  disabled={locked}
                                  onChange={() => toggleField(obj, f.apiName, locked)}
                                />
                              </td>
                              <td>
                                {f.label}
                                <br />
                                <span className="muted">{f.apiName}</span>
                                {ex.reason === 'namespace' && (
                                  <span className="status-warn"> · namespace excluded</span>
                                )}
                                {ex.reason === 'unpopulated' && (
                                  <span className="status-warn"> · not populated</span>
                                )}
                                {ex.reason === 'skippedRef' &&
                                  (config.mappings[obj]?.[f.apiName]?.strategy === 'skip' ? (
                                    <span className="status-warn">
                                      {' '}
                                      · skipped by your mapping (change on the Mappings step)
                                    </span>
                                  ) : (
                                    <span className="status-warn">
                                      {' '}
                                      · ref → {f.refTo} out of scope (skipped by mapping)
                                    </span>
                                  ))}
                              </td>
                              <td>{f.namespace ?? <span className="muted">—</span>}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* UI-3, same guard as StepMappings: a template apply persists after its
       * await resolves, so leaving mid-apply rewrites the field selection from
       * a step the user has already left. */}
      <div className="toolbar">
        <button className="btn" disabled={templateBusy} onClick={() => goToStep('mappings')}>
          Back
        </button>
        <button className="btn primary" disabled={templateBusy} onClick={() => goToStep('summary')}>
          Next: summary
        </button>
        {templateBusy && <span className="muted">Finishing the current action…</span>}
      </div>
    </>
  )
}
