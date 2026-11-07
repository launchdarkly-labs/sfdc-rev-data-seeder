import { useMemo, useState } from 'react'
import { KEYLESS_CAUTION } from '../../../shared/wizard'
import type { DeploymentKind } from '../../../shared/types'
import { Link, useNavigate } from 'react-router-dom'
import { describeAssignment } from '../../../shared/roles'
import { useIpcQuery, useIpcMutation } from '../ipc/hooks'
import { useToast } from '../ui/Toast'

/**
 * Create-deployment form: type + name + source + target (same-org guarded), then
 * create the Draft row and enter the wizard at Step 1. Source/target are fixed
 * for the life of a draft (changing them = a new deployment).
 *
 * S52 F1: picking an `unassigned` org here IS its role assignment — the create
 * writes source/target onto the connection rows atomically (main side), and a
 * toast names what was written. Rows that already have a role are untouched.
 *
 * S72 (D1): the TYPE is chosen here and fixed for the life of the row, the same
 * rule as source/target. 'data' is today's deployment; 'sandboxSetup' runs
 * templates first (required) with the data stage optional (D2, default on).
 */
export function NewDeploymentPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { data: orgs, loading } = useIpcQuery(() => window.rds.listOrgs(), [])
  const create = useIpcMutation(window.rds.draftCreate)

  const [kind, setKind] = useState<DeploymentKind>('data')
  const [name, setName] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  // S61 (U-5): Jack's decision — the External Id field is OPTIONAL. Default on (the proven path);
  // off = keyless, insert-only through the local id map, with the caution shown right here.
  const [useExternalIds, setUseExternalIds] = useState(true)
  // S72 (D2): a sandbox setup's data stage — default ON (S71's proven shape); off = templates only.
  const [includeData, setIncludeData] = useState(true)
  const setup = kind === 'sandboxSetup'

  // S52 F3: superseded (alias renamed / sandbox refreshed) and not-in-CLI rows
  // stay out of the pickers — they still work for old deployments, but a new
  // deployment should point at the live alias.
  const pickable = useMemo(
    () => (orgs ?? []).filter((o) => !o.supersededBy && o.cliStatus !== 'Not in CLI'),
    [orgs]
  )
  const sources = useMemo(
    () => pickable.filter((o) => o.role === 'source' || o.role === 'unassigned'),
    [pickable]
  )
  // Prod can never be a target (store enforces it too); keep it out of the picker.
  const targets = useMemo(
    () => pickable.filter((o) => (o.role === 'target' || o.role === 'unassigned') && !o.prodPinned),
    [pickable]
  )

  const sameOrg = sourceId !== '' && sourceId === targetId
  const canCreate = name.trim() !== '' && sourceId !== '' && targetId !== '' && !sameOrg

  // On failure, mutate returns undefined and sets create.error, which renders
  // reactively below — never read create.error synchronously after the await
  // (that closure holds the pre-call value).
  const submit = async (): Promise<void> => {
    const result = await create.mutate({
      name: name.trim(),
      sourceConnectionId: sourceId,
      targetConnectionId: targetId,
      useExternalIds: setup ? (includeData ? useExternalIds : true) : useExternalIds,
      kind,
      includeData: setup ? includeData : undefined
    })
    if (result == null) return
    const labelOf = (id: string): string => (orgs ?? []).find((o) => o.id === id)?.label ?? id
    const written = describeAssignment(result.assigned, {
      source: labelOf(sourceId),
      target: labelOf(targetId)
    })
    if (written) toast(written, 'success')
    // S72: both kinds enter at the Orgs step; the kind drives the step list after it.
    navigate(`/deployments/${result.id}/wizard/orgs`)
  }

  return (
    <>
      <h1>New Deployment</h1>
      <p className="sub">Pick a source to read from and a target to deploy into.</p>

      {loading ? (
        <p className="muted">Loading connections…</p>
      ) : pickable.length === 0 ? (
        <div className="banner warn" role="note" data-testid="no-orgs">
          <strong>No orgs connected yet.</strong> A deployment needs a source and a target org.{' '}
          <Link to="/connections">Connect your orgs</Link> first — the app lists every org you have signed in to with
          the Salesforce CLI, or you can add one with OAuth.
        </div>
      ) : (
        <div className="form">
          {/* S72 (D1): the type is fixed at creation — radio cards, not a select that implies editability. */}
          <fieldset className="field" data-testid="deployment-kind">
            <legend>What are you starting?</legend>
            <div className="kind-cards">
              <label className={`kind-card ${kind === 'data' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="deployment-kind"
                  value="data"
                  checked={kind === 'data'}
                  onChange={() => setKind('data')}
                />
                <span className="kind-card-title">Data deployment</span>
                <span className="muted">
                  Copy a scoped record graph from a source org into a target. Templates optional.
                </span>
              </label>
              <label className={`kind-card ${setup ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="deployment-kind"
                  value="sandboxSetup"
                  checked={setup}
                  onChange={() => setKind('sandboxSetup')}
                />
                <span className="kind-card-title">Sandbox setup</span>
                <span className="muted">
                  Take a fresh sandbox from empty to working — templates first (required), data optional.
                </span>
              </label>
            </div>
          </fieldset>

          {setup && (
            <label className="master-toggle">
              <input
                type="checkbox"
                checked={includeData}
                onChange={(e) => setIncludeData(e.target.checked)}
              />{' '}
              Include a data stage (copy records after the setup templates)
            </label>
          )}

          <label className="field">
            <span>Name</span>
            <input
              className="text-input"
              value={name}
              placeholder={setup ? 'e.g. week45 sandbox setup' : 'e.g. Acme CPQ scope'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Source (read-only)</span>
            <select
              className="text-input"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">Select source…</option>
              {sources.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.prodPinned
                    ? ' (PROD · read-only)'
                    : o.role === 'unassigned'
                      ? ' (will become Source)'
                      : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Target</span>
            <select
              className="text-input"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">Select target…</option>
              {targets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.role === 'unassigned' ? ' (will become Target)' : ''}
                </option>
              ))}
            </select>
          </label>

          {/* S72: the key question only exists when data will land — a data-less setup has no upsert at all. */}
          {(!setup || includeData) && (
            <label className="master-toggle">
              <input type="checkbox" checked={useExternalIds} onChange={(e) => setUseExternalIds(e.target.checked)} />{' '}
              Use an External Id field on the target (recommended — re-runs update the same rows)
            </label>
          )}
          {(!setup || includeData) && !useExternalIds && (
            <div className="banner warn" role="note" data-testid="keyless-caution">
              <strong>Keyless deployment.</strong> {KEYLESS_CAUTION} The Readiness step is skipped.
            </div>
          )}
          {setup && !includeData && (
            <div className="banner" role="note" data-testid="setup-no-data">
              Templates only — no records are copied and no plan is analyzed. The wizard is Orgs →
              Setup → Review.
            </div>
          )}

          {sameOrg && <div className="banner">Source and target must be different orgs.</div>}
          {create.error && <div className="banner">Could not create: {create.error.message}</div>}

          <div className="toolbar">
            <button
              className="btn primary"
              disabled={!canCreate || create.loading}
              onClick={() => void submit()}
            >
              {create.loading ? 'Creating…' : 'Create & continue'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
