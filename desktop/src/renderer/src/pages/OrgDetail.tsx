import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { OrgConnection, OrgExtIdFootprint } from '../../../shared/types'
import { effectiveRole, instanceHost } from '../../../shared/connectionsFilter'
import { statusLabel, statusTone } from '../../../shared/labels'
import { callIpc, toRdsError } from '../ipc/client'
import { useIpcQuery } from '../ipc/hooks'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { Loading } from '../ui/Loading'

/**
 * S70 (UAT U-4): one org's page — identity facts, its External Id footprint
 * (which objects carry `Data_Deployment_External_Id__c`, live from the org),
 * and the deployments that use it. Every call here is a READ; a prod-pinned
 * org answers like any other. The footprint is on demand, not on load: it is
 * one or two Tooling queries against a live session, and the row counts are
 * one COUNT() each, so nothing fires until the user asks.
 */
export function OrgDetailPage(): React.JSX.Element {
  const { id = '' } = useParams()
  const { data: orgs, loading } = useIpcQuery(() => window.rds.listOrgs(), [])
  const { data: deployments } = useIpcQuery(() => window.rds.draftList(), [])
  const org = orgs?.find((o) => o.id === id)

  if (loading && !orgs) return <Loading label="Loading connection…" />
  if (!org) {
    return (
      <>
        <Link to="/connections" className="back-link">
          ← Org Connections
        </Link>
        <EmptyState
          title="Connection not found"
          hint="It may have been removed, or the sf CLI alias was renamed. Go back and refresh the list."
        />
      </>
    )
  }

  const isOAuth = org.authKind === 'oauth'
  const live = isOAuth ? org.status === 'Active' : org.cliStatus === 'Connected'
  const using = (deployments ?? []).filter(
    (d) => d.sourceConnectionId === org.id || d.targetConnectionId === org.id
  )

  return (
    <>
      <Link to="/connections" className="back-link">
        ← Org Connections
      </Link>
      <h1>
        {org.label}
        <span className={`pill ml-2 ${isOAuth ? 'oauth' : 'cli'}`}>{isOAuth ? 'OAuth' : 'CLI'}</span>
        <span className={`pill ml-2 ${effectiveRole(org)}`}>{effectiveRole(org)}</span>
        {org.prodPinned && <span className="pill prod ml-2">PROD · read-only</span>}
      </h1>
      <p className="sub">{org.username}</p>

      <dl className="org-facts">
        <dt>Org Id</dt>
        <dd>
          <code>{org.orgId || '—'}</code>
        </dd>
        <dt>Instance</dt>
        <dd>{instanceHost(org.instanceUrl) || '—'}</dd>
        {org.cliAlias && (
          <>
            <dt>sf alias</dt>
            <dd>
              <code>{org.cliAlias}</code>
            </dd>
          </>
        )}
        {org.loginUrl && (
          <>
            <dt>Login host</dt>
            <dd>{instanceHost(org.loginUrl)}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>
          <span className={live ? 'status-ok' : 'status-warn'}>{isOAuth ? org.status : org.cliStatus}</span>
        </dd>
        <dt>Sandbox</dt>
        <dd>{org.isSandbox == null ? 'unknown' : org.isSandbox ? 'yes' : 'no'}</dd>
        <dt>Last verified</dt>
        <dd>{org.lastVerifiedAt ? new Date(org.lastVerifiedAt).toLocaleString() : 'never'}</dd>
      </dl>

      <ExtIdFootprint org={org} />

      <section className="org-section" aria-labelledby="org-deployments-heading">
        <h2 id="org-deployments-heading">Deployments using this org</h2>
        {using.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Deployment</th>
                  <th>Role here</th>
                  <th>Other org</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {using.map((d) => {
                  const asSource = d.sourceConnectionId === org.id
                  return (
                    <tr key={d.id}>
                      <td>
                        <Link to={`/deployments/${d.id}`}>{d.name}</Link>
                      </td>
                      <td>
                        <span className={`pill ${asSource ? 'source' : 'target'}`}>{asSource ? 'source' : 'target'}</span>
                      </td>
                      <td className="muted">{asSource ? `→ ${d.targetLabel}` : `${d.sourceLabel} →`}</td>
                      <td>
                        <Badge tone={statusTone('deployment', d.status)}>{statusLabel('deployment', d.status)}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

type CountState = number | 'loading' | { error: string }

function ExtIdFootprint({ org }: { org: OrgConnection }): React.JSX.Element {
  const [footprint, setFootprint] = useState<OrgExtIdFootprint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [counts, setCounts] = useState<Record<string, CountState>>({})

  const check = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      setFootprint(await callIpc(() => window.rds.orgExtIdFootprint(org.id)))
      setCounts({})
    } catch (e) {
      setError(toRdsError(e).message)
    } finally {
      setChecking(false)
    }
  }

  const count = async (objectName: string): Promise<void> => {
    setCounts((c) => ({ ...c, [objectName]: 'loading' }))
    try {
      const n = await callIpc(() => window.rds.orgExtIdCount(org.id, objectName))
      setCounts((c) => ({ ...c, [objectName]: n }))
    } catch (e) {
      setCounts((c) => ({ ...c, [objectName]: { error: toRdsError(e).message } }))
    }
  }

  return (
    <section className="org-section" aria-labelledby="org-extid-heading" data-testid="org-extid">
      <h2 id="org-extid-heading">External Id field</h2>
      <p className="sub">
        Which objects on this org carry the seeder&rsquo;s upsert key, <code>Data_Deployment_External_Id__c</code>.
        Read live from the org (a Tooling query — it sees the field even before field-level security is granted).
        Nothing is written.
      </p>
      <div className="toolbar">
        <button className="btn primary" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : footprint ? 'Check again' : 'Check this org'}
        </button>
      </div>
      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}
      {footprint && (
        <>
          <p className="footprint-meta">
            Checked {new Date(footprint.checkedAt).toLocaleTimeString()} —{' '}
            {footprint.objects.length === 0
              ? 'no object carries the field yet. The Readiness step of a deployment can create it.'
              : `${footprint.objects.length} object${footprint.objects.length === 1 ? '' : 's'} carry the field.`}
          </p>
          {footprint.objects.length > 0 && (
            <div className="table-wrap">
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th>Note</th>
                    <th>Rows with a key</th>
                  </tr>
                </thead>
                <tbody>
                  {footprint.objects.map((o) => {
                    const c = counts[o.objectName]
                    return (
                      <tr key={o.objectName}>
                        <td>
                          <code>{o.objectName}</code>
                        </td>
                        <td className="muted">{o.isJunction ? 'junction — keyed by its two parents, field not required' : ''}</td>
                        <td className="count-cell">
                          {c === undefined && (
                            <button className="btn btn-small" onClick={() => void count(o.objectName)}>
                              Count
                            </button>
                          )}
                          {c === 'loading' && <span className="muted">…</span>}
                          {typeof c === 'number' && c.toLocaleString()}
                          {typeof c === 'object' && c !== null && (
                            <span className="status-err" title={c.error}>
                              failed
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
