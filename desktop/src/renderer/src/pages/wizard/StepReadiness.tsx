import { useEffect, useState } from 'react'
import type { ObjectReadiness, ProvisionExtIdsSummary } from '../../../../shared/types'
import { nextLabel,
  readinessBlockingObjects,
  readinessGate,
  readinessGateMessage,
  readinessScopeKey,
  readinessUnfixableObjects
} from '../../../../shared/wizard'
import { GLOSSARY } from '../../../../shared/labels'
import { cannotHostExplanation } from '../../../../shared/extIdCapability'
import { useIpcQuery } from '../../ipc/hooks'
import { callIpc, toRdsError } from '../../ipc/client'
import { useWizard } from './WizardShell'

/** The one API name this step shows (ux T-2: prose says "the External Id field"; the name appears once, in code). */
const EXT_ID_API_NAME = 'Data_Deployment_External_Id__c'

/**
 * Wizard Step 3 — Readiness. Read-only check that the TARGET org has the
 * seeder's External Id upsert-key field (`Data_Deployment_External_Id__c`) on each
 * in-scope object. Junctions are exempt. A footprint line previews the deploy's
 * object count.
 *
 * S54 (L1): this step is a HARD STOP. A non-junction object whose External Id field
 * is missing / not an External Id / FLS-hidden — or that cannot be described —
 * renders RED and closes `readinessGate`: Next, the step nav, Analyze and
 * Deploy all consult the same predicate (shared/wizard.ts). The outcome of
 * every check is persisted on the draft keyed by scope, so a green for one
 * scope cannot leak through an added object. The S53 plan-freeze own-key
 * gate remains the last line of defence.
 *
 * S46: the per-row "Create field" buttons are gone. Provisioning is ONE action
 * for the whole scope, because creating the field is only half the job — the
 * field also needs field-level security before describe can see it, and FLS is
 * granted once, per permission set, not per object.
 *
 * S64 (P3, ux F-2): while that one action runs, each object it will create a
 * field on shows "…" in its row; the refetch that follows ticks them. The IPC
 * reports no per-object progress, so this is the honest minimum.
 */
