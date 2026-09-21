import { useMemo, useState } from 'react'
import type { FieldInfo, Template, TemplateKind } from '../../../../shared/types'
import type { FieldMapping, MappingStrategy } from '../../../../shared/wizard'
import {
  DIRECT_ID_DEFAULT_REFS,
  NO_TARGET_KEYS,
  defaultMatchField,
  effectiveStrategy,
  isHiddenRefField,
  isStrategyLocked,
  isUnlockedByTargetKey,
  lockBadge,
  reconcileTemplateMappings,
  strategyOptionsFor,
  targetKeyProbeCandidates,
  type RefFieldRef,
  type TargetKeyInfo
} from '../../../../shared/mappingPolicy'
import { isDeployableField } from '../../../../shared/fieldPolicy'
import { useIpcQuery } from '../../ipc/hooks'
import { callIpc, toRdsError } from '../../ipc/client'
import { useWizard } from './WizardShell'
import { useTargetKeys } from './useTargetKeys'
import { OutcomeNote, errNote, okNote, type Note } from '../../ui/OutcomeNote'

const MAPPINGS_KIND: TemplateKind = 'mappings'

/** Which async bulk action is in flight, so the spinner names the right work. */
type BusyAction = 'suggest' | 'template' | null

/**
 * Describe both orgs (cached) and return the deployable (source∩target) reference
 * fields with their first `referenceTo`. Shared by Suggest and template-apply so
 * both act only on fields that exist on BOTH orgs (mirrors Apex getDeployableFields).
 */
async function deployableRefFields(
  sourceConnectionId: string,
  targetConnectionId: string,
  objectName: string
): Promise<RefFieldRef[]> {
  // Route through callIpc so an AUTH_EXPIRED describe surfaces the re-auth prompt
  // (raw window.rds calls bypass that); still throws so callers can handle failure.
  const [src, tgt] = await Promise.all([
    callIpc(() => window.rds.describeObject(sourceConnectionId, objectName)),
    callIpc(() => window.rds.describeObject(targetConnectionId, objectName))
  ])
  // BOTH-side deployability (isCreateable/!calculated/!autoNumber/!system-managed)
  // mirrors Apex getDeployableFields — raw describes would surface CreatedById/
  // LastModifiedById etc. as mappable rows the plan freeze then discards
  // (E2.6 review fix).
  const targetByName = new Map(tgt.filter((f) => isDeployableField(f)).map((f) => [f.apiName, f]))
  return src
    .filter((f) => f.isReference && f.referenceTo.length > 0)
    .filter((f) => !isHiddenRefField(f.apiName, f.referenceTo[0]))
    .filter((f) => isDeployableField(f) && targetByName.has(f.apiName))
    .map((f) => ({ fieldName: f.apiName, refTo: f.referenceTo[0] as string }))
}

/**
 * Wizard Step 4 — Mappings. For every in-scope object, a per-reference-field table
 * offering the 6 strategies (externalId / nameMatch / directId / customId / setToMe /
 * skip). Defaults + lock rules come from the single-source `mappingPolicy` (never
 * re-derived here). Only user *overrides* are persisted into `config.mappings`
 * (sparse) — defaults and locks are recomputed live, so the table never goes stale
 * when the scope changes. A source sample-value column surfaces typed query errors
 * instead of silent blanks (pain 3.17). Suggest, Reset and mapping templates are
 * offered as bulk actions.
 *
 * Objects describe lazily on expand (describe is SQLite-cached). Phase-2 orphan
 * locks from reference-coverage analysis are a 5B.3-followup — not wired yet.
 */
