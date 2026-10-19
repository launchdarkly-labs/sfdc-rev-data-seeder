import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { TemplateKind } from '../../../../shared/types'
import { TEMPLATE_KIND_LABELS, isRunnableKind, type TemplateSummary } from '../../../../shared/templates/types'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { Badge } from '../../ui/Badge'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toast'
import { fmtWhen, runStateTone } from './templateUi'

type Filter = 'all' | TemplateKind

/**
 * /templates — every template of every kind (S59 plan §2.1). The two runnable
 * kinds (Data seed, Post-refresh) get Edit + Run; the wizard's objects /
 * mappings / fields templates are listed too (D6) with Rename / Export-less
 * Delete only — their editing stays on the wizard steps.
 */
export function TemplatesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { data, loading, error, refetch } = useIpcQuery(() => window.rds.templateListAll(), [])
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => (data ?? []).filter((t) => filter === 'all' || t.kind === filter), [data, filter])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const importFile = (): Promise<void> =>
    run(async () => {
      const saved = await callIpc(() => window.rds.templateImport())
      if (saved == null) return
      toast(`Imported ${saved.length} template${saved.length === 1 ? '' : 's'}: ${saved.map((s) => s.name).join(', ')}`, 'success')
      refetch()
    })

  const exportOne = (t: TemplateSummary): Promise<void> =>
    run(async () => {
      const path = await callIpc(() => window.rds.templateExport(t.id))
      if (path) toast(`Exported "${t.name}" to ${path}`, 'success')
    })

  const sample = (kind: 'seed' | 'postRefresh'): Promise<void> =>
    run(async () => {
      const s = await callIpc(() => window.rds.templateSample(kind))
      toast(`Created "${s.name}" from the shipped sample`, 'success')
      refetch()
    })

  const rename = (t: TemplateSummary): Promise<void> =>
    run(async () => {
      const name = window.prompt(`Rename "${t.name}" to:`, t.name)?.trim()
      if (!name || name === t.name) return
      await callIpc(() => window.rds.templateRename({ id: t.id, name }))
      toast(`Renamed to "${name}"`, 'success')
      refetch()
    })

  const duplicate = (t: TemplateSummary): Promise<void> =>
    run(async () => {
      if (!isRunnableKind(t.kind)) return
      const full = await callIpc(() => window.rds.templateGet(t.id))
      const saved = await callIpc(() =>
        window.rds.templateSaveRunnable({ kind: t.kind as 'seed' | 'postRefresh', name: `${t.name} (copy)`, description: t.description, payload: full.payload })
      )
      toast(`Duplicated as "${saved.name}"`, 'success')
      refetch()
    })

  const remove = (t: TemplateSummary): Promise<void> =>
    run(async () => {
      const ok = await confirm({
        title: `Delete "${t.name}"?`,
        message: 'The template is removed from this app. Runs that used it keep their reports. Nothing in any org changes.',
        confirmLabel: 'Delete',
        danger: true
      })
      if (!ok) return
      await callIpc(() => window.rds.templateDelete(t.id))
      toast(`Deleted "${t.name}"`, 'success')
      refetch()
    })

  return (
    <>
      <h1>Templates</h1>
      <p className="sub">
        Data seed templates copy configuration from a source org into a sandbox; Post-refresh templates set flows and
        triggers to a wanted state, patch settings, then run seeds. Wizard templates (objects, mappings, fields) are
        listed here too.
      </p>

      <div className="toolbar">
        <Link className="btn primary" to="/templates/new">
          New Template
        </Link>
        <button className="btn" onClick={() => void importFile()} disabled={busy}>
          Import…
        </button>
        <button className="btn" onClick={() => void sample('seed')} disabled={busy} title="A neutral CPQ configuration seed to start from">
          New from sample: Data seed
        </button>
        <button className="btn" onClick={() => void sample('postRefresh')} disabled={busy}>
          New from sample: Post-refresh
        </button>
        <select className="map-strategy" aria-label="Type filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">All types</option>
          <option value="seed">Data seed</option>
          <option value="postRefresh">Post-refresh</option>
          <option value="objects">Objects (wizard)</option>
          <option value="mappings">Mappings (wizard)</option>
          <option value="fields">Fields (wizard)</option>
        </select>
      </div>

      {loading && <p className="muted">Loading templates…</p>}
      {error && (
        <div className="banner">
          {error.message}{' '}
          <button className="btn" onClick={refetch}>
            Retry
          </button>
        </div>
      )}
      {data && rows.length === 0 && (
        <p className="muted">
          No templates{filter === 'all' ? ' yet' : ' of this type'} — <Link to="/templates/new">build one</Link>, import a file,
          or start from a sample.
        </p>
      )}
      {rows.length > 0 && (
        <table className="orgs templates-table" aria-label="Templates">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Contents</th>
              <th>Built from</th>
              <th>Updated</th>
              <th>Last run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const runnable = isRunnableKind(t.kind)
              return (
                <tr key={t.id} data-testid={`template-${t.id}`}>
                  <td>
                    {runnable ? <Link to={`/templates/${t.id}/edit`}>{t.name}</Link> : t.name}
                    {t.description && <div className="muted template-desc">{t.description}</div>}
                  </td>
                  <td>
                    <Badge tone={t.kind === 'seed' ? 'accent' : t.kind === 'postRefresh' ? 'warn' : 'neutral'}>
                      {TEMPLATE_KIND_LABELS[t.kind]}
                    </Badge>
                  </td>
                  <td className="muted">{t.detail}</td>
                  <td className="muted">{t.builtFrom?.label ?? '—'}</td>
                  <td className="muted">{fmtWhen(t.updatedAt)}</td>
                  <td>
                    {t.lastRun ? (
                      <Link to={`/templates/${t.id}/runs/${t.lastRun.runId}`} className="last-run">
                        <Badge tone={runStateTone(t.lastRun.state)}>{t.lastRun.state}</Badge>{' '}
                        <span className="muted">
                          {t.lastRun.mode} · {t.lastRun.targetLabel} · {fmtWhen(t.lastRun.startedAt)}
                        </span>
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="template-actions">
                    {runnable && (
                      <>
                        <button className="btn btn-small" onClick={() => navigate(`/templates/${t.id}/edit`)} disabled={busy}>
                          Edit
                        </button>
                        <button className="btn btn-small primary" onClick={() => navigate(`/templates/${t.id}/run`)} disabled={busy}>
                          Run
                        </button>
                        <button className="btn btn-small" onClick={() => void duplicate(t)} disabled={busy}>
                          Duplicate
                        </button>
                        <button className="btn btn-small" onClick={() => void exportOne(t)} disabled={busy}>
                          Export…
                        </button>
                      </>
                    )}
                    <button className="btn btn-small" onClick={() => void rename(t)} disabled={busy}>
                      Rename
                    </button>
                    <button className="btn btn-small danger" onClick={() => void remove(t)} disabled={busy}>
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
