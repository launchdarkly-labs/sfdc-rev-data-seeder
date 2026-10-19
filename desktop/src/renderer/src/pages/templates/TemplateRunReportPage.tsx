import { memo, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { JobEvent, JobSummary } from '../../../../shared/types'
import { DRY_RUN_CAVEAT, type SeedTemplate, type TemplateReport, type TemplateRunInput, type TemplateRunStateView } from '../../../../shared/templates/types'
import { phaseLabel } from '../../../../shared/labels'
import { callIpc, toRdsError } from '../../ipc/client'
import { useIpcQuery } from '../../ipc/hooks'
import { useJob, useJobsStore } from '../../store/jobs'
import { Badge } from '../../ui/Badge'
import { CancelJobButton } from '../../ui/CancelJobButton'
import { useConfirm } from '../../ui/ConfirmDialog'
import { ProgressBar } from '../../ui/ProgressBar'
import { useToast } from '../../ui/Toast'
import { useGuardedRefresh } from '../../ipc/guardedRefresh'
import { fmtDuration, fmtWhen, runStateTone } from './templateUi'

const MAX_LOG_LINES = 400

interface LogLine {
  level: string
  message: string
}

/**
 * /templates/:id/runs/:runId — monitor + report (S59 plan §2.4). Live: the
 * job's phase chip, progress and log; cooperative Cancel. Done: the persisted
 * report — automation, patches, safety check, target automation, seed tiers,
 * second pass, relink, verify, and the summary with next action and batch-size
 * suggestions (D4 → "Apply to template").
 */
export function TemplateRunReportPage(): React.JSX.Element {
  const { runId } = useParams()
  const run = Number(runId)
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()

  const [state, setState] = useState<TemplateRunStateView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])

  useEffect(() => {
    void useJobsStore.getState().refresh()
  }, [run])

  const liveJob = useJob(state?.run.jobId ?? undefined)
  const job: JobSummary | null = liveJob ?? state?.job ?? null
  const jobKey = liveJob ? `${liveJob.id}|${liveJob.status}|${liveJob.phase ?? ''}|${liveJob.progress?.value ?? ''}/${liveJob.progress?.max ?? ''}|${liveJob.progress?.label ?? ''}` : ''
  const jobRunning = job?.status === 'running'
  // S64 P5 (5.4): one guarded refresh path — the debounced job-change read and
  // the 3 s floor while the job runs both go through it (see useGuardedRefresh).
  const load = useGuardedRefresh<TemplateRunStateView>({
    key: run,
    enabled: Number.isFinite(run),
    fetch: () => window.rds.templateRunState(run),
    onLoaded: (next) => {
      setState(next)
      setError(null)
    },
    onError: setError,
    jobKey,
    polling: jobRunning
  })

  // Live log: the job-event stream filtered to this run's job (not persisted — the report is).
  // S64 P5 (5.4): the ring buffer lives in a ref and is appended in place; a
  // burst of lines is published to state ONCE per macrotask (one ≤400-entry
  // copy, one render) instead of a copy + render per line.
  const jobId = state?.run.jobId ?? null
  const logBuf = useRef<LogLine[]>([])
  useEffect(() => {
    if (!jobId) return
    let flush: ReturnType<typeof setTimeout> | null = null
    const off = window.rds.onJobEvent((e: JobEvent) => {
      if (e.jobId !== jobId || e.kind !== 'log') return
      const buf = logBuf.current
      buf.push({ level: String(e.data.level ?? 'info'), message: String(e.data.message ?? '') })
      if (buf.length > MAX_LOG_LINES) buf.shift()
      if (flush == null) {
        flush = setTimeout(() => {
          flush = null
          setLog(logBuf.current.slice())
        }, 0)
      }
    })
    return () => {
      off()
      if (flush != null) clearTimeout(flush)
    }
  }, [jobId])

  // S64 (P3, ux F-7): the log follows its tail unless the pointer is over it, and can be
  // narrowed to errors and warnings. Scrolling the element is a DOM effect, not state.
  const logRef = useRef<HTMLPreElement>(null)
  const [logPaused, setLogPaused] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const shownLog = errorsOnly ? log.filter((l) => l.level === 'error' || l.level === 'warn') : log
  useEffect(() => {
    const el = logRef.current
    if (el && !logPaused) el.scrollTop = el.scrollHeight
  }, [shownLog.length, logPaused])

  // S61 U-1 — "Apply with these settings": a clean (or partial) DRY RUN of the current template
  // revision, run in THIS app session, can be applied from its report with exactly the steps and
  // options it was given — the D8 unlock rule, applied here instead of back on the form. The
  // attestation and the purge alias were already given for this very configuration.
  const templateId = state?.run.templateId ?? null
  const templateQ = useIpcQuery(() => (templateId != null ? window.rds.templateGet(templateId) : Promise.resolve(null)), [templateId])
  const template = templateQ.data ?? null
  const dryRunUnlocksApply =
    state != null &&
    state.run.mode === 'dry-run' &&
    (state.run.state === 'clean' || state.run.state === 'partial') &&
    state.run.templateId != null &&
    liveJob != null &&
    template != null &&
    state.run.startedAt >= template.updatedAt

  const applyWithTheseSettings = async (): Promise<void> => {
    if (!state || state.run.templateId == null) return
    const r = state.run
    const ok = await confirm({
      title: `Apply "${r.templateName}" to ${r.targetLabel}?`,
      message: (
        <>
          <p>
            This WRITES to <strong>{r.targetLabel}</strong>
            {r.sourceLabel ? ` from ${r.sourceLabel}` : ''} with exactly the steps and options of dry run #{r.id}.
            {state.options?.purge ? ' Existing rows in the seed objects are DELETED first.' : ''}
          </p>
          <p className="muted">{DRY_RUN_CAVEAT}</p>
        </>
      ),
      confirmLabel: 'Apply',
      danger: true
    })
    if (!ok) return
    const input: TemplateRunInput = {
      templateId: r.templateId!,
      mode: 'apply',
      targetConnectionId: r.targetConnectionId,
      sourceConnectionId: r.sourceConnectionId ?? undefined,
      steps: state.steps,
      options: { ...(state.options ?? { disableTargetAutomation: true, cpqAttestation: false, purge: false, resume: false }), resume: false }
    }
    try {
      const { runId } = await callIpc(() => window.rds.templateRun(input))
      await useJobsStore.getState().refresh()
      navigate(`/templates/${r.templateId}/runs/${runId}`)
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    }
  }

  const restore = async (): Promise<void> => {
    try {
      await callIpc(() => window.rds.templateRestoreAutomation(run))
      await useJobsStore.getState().refresh()
      toast('Restore started — the run page follows it.', 'success')
      load()
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    }
  }

  const exportJson = (): void => {
    if (!state?.report) return
    const blob = new Blob([JSON.stringify({ run: state.run, steps: state.steps, options: state.options, report: state.report }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `template-run-${run}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const applyBatchSize = async (object: string): Promise<void> => {
    if (!state?.run.templateId) return
    try {
      const t = await callIpc(() => window.rds.templateGet(state.run.templateId!))
      if (t.kind !== 'seed') {
        toast('Batch sizes live on the Data seed template — open it and set batchSize 1 on that tier.', 'info')
        return
      }
      const payload = t.payload as SeedTemplate
      const tiers = payload.tiers.map((tier) => (tier.object === object ? { ...tier, batchSize: 1 } : tier))
      await callIpc(() => window.rds.templateSaveRunnable({ id: t.id, kind: 'seed', name: t.name, description: t.description, payload: { ...payload, tiers } }))
      toast(`${object}: batchSize 1 saved to "${t.name}"`, 'success')
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    }
  }

  if (error && !state) {
    return (
      <>
        <h1>Template run {run}</h1>
        <div className="banner">
          {error}{' '}
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      </>
    )
  }
  if (!state) {
    return (
      <>
        <h1>Template run {run}</h1>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const r = state.run
  const report = state.report
  const phase = job?.phase ?? null
  const unrestored = state.unrestoredTemporary
  const seedCount = state.steps.seeds.length

  return (
    <>
      <h1>
        {r.mode === 'dry-run' ? 'Dry run' : r.mode === 'apply' ? 'Apply' : 'Restore'}: {r.templateName}
      </h1>
      <p className="sub">
        Run #{r.id} · {r.sourceLabel ? `${r.sourceLabel} → ` : ''}
        {r.targetLabel} · started {fmtWhen(r.startedAt)} · {fmtDuration(r.startedAt, r.finishedAt)} ·{' '}
        {r.templateId != null && <Link to={`/templates/${r.templateId}/run?from=${r.id}`}>run again</Link>}
      </p>

      <div className="run-head">
        <Badge tone={runStateTone(r.state)}>
          {r.state}
          {r.state === 'partial' && report ? ` · ${report.summary.unexpected} unexpected` : ''}
        </Badge>
        {jobRunning && phase && <span className="muted"> · {phaseLabel(phase)}</span>}
        {jobRunning && job && <CancelJobButton jobId={job.id} />}
      </div>
      {jobRunning && job?.progress && <ProgressBar value={job.progress.value} max={job.progress.max} label={job.progress.label} />}
      {job?.error && !jobRunning && <div className="banner">{job.error}</div>}

      {unrestored > 0 && (
        <div className="banner warn" role="alert">
          {unrestored} temporary automation item{unrestored === 1 ? '' : 's'} this run disabled on {r.targetLabel}{' '}
          {unrestored === 1 ? 'is' : 'are'} not confirmed restored. Deploys and template applies into this org are refused until
          they are.{' '}
          <button className="btn primary" onClick={() => void restore()} disabled={jobRunning}>
            Restore target automation
          </button>
        </div>
      )}

      {report && (
        <>
          <div className="toolbar">
            {dryRunUnlocksApply && (
              <button className="btn danger" onClick={() => void applyWithTheseSettings()} title="Writes to the target with exactly this dry run's steps and options">
                Apply with these settings
              </button>
            )}
            {report.summary.nextAction === 'resume' && r.templateId != null && seedCount > 0 && (
              <button className="btn primary" onClick={() => navigate(`/templates/${r.templateId}/run?resume=1`)}>
                Resume
              </button>
            )}
            {report.summary.nextAction === 'rerunAutomation' && r.templateId != null && (
              <button className="btn" onClick={() => navigate(`/templates/${r.templateId}/run`)}>
                Re-run automation
              </button>
            )}
            <button className="btn" onClick={exportJson}>
              Export report JSON
            </button>
          </div>

          <Summary report={report} onApplyBatchSize={applyBatchSize} canApply={r.templateKind === 'seed' || seedCount > 0} />

          {report.preflight.blockers.length > 0 && (
            <section>
              <h2>Blocked</h2>
              <ul className="problem-list">
                {report.preflight.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </section>
          )}
          {report.preflight.notes.length > 0 && (
            <p className="muted">
              {report.preflight.notes.map((n) => (
                <span key={n}>
                  {n}
                  <br />
                </span>
              ))}
            </p>
          )}

          {report.automation.length > 0 && (
            <section>
              <h2>Automation</h2>
              <table className="orgs">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Object</th>
                    <th>Wanted</th>
                    <th>Found</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {report.automation.map((a) => (
                    <tr key={`${a.itemType}:${a.name}`}>
                      <td className="muted">{a.itemType === 'Flow' ? 'Flow' : 'Trigger'}</td>
                      <td>{a.name}</td>
                      <td className="muted">{a.object ?? '—'}</td>
                      <td>{a.wanted}</td>
                      <td className="muted">{a.found}</td>
                      <td>
                        <Badge tone={a.result === 'failed' || a.result === 'notFound' ? 'danger' : a.result === 'changed' || a.result === 'planned' ? 'accent' : 'neutral'}>
                          {a.result}
                        </Badge>
                        {a.detail && <span className="muted"> {a.detail}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.settingPatches.length > 0 && (
            <section>
              <h2>Settings patches</h2>
              <table className="orgs">
                <thead>
                  <tr>
                    <th>Patch</th>
                    <th>Field</th>
                    <th title="Rows the patch’s WHERE clause selected on the target">Rows selected</th>
                    <th title="Rows that already held the wanted value — left alone">Already patched</th>
                    <th title="Rows written by this run">Updated</th>
                    <th title="Rows the target refused">Failed</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {report.settingPatches.map((p) => (
                    <tr key={p.label}>
                      <td>{p.label}</td>
                      <td className="muted">
                        {p.object}.{p.field}
                      </td>
                      <td>{p.rows}</td>
                      <td>{p.alreadyPatched}</td>
                      <td>{p.updated}</td>
                      <td>{p.failed}</td>
                      <td>
                        <Badge tone={p.result === 'failed' ? 'danger' : p.result === 'applied' || p.result === 'planned' ? 'accent' : 'neutral'}>{p.result}</Badge>
                        {p.detail && <span className="muted"> {p.detail}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.safetyCheck && (
            <section>
              <h2>Safety check</h2>
              {report.safetyCheck.problems.length === 0 ? (
                <p className="status-ok">
                  <span aria-hidden="true">✓</span> Every automation item and patch re-read in the wanted state.
                </p>
              ) : (
                <ul className="problem-list">
                  {report.safetyCheck.problems.map((p) => (
                    <li key={p} className="status-err">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {report.targetAutomation && (
            <section>
              <h2>Target automation (temporary)</h2>
              <p className="muted">
                {report.targetAutomation.planned} found on the seeded objects · {report.targetAutomation.disabled} disabled ·{' '}
                {report.targetAutomation.restored} restored · {report.targetAutomation.unconfirmed} unconfirmed
              </p>
              {report.targetAutomation.items.length > 0 && (
                <details>
                  <summary>Items</summary>
                  <table className="orgs">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Name</th>
                        <th>Object</th>
                        <th>Disabled</th>
                        <th>Restored</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.targetAutomation.items.map((i) => (
                        <tr key={`${i.itemType}:${i.name}`}>
                          <td className="muted">{i.itemType}</td>
                          <td>{i.name}</td>
                          <td className="muted">{i.object}</td>
                          <td>{i.disabled ? <Tick ok label="disabled" /> : i.detail ?? '—'}</td>
                          <td>{i.restored ? <Tick ok label="restored" /> : report.mode === 'dry-run' ? '—' : <Tick ok={false} label="not restored" />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </section>
          )}

          {report.purge && report.purge.length > 0 && (
            <section>
              <h2>Purge</h2>
              <ul className="problem-list">
                {report.purge.map((p) => (
                  <li key={p.object}>
                    {p.object}: {report.mode === 'dry-run' ? `${p.deleted} rows would be deleted` : `deleted ${p.deleted}${p.failed ? `, ${p.failed} failed` : ''}`}
                    {p.via ? <span className="muted"> ({p.via})</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.seed.length > 0 && (
            <section>
              <h2>Seed</h2>
              <table className="orgs seed-table">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th title="The load group this object belongs to">Load group</th>
                    <th title="Rows read from the source">Source rows</th>
                    <th title="Rows written to the target">Loaded</th>
                    <th title="Rows the target refused">Failed</th>
                    <th title="Rows left out on purpose (parent missing, policy skip)">Skipped</th>
                    <th title="Lookups set to null because the parent was not loaded">Nulled lookups</th>
                    <th title="Distinct fields written per row">Fields written</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {report.seed.map((s) => (
                    <SeedRow key={s.object} s={s} />
                  ))}
                </tbody>
              </table>
              <p className="muted legend">
                Source rows → Loaded + Failed + Skipped. Nulled lookups: references whose parent was not loaded.
                Fields written: distinct fields per row. Expand an object for its row-level detail.
              </p>
            </section>
          )}

          {report.secondPass.length > 0 && (
            <section>
              <h2>Second pass</h2>
              <table className="orgs">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th title="Rows with deferred fields to write in the second pass">Updates planned</th>
                    <th title="Rows written in the second pass">Updated</th>
                    <th title="Rows the target refused in the second pass">Failed</th>
                    <th title="The deferred fields written">Fields written</th>
                  </tr>
                </thead>
                <tbody>
                  {report.secondPass.map((s) => (
                    <tr key={s.object}>
                      <td>{s.object}</td>
                      <td>{s.updates}</td>
                      <td>{s.updated}</td>
                      <td>{s.failed}</td>
                      <td className="muted">
                        {s.fields.join(', ')}
                        {s.savedOnSingleRetry > 0 && ` (${s.savedOnSingleRetry} on single-record retry)`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.relink.length > 0 && (
            <section>
              <h2>Relink</h2>
              <table className="orgs">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th title="Rows of this shared object examined">Records</th>
                    <th title="Rows whose lookups were repointed at the seeded rows">Updated</th>
                    <th title="Rows already pointing at the right target rows">Already correct</th>
                    <th title="Rows where some lookups relinked and others could not">Partial</th>
                    <th title="Rows the target refused">Failed</th>
                    <th title="The lookup fields relinked">Fields relinked</th>
                  </tr>
                </thead>
                <tbody>
                  {report.relink.map((s) => (
                    <tr key={s.object}>
                      <td>{s.object}</td>
                      <td>{s.records}</td>
                      <td>{s.updated}</td>
                      <td>{s.alreadyCorrect}</td>
                      <td>{s.partial}</td>
                      <td>{s.failed}</td>
                      <td className="muted">{s.fields.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.verify && (
            <section>
              <h2>Verify</h2>
              {report.verify.counts.length > 0 && (
                <table className="orgs">
                  <thead>
                    <tr>
                      <th>Object</th>
                      <th>Source</th>
                      <th>Loaded</th>
                      <th>Target</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {report.verify.counts.map((c) => (
                      <tr key={c.object}>
                        <td>{c.object}</td>
                        <td>{c.source}</td>
                        <td>{c.loaded}</td>
                        <td>{c.target}</td>
                        <td>
                          {c.gap ? (
                            <Badge tone="warn">gap</Badge>
                          ) : (
                            <span className="status-ok">
                              <Tick ok label="counts match" />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {report.verify.dangling.length > 0 && (
                <p className="muted">
                  Dangling lookups:{' '}
                  {report.verify.dangling.map((d) => `${d.object}.${d.field} ${d.count}${d.known ? ` (${d.known} from known relink failures)` : ''}`).join(' · ')}
                </p>
              )}
              {report.verify.parity.map((p) => (
                <div key={p.object} className="parity-row">
                  <strong>{p.object}</strong>: {p.checked} checked, {p.mismatches} mismatch{p.mismatches === 1 ? '' : 'es'}{' '}
                  <span className="muted">[{p.fields.join(', ')}]</span>
                  {p.samples.length > 0 && (
                    <ul className="problem-list">
                      {p.samples.map((s, i) => (
                        <li key={i} className="muted">
                          {s.sourceId} → {s.targetId} {s.field}: expected {JSON.stringify(s.expected)}, found {JSON.stringify(s.actual)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {log.length > 0 && (
        <section>
          <div className="log-head">
            <h2>Log</h2>
            <span className="muted" data-testid="log-cap">
              {log.length >= MAX_LOG_LINES
                ? `showing the last ${MAX_LOG_LINES} lines`
                : `${log.length} line${log.length === 1 ? '' : 's'} so far — showing the last ${MAX_LOG_LINES} once it fills`}
            </span>
            <label className="check inline">
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors and warnings only
            </label>
            {logPaused && <span className="muted">auto-scroll paused while the pointer is over the log</span>}
          </div>
          <pre
            ref={logRef}
            className="run-log"
            data-testid="run-log"
            onMouseEnter={() => setLogPaused(true)}
            onMouseLeave={() => setLogPaused(false)}
          >
            {shownLog.map((l, i) => (
              <div key={i} className={l.level === 'error' ? 'status-err' : l.level === 'warn' ? 'status-warn' : ''}>
                {l.message}
              </div>
            ))}
            {errorsOnly && shownLog.length === 0 && <div className="muted">No errors or warnings in the last {log.length} lines.</div>}
          </pre>
        </section>
      )}
    </>
  )
}

/** Decorative ✓ / ✗ with the meaning in text for assistive tech (ux A-12). */
function Tick({ ok, label }: { ok: boolean; label: string }): React.JSX.Element {
  return (
    <>
      <span aria-hidden="true">{ok ? '✓' : '✗'}</span>
      <span className="sr-only">{label}</span>
    </>
  )
}

function Summary({ report, onApplyBatchSize, canApply }: { report: TemplateReport; onApplyBatchSize: (object: string) => Promise<void>; canApply: boolean }): React.JSX.Element {
  const s = report.summary
  return (
    <section className="run-summary">
      <h2>Summary</h2>
      <div className="kpi-row">
        <div className="kpi">
          <span className="kpi-value">{s.unexpected}</span>
          <span className="kpi-label">unexpected problems</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{s.expected}</span>
          <span className="kpi-label">expected (known)</span>
        </div>
        <div className="kpi">
          <span className="kpi-value">{report.seed.reduce((a, t) => a + t.loaded, 0)}</span>
          <span className="kpi-label">{report.mode === 'dry-run' ? 'rows planned' : 'rows loaded'}</span>
        </div>
      </div>
      {s.unexpectedGroups.length > 0 && (
        <>
          <h3>Unexpected</h3>
          <table className="orgs">
            <thead>
              <tr>
                <th>Step</th>
                <th>Object</th>
                <th>Count</th>
                <th>Example</th>
              </tr>
            </thead>
            <tbody>
              {s.unexpectedGroups.map((g) => (
                <tr key={`${g.step}|${g.object}`}>
                  <td>{g.step}</td>
                  <td>{g.object ?? '—'}</td>
                  <td>{g.count}</td>
                  <td className="muted">{g.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {s.expectedGroups.length > 0 && (
        <>
          <h3>Expected (known)</h3>
          <table className="orgs">
            <thead>
              <tr>
                <th>Step</th>
                <th>Object</th>
                <th>Count</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {s.expectedGroups.map((g) => (
                <tr key={`${g.step}|${g.object}`}>
                  <td>{g.step}</td>
                  <td>{g.object ?? '—'}</td>
                  <td>{g.count}</td>
                  <td className="muted">{g.why ?? g.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {s.batchSizeSuggestions.length > 0 && (
        <div className="banner warn" data-testid="batch-suggestions">
          <strong>Batch size suggestions</strong> — these objects only saved one row at a time:
          <ul>
            {s.batchSizeSuggestions.map((b) => (
              <li key={b.object}>
                set batchSize 1 for <code>{b.object}</code> <span className="muted">({b.reason})</span>{' '}
                {canApply && (
                  <button className="btn btn-small" onClick={() => void onApplyBatchSize(b.object)}>
                    Apply to template
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.nextAction !== 'none' && (
        <p className="muted">
          Next:{' '}
          {s.nextAction === 'resume'
            ? 'fix the cause, then Resume to load the rows this run did not.'
            : s.nextAction === 'rerunAutomation'
              ? 're-run the automation step after fixing the cause.'
              : s.nextAction === 'restoreTargetAutomation'
                ? 'restore the target automation this run left disabled.'
                : 'fix the cause — or record it as an expected failure on the template — then run again. Resume would meet the same rows.'}
        </p>
      )}
    </section>
  )
}

/**
 * S64 P5 (5.5b): memoised — `s` is a row of the persisted report, which keeps
 * its reference across the log-flush and job-event renders of the page, so
 * those renders skip every seed row. (A fresh `templateRunState` read is a new
 * report object; the rows re-render then, which is the correct cost.)
 */
const SeedRow = memo(function SeedRow({ s }: { s: TemplateReport['seed'][number] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const notes: string[] = []
  if (s.skippedObject) notes.push(`SKIPPED: ${s.skippedObject}`)
  if (s.note) notes.push(s.note)
  if (s.resumed > 0) notes.push(`${s.resumed} resumed`)
  if (s.savedOnSingleRetry > 0) notes.push(`${s.savedOnSingleRetry} on single-record retry`)
  if (s.bulkOnlyFailures > 0) notes.push(`${s.bulkOnlyFailures} bulk-only failures`)
  if (s.pruned != null && s.pruned > 0) notes.push(`${s.pruned} pruned`)
  if (s.noAccess.length > 0) notes.push(`${s.noAccess.length} not copied (no create access)`)
  const hasDetail = s.failures.length + s.skips.length + Object.keys(s.nulledFields).length + s.noAccess.length + s.missingOnTarget.length > 0
  return (
    <>
      <tr>
        <td>
          {hasDetail ? (
            <button className="btn subtle tier-name" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <span aria-hidden="true">{open ? '▾' : '▸'}</span> {s.object}
            </button>
          ) : (
            s.object
          )}
        </td>
        <td className="muted">{s.group}</td>
        <td>{s.source}</td>
        <td>{s.loaded}</td>
        <td className={s.failed > 0 ? 'status-err' : ''}>{s.failed}</td>
        <td className={s.skipped > 0 ? 'status-warn' : ''}>{s.skipped}</td>
        <td>{s.nulled}</td>
        <td className="muted">{s.fields}</td>
        <td className="muted">{notes.join(' · ')}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9}>
            <div className="seed-detail">
              {s.failures.slice(0, 20).map((f, i) => (
                <div key={`f${i}`} className="status-err">
                  FAILED {f.recordId ?? ''}: {f.message}
                </div>
              ))}
              {s.failures.length > 20 && <div className="muted">…and {s.failures.length - 20} more failures</div>}
              {s.skips.slice(0, 20).map((f, i) => (
                <div key={`s${i}`} className="status-warn">
                  SKIPPED {f.recordId ?? ''}: {f.message}
                </div>
              ))}
              {s.skips.length > 20 && <div className="muted">…and {s.skips.length - 20} more skips</div>}
              {Object.entries(s.nulledFields).map(([f, n]) => (
                <div key={f} className="muted">
                  nulled {f} on {n} row{n === 1 ? '' : 's'}: the referenced record is not on the target or was not loaded
                </div>
              ))}
              {s.noAccess.length > 0 && <div className="muted">NOT COPIED (no create access on the target): {s.noAccess.join(', ')}</div>}
              {s.missingOnTarget.length > 0 && <div className="muted">Not on the target: {s.missingOnTarget.join(', ')}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
})
