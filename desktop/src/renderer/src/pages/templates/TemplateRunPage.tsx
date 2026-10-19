import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { JobSummary, OrgConnection } from '../../../../shared/types'
import {
  DRY_RUN_CAVEAT,
  isRunnableKind,
  type PostRefreshTemplate,
  type SeedTemplate,
  type TemplateDetail,
  type TemplateRunInput,
  type TemplateRunStateView,
  type TemplateRunSummary,
  type TemplateSummary
} from '../../../../shared/templates/types'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { useShallow } from 'zustand/react/shallow'
import { useJobsStore } from '../../store/jobs'
import { Badge } from '../../ui/Badge'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toast'
import { fmtDuration, fmtWhen, livePickable, runStateTone } from './templateUi'

/**
 * D8 — Apply enables only after a dry run of the SAME template revision on the
 * SAME target in THIS app session ended without blockers. "This session" is
 * the renderer's job store (jobs are session-scoped); "same revision" is a dry
 * run started after the template's last save; "no blockers" is the run's
 * state. Pure derivation — no module state, nothing set in effects.
 */
export function applyUnlockedBy(
  t: Pick<TemplateDetail, 'id' | 'updatedAt'>,
  targetConnectionId: string,
  jobs: ReadonlyArray<JobSummary>,
  runs: ReadonlyArray<TemplateRunSummary>
): boolean {
  for (const j of jobs) {
    if (j.templateId !== t.id || j.kind !== 'template-dry-run' || j.status !== 'done' || j.templateRunId == null) continue
    const run = runs.find((r) => r.id === j.templateRunId)
    if (!run || run.targetConnectionId !== targetConnectionId) continue
    if (run.state === 'blocked' || run.state === 'running' || run.state === 'cancelled') continue
    if (run.startedAt < t.updatedAt) continue
    return true
  }
  // A dry run that ends 'failed' (unexpected problems, no blockers) also unlocks: the user may
  // deliberately apply with known-bad rows. Its job ended in 'error', so look at the runs too.
  for (const j of jobs) {
    if (j.templateId !== t.id || j.kind !== 'template-dry-run' || j.status !== 'error' || j.templateRunId == null) continue
    const run = runs.find((r) => r.id === j.templateRunId)
    if (!run || run.targetConnectionId !== targetConnectionId || run.state !== 'failed' || run.startedAt < t.updatedAt) continue
    return true
  }
  return false
}

/**
 * /templates/:id/run — the run form + history (S59 plan §2.3). Target must be
 * a role-'target' connection; the live IsSandbox check happens in the runner's
 * preflight (the row does not know it). Source (seed steps) must be role
 * 'source'. Steps, opt-ins, options, Dry run → Apply, with the dry-run caveat
 * verbatim on the form and in the Apply confirm.
 */
export function TemplateRunPage(): React.JSX.Element {
  const { id } = useParams()
  const templateId = Number(id)
  const [params] = useSearchParams()
  // S61 U-9: "run again" names the run it sits on; the form starts from THAT run's target,
  // source, steps and options — never from the first target in the list.
  const fromId = Number(params.get('from') ?? 0)
  const tQ = useIpcQuery(() => window.rds.templateGet(templateId), [templateId])
  const orgsQ = useIpcQuery(() => window.rds.listOrgs(), [])
  const seedsQ = useIpcQuery(() => window.rds.templateListAll(), [])
  const runsQ = useIpcQuery(() => window.rds.templateRuns(templateId), [templateId])
  const fromQ = useIpcQuery(() => (fromId > 0 ? window.rds.templateRunState(fromId) : Promise.resolve(null)), [fromId])

  // Re-read history whenever one of this template's jobs changes state.
  const jobsKey = useJobsStore((s) =>
    s.order
      .map((jid) => s.byId[jid]!)
      .filter((j) => j.templateId === templateId)
      .map((j) => `${j.id}:${j.status}`)
      .join('|')
  )
  const refetchRuns = runsQ.refetch
  useEffect(() => {
    refetchRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsKey])

  if (tQ.loading || orgsQ.loading || seedsQ.loading || fromQ.loading || (runsQ.loading && !runsQ.data)) {
    return (
      <>
        <h1>Run template</h1>
        <p className="muted">Loading…</p>
      </>
    )
  }
  const t = tQ.data
  if (tQ.error || !t || !isRunnableKind(t.kind)) {
    return (
      <>
        <h1>Run template</h1>
        <div className="banner">{tQ.error?.message ?? 'This template cannot be run.'}</div>
        <Link to="/templates">Back to templates</Link>
      </>
    )
  }
  return <RunForm key={`${t.id}:${t.updatedAt}:${fromId}`} t={t} orgs={orgsQ.data ?? []} all={seedsQ.data ?? []} runs={runsQ.data ?? []} preset={fromQ.data ?? null} />
}

