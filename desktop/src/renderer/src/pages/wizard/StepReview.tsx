import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  duplicateStageReferences,
  isDeployFinished,
  setupAttestationBlocked,
  setupMissingStages,
  templateStepsOf
} from '../../../../shared/wizard'
import { DRY_RUN_CAVEAT } from '../../../../shared/templates/types'
import type { PostRefreshTemplate, TemplateDetail } from '../../../../shared/templates/types'
import { Badge } from '../../ui/Badge'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useIpcMutation, useIpcQuery } from '../../ipc/hooks'
import { useJobsStore } from '../../store/jobs'
import { useWizard } from './WizardShell'

/**
 * S72 — the data-less sandbox setup's terminal step ("Review"): the stage
 * run-order strip, the CPQ attestation (gated objects from every ticked seed —
 * there is no plan snapshot to union with), the S71 duplicate-reference
 * warning, and Run setup. No analysis, no plan row, no deploy_runs row — the
 * run is template stages only, and the re-run guard speaks the templates'
 * vocabulary (resume via the seed id map; purge only by hand on the Templates
 * tab).
 */
export function StepReview(): React.JSX.Element {
  const { deploymentId, config, updateConfig, goToStep, status, sourceLabel, targetLabel, kind } =
    useWizard()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const rerun = isDeployFinished(status)

  const steps = templateStepsOf(config)
  const missingStages = setupMissingStages(kind, config)
  // Every stage's gated objects + the duplicate check need the template payloads.
  const all = useIpcQuery(() => window.rds.templateListAll(), [])
  const postRefreshIds = useMemo(
    () =>
      (all.data ?? []).filter((t) => t.kind === 'postRefresh').map((t) => t.id),
    [all.data]
  )
  const details = useIpcQuery(
    () => Promise.all(postRefreshIds.map((id) => window.rds.templateGet(id))),
    [postRefreshIds.join(',')]
  )
  const detailById = useMemo(() => {
    const m = new Map<number, TemplateDetail>()
    for (const d of details.data ?? []) m.set(d.id, d)
    return m
  }, [details.data])

  const postRefreshSeeds = useMemo(() => {
    const m = new Map<number, ReadonlyArray<string>>()
    for (const id of postRefreshIds) {
      const payload = detailById.get(id)?.payload as PostRefreshTemplate | undefined
      m.set(id, (payload?.seedTemplates ?? []).map((s) => s.name))
    }
    return m
  }, [postRefreshIds, detailById])
  const duplicates = duplicateStageReferences(config, postRefreshSeeds)

  // The attestation set: every ticked seed's cpqGatedObjects (the plan's gated
  // objects do not exist — there is no plan). Derived from templateStepsOf so
  // the memo's inputs are stable draft fields, not fresh copies.
  const gatedObjects = useMemo(() => {
    const summaries = all.data ?? []
    const t = templateStepsOf(config)
    const ticked = new Set(
      [...t.before, ...t.after].flatMap((r) => r.steps.seeds.map((s) => s.name))
    )
    return [
      ...new Set(
        summaries
          .filter((s) => s.kind === 'seed' && ticked.has(s.name))
          .flatMap((s) => s.cpqGatedObjects ?? [])
      )
    ].sort()
  }, [all.data, config])
  const cpqBlocked = setupAttestationBlocked(gatedObjects, config.cpqAttestation)

  const run = useIpcMutation(() => window.rds.deployStart(deploymentId))

  const runAllowed =
    !missingStages && duplicates.length === 0 && !cpqBlocked && !run.loading

  const runCopy = rerun ? 'Re-run setup' : 'Run setup'

  return (
    <>
      <h2>Review the setup</h2>
      <p className="muted">
        {steps.before.length + steps.after.length} template stage
        {steps.before.length + steps.after.length === 1 ? '' : 's'} run in order against{' '}
        {targetLabel}, reading from {sourceLabel}. No records are copied and no plan is analyzed —
        each stage is a template run with its own report.
      </p>

      {missingStages && (
        <div className="banner error" role="alert" data-testid="setup-missing-stages">
          No template stages are placed — add at least one on the Setup step.
        </div>
      )}
      {duplicates.length > 0 && (
        <div className="banner error" role="alert" data-testid="duplicate-stage-refs">
          {(() => {
            const first = duplicates[0]
            if (!first) return null
            return (
              <>
                <strong>A template is referenced twice.</strong> {first.seedName} runs as its own
                stage AND nested inside “{first.nestedIn}” — the second run would find the seed
                objects already loaded and block, skipping every later stage. Set one of the two to
                “Not used” on the Setup step.
                {duplicates.length > 1 && (
                  <details className="learn-more">
                    <summary>{duplicates.length - 1} more</summary>
                    <ul>
                      {duplicates.slice(1).map((d, i) => (
                        <li key={i}>
                          {d.seedName} — own stage “{d.ownStage}” + nested in “{d.nestedIn}”
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )
          })()}
        </div>
      )}

      <section className="preflight" aria-labelledby="review-heading" data-testid="review-stages">
        <h3 id="review-heading">Run order</h3>
        {/* The refs carry both the label and the kind — labels alone cannot tell
            a post-refresh stage from a seed stage sharing the same name shape. */}
        <ul className="stage-order-list">
          {[...steps.before, ...steps.after].map((s, i) => (
            <li key={`${s.templateId}-${i}`}>
              <span className="stage-order-num" aria-hidden="true">
                {i + 1}
              </span>
              <span>{s.name}</span>
              <span className="muted">{s.kind === 'postRefresh' ? 'post-refresh' : 'data seed'}</span>
            </li>
          ))}
        </ul>
        <p className="muted">A stage that ends blocked, failed or cancelled stops the sequence.</p>
      </section>

      <section className="preflight" aria-labelledby="review-gates-heading">
        <h3 id="review-gates-heading">Before you run</h3>
        <ul className="preflight-list">
          <li className="preflight-row" data-state={cpqBlocked ? 'todo' : 'ok'} data-testid="review-cpq">
            <details open={cpqBlocked || undefined}>
              <summary className="preflight-summary">
                <span className="preflight-label">CPQ “Triggers Disabled” confirmation</span>
                <span className="preflight-line muted">
                  {cpqBlocked
                    ? `Confirm before running — ${gatedObjects.length} gated object${gatedObjects.length === 1 ? '' : 's'}`
                    : gatedObjects.length > 0
                      ? `Confirmed for ${gatedObjects.length} gated object${gatedObjects.length === 1 ? '' : 's'}`
                      : 'Not needed — no CPQ-gated objects in these seeds'}
                </span>
              </summary>
              <div className="preflight-body">
                {gatedObjects.length > 0 ? (
                  <>
                    <p>
                      A ticked seed loads objects that Salesforce CPQ&rsquo;s managed triggers react
                      to ({gatedObjects.join(', ')}). Tick CPQ&rsquo;s <strong>Triggers Disabled</strong>{' '}
                      checkbox on the target (Setup → Installed Packages → Salesforce CPQ →
                      Configure → Additional Settings), then confirm here — and untick it after the
                      run.
                    </p>
                    <label className="master-toggle">
                      <input
                        type="checkbox"
                        checked={config.cpqAttestation}
                        onChange={(e) => updateConfig({ cpqAttestation: e.target.checked })}
                      />{' '}
                      Confirmed — I checked “Triggers Disabled” on {targetLabel}
                    </label>
                  </>
                ) : (
                  <p className="muted">
                    No ticked seed touches CPQ-gated objects, so the bypass step is not needed for
                    this setup.
                  </p>
                )}
              </div>
            </details>
          </li>
        </ul>
      </section>

      {rerun && (
        <div className="banner warn" role="note" data-testid="rerun-note">
          <strong>This setup already ran ({status}).</strong> Re-running resumes each seed from the
          id map (rows it already mapped are skipped); anything not mapped loads again. To start
          over from scratch, purge the seed objects on the Templates tab first — a composed run
          never purges.
        </div>
      )}

      <div className="toolbar">
        <button className="btn" onClick={() => goToStep('templates')}>
          Back
        </button>
        <button
          className="btn primary"
          disabled={!runAllowed}
          title={
            missingStages
              ? 'Place at least one template stage first'
              : duplicates.length > 0
                ? 'A template is referenced twice — fix it on the Setup step'
                : cpqBlocked
                  ? 'Confirm the CPQ “Triggers Disabled” step first'
                  : undefined
          }
          onClick={() =>
            void (async () => {
              if (rerun) {
                const ok = await confirm({
                  title: 'Re-run this setup?',
                  message:
                    'Each seed resumes from the id map (rows it already mapped are skipped); anything not mapped loads again. A composed run never purges — to start from scratch, purge on the Templates tab first.',
                  confirmLabel: 'Re-run setup'
                })
                if (!ok) return
              }
              const started = await run.mutate()
              if (!started) return
              await useJobsStore.getState().refresh()
              navigate(`/deployments/${deploymentId}`)
            })()
          }
        >
          {run.loading ? 'Starting…' : runCopy}
        </button>
      </div>
      {run.error && <p className="error">Setup failed to start: {run.error.message}</p>}
      <p className="muted legend" data-testid="dry-run-caveat">
        {DRY_RUN_CAVEAT} Run a dry run of a template on the Templates tab to see what it would
        do — this run applies for real.
      </p>
      <Badge tone="neutral" data-testid="setup-kind">
        Sandbox setup — templates only
      </Badge>
    </>
  )
}