export function StepReadiness(): React.JSX.Element {
  const { deploymentId, config, goToStep, updateConfig } = useWizard()
  const scopeKey = readinessScopeKey(config)
  const { data, loading, error, refetch } = useIpcQuery(
    () => window.rds.readinessCheck(deploymentId),
    [deploymentId, scopeKey]
  )

  // Persist every check's verdict for THIS scope (S54 L1) — the gate reads the
  // draft, not this component, so it holds on the Summary and Plan steps too.
  useEffect(() => {
    if (!data) return
    const blockingObjects = readinessBlockingObjects(data)
    const rec = config.readiness
    const ready = blockingObjects.length === 0
    if (
      rec &&
      rec.scopeKey === scopeKey &&
      rec.ready === ready &&
      rec.blockingObjects.join(',') === blockingObjects.join(',')
    ) {
      return // unchanged verdict — don't churn the draft
    }
    updateConfig({
      readiness: { scopeKey, ready, blockingObjects, checkedAt: new Date().toISOString() }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config.readiness is compared, not depended on
  }, [data, scopeKey])

  const gate = readinessGate(config)

  const [provisioning, setProvisioning] = useState<string[] | null>(null)
  const [summary, setSummary] = useState<ProvisionExtIdsSummary | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)

  // Provisioning can only ADD a truly-absent field; a same-named field that
  // isn't flagged External Id must be converted manually (metadata.create would
  // DUPLICATE it), so those objects are called out separately and excluded from
  // the count on the button.
  const creatable = (data?.objects ?? []).filter(
    (o) => o.needsExtIdField && !o.hasExtIdField && !o.describeError && !o.cannotHostCustomField
  )
  const unfixable = data ? readinessUnfixableObjects(data) : []
  const needsManualFlag = (data?.objects ?? []).filter((o) => o.needsExtIdField && o.hasExtIdField)
  const failureFor = (objectName: string): string | undefined =>
    summary?.failures.find((f) => f.objectName === objectName)?.error

  const provision = async (): Promise<void> => {
    setProvisioning(creatable.map((o) => o.objectName))
    setProvisionError(null)
    setSummary(null)
    try {
      setSummary(await callIpc(() => window.rds.readinessProvisionExtIds(deploymentId)))
    } catch (e) {
      setProvisionError(toRdsError(e).message)
    } finally {
      setProvisioning(null)
      // Always re-check against the LIVE target — a partial run still moved some
      // objects forward, so reflect reality either way.
      refetch()
    }
  }
  const busy = provisioning != null

  // S57 (B4): the only fix for an object that can never carry the key.
  const deselect = (objectName: string): void => {
    const filters = { ...config.filters }
    delete filters[objectName]
    const mappings = { ...config.mappings }
    delete mappings[objectName]
    updateConfig({
      selectedObjects: config.selectedObjects.filter((o) => o !== objectName),
      filters,
      mappings
    })
  }

  const statusCell = (o: ObjectReadiness): React.JSX.Element => {
    if (o.describeError) {
      return (
        <div className="status-err">
          <Glyph kind="err" /> could not describe on target
          <details className="learn-more">
            <summary>Why</summary>
            <pre className="error-text">{o.describeError}</pre>
          </details>
        </div>
      )
    }
    if (o.isJunction)
      return (
        <span className="muted" title={GLOSSARY.junction}>
          n/a (junction)
        </span>
      )
    if (!o.needsExtIdField)
      return (
        <span className="status-ok">
          <Glyph kind="ok" /> External Id present
        </span>
      )
    // S57 (B4): permanently red — provisioning cannot help; the Notes column says why.
    if (o.cannotHostCustomField) {
      return (
        <span className="status-err">
          <Glyph kind="err" /> can&apos;t carry a custom field
        </span>
      )
    }
    if (provisioning != null && provisioning.includes(o.objectName)) {
      return (
        <span className="muted" data-testid={`provisioning-${o.objectName}`}>
          <span aria-hidden="true">…</span> creating the field and granting access
        </span>
      )
    }
    // RED, not yellow (S54 L1): this row blocks the deploy.
    return (
      <span className="status-err">
        <Glyph kind="err" />{' '}
        {o.hasExtIdField ? 'field exists but is not an External Id' : 'missing External Id field'}
      </span>
    )
  }

  return (
    <>
      <h2>Readiness</h2>
      <p className="sub">
        Re-running a deployment updates the same rows because each object carries the External Id
        field this app adds on the target. Create the missing ones in one step below — junctions
        are matched by their lookup pair and need no field.
      </p>

      {loading && (
        <p className="muted" role="status">
          Checking the target…
          <span className="spinner" aria-hidden="true" />
        </p>
      )}
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
          <p className="footprint">
            <strong>{data.objectCount}</strong> object{data.objectCount === 1 ? '' : 's'} in scope ·{' '}
            <strong>{data.junctionCount}</strong> junction{data.junctionCount === 1 ? '' : 's'} ·{' '}
            {data.missingExtIdCount === 0 ? (
              <span className="status-ok">target ready</span>
            ) : (
              <span className="status-err">
                {data.missingExtIdCount} object{data.missingExtIdCount === 1 ? ' needs' : 's need'}{' '}
                an External Id field
              </span>
            )}
          </p>

          <div className="toolbar">
            <button
              className="btn primary"
              onClick={() => void provision()}
              disabled={busy || creatable.length === 0}
            >
              {busy
                ? 'Creating fields and granting access…'
                : creatable.length === 0
                  ? 'All External Id fields present'
                  : `Create ${creatable.length} External Id field${creatable.length === 1 ? '' : 's'}`}
              {busy && <span className="spinner" aria-hidden="true" />}
            </button>
            <button className="btn" onClick={refetch} disabled={busy}>
              Re-check target
            </button>
          </div>
          <p className="muted">
            Creates the External Id field (<code>{EXT_ID_API_NAME}</code>) on every object that needs
            it, then grants your user read/edit on those fields through a permission set the app
            manages (&ldquo;RDS Deployment Access&rdquo;). Without that grant the field exists but
            stays invisible to the API.
          </p>

          {provisionError && <div className="banner">{provisionError}</div>}

          {summary && (
            <div className={summary.failures.length > 0 ? 'banner warn' : 'banner ok'}>
              {summary.created.length > 0 && (
                <>
                  Created {summary.created.length} field
                  {summary.created.length === 1 ? '' : 's'}.{' '}
                </>
              )}
              {summary.granted.length > 0 && (
                <>
                  Granted access on {summary.granted.length} object
                  {summary.granted.length === 1 ? '' : 's'} via{' '}
                  <code>{summary.permissionSetName}</code>
                  {summary.permissionSetCreated && ' (permission set created)'}
                  {summary.assignmentCreated && ' (assigned to you)'}.{' '}
                </>
              )}
              {summary.skippedJunctions.length > 0 && (
                <>
                  Skipped {summary.skippedJunctions.length} junction
                  {summary.skippedJunctions.length === 1 ? '' : 's'}.{' '}
                </>
              )}
              {summary.failures.length > 0 && (
                <>
                  {summary.failures.length} object{summary.failures.length === 1 ? '' : 's'} failed
                  — see the rows below.
                </>
              )}
            </div>
          )}

          <table className="orgs">
            <thead>
              <tr>
                <th>Object</th>
                <th>External Id</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.objects.map((o) => {
                const err = failureFor(o.objectName)
                return (
                  <tr key={o.objectName}>
                    <td>{o.objectName}</td>
                    <td>{statusCell(o)}</td>
                    <td>
                      {o.cannotHostCustomField ? (
                        <>
                          <span className="muted">{cannotHostExplanation(o.objectName)}</span>{' '}
                          <button
                            className="btn btn-small"
                            onClick={() => deselect(o.objectName)}
                            disabled={busy}
                          >
                            Deselect {o.objectName}
                          </button>
                        </>
                      ) : (
                        err && (
                          <details className="verify-error">
                            <summary className="status-err">
                              <Glyph kind="err" /> Could not create the field — show the error
                            </summary>
                            <pre className="error-text">{err}</pre>
                          </details>
                        )
                      )}
                      {!err && o.needsExtIdField && o.hasExtIdField && (
                        <span className="muted">
                          Mark the existing field as an External Id in Setup.
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.junctionCount > 0 && (
            <p className="muted legend">
              <strong>junction</strong> — {GLOSSARY.junction}
            </p>
          )}

          {needsManualFlag.length > 0 && (
            <div className="banner warn">
              {needsManualFlag.length} object{needsManualFlag.length === 1 ? ' has' : 's have'} a
              field with the External Id API name above that is not flagged as an External Id. The
              app will not touch those — flag them in Setup, then re-check.
            </div>
          )}

          {gate.blocked && gate.reason === 'blocked' && (
            <div className="banner error" role="alert">
              {readinessGateMessage(gate)}
              {unfixable.length > 0 && (
                <>
                  {' '}
                  {unfixable.join(', ')} can&apos;t carry a custom field at all — provisioning
                  will never fix {unfixable.length === 1 ? 'it' : 'them'}; deselect{' '}
                  {unfixable.length === 1 ? 'it' : 'them'} to continue.
                </>
              )}
            </div>
          )}
          {!gate.blocked && (
            <p className="muted">Target ready for this scope — you can continue.</p>
          )}

          <div className="toolbar">
            <button className="btn" onClick={() => goToStep('scope')}>
              Back
            </button>
            <button
              className="btn primary"
              onClick={() => goToStep('mappings')}
              disabled={gate.blocked}
              title={gate.blocked ? readinessGateMessage(gate) : undefined}
            >
              {nextLabel('mappings')}
            </button>
          </div>
          {/* F-8 / A-9: the reason Next is disabled, visible — not only in `title`. */}
          {gate.blocked && (
            <p className="muted deploy-gate-note" data-testid="readiness-gate-note">
              {gate.reason === 'blocked'
                ? 'Next is disabled until every object above has a usable External Id field.'
                : readinessGateMessage(gate)}
            </p>
          )}
        </>
      )}
    </>
  )
}

/** Decorative ✓ / ✗ — the words beside it carry the meaning (ux A-12). */
function Glyph({ kind }: { kind: 'ok' | 'err' }): React.JSX.Element {
  return <span aria-hidden="true">{kind === 'ok' ? '✓' : '✗'}</span>
}
