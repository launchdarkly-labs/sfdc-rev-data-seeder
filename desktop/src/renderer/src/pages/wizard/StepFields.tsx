import { memo, useCallback, useMemo, useState } from 'react'
import { nextLabel, isKeyless } from '../../../../shared/wizard'
import {
  fieldExclusion,
  fieldNamespace,
  isDeployableField,
  isFieldLocked,
  reconcileFieldsTemplate,
  suggestExcludedNamespaces,
  type FieldExclusion,
  type FieldsTemplatePayload
} from '../../../../shared/fieldPolicy'
import type { Template, TemplateKind } from '../../../../shared/types'
import type { FieldMapping } from '../../../../shared/wizard'
import { targetKeyProbeCandidates, type TargetKeyInfo } from '../../../../shared/mappingPolicy'
import { useIpcQuery } from '../../ipc/hooks'
import { callIpc, toRdsError } from '../../ipc/client'
import { useWizard } from './WizardShell'
import { useTargetKeys } from './useTargetKeys'
import type { DescribeCache } from './describeCache'
import { OutcomeNote, errNote, okNote, type Note } from '../../ui/OutcomeNote'
import { Loading } from '../../ui/Loading'

const FIELDS_KIND: TemplateKind = 'fields'

interface DeployableField {
  apiName: string
  label: string
  namespace: string | null
  /** First referenced object for reference fields (drives the out-of-scope-ref lock). */
  refTo: string | null
}

/** Describe both orgs (through the shell's describe cache — S64 P5, 5.6a) and return
 *  each object's deployable (source∩target) fields. S64 P5 (5.6b): every object's
 *  pair is requested at once (`Promise.all`), not one object at a time; `onProgress`
 *  still fires as each object's pair resolves (ux F-10: the step used to say
 *  "Loading fields…" for the whole scope with no sign of how far it had got). */
