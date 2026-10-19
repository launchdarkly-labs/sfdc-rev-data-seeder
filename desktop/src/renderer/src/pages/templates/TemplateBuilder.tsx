import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { OrgConnection } from '../../../../shared/types'
import {
  TEMPLATE_KIND_LABELS,
  emptyPostRefreshTemplate,
  emptySeedTemplate,
  isRunnableKind,
  type PostRefreshTemplate,
  type RunnableTemplateKind,
  type SeedTemplate,
  type TemplateDetail
} from '../../../../shared/templates/types'
import { validateTemplate, type ValidationError } from '../../../../shared/templates/validate'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { useToast } from '../../ui/Toast'
import { SeedBuilder } from './SeedBuilder'
import { PostRefreshBuilder } from './PostRefreshBuilder'
import { ReadFromPicker, livePickable, orgsForScope, type OrgScope } from './templateUi'

/**
 * /templates/new and /templates/:id/edit — the template BUILDER (S59 plan
 * §2.2). Header: Name · Type (default Data seed, locked after save) ·
 * Description · Read from (source orgs by default). Everything below reads
 * from the picked org only; the template stores API names plus a `builtFrom`
 * hint. Save validates (shared/templates/validate) and lists errors by field.
 *
 * The page fetches; the FORM below initialises its state from the loaded
 * template once (keyed on the template id) — no state is set inside effects.
 */
export function TemplateBuilderPage(): React.JSX.Element {
  const { id } = useParams()
  const templateId = id != null ? Number(id) : null
  const editing = templateId != null && Number.isInteger(templateId) && templateId > 0
  const orgsQ = useIpcQuery(() => window.rds.listOrgs(), [])
  const existing = useIpcQuery(() => (editing ? window.rds.templateGet(templateId) : Promise.resolve(null)), [templateId])

  if (editing && existing.loading) {
    return (
      <>
        <h1>Template</h1>
        <p className="muted">Loading…</p>
      </>
    )
  }
  if (editing && (existing.error || !existing.data)) {
    return (
      <>
        <h1>Template</h1>
        <div className="banner">{existing.error?.message ?? 'Template not found.'}</div>
        <Link to="/templates">Back to templates</Link>
      </>
    )
  }
  if (editing && existing.data && !isRunnableKind(existing.data.kind)) {
    return (
      <>
        <h1>Template</h1>
        <div className="banner">Only Data seed and Post-refresh templates open in the builder. Wizard templates are edited on their wizard steps.</div>
        <Link to="/templates">Back to templates</Link>
      </>
    )
  }
  return <BuilderForm key={editing ? templateId : 'new'} initial={editing ? existing.data! : null} orgs={orgsQ.data} />
}

function BuilderForm({ initial, orgs }: { initial: TemplateDetail | null; orgs: OrgConnection[] | undefined }): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const editing = initial != null

  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [kind, setKind] = useState<RunnableTemplateKind>((initial?.kind as RunnableTemplateKind | undefined) ?? 'seed')
  const [seed, setSeed] = useState<SeedTemplate>(() => (initial?.kind === 'seed' ? (initial.payload as SeedTemplate) : emptySeedTemplate()))
  const [post, setPost] = useState<PostRefreshTemplate>(() =>
    initial?.kind === 'postRefresh' ? (initial.payload as PostRefreshTemplate) : emptyPostRefreshTemplate()
  )
  const [scopePick, setScopePick] = useState<OrgScope | null>(null)
  const [connectionPick, setConnectionPick] = useState<string | null>(null)
  const [errors, setErrors] = useState<ValidationError[]>([])
  const [saving, setSaving] = useState(false)

  // Read-from: the user's pick wins; else the built-from org when it is still around; else the first source org.
  const live = useMemo(() => livePickable(orgs), [orgs])
  const builtFromConn = useMemo(() => live.find((o) => o.orgId === initial?.builtFrom?.orgId), [live, initial])
  const scope: OrgScope = scopePick ?? (builtFromConn?.role === 'target' ? 'target' : 'source')
  const inScope = useMemo(() => orgsForScope(live, scope), [live, scope])
  const connectionId =
    connectionPick != null && live.some((o) => o.id === connectionPick) ? connectionPick : (builtFromConn?.id ?? inScope[0]?.id ?? '')
  const org = live.find((o) => o.id === connectionId)
  const payload = kind === 'seed' ? seed : post

  const save = async (): Promise<void> => {
    const withHint = { ...payload, builtFrom: org ? { orgId: org.orgId, label: org.label } : payload.builtFrom }
    const v = validateTemplate(kind, withHint)
    const all = [...(name.trim() ? [] : [{ path: 'name', message: 'is required' }]), ...v.errors]
    setErrors(all)
    if (all.length > 0) {
      toast(`Fix ${all.length} problem${all.length === 1 ? '' : 's'} before saving.`, 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await callIpc(() =>
        window.rds.templateSaveRunnable({
          id: initial?.id,
          kind,
          name: name.trim(),
          description: description.trim() || null,
          payload: withHint
        })
      )
      toast(`Saved "${saved.name}"`, 'success')
      navigate('/templates')
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1>{editing ? `Edit: ${name || 'template'}` : 'New template'}</h1>
      <p className="sub">
        {kind === 'seed'
          ? 'What to copy from a source org into a sandbox, in what order, and how.'
          : 'Which flows and triggers to deactivate, activate or comment out; settings to patch; then which seeds to run.'}
      </p>

      <div className="builder-head">
        <label className="field">
          <span>Name</span>
          <input className="text-input" aria-label="Template name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CPQ configuration" />
        </label>
        <label className="field">
          <span>Type{editing ? ' (locked after save)' : ''}</span>
          <select className="map-strategy" aria-label="Template type" value={kind} disabled={editing} onChange={(e) => setKind(e.target.value as RunnableTemplateKind)}>
            <option value="seed">{TEMPLATE_KIND_LABELS.seed}</option>
            <option value="postRefresh">{TEMPLATE_KIND_LABELS.postRefresh}</option>
          </select>
        </label>
        <label className="field builder-desc">
          <span>Description</span>
          <input className="text-input" aria-label="Template description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <ReadFromPicker
        orgs={orgs}
        scope={scope}
        connectionId={connectionId}
        onScope={(s) => {
          setScopePick(s)
          setConnectionPick(null)
        }}
        onConnection={setConnectionPick}
      />
      <p className="muted builder-note">
        The read-from org is only used to BUILD the template (describes, automation catalog, filter counts). Nothing is
        written to it. The template stores API names; the org is kept as a hint.
      </p>

      {errors.length > 0 && (
        <div className="banner" role="alert">
          <strong>
            {errors.length} problem{errors.length === 1 ? '' : 's'}:
          </strong>
          <ul>
            {errors.slice(0, 20).map((e) => (
              <li key={`${e.path}:${e.message}`}>
                <code>{e.path || '(template)'}</code> {e.message}
              </li>
            ))}
            {errors.length > 20 && <li className="muted">…and {errors.length - 20} more</li>}
          </ul>
        </div>
      )}

      {kind === 'seed' ? (
        <SeedBuilder value={seed} onChange={setSeed} connectionId={connectionId} />
      ) : (
        <PostRefreshBuilder value={post} onChange={setPost} connectionId={connectionId} />
      )}

      <div className="toolbar builder-footer">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save template'}
        </button>
        <Link className="btn" to="/templates">
          Cancel
        </Link>
      </div>
    </>
  )
}