interface SeedRef {
  name: string
  groups: string[]
  defaultGroups: string[] | null
  missing: boolean
}

function seedRefsFor(t: TemplateDetail, all: ReadonlyArray<TemplateSummary>): SeedRef[] {
  const seeds = all.filter((s) => s.kind === 'seed')
  if (t.kind === 'seed') {
    const groups = all.find((s) => s.id === t.id)?.seedGroups ?? []
    return [{ name: t.name, groups, defaultGroups: null, missing: false }]
  }
  return (t.payload as PostRefreshTemplate).seedTemplates.map((r) => {
    const def = seeds.find((s) => s.name === r.name)
    return { name: r.name, groups: def?.seedGroups ?? [], defaultGroups: r.groups ?? null, missing: !def }
  })
}

function RunForm({
  t,
  orgs,
  all,
  runs,
  preset
}: {
  t: TemplateDetail
  orgs: OrgConnection[]
  all: TemplateSummary[]
  runs: TemplateRunSummary[]
  /** The run "run again" was clicked on — its target, source, steps and options seed the form (S61 U-9). */
  preset: TemplateRunStateView | null
}): React.JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const kind = t.kind as 'seed' | 'postRefresh'
  const payload = t.payload as SeedTemplate | PostRefreshTemplate

  const live = useMemo(() => livePickable(orgs), [orgs])
  const targets = useMemo(() => live.filter((o) => o.role === 'target' && !o.prodPinned), [live])
  const sources = useMemo(() => live.filter((o) => o.role === 'source'), [live])
  const seedRefs = useMemo(() => seedRefsFor(t, all), [t, all])

  const [targetPick, setTargetPick] = useState<string | null>(preset?.run.targetConnectionId ?? null)
  const [sourcePick, setSourcePick] = useState<string | null>(preset?.run.sourceConnectionId ?? null)
  const [automation, setAutomation] = useState(preset?.steps.automation ?? true)
  const [seedPicks, setSeedPicks] = useState<Record<string, { on: boolean; groups: string[] }>>(() =>
    Object.fromEntries(
      seedRefs.map((r) => {
        if (!preset) return [r.name, { on: !r.missing, groups: r.defaultGroups ?? r.groups }]
        const was = preset.steps.seeds.find((s) => s.name === r.name)
        return [r.name, { on: was != null && !r.missing, groups: was?.groups.length ? was.groups : (r.defaultGroups ?? r.groups) }]
      })
    )
  )
  const [optIns, setOptIns] = useState<string[]>(preset?.steps.optInPatches ?? [])
  const [disableTargetAutomation, setDisableTargetAutomation] = useState(
    preset?.options?.disableTargetAutomation ?? (kind === 'seed' ? (payload as SeedTemplate).runDefaults.disableTargetAutomation : true)
  )
  // The attestation is a statement about the org NOW — never carried over; the purge alias is retyped.
  const [cpqAttestation, setCpqAttestation] = useState(false)
  const [purge, setPurge] = useState(preset?.options?.purge ?? false)
  const [purgeConfirm, setPurgeConfirm] = useState('')
  const [resume, setResume] = useState(params.get('resume') === '1')
  const [starting, setStarting] = useState<'dry-run' | 'apply' | null>(null)

  // Defaults derived in render: the preset run's target, else the first target — but a preset
  // target that is no longer a Target connection leaves the pick EMPTY rather than silently
  // falling through to whichever org happens to be first (U-9's hazard).
  const presetTarget = preset?.run.targetConnectionId ?? null
  const presetTargetMissing = presetTarget != null && !targets.some((o) => o.id === presetTarget)
  const targetId =
    targetPick != null && targets.some((o) => o.id === targetPick) ? targetPick : presetTargetMissing && (targetPick == null || targetPick === presetTarget) ? '' : (targets[0]?.id ?? '')
  const builtFromSource = sources.find((o) => o.orgId === t.builtFrom?.orgId)
  const sourceId = sourcePick != null && sources.some((o) => o.id === sourcePick) ? sourcePick : (builtFromSource?.id ?? sources[0]?.id ?? '')
  const target = targets.find((o) => o.id === targetId)

  const anySeed = Object.values(seedPicks).some((p) => p.on)
  // The attestation block follows the seeds actually ticked — a post-refresh template's embedded seeds included.
  // The list comes from main (TemplateSummary.cpqGatedObjects), resolved with the runner's own policy.
  const cpqGated = useMemo(() => {
    const picked = new Set(seedRefs.filter((r) => seedPicks[r.name]?.on).map((r) => r.name))
    const objects = all.filter((s) => s.kind === 'seed' && picked.has(s.name)).flatMap((s) => s.cpqGatedObjects ?? [])
    return [...new Set(objects)].sort()
  }, [all, seedRefs, seedPicks])

  const applyRuns = runs.filter((r) => r.mode === 'apply' && r.targetConnectionId === targetId)
  const lastApply = applyRuns[0]
  const resumable = lastApply != null && lastApply.state !== 'clean' && anySeed
  // useShallow: a fresh array per select would re-render forever (zustand compares by identity).
  const jobs = useJobsStore(useShallow((s) => s.order.map((jid) => s.byId[jid]!)))
  const applyUnlocked = targetId !== '' && applyUnlockedBy(t, targetId, jobs, runs)

  const buildInput = (mode: 'dry-run' | 'apply'): TemplateRunInput => ({
    templateId: t.id,
    mode,
    targetConnectionId: targetId,
    sourceConnectionId: anySeed ? sourceId || undefined : undefined,
    steps: {
      automation: kind === 'postRefresh' ? automation : false,
      seeds: seedRefs.filter((r) => seedPicks[r.name]?.on).map((r) => ({ name: r.name, groups: seedPicks[r.name]!.groups })),
      optInPatches: optIns
    },
    options: { disableTargetAutomation, cpqAttestation, purge, resume }
  })

  const start = async (mode: 'dry-run' | 'apply'): Promise<void> => {
    const input = buildInput(mode)
    if (mode === 'apply') {
      const ok = await confirm({
        title: `Apply "${t.name}" to ${target?.label ?? 'the target'}?`,
        message: (
          <>
            <p>
              This WRITES to <strong>{target?.label}</strong>
              {anySeed ? ` from ${sources.find((o) => o.id === sourceId)?.label ?? 'the source'}` : ''}.
              {purge ? ' Existing rows in the seed objects are DELETED first.' : ''}
              {resume ? ' Resuming from the last apply’s id map.' : ''}
            </p>
            <p className="muted">{DRY_RUN_CAVEAT}</p>
          </>
        ),
        confirmLabel: 'Apply',
        danger: true
      })
      if (!ok) return
    }
    setStarting(mode)
    try {
      const { runId } = await callIpc(() => window.rds.templateRun(input))
      await useJobsStore.getState().refresh()
      navigate(`/templates/${t.id}/runs/${runId}`)
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    } finally {
      setStarting(null)
    }
  }

  const stepsOk = kind === 'postRefresh' ? automation || anySeed : anySeed
  const needsSource = anySeed
  const canStart = targetId !== '' && stepsOk && (!needsSource || sourceId !== '') && (!purge || purgeConfirm === (target?.label ?? ''))
  const patches = kind === 'postRefresh' ? (payload as PostRefreshTemplate).automation.settingPatches : []

  return (
    <>
      <h1>Run: {t.name}</h1>
      <p className="sub">
        {t.detail} · <Link to={`/templates/${t.id}/edit`}>edit the template</Link>
      </p>

      <div className="run-form">
        {needsSource && (
          <label className="field">
            <span>Source (read-only)</span>
            <select className="map-strategy" aria-label="Source org" value={sourceId} onChange={(e) => setSourcePick(e.target.value)}>
              <option value="">— pick a source —</option>
              {sources.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} · {o.orgId.slice(0, 15)}
                </option>
              ))}
            </select>
          </label>
        )}
        {presetTargetMissing && (
          <div className="banner warn" role="alert">
            Run #{preset!.run.id} targeted <strong>{preset!.run.targetLabel}</strong>, which is no longer a Target connection here — pick the target deliberately.
          </div>
        )}
        <label className="field">
          <span>Target (sandbox — checked live at run start)</span>
          <select className="map-strategy" aria-label="Target org" value={targetId} onChange={(e) => setTargetPick(e.target.value)}>
            <option value="">— pick a target —</option>
            {targets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} · {o.orgId.slice(0, 15)}
              </option>
            ))}
          </select>
          {targets.length === 0 && (
            <span className="muted">
              No target orgs — give a sandbox the Target role on <Link to="/connections">Org Connections</Link>.
            </span>
          )}
        </label>


        <fieldset className="run-steps">
          <legend>Steps</legend>
          {kind === 'postRefresh' && (
            <label className="master-toggle">
              <input type="checkbox" checked={automation} onChange={(e) => setAutomation(e.target.checked)} /> Automation + settings patches
            </label>
          )}
          {seedRefs.map((r) => (
            <div key={r.name} className="run-seed">
              <label className="master-toggle">
                <input
                  type="checkbox"
                  checked={seedPicks[r.name]?.on ?? false}
                  disabled={r.missing}
                  onChange={(e) => setSeedPicks((p) => ({ ...p, [r.name]: { on: e.target.checked, groups: p[r.name]?.groups ?? r.groups } }))}
                />{' '}
                Seed: {r.name}
                {r.missing && <Badge tone="danger">missing</Badge>}
              </label>
              {r.groups.length > 1 && (
                <span className="group-picks">
                  {r.groups.map((g) => (
                    <label key={g} className="group-pick">
                      <input
                        type="checkbox"
                        checked={seedPicks[r.name]?.groups.includes(g) ?? true}
                        onChange={(e) =>
                          setSeedPicks((p) => {
                            const cur = p[r.name] ?? { on: true, groups: r.groups }
                            const groups = e.target.checked ? [...new Set([...cur.groups, g])] : cur.groups.filter((x) => x !== g)
                            return { ...p, [r.name]: { ...cur, groups } }
                          })
                        }
                      />{' '}
                      {g}
                    </label>
                  ))}
                </span>
              )}
            </div>
          ))}
          {patches.filter((p) => p.optIn).length > 0 && (
            <div className="run-optins">
              <span className="muted">Opt-in settings patches:</span>
              {patches
                .filter((p) => p.optIn)
                .map((p) => (
                  <label key={p.label} className="master-toggle">
                    <input
                      type="checkbox"
                      checked={optIns.includes(p.label)}
                      onChange={(e) => setOptIns((o) => (e.target.checked ? [...o, p.label] : o.filter((x) => x !== p.label)))}
                    />{' '}
                    {p.label}{' '}
                    <span className="muted">
                      ({p.object}.{p.field})
                    </span>
                  </label>
                ))}
            </div>
          )}
        </fieldset>

        {anySeed && (
          <fieldset className="run-options">
            <legend>Options</legend>
            <label className="master-toggle">
              <input type="checkbox" checked={disableTargetAutomation} onChange={(e) => setDisableTargetAutomation(e.target.checked)} /> Disable the
              target’s own automation on the seeded objects during the seed, restore after
            </label>
            {cpqGated.length > 0 && (
              <div className="banner warn cpq-notice" role="alert">
                <p>
                  <strong>Required — disable Salesforce CPQ triggers on the target org before applying.</strong>
                  <br />
                  This seed includes objects that Salesforce CPQ&rsquo;s managed triggers react to ({cpqGated.slice(0, 8).join(', ')}
                  {cpqGated.length > 8 ? ` and ${cpqGated.length - 8} more` : ''}). The app cannot turn these off automatically. In the{' '}
                  <strong>target org</strong>:
                </p>
                <ol>
                  <li>
                    Setup &rarr; Installed Packages &rarr; <strong>Salesforce CPQ</strong> &rarr; Configure &rarr; Additional Settings tab
                  </li>
                  <li>
                    Check <strong>Triggers Disabled</strong> and Save
                  </li>
                  <li>Come back here and confirm below</li>
                  <li>
                    When the seed finishes, <strong>uncheck it</strong> to turn CPQ automation back on
                  </li>
                </ol>
                <label className="cpq-attest">
                  <input type="checkbox" checked={cpqAttestation} onChange={(e) => setCpqAttestation(e.target.checked)} />{' '}
                  {"Confirmed — I checked 'Triggers Disabled' in the target org"}
                </label>
              </div>
            )}
            <label className="master-toggle">
              <input
                type="checkbox"
                checked={purge}
                disabled={resume}
                onChange={(e) => {
                  setPurge(e.target.checked)
                  setPurgeConfirm('')
                }}
              />{' '}
              Purge existing rows in the seed objects first (apply only; children first)
            </label>
            {purge && (
              <label className="field purge-confirm">
                <span>
                  Type the target alias <code>{target?.label}</code> to confirm the purge
                </span>
                <input className="text-input" aria-label="Purge confirmation" value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)} />
              </label>
            )}
            {resumable && (
              <label className="master-toggle">
                <input type="checkbox" checked={resume} disabled={purge} onChange={(e) => setResume(e.target.checked)} /> Resume from the last apply (
                {fmtWhen(lastApply.startedAt)}, {lastApply.state}) — load only the rows its id map lacks
              </label>
            )}
          </fieldset>
        )}

        <p className="muted dry-run-caveat" data-testid="dry-run-caveat">
          {DRY_RUN_CAVEAT}
        </p>

        <div className="toolbar">
          <button className="btn primary" onClick={() => void start('dry-run')} disabled={!canStart || starting != null}>
            {starting === 'dry-run' ? 'Starting…' : 'Dry run'}
          </button>
          <button
            className="btn danger"
            onClick={() => void start('apply')}
            disabled={!canStart || !applyUnlocked || starting != null}
            title={applyUnlocked ? 'Writes to the target' : 'Apply unlocks after a dry run of this template revision on this target, in this session, with no blockers'}
          >
            {starting === 'apply' ? 'Starting…' : 'Apply'}
          </button>
          {!applyUnlocked && targetId && (
            <span className="muted deploy-gate-note">Apply unlocks after a dry run of this revision on {target?.label} with no blockers.</span>
          )}
        </div>
      </div>

      <h2>History</h2>
      {runs.length === 0 && <p className="muted">No runs yet.</p>}
      {runs.length > 0 && <RunHistory runs={runs} templateId={t.id} />}
    </>
  )
}

function RunHistory({ runs, templateId }: { runs: TemplateRunSummary[]; templateId: number }): React.JSX.Element {
  return (
    <table className="orgs" aria-label="Run history">
      <thead>
        <tr>
          <th>Run</th>
          <th>Mode</th>
          <th>Source</th>
          <th>Target</th>
          <th>State</th>
          <th>Started</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/templates/${templateId}/runs/${r.id}`}>#{r.id}</Link>
            </td>
            <td>
              {r.mode}
              {r.deploymentId != null && (
                <div className="muted">
                  via <Link to={`/deployments/${r.deploymentId}`}>deployment #{r.deploymentId}</Link>
                </div>
              )}
            </td>
            <td className="muted">{r.sourceLabel ?? '—'}</td>
            <td className="muted">{r.targetLabel}</td>
            <td>
              <Badge tone={runStateTone(r.state)}>{r.state}</Badge>
            </td>
            <td className="muted">{fmtWhen(r.startedAt)}</td>
            <td className="muted">{fmtDuration(r.startedAt, r.finishedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
