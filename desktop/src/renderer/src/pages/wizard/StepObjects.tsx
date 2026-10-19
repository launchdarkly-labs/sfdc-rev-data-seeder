import { useState } from 'react'
import type { Template, TemplateKind } from '../../../../shared/types'
import { nextLabel, reconcileObjectsTemplate } from '../../../../shared/wizard'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { Loading } from '../../ui/Loading'
import { ObjectPicker } from '../../ui/ObjectPicker'
import { OutcomeNote, errNote, okNote, type Note } from '../../ui/OutcomeNote'
import { SelectionPills } from '../../ui/SelectionPills'
import { useWizard } from './WizardShell'

const OBJECTS_KIND: TemplateKind = 'objects'

/**
 * Wizard Step 2 — WHICH objects to deploy. Split out of the old Scope step in
 * S49 (UI-2a): that one step carried the 1,550-row object picker, the scope
 * mode and a WHERE-clause row per selected object all at once. Scope mode +
 * filters now live on Step 3.
 *
 * Gate: at least one object selected.
 *
 * ORPHAN-FILTER RULE (UI-2e): deselecting an object here DROPS its WHERE
 * clause. Otherwise a filter for an object that is no longer in scope survives
 * in the draft, rides into the frozen plan, and silently narrows — or fails —
 * a deploy the user believes is unfiltered. Selection and filters are edited on
 * different steps now, so nothing else would ever reconcile them.
 *
 * TEMPLATES (UI-5): the `'objects'` TemplateKind existed since S49 and was
 * wired to nothing, so the same 11-object selection was rebuilt by hand for
 * every deployment. A template here carries ONLY the object list — filters
 * moved to Step 3 in UI-2a and have their own persistence, so bundling them
 * would re-couple what that split deliberately separated.
 */