async function loadAllDeployableFields(
  describe: DescribeCache['describe'],
  sourceConnectionId: string,
  targetConnectionId: string,
  objects: string[],
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, DeployableField[]>> {
  const total = objects.length
  let done = 0
  const entries = await Promise.all(
    objects.map(async (obj): Promise<readonly [string, DeployableField[]]> => {
      const [src, tgt] = await Promise.all([
        describe(sourceConnectionId, obj),
        describe(targetConnectionId, obj)
      ])
      // Intersect source-deployable ∩ target-DEPLOYABLE (not just name-present): a field
      // writable on source but read-only/formula/auto-number on the target must be
      // dropped, else the upsert fails for every record (SchemaService.cls:294-298).
      const targetDeployable = new Set(tgt.filter(isDeployableField).map((f) => f.apiName))
      const fields = src
        .filter(isDeployableField)
        .filter((f) => targetDeployable.has(f.apiName))
        .map((f) => ({
          apiName: f.apiName,
          label: f.label || f.apiName,
          namespace: fieldNamespace(f.apiName),
          refTo: f.isReference && f.referenceTo.length > 0 ? (f.referenceTo[0] ?? null) : null
        }))
      done += 1
      onProgress?.(done, total)
      return [obj, fields] as const
    })
  )
  const result: Record<string, DeployableField[]> = {}
  for (const [obj, fields] of entries) result[obj] = fields
  return result
}

/** Probe which fields are non-blank in a source sample per object (fail-open → all populated). */
async function loadPopulated(
  describe: DescribeCache['describe'],
  sourceConnectionId: string,
  targetConnectionId: string,
  objects: string[]
): Promise<Record<string, string[]>> {
  const byObject = await loadAllDeployableFields(describe, sourceConnectionId, targetConnectionId, objects)
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

/** `excludedFields` with `obj` set to `names`. An empty list DELETES the key — a
 *  stored `obj: []` excludes nothing and would only pollute templates/drop-counts. */
function withExcludedFields(
  excludedFields: Record<string, string[]>,
  obj: string,
  names: string[]
): Record<string, string[]> {
  const next = { ...excludedFields }
  if (names.length === 0) delete next[obj]
  else next[obj] = names
  return next
}

// Stable empties so a memoised section doesn't re-render for a fresh `[]`.
const EMPTY_FIELDS: readonly DeployableField[] = []
const EMPTY_NAMES: readonly string[] = []

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
 *
 * S64 P5 (5.6b): each object renders through a memoised `FieldsObjectSection`
 * that owns its expand/search state and memoises its exclusion verdicts, so a
 * keystroke in one object's search (or a checkbox) never re-evaluates every
 * field of every other object.
 */
export function StepFields(): React.JSX.Element {
  const { config, updateConfig, goToStep, sourceConnectionId, targetConnectionId, describe } =
    useWizard()
  const objects = config.selectedObjects
  const scopeKey = objects.join(',')

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

  // Progress is written from inside the fetcher (after each await), never from an effect.
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null)
  const scan = useIpcQuery(
    () =>
      loadAllDeployableFields(
        describe,
        sourceConnectionId,
        targetConnectionId,
        objects,
        (done, total) => setScanProgress({ done, total })
      ),
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
  // S61 (U-5): keyless — never ask the target about keys.
  const { keys: targetKeys } = useTargetKeys(targetConnectionId, isKeyless(config) ? [] : probeCandidates)
  const populated = useIpcQuery(
    () =>
      config.populatedOnly
        ? loadPopulated(describe, sourceConnectionId, targetConnectionId, objects)
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

  // Both callbacks use the UPDATER form of updateConfig: they read the freshest
  // excludedFields (the shell's latest-value ref) and stay referentially stable,
  // which is what lets FieldsObjectSection be memoised.
  const setExcludedFields = useCallback(
    (obj: string, names: string[]): void => {
      updateConfig((prev) => ({ excludedFields: withExcludedFields(prev.excludedFields, obj, names) }))
    },
    [updateConfig]
  )

  const toggleField = useCallback(
    (obj: string, field: string, locked: boolean): void => {
      if (locked) return // double-defense: a namespace/unpopulated lock is not user-toggleable
      updateConfig((prev) => {
        const current = prev.excludedFields[obj] ?? []
        const names = current.includes(field)
          ? current.filter((f) => f !== field)
          : [...current, field]
        return { excludedFields: withExcludedFields(prev.excludedFields, obj, names) }
      })
    },
    [updateConfig]
  )

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
  // when the toggle was off — the hook keeps the last value on error), the
  // sections get null so fieldExclusion excludes nothing — never a fail-closed
  // "all fields excluded".
  const populatedReady =
    config.populatedOnly && !populated.loading && !populated.error && !!populated.data

  return (
    <>
      <h2>Fields</h2>
      <p className="sub">
        Pick which fields deploy on each object. Everything deployable is included by default;
        exclude individual fields, whole managed namespaces, or unpopulated fields.
      </p>

      {scan.loading && (
        <Loading
          label={
            scanProgress && scanProgress.total > 1
              ? `Loading fields — ${scanProgress.done} / ${scanProgress.total} objects…`
              : 'Loading fields…'
          }
        />
      )}
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
              className="select"
              aria-label="Saved fields preset"
              value={selectedTemplateId === '' ? '' : String(selectedTemplateId)}
              onChange={(e) =>
                setSelectedTemplateId(e.target.value === '' ? '' : Number(e.target.value))
              }
            >
              <option value="">— saved presets —</option>
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
              className="input-sm"
              aria-label="Fields preset name"
              placeholder="preset name"
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
                <label key={ns} className="map-detail mr-3">
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
            <Loading label="Sampling populated fields…" />
          )}

          {objects.map((obj) => (
            <FieldsObjectSection
              key={obj}
              objectName={obj}
              fields={scan.data?.[obj] ?? EMPTY_FIELDS}
              selectedObjects={objects}
              excluded={config.excludedFields[obj]}
              excludedNamespaces={config.excludedNamespaces}
              populatedOnly={config.populatedOnly}
              populatedNames={populatedReady ? (populated.data?.[obj] ?? EMPTY_NAMES) : null}
              mappings={config.mappings[obj]}
              targetKeys={targetKeys}
              onSetExcluded={setExcludedFields}
              onToggleField={toggleField}
            />
          ))}
        </>
      )}

      {/* UI-3, same guard as StepMappings: a template apply persists after its
       * await resolves, so leaving mid-apply rewrites the field selection from
       * a step the user has already left. */}
      <div className="toolbar">
        <button className="btn" disabled={templateBusy} onClick={() => goToStep('mappings')}>
          Back
        </button>
        <button className="btn primary" disabled={templateBusy} onClick={() => goToStep('templates')}>
          {nextLabel('templates')}
        </button>
        {templateBusy && <span className="muted">Finishing the current action…</span>}
      </div>
    </>
  )
}