export function StepMappings(): React.JSX.Element {
  const { config, updateConfig, goToStep, sourceConnectionId, targetConnectionId } = useWizard()
  const objects = config.selectedObjects
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Target connected user, shown for "Set to Me". Non-blocking: the table renders
  // regardless. The deploy engine resolves the real target user at run time.
  const targetUser = useIpcQuery(
    () => window.rds.verifyOrg(targetConnectionId),
    [targetConnectionId]
  )
  const targetUserLabel = targetUser.data?.username ?? 'target connected user'

  const templates = useIpcQuery(() => window.rds.templateList(MAPPINGS_KIND), [])
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | ''>('')
  const [templateName, setTemplateName] = useState('')

  // A single busy flag freezes the strategy selects during any async bulk action
  // (Suggest / template apply) so a concurrent edit can't be clobbered, and UI-3
  // extends it to the wizard toolbar. It records WHICH action is running so the
  // spinner sits beside the control actually clicked — a spinner next to Suggest
  // during a template apply would name the wrong work.
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const busy = busyAction !== null
  const [note, setNote] = useState<Note | undefined>()
  const ok = (text: string): void => setNote(okNote(text))
  const err = (text: string): void => setNote(errNote(text))

  const toggle = (obj: string): void => setExpanded((e) => ({ ...e, [obj]: !e[obj] }))

  // Persist a single field's override (or clear it). Reads the current config
  // snapshot each call (fresh per render) and shallow-merges the whole mappings map.
  const setFieldMapping = (obj: string, field: string, mapping: FieldMapping | undefined): void => {
    const objMap = { ...(config.mappings[obj] ?? {}) }
    if (mapping) objMap[field] = mapping
    else delete objMap[field]
    updateConfig({ mappings: { ...config.mappings, [obj]: objMap } })
  }

  // Suggest: probe live Id-overlap and apply directId-vs-nameMatch to every
  // directId-default reference (unlocked) across all in-scope objects. Non-directId
  // refs and any user edits on them are left untouched (Reset clears everything).
  const runSuggest = async (): Promise<void> => {
    setBusyAction('suggest')
    setNote(undefined)
    try {
      const s = await callIpc(() =>
        window.rds.mappingsSuggest({ sourceConnectionId, targetConnectionId })
      )
      const nextMappings = { ...config.mappings }
      let toDirectId = 0
      let toNameMatch = 0
      for (const obj of objects) {
        let refFields: RefFieldRef[]
        try {
          refFields = await deployableRefFields(sourceConnectionId, targetConnectionId, obj)
        } catch {
          continue // best-effort: an un-describable object is skipped
        }
        const objMap = { ...(nextMappings[obj] ?? {}) }
        for (const rf of refFields) {
          if (!DIRECT_ID_DEFAULT_REFS.has(rf.refTo)) continue
          if (isStrategyLocked(rf.refTo, obj, objects)) continue
          const verdict = s.recommendationByObject[rf.refTo] ?? s.recommendation
          objMap[rf.fieldName] = { ...(objMap[rf.fieldName] ?? {}), strategy: verdict }
          if (verdict === 'directId') toDirectId++
          else toNameMatch++
        }
        nextMappings[obj] = objMap
      }
      updateConfig({ mappings: nextMappings })
      // Always report BOTH counts — a directId org-wide verdict can still flip
      // divergent CPQ catalog refs to nameMatch (per-object verdict), so a
      // "share record Ids" summary that hid the nameMatch count would mislead.
      const parts: string[] = []
      if (toDirectId > 0) parts.push(`${toDirectId} to Direct ID`)
      if (toNameMatch > 0) parts.push(`${toNameMatch} to Name Match`)
      const body = parts.length > 0 ? parts.join(', ') : 'no directId-default references in scope'
      ok(
        toNameMatch === 0
          ? `Orgs share record Ids — ${body}.`
          : `Applied suggestions — ${body} (some record Ids diverge across orgs).`
      )
    } catch (e) {
      err(`Suggest failed: ${toRdsError(e).message}`)
    } finally {
      setBusyAction(null)
    }
  }

  const resetDefaults = (): void => {
    updateConfig({ mappings: {} })
    ok('Reset all mappings to policy defaults.')
  }

  const selectedTemplate = (): Template | undefined =>
    templates.data?.find((t) => t.id === selectedTemplateId)

  const saveCurrentAsTemplate = async (): Promise<void> => {
    const name = templateName.trim()
    if (!name) return
    setBusyAction('template')
    setNote(undefined)
    try {
      // saveTemplate is an upsert on (kind, name) — say so instead of silently clobbering.
      const overwriting = templates.data?.some((t) => t.name === name) ?? false
      const saved = await callIpc(() =>
        window.rds.templateSave({ kind: MAPPINGS_KIND, name, payload: config.mappings })
      )
      setTemplateName('')
      templates.refetch()
      setSelectedTemplateId(saved.id)
      ok(overwriting ? `Overwrote template "${saved.name}".` : `Saved template "${saved.name}".`)
    } catch (e) {
      err(`Save failed: ${toRdsError(e).message}`)
    } finally {
      setBusyAction(null)
    }
  }

  // Apply: merge the template's overrides into the current mappings, but re-validate
  // against the live scope — an entry whose reference is now locked (out-of-scope /
  // self) is dropped and counted, so a stale template can't reintroduce a bad mapping.
  const applyTemplate = async (): Promise<void> => {
    const t = selectedTemplate()
    if (!t) return
    setBusyAction('template')
    setNote(undefined)
    try {
      const payload = t.payload as Record<string, Record<string, FieldMapping>>
      // Reconcile only the in-scope objects we could actually describe. A describe
      // FAILURE must NOT be conflated with "no reference fields" — otherwise the
      // object's entries would be silently dropped as schema-drift and the apply
      // would falsely report success. Failed objects are excluded and reported.
      const describable: Record<string, Record<string, FieldMapping>> = {}
      const refFieldsByObject: Record<string, RefFieldRef[]> = {}
      const failed: string[] = []
      for (const obj of Object.keys(payload)) {
        if (!objects.includes(obj)) continue
        const entries = payload[obj]
        if (!entries) continue
        try {
          refFieldsByObject[obj] = await deployableRefFields(
            sourceConnectionId,
            targetConnectionId,
            obj
          )
          describable[obj] = entries
        } catch {
          failed.push(obj)
        }
      }
      // S57 (B1): a template entry pointing at a parent the TARGET can key is
      // kept (External ID resolves against RDS-keyed rows there), not dropped as
      // "parent not in this deployment". Fail-open to the pre-S57 lock.
      let targetKeys: TargetKeyInfo = NO_TARGET_KEYS
      const candidates = new Set<string>()
      for (const [obj, refs] of Object.entries(refFieldsByObject)) {
        for (const c of targetKeyProbeCandidates(
          refs.map((r) => r.refTo),
          obj,
          objects
        )) {
          candidates.add(c)
        }
      }
      if (candidates.size > 0) {
        try {
          const r = await callIpc(() =>
            window.rds.targetKeyedObjects({ targetConnectionId, objectNames: [...candidates] })
          )
          targetKeys = { hasField: new Set(r.hasField), keyedRows: new Set(r.keyedRows) }
        } catch {
          targetKeys = NO_TARGET_KEYS
        }
      }
      const { mappings: applied, corrected } = reconcileTemplateMappings(
        describable,
        refFieldsByObject,
        objects,
        targetKeys
      )
      const next = { ...config.mappings }
      for (const obj of Object.keys(applied)) {
        const objApplied = applied[obj]
        if (!objApplied) continue
        next[obj] = { ...(next[obj] ?? {}), ...objApplied }
      }
      updateConfig({ mappings: next })
      let msg =
        corrected > 0
          ? `Applied "${t.name}" — ${corrected} mapping${corrected === 1 ? '' : 's'} skipped (parent not in this deployment).`
          : `Applied template "${t.name}".`
      if (failed.length > 0) {
        msg += ` ${failed.length} object${failed.length === 1 ? '' : 's'} could not be described and ${failed.length === 1 ? 'was' : 'were'} not applied — retry: ${failed.join(', ')}.`
      }
      ok(msg)
    } catch (e) {
      err(`Apply failed: ${toRdsError(e).message}`)
    } finally {
      setBusyAction(null)
    }
  }

  const renameSelectedTemplate = async (): Promise<void> => {
    const t = selectedTemplate()
    const name = templateName.trim()
    if (!t || !name) return
    setBusyAction('template')
    setNote(undefined)
    try {
      await callIpc(() => window.rds.templateRename({ id: t.id, name }))
      setTemplateName('')
      templates.refetch()
      ok(`Renamed to "${name}".`)
    } catch (e) {
      err(`Rename failed: ${toRdsError(e).message}`)
    } finally {
      setBusyAction(null)
    }
  }

  const deleteSelectedTemplate = async (): Promise<void> => {
    const t = selectedTemplate()
    if (!t) return
    setBusyAction('template')
    setNote(undefined)
    try {
      await callIpc(() => window.rds.templateDelete(t.id))
      setSelectedTemplateId('')
      templates.refetch()
      ok(`Deleted "${t.name}".`)
    } catch (e) {
      err(`Delete failed: ${toRdsError(e).message}`)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <>
      <h2>Mappings</h2>
      <p className="sub">
        Choose how each reference field resolves on the target. Defaults follow the object-gating
        policy. Self-references are locked to Skip, and so is a reference to an object outside this
        deployment — unless the target already carries that object&apos;s External Id field, in
        which case it can resolve against the RDS-keyed rows already there. Only your changes are
        saved.
      </p>

      {objects.length > 0 && (
        <>
          <div className="toolbar">
            {/*
             * The label no longer swaps to "Working…": the spinner carries the
             * in-flight state, and a button whose text changes also changes
             * width, which made the whole row jump. The spinner is rendered only
             * for `busyAction === 'suggest'` so it never claims a template
             * apply is a Suggest.
             */}
            <button className="btn" disabled={busy} onClick={() => void runSuggest()}>
              Suggest mappings
              {busyAction === 'suggest' && <span className="spinner" aria-hidden="true" />}
            </button>
            <button className="btn" disabled={busy} onClick={resetDefaults}>
              Reset to defaults
            </button>
          </div>
          <div className="toolbar">
            <select
              className="map-strategy"
              aria-label="Saved mapping template"
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
              disabled={busy || selectedTemplateId === ''}
              onClick={() => void applyTemplate()}
            >
              Apply
            </button>
            <button
              className="btn"
              disabled={busy || selectedTemplateId === '' || !templateName.trim()}
              onClick={() => void renameSelectedTemplate()}
            >
              Rename
            </button>
            <button
              className="btn"
              disabled={busy || selectedTemplateId === ''}
              onClick={() => void deleteSelectedTemplate()}
            >
              Delete
            </button>
            <input
              className="map-matchfield"
              aria-label="Template name"
              placeholder="template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <button
              className="btn"
              disabled={busy || !templateName.trim()}
              onClick={() => void saveCurrentAsTemplate()}
            >
              Save as
            </button>
          </div>
        </>
      )}
      <OutcomeNote note={note} />

      {objects.length === 0 ? (
        <p className="muted">No objects in scope yet — add some in the Scope step.</p>
      ) : (
        objects.map((obj) => (
          <div key={obj} className="map-object">
            <button
              className="map-object-hdr btn"
              aria-expanded={!!expanded[obj]}
              onClick={() => toggle(obj)}
            >
              {expanded[obj] ? '▾' : '▸'} {obj}
            </button>
            {expanded[obj] && (
              <ObjectMappingTable
                objectName={obj}
                selectedObjects={objects}
                overrides={config.mappings[obj] ?? {}}
                sourceConnectionId={sourceConnectionId}
                targetConnectionId={targetConnectionId}
                targetUserLabel={targetUserLabel}
                disabled={busy}
                setFieldMapping={setFieldMapping}
              />
            )}
          </div>
        ))
      )}

      {/*
       * UI-3: the toolbar is part of the `busy` guard, not exempt from it.
       * Navigating away mid-Suggest does not corrupt the config (updateConfig
       * merges over the freshest snapshot via the S35 latest-value refs), but
       * the write still lands after the user has left — so their mappings get
       * rewritten by an action they walked away from, and the resulting
       * "Applied suggestions" / "Suggest failed" note renders on a step they
       * are no longer looking at. A failed Suggest would pass unnoticed.
       */}
      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={() => goToStep('readiness')}>
          Back
        </button>
        <button className="btn primary" disabled={busy} onClick={() => goToStep('fields')}>
          Next: fields
        </button>
        {busy && <span className="muted">Finishing the current action…</span>}
      </div>
    </>
  )
}

interface RefField {
  fieldName: string
  label: string
  refTo: string
}

interface ObjectMappingTableProps {
  objectName: string
  selectedObjects: string[]
  overrides: Record<string, FieldMapping>
  sourceConnectionId: string
  targetConnectionId: string
  targetUserLabel: string
  /** Selects/inputs are frozen while a Suggest probe is applying (avoids a lost-update race). */
  disabled: boolean
  setFieldMapping: (obj: string, field: string, mapping: FieldMapping | undefined) => void
}

/** One object's reference-field mapping table. Mounts only when the section is expanded. */
function ObjectMappingTable(props: ObjectMappingTableProps): React.JSX.Element {
  const { objectName, selectedObjects, overrides, sourceConnectionId, targetConnectionId } = props

  // Describe BOTH orgs and intersect field API names: a reference field present
  // only on the source would fail at upsert, so it must never be mappable — this
  // mirrors the Apex LWC's getDeployableFields(source∩target) (deploymentMappings.js
  // L296-302). Both describes are SQLite-cached, so two calls are cheap.
  const srcDescribe = useIpcQuery(
    () => window.rds.describeObject(sourceConnectionId, objectName),
    [sourceConnectionId, objectName]
  )
  const tgtDescribe = useIpcQuery(
    () => window.rds.describeObject(targetConnectionId, objectName),
    [targetConnectionId, objectName]
  )

  const refFields: RefField[] = useMemo(() => {
    const src: FieldInfo[] = srcDescribe.data ?? []
    const tgt = tgtDescribe.data
    // Wait for the target describe before intersecting — otherwise a source-only
    // field would flash as mappable until the target resolves.
    if (!tgt) return []
    // BOTH-side deployability — mirrors Apex getDeployableFields; the raw
    // describe would render CreatedById/formula lookups as mappable rows the
    // plan freeze then silently discards (E2.6 review fix).
    const targetByName = new Map(tgt.filter((f) => isDeployableField(f)).map((f) => [f.apiName, f]))
    return src
      .filter((f) => f.isReference && f.referenceTo.length > 0)
      .filter((f) => !isHiddenRefField(f.apiName, f.referenceTo[0]))
      .filter((f) => isDeployableField(f) && targetByName.has(f.apiName))
      .map((f) => ({
        fieldName: f.apiName,
        label: f.label || f.apiName,
        refTo: f.referenceTo[0] as string
      }))
  }, [srcDescribe.data, tgtDescribe.data])

  const fieldNamesKey = refFields.map((f) => f.fieldName).join(',')

  // S57 (B1): ask the target about the parents this object references that are
  // NOT in the plan (cached in main, fail-open to the pre-S57 lock).
  const probeCandidates = useMemo(
    () =>
      targetKeyProbeCandidates(
        refFields.map((f) => f.refTo),
        objectName,
        selectedObjects
      ),
    [refFields, objectName, selectedObjects]
  )
  const { keys: targetKeys } = useTargetKeys(targetConnectionId, probeCandidates)

  const sample = useIpcQuery(
    () =>
      window.rds.sampleGet({
        connectionId: sourceConnectionId,
        objectName,
        fieldNames: refFields.map((f) => f.fieldName)
      }),
    [sourceConnectionId, objectName, fieldNamesKey]
  )

  const describeLoading = srcDescribe.loading || tgtDescribe.loading
  const describeError = srcDescribe.error ?? tgtDescribe.error
  const retryDescribe = (): void => {
    srcDescribe.refetch()
    tgtDescribe.refetch()
  }

  if (describeLoading) return <p className="muted">Loading fields for {objectName}…</p>
  if (describeError) {
    return (
      <div className="banner">
        {describeError.message}{' '}
        <button className="btn" onClick={retryDescribe}>
          Retry
        </button>
      </div>
    )
  }
  if (refFields.length === 0) {
    return (
      <p className="muted">No reference fields to map on {objectName} (present on both orgs).</p>
    )
  }

  const sampleErr = sample.data && !sample.data.ok ? sample.data.error : undefined
  // Distinguish "sample query still in flight" from "field is genuinely empty":
  // describe is cached (fast) but sample is a live query, so there is a routine
  // window where the table renders before the sample resolves.
  const samplePending = !sample.data && sample.loading
  const sampleValues = sample.data?.ok ? (sample.data.values ?? {}) : {}

  return (
    <>
      {sampleErr && (
        <div className="banner warn" title={sampleErr}>
          Sample values unavailable: {sampleErr}
        </div>
      )}
      <table className="orgs">
        <thead>
          <tr>
            <th>Field</th>
            <th>References</th>
            <th>Sample</th>
            <th>Strategy</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {refFields.map((f) => (
            <MappingRow
              key={f.fieldName}
              objectName={objectName}
              field={f}
              selectedObjects={selectedObjects}
              targetKeys={targetKeys}
              override={overrides[f.fieldName]}
              sampleValue={sampleValues[f.fieldName]}
              sampleErrored={!!sampleErr}
              samplePending={samplePending}
              targetUserLabel={props.targetUserLabel}
              disabled={props.disabled}
              setFieldMapping={props.setFieldMapping}
            />
          ))}
        </tbody>
      </table>
    </>
  )
}

interface MappingRowProps {
  objectName: string
  field: RefField
  selectedObjects: string[]
  /** S57 (B1): what the target knows about out-of-scope parents. */
  targetKeys: TargetKeyInfo
  override: FieldMapping | undefined
  sampleValue: unknown
  sampleErrored: boolean
  samplePending: boolean
  targetUserLabel: string
  disabled: boolean
  setFieldMapping: (obj: string, field: string, mapping: FieldMapping | undefined) => void
}

function MappingRow(props: MappingRowProps): React.JSX.Element {
  const { objectName, field, selectedObjects, override, sampleValue, sampleErrored, targetKeys } =
    props
  const { refTo } = field

  const locked = isStrategyLocked(refTo, objectName, selectedObjects, targetKeys)
  // S57 (B1): the ONE policy call — the Fields step and the plan freeze make the
  // same one, so what this row shows is what deploys.
  const effective: MappingStrategy = effectiveStrategy(
    refTo,
    objectName,
    selectedObjects,
    override?.strategy,
    targetKeys
  )
  const chosen: MappingStrategy = effective
  const unlockedByTarget = !locked && isUnlockedByTargetKey(refTo, selectedObjects, targetKeys)
  const matchField = override?.matchField ?? defaultMatchField(refTo)
  const customValue = override?.customValue ?? ''

  // Carry the existing override forward so an edited matchField/customValue
  // survives strategy toggles (mirrors the Apex LWC's `...f` spread — an edited
  // key must not silently revert to the default when you switch away and back).
  const onStrategyChange = (strat: MappingStrategy): void => {
    const next: FieldMapping = { ...(override ?? {}), strategy: strat }
    if (strat === 'nameMatch' && !next.matchField) next.matchField = defaultMatchField(refTo)
    if (strat === 'customId' && next.customValue == null) next.customValue = ''
    props.setFieldMapping(objectName, field.fieldName, next)
  }

  const sampleCell = sampleErrored ? (
    <span className="muted">—</span>
  ) : props.samplePending ? (
    <span className="muted">…</span>
  ) : sampleValue != null ? (
    <span title={String(sampleValue)}>{truncate(String(sampleValue), 18)}</span>
  ) : (
    <span className="muted">— (empty)</span>
  )

  return (
    <tr>
      <td>
        {field.label}
        <br />
        <span className="muted">{field.fieldName}</span>
      </td>
      <td>{refTo}</td>
      <td>{sampleCell}</td>
      <td>
        {locked ? (
          <span className="status-warn" title={lockBadge(refTo, objectName)}>
            Skip 🔒
          </span>
        ) : (
          <select
            className="map-strategy"
            aria-label={`Strategy for ${field.fieldName}`}
            value={chosen}
            disabled={props.disabled}
            onChange={(e) => onStrategyChange(e.target.value as MappingStrategy)}
          >
            {strategyOptionsFor(refTo, unlockedByTarget).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </td>
      <td>
        {locked ? (
          <span className="muted">{lockBadge(refTo, objectName)}</span>
        ) : (
          <>
            <DetailCell
              objectName={objectName}
              field={field}
              effective={effective}
              matchField={matchField}
              customValue={customValue}
              targetUserLabel={props.targetUserLabel}
              disabled={props.disabled}
              setFieldMapping={props.setFieldMapping}
            />
            {unlockedByTarget && (
              <div className="muted" data-testid={`target-key-${field.fieldName}`}>
                {lockBadge(refTo, objectName, targetKeys)}
              </div>
            )}
          </>
        )}
      </td>
    </tr>
  )
}

interface DetailCellProps {
  objectName: string
  field: RefField
  effective: MappingStrategy
  matchField: string
  customValue: string
  targetUserLabel: string
  disabled: boolean
  setFieldMapping: (obj: string, field: string, mapping: FieldMapping | undefined) => void
}

/** Strategy-specific detail: nameMatch key input, customId value input, or a preview. */
function DetailCell(props: DetailCellProps): React.JSX.Element {
  const { objectName, field, effective, matchField, customValue, targetUserLabel } = props
  switch (effective) {
    case 'nameMatch':
      return (
        <label className="map-detail">
          matched by{' '}
          <input
            className="map-matchfield"
            aria-label={`Match field for ${field.fieldName}`}
            value={matchField}
            disabled={props.disabled}
            onChange={(e) =>
              props.setFieldMapping(objectName, field.fieldName, {
                strategy: 'nameMatch',
                matchField: e.target.value
              })
            }
          />
        </label>
      )
    case 'customId':
      return (
        <label className="map-detail">
          value{' '}
          <input
            className="map-customvalue"
            aria-label={`Custom value for ${field.fieldName}`}
            // customId writes the value verbatim onto a target reference (Id) field;
            // cap at 18 chars to match the Apex LWC and avoid the Id-overflow scar.
            maxLength={18}
            value={customValue}
            disabled={props.disabled}
            onChange={(e) =>
              props.setFieldMapping(objectName, field.fieldName, {
                strategy: 'customId',
                customValue: e.target.value.slice(0, 18)
              })
            }
          />
        </label>
      )
    case 'setToMe':
      return <span className="muted">= {targetUserLabel}</span>
    case 'externalId':
      return <span className="muted">via External Id</span>
    case 'directId':
      return <span className="muted">copy source Id</span>
    default:
      return <span className="muted">omitted</span>
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
