import { useMemo } from 'react'
import type { PostRefreshTemplate, TemplateDetail, TemplateSummary } from '../../../../shared/templates/types'
import { nextLabel,
  TEMPLATE_STAGES_NOTE_LEAD,
  TEMPLATE_STAGES_NOTE_MORE,
  templateStepsOf,
  stageLabels,
  type TemplateStepRef,
  type TemplateStepsConfig
} from '../../../../shared/wizard'
import { Badge } from '../../ui/Badge'
import { useIpcQuery } from '../../ipc/hooks'
import { useWizard } from './WizardShell'

type Placement = 'none' | 'before' | 'after'

/**
 * S62 (U-2) — Wizard step "Templates": run saved Data-seed / Post-refresh templates as STAGES of
 * this deployment, before and/or after the data. The deployment's source and target are used for
 * every stage; each stage is a real template run with its own report (see TEMPLATE_STAGES_NOTE).
 * Nothing here talks to an org — it only edits `config.templateSteps`.
 */
export function StepTemplates(): React.JSX.Element {
  const { config, updateConfig, goToStep, sourceLabel, targetLabel } = useWizard()
  const all = useIpcQuery(() => window.rds.templateListAll(), [])
  const runnable = useMemo(
    () => (all.data ?? []).filter((t) => t.kind === 'seed' || t.kind === 'postRefresh'),
    [all.data]
  )
  // Post-refresh templates name their embedded seeds in the payload — one detail read per template.
  const postRefreshIds = runnable.filter((t) => t.kind === 'postRefresh').map((t) => t.id)
  const details = useIpcQuery(
    () => Promise.all(postRefreshIds.map((id) => window.rds.templateGet(id))),
    [postRefreshIds.join(',')]
  )
  const detailById = useMemo(() => {
    const m = new Map<number, TemplateDetail>()
    for (const d of details.data ?? []) m.set(d.id, d)
    return m
  }, [details.data])

  const steps = templateStepsOf(config)
  const placementOf = (id: number): Placement =>
    steps.before.some((s) => s.templateId === id) ? 'before' : steps.after.some((s) => s.templateId === id) ? 'after' : 'none'
  const refOf = (id: number): TemplateStepRef | undefined =>
    steps.before.find((s) => s.templateId === id) ?? steps.after.find((s) => s.templateId === id)

  const save = (next: TemplateStepsConfig): void => updateConfig({ templateSteps: next })

  /** Default steps for a template: post-refresh = automation + every embedded seed; seed = all groups. */
  const defaultRef = (t: TemplateSummary): TemplateStepRef => {
    if (t.kind === 'seed') {
      return { templateId: t.id, name: t.name, kind: 'seed', steps: { automation: false, seeds: [{ name: t.name, groups: [] }], optInPatches: [] } }
    }
    const payload = detailById.get(t.id)?.payload as PostRefreshTemplate | undefined
    const seeds = (payload?.seedTemplates ?? []).map((s) => ({ name: s.name, groups: s.groups ?? [] }))
    return { templateId: t.id, name: t.name, kind: 'postRefresh', steps: { automation: true, seeds, optInPatches: [] } }
  }

  const place = (t: TemplateSummary, where: Placement): void => {
    const current = refOf(t.id) ?? defaultRef(t)
    const without = {
      before: steps.before.filter((s) => s.templateId !== t.id),
      after: steps.after.filter((s) => s.templateId !== t.id)
    }
    if (where === 'none') return save(without)
    // Fixed order inside a bucket: post-refresh templates first, then seeds, each in list order.
    const bucket = [...without[where], current]
    const rank = (r: TemplateStepRef): number => (r.kind === 'postRefresh' ? 0 : 1) * 10_000 + runnable.findIndex((x) => x.id === r.templateId)
    bucket.sort((a, b) => rank(a) - rank(b))
    save({ ...without, [where]: bucket })
  }

  const patch = (t: TemplateSummary, fn: (ref: TemplateStepRef) => TemplateStepRef): void => {
    const where = placementOf(t.id)
    if (where === 'none') return
    save({ ...steps, [where]: steps[where].map((s) => (s.templateId === t.id ? fn(s) : s)) })
  }

  const seedSummaries = runnable.filter((t) => t.kind === 'seed')
  const labels = stageLabels(config)

  return (
    <>
      <h2>Templates to run with this deployment</h2>
      <p className="muted">
        Optional. Run a saved post-refresh or data-seed template before the data lands in {targetLabel} (silence the org,
        load configuration) or after it. Every stage reads from {sourceLabel} and writes to {targetLabel}.
      </p>
      {/* T-16: one-sentence lead; the rest behind a disclosure. */}
      <div className="banner warn" role="note" data-testid="stages-note">
        {TEMPLATE_STAGES_NOTE_LEAD}
        <details className="learn-more">
          <summary>Learn more</summary>
          <p>{TEMPLATE_STAGES_NOTE_MORE}</p>
        </details>
      </div>

      {all.loading && <p className="muted">Loading templates…</p>}
      {all.error && <div className="banner">{all.error.message}</div>}
      {!all.loading && runnable.length === 0 && (
        <p className="muted">No runnable templates yet — build one on the Templates tab, or continue without.</p>
      )}

      {runnable.length > 0 && (
        <table className="orgs" aria-label="Template stages">
          <thead>
            <tr>
              <th>Template</th>
              <th>Kind</th>
              <th>When</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            {runnable.map((t) => {
              const where = placementOf(t.id)
              const ref = refOf(t.id)
              const payload = t.kind === 'postRefresh' ? (detailById.get(t.id)?.payload as PostRefreshTemplate | undefined) : undefined
              const embedded = payload?.seedTemplates ?? []
              const gated =
                t.kind === 'seed'
                  ? t.cpqGatedObjects
                  : [...new Set(embedded.flatMap((e) => seedSummaries.find((s) => s.name === e.name)?.cpqGatedObjects ?? []))]
              return (
                <tr key={t.id} data-testid={`template-stage-${t.id}`}>
                  <td>
                    {t.name}
                    <div className="muted">{t.detail}</div>
                  </td>
                  <td>
                    <Badge tone={t.kind === 'seed' ? 'accent' : 'neutral'}>{t.kind === 'seed' ? 'data seed' : 'post-refresh'}</Badge>
                  </td>
                  <td>
                    <select
                      className="text-input"
                      aria-label={`When to run ${t.name}`}
                      value={where}
                      onChange={(e) => place(t, e.target.value as Placement)}
                    >
                      <option value="none">Not used</option>
                      <option value="before">Before the data</option>
                      <option value="after">After the data</option>
                    </select>
                  </td>
                  <td>
                    {where !== 'none' && ref && (
                      <div className="stage-steps">
                        {t.kind === 'postRefresh' && (
                          <label className="master-toggle">
                            <input
                              type="checkbox"
                              checked={ref.steps.automation}
                              onChange={(e) => patch(t, (r) => ({ ...r, steps: { ...r.steps, automation: e.target.checked } }))}
                            />{' '}
                            Automation + settings patches
                          </label>
                        )}
                        {(t.kind === 'seed' ? [{ name: t.name, groups: [] as string[] }] : embedded).map((e) => {
                          const on = ref.steps.seeds.some((s) => s.name === e.name)
                          const groups = seedSummaries.find((s) => s.name === e.name)?.seedGroups ?? []
                          const picked = ref.steps.seeds.find((s) => s.name === e.name)?.groups ?? []
                          const missing = !seedSummaries.some((s) => s.name === e.name)
                          return (
                            <div key={e.name}>
                              <label className="master-toggle">
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={missing}
                                  onChange={(ev) =>
                                    patch(t, (r) => ({
                                      ...r,
                                      steps: {
                                        ...r.steps,
                                        seeds: ev.target.checked
                                          ? [...r.steps.seeds, { name: e.name, groups: e.groups ?? [] }]
                                          : r.steps.seeds.filter((s) => s.name !== e.name)
                                      }
                                    }))
                                  }
                                />{' '}
                                Seed: {e.name}
                                {missing && <span className="muted"> (no seed template with this name)</span>}
                              </label>
                              {on && groups.length > 1 && (
                                <span className="stage-groups">
                                  {groups.map((g) => {
                                    const all = picked.length === 0
                                    const checked = all || picked.includes(g)
                                    return (
                                      <label key={g} className="master-toggle inline">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={(ev) =>
                                            patch(t, (r) => ({
                                              ...r,
                                              steps: {
                                                ...r.steps,
                                                seeds: r.steps.seeds.map((s) => {
                                                  if (s.name !== e.name) return s
                                                  const cur = s.groups.length === 0 ? [...groups] : [...s.groups]
                                                  const next = ev.target.checked ? [...new Set([...cur, g])] : cur.filter((x) => x !== g)
                                                  return { ...s, groups: next.length === groups.length ? [] : next }
                                                })
                                              }
                                            }))
                                          }
                                        />{' '}
                                        {g}
                                      </label>
                                    )
                                  })}
                                </span>
                              )}
                            </div>
                          )
                        })}
                        {gated.length > 0 && (
                          <div className="muted">
                            Needs the CPQ “Triggers Disabled” confirmation on the Plan step ({gated.length} gated object
                            {gated.length === 1 ? '' : 's'}).
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <p className="muted" data-testid="stage-sequence">
        Run order: {labels.map((l, i) => `${i + 1}. ${l}`).join(' → ')}
      </p>

      <div className="toolbar">
        <button className="btn" onClick={() => goToStep('fields')}>
          Back
        </button>
        <button className="btn primary" onClick={() => goToStep('summary')}>
          {nextLabel('summary')}
        </button>
      </div>
    </>
  )
}