interface FieldsObjectSectionProps {
  objectName: string
  fields: readonly DeployableField[]
  selectedObjects: string[]
  /** `config.excludedFields[objectName]` — undefined when nothing is excluded. */
  excluded: string[] | undefined
  excludedNamespaces: string[]
  populatedOnly: boolean
  /** Populated field names once the probe has loaded for this toggle; null = gate inactive. */
  populatedNames: readonly string[] | null
  /** `config.mappings[objectName]` — a user-chosen 'skip' strips the field too. */
  mappings: Record<string, FieldMapping> | undefined
  targetKeys: TargetKeyInfo
  onSetExcluded: (obj: string, names: string[]) => void
  onToggleField: (obj: string, field: string, locked: boolean) => void
}

type FieldPolicySlice = Parameters<typeof fieldExclusion>[2]

/**
 * One object's include/exclude section (S64 P5, 5.6b). Owns its expand + search
 * state (keyed on the object by the parent, so it resets when the object leaves
 * the scope) and memoises the per-field exclusion verdicts on the policy inputs
 * they actually read — a search keystroke only re-filters the shown rows.
 * Memoised: the parent's callbacks are stable and every other prop is a
 * primitive or a config slice that only changes when THIS object's inputs do.
 */
const FieldsObjectSection = memo(function FieldsObjectSection(
  props: FieldsObjectSectionProps
): React.JSX.Element {
  const {
    objectName,
    fields,
    selectedObjects,
    excluded,
    excludedNamespaces,
    populatedOnly,
    populatedNames,
    mappings,
    targetKeys,
    onSetExcluded,
    onToggleField
  } = props
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')

  // 5.6c: the explicit-exclusion Set, built once per object per change — the
  // O(1) lookup fieldExclusion uses instead of scanning the array per field.
  const excludedSet = useMemo<ReadonlySet<string>>(() => new Set(excluded ?? []), [excluded])
  const popSet = useMemo<ReadonlySet<string> | null>(
    () => (populatedNames ? new Set(populatedNames) : null),
    [populatedNames]
  )
  const policy = useMemo<FieldPolicySlice>(
    () => ({
      excludedFields: excluded ? { [objectName]: excluded } : {},
      excludedNamespaces,
      populatedOnly
    }),
    [excluded, objectName, excludedNamespaces, populatedOnly]
  )

  // The verdict for EVERY field (the header count needs all of them, expanded or
  // not), keyed on the policy inputs only.
  const exclusions = useMemo(() => {
    const out = new Map<string, FieldExclusion>()
    for (const f of fields) {
      out.set(
        f.apiName,
        fieldExclusion(
          f.apiName,
          objectName,
          policy,
          popSet,
          {
            refTo: f.refTo,
            selectedObjects,
            // A user-chosen 'skip' on the Mappings step strips the field too.
            overrideStrategy: mappings?.[f.apiName]?.strategy,
            targetKeys
          },
          excludedSet
        )
      )
    }
    return out
  }, [fields, objectName, policy, popSet, selectedObjects, mappings, targetKeys, excludedSet])

  const includedCount = useMemo(() => {
    let n = 0
    for (const ex of exclusions.values()) if (!ex.excluded) n += 1
    return n
  }, [exclusions])

  const shown = useMemo(() => {
    const q = search.toLowerCase()
    return q
      ? fields.filter(
          (f) => f.apiName.toLowerCase().includes(q) || f.label.toLowerCase().includes(q)
        )
      : fields
  }, [fields, search])

  return (
    <div className="map-object">
      <button
        className="map-object-hdr btn"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {objectName}{' '}
        <span className="muted">
          ({includedCount}/{fields.length} included)
        </span>
      </button>
      {expanded && (
        <div>
          <div className="toolbar">
            <input
              className="input-sm"
              aria-label={`Search fields in ${objectName}`}
              placeholder="search fields"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn" onClick={() => onSetExcluded(objectName, [])}>
              Include all
            </button>
            <button
              className="btn"
              onClick={() =>
                // EVERY deployable field goes into the explicit list — an entry on
                // a currently-locked field is inert while locked (derived reasons
                // win) but preserves the user's exclude-all intent if the lock
                // later lifts (namespace un-excluded, ref back in scope).
                onSetExcluded(
                  objectName,
                  fields.map((f) => f.apiName)
                )
              }
            >
              Exclude all
            </button>
          </div>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Include</th>
                <th>Field</th>
                <th>Namespace</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const ex = exclusions.get(f.apiName) ?? { excluded: false }
                const locked = isFieldLocked(ex.reason)
                return (
                  <tr key={f.apiName}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include ${f.apiName}`}
                        checked={!ex.excluded}
                        disabled={locked}
                        onChange={() => onToggleField(objectName, f.apiName, locked)}
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
                        (mappings?.[f.apiName]?.strategy === 'skip' ? (
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
})
