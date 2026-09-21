import { deploymentRoleIssues, describeAssignment } from '../../../../shared/roles'
import { useIpcMutation, useIpcQuery } from '../../ipc/hooks'
import { useToast } from '../../ui/Toast'
import { useWizard } from './WizardShell'

/**
 * Wizard Step 1 — confirm the source→target pair and show the object
 * intersection: how many objects are deployable (in both orgs) vs excluded
 * because they exist only on one side. Gate: at least one common object.
 *
 * S52 F2: also shows the pair's CONNECTION roles and fixes them in place. A
 * draft created before F1 (or after a demotion on the Connections page) can
 * still carry an `unassigned` target; before this the first sign was the deploy
 * refusal "cannot be a deploy target (role 'unassigned')" seven steps later.
 */
export function StepOrgs(): React.JSX.Element {
  const {
    deploymentId,
    sourceConnectionId,
    targetConnectionId,
    sourceLabel,
    targetLabel,
    goToStep
  } = useWizard()
  const toast = useToast()
  const { data, loading, error, refetch } = useIpcQuery(
    () => window.rds.objectsIntersection({ sourceConnectionId, targetConnectionId }),
    [sourceConnectionId, targetConnectionId]
  )
  const orgs = useIpcQuery(() => window.rds.listOrgs(), [])
  const assign = useIpcMutation(() => window.rds.deploymentAssignRoles(deploymentId))

  const sourceRow = orgs.data?.find((o) => o.id === sourceConnectionId)
  const targetRow = orgs.data?.find((o) => o.id === targetConnectionId)
  const issues = sourceRow && targetRow ? deploymentRoleIssues(sourceRow, targetRow) : []
  const fixable = issues.some((i) => i.fixable)
  const blocked = issues.filter((i) => !i.fixable)

  const assignRoles = async (): Promise<void> => {
    const assigned = await assign.mutate()
    if (!assigned) return
    const written = describeAssignment(assigned, { source: sourceLabel, target: targetLabel })
    toast(written || 'Roles were already set.', 'success')
    orgs.refetch()
  }

  return (
    <>
      <h2>Objects in common</h2>

      {sourceRow && targetRow && (
        <p className="role-line">
          <span className={`pill ${sourceRow.role}`}>{sourceRow.role}</span> {sourceLabel}
          <span className="muted">→</span>
          <span className={`pill ${targetRow.role}`}>{targetRow.role}</span> {targetLabel}
        </p>
      )}

      {issues.length > 0 && (
        <div className={blocked.length > 0 ? 'banner' : 'banner warn'} role="alert">
          <strong>Roles need attention before this can deploy.</strong>
          <ul>
            {issues.map((i) => (
              <li key={i.side}>{i.reason}</li>
            ))}
          </ul>
          {fixable && (
            <button
              className="btn primary"
              onClick={() => void assignRoles()}
              disabled={assign.loading}
            >
              {assign.loading ? 'Saving…' : 'Assign roles'}
            </button>
          )}
          {assign.error && <p className="error">{assign.error.message}</p>}
        </div>
      )}

      {loading && <p className="muted">Comparing schemas…</p>}
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
          <div className="intersection-banner">
            <span className="badge badge-success">{data.common} deployable</span>
            <span className="badge badge-warn">{data.sourceOnly} source-only (excluded)</span>
            <span className="badge badge-neutral">{data.targetOnly} target-only</span>
          </div>
          <p className="sub">
            {data.common} object{data.common === 1 ? '' : 's'} exist in both {sourceLabel} and{' '}
            {targetLabel} and can be deployed. Source-only objects are skipped — the target has
            nothing to write them into.
          </p>
          <div className="toolbar">
            <button
              className="btn primary"
              disabled={data.common === 0}
              onClick={() => goToStep('objects')}
            >
              Next: choose objects
            </button>
          </div>
          {data.common === 0 && (
            <div className="banner">
              These orgs share no deployable objects — check the source/target selection.
            </div>
          )}
        </>
      )}
    </>
  )
}