export function StepObjects(): React.JSX.Element {
  const { sourceConnectionId, targetConnectionId, config, updateConfig, goToStep } = useWizard()
  const { data, loading, error, refetch } = useIpcQuery(
    () => window.rds.objectsIntersection({ sourceConnectionId, targetConnectionId }),
    [sourceConnectionId, targetConnectionId]
  )

  const templates = useIpcQuery(() => window.rds.templateList(OBJECTS_KIND), [])
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | ''>('')
  const [templateName, setTemplateName] = useState('')
  const [templateBusy, setTemplateBusy] = useState(false)
  const [note, setNote] = useState<Note | undefined>()
  const ok = (text: string): void => setNote(okNote(text))
  const err = (text: string): void => setNote(errNote(text))

  const selected = config.selectedObjects

  function setSelected(next: string[]): void {
    const keep = new Set(next)
    // Drop filters for objects that just left the selection.
    const filters: Record<string, string> = {}
    for (const [obj, clause] of Object.entries(config.filters)) {
      if (keep.has(obj)) filters[obj] = clause
    }
    updateConfig({ selectedObjects: next, filters })
  }

  const selectedTemplate = (): Template | undefined =>
    templates.data?.find((t) => t.id === selectedTemplateId)

  const saveCurrentAsTemplate = async (): Promise<void> => {
    const name = templateName.trim()
    if (!name) return
    setTemplateBusy(true)
    setNote(undefined)
    try {
      // templateSave is an upsert on (kind, name) — say so rather than silently
      // clobbering a preset the user meant to keep.
      const overwriting = templates.data?.some((t) => t.name === name) ?? false
      const saved = await callIpc(() =>
        window.rds.templateSave({ kind: OBJECTS_KIND, name, payload: { objects: selected } })
      )
      setTemplateName('')
      templates.refetch()
      setSelectedTemplateId(saved.id)
      ok(
        `${overwriting ? 'Overwrote' : 'Saved'} template "${saved.name}" — ${selected.length} object${
          selected.length === 1 ? '' : 's'
        }.`
      )
    } catch (e) {
      err(`Save failed: ${toRdsError(e).message}`)
    } finally {
      setTemplateBusy(false)
    }
  }

  /**
   * Apply REPLACES the selection rather than merging into it. A saved object set
   * is a complete statement of what to deploy, and a merge could only ever grow
   * it — there would be no way to use a template to deploy *less*.
   *
   * Routed through `setSelected` so the orphan-filter rule above still holds:
   * applying a narrower template drops the filters of the objects it removes.
   */
  // S59 (F2 / FB-11): a template that still carries an object that can never be
  // keyed (CampaignMemberStatus) is remembered so one click writes it back clean.
  const [cleanable, setCleanable] = useState<{ template: Template; objects: string[]; unkeyable: string[] } | null>(null)

  const applyTemplate = (): void => {
    const t = selectedTemplate()
    if (!t || !data) return
    const available = data.objects.filter((o) => o.inSource && o.inTarget).map((o) => o.apiName)
    const r = reconcileObjectsTemplate(t.payload, available)
    setSelected(r.objects)
    setCleanable(r.unkeyable.length > 0 ? { template: t, objects: r.objects, unkeyable: r.unkeyable } : null)
    const body = `${r.objects.length} object${r.objects.length === 1 ? '' : 's'} selected`
    const parts: string[] = []
    if (r.dropped.length > 0) {
      // Name them: "3 dropped" leaves the user unable to tell a harmless
      // package difference from the object they actually needed.
      parts.push(`${r.dropped.length} not deployable in both orgs and dropped (${r.dropped.join(', ')})`)
    }
    if (r.unkeyable.length > 0) {
      parts.push(
        `${r.unkeyable.length} can never carry the External Id field and ${r.unkeyable.length === 1 ? 'was' : 'were'} dropped (${r.unkeyable.join(', ')})`
      )
    }
    ok(`Applied "${t.name}" — ${body}${parts.length ? `; ${parts.join('; ')}` : ''}.`)
  }

  const saveCleanedTemplate = async (): Promise<void> => {
    if (!cleanable) return
    setTemplateBusy(true)
    setNote(undefined)
    try {
      const saved = await callIpc(() =>
        window.rds.templateSave({ kind: OBJECTS_KIND, name: cleanable.template.name, payload: { objects: cleanable.objects } })
      )
      templates.refetch()
      setSelectedTemplateId(saved.id)
      setCleanable(null)
      ok(`Updated template "${saved.name}" without ${cleanable.unkeyable.join(', ')} — ${cleanable.objects.length} object${cleanable.objects.length === 1 ? '' : 's'}.`)
    } catch (e) {
      err(`Save failed: ${toRdsError(e).message}`)
    } finally {
      setTemplateBusy(false)
    }
  }

  const renameSelectedTemplate = async (): Promise<void> => {
    const t = selectedTemplate()
    const name = templateName.trim()
    if (!t || !name) return
    setTemplateBusy(true)
    setNote(undefined)
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
    setNote(undefined)
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

  return (
    <>
      <h2>Choose objects</h2>
      <p className="muted">
        Only objects present in BOTH orgs are selectable. Scope mode and per-object filters come
        next.
      </p>

      {loading && <Loading label="Loading objects…" />}
      {error && (
        <div className="banner">
          {error.message}{' '}
          <button className="btn" onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="toolbar">
            <select
              className="select"
              aria-label="Saved objects preset"
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
              aria-label="Objects preset name"
              placeholder="preset name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <button
              className="btn"
              // Saving an empty selection would produce a template that
              // deselects everything on apply — a footgun, not a preset.
              disabled={templateBusy || !templateName.trim() || selected.length === 0}
              onClick={() => void saveCurrentAsTemplate()}
            >
              Save as
            </button>
          </div>
          <OutcomeNote note={note} />
          {cleanable && (
            <div className="banner warn" role="status" data-testid="template-cleanup">
              The template &ldquo;{cleanable.template.name}&rdquo; still lists {cleanable.unkeyable.join(', ')}, which the platform
              allows no custom fields on — every deployment built from it would land on a red Readiness row.{' '}
              <button className="btn btn-small" disabled={templateBusy} onClick={() => void saveCleanedTemplate()}>
                Save the template without {cleanable.unkeyable.length === 1 ? 'it' : 'them'}
              </button>
            </div>
          )}

          <SelectionPills
            selected={selected}
            onRemove={(obj) => setSelected(selected.filter((s) => s !== obj))}
            onClear={() => setSelected([])}
          />

          <ObjectPicker objects={data.objects} selected={selected} onChange={setSelected} />

          {/* UI-3: the toolbar is inside the busy guard like every other step. */}
          <div className="toolbar">
            <button className="btn" disabled={templateBusy} onClick={() => goToStep('orgs')}>
              Back
            </button>
            <button
              className="btn primary"
              disabled={selected.length === 0 || templateBusy}
              onClick={() => goToStep('scope')}
            >
              {nextLabel('scope', `(${selected.length} selected)`)}
            </button>
            {templateBusy && <span className="muted">Finishing the current action…</span>}
          </div>
        </>
      )}
    </>
  )
}
