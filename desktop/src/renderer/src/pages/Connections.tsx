import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrgConnection, OrgRole, VerifyResult } from '../../../shared/types'
import { LOGIN_HOSTS } from '../../../shared/types'
import { callIpc, toRdsError } from '../ipc/client'

type HostChoice = 'production' | 'sandbox' | 'custom'

/** How long the per-row “Saved” marker stays up after a role write. */
const ROLE_SAVED_MS = 2000

/** Decode any rejection to the clean human message (never the raw RDS_ERR envelope). */
const errMsg = (e: unknown): string => toRdsError(e).message

export function ConnectionsPage(): React.JSX.Element {
  const [orgs, setOrgs] = useState<OrgConnection[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState<Record<string, boolean>>({})
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({})

  // OAuth add-org form state.
  const [hostChoice, setHostChoice] = useState<HostChoice>('production')
  const [customHost, setCustomHost] = useState('')
  const [oauthLabel, setOauthLabel] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  // Per-row busy flag (keyed by id) — a single shared id would clobber one row's
  // spinner/disabled state when another row's op starts or finishes.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  // Role writes persist immediately (no Save button by design), so the only
  // thing missing was proof — a transient per-row "Saved" marker. Timers are
  // tracked so a rapid re-pick replaces its predecessor instead of leaving an
  // orphan timeout that clears the newer marker early.
  const [roleSaved, setRoleSaved] = useState<Record<string, boolean>>({})
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(
    () => () => {
      Object.values(savedTimers.current).forEach(clearTimeout)
    },
    []
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setOrgs(await callIpc(() => window.rds.refreshOrgs()))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Initial load; on first launch (empty store) auto-populate from the sf CLI.
    void (async () => {
      const existing = await window.rds.listOrgs()
      if (existing.length === 0) {
        await refresh()
      } else {
        setOrgs(existing)
      }
    })()
  }, [refresh])

  const setRole = async (connectionId: string, role: OrgRole): Promise<void> => {
    setError(null)
    try {
      setOrgs(await callIpc(() => window.rds.setOrgRole(connectionId, role)))
      clearTimeout(savedTimers.current[connectionId])
      setRoleSaved((s) => ({ ...s, [connectionId]: true }))
      savedTimers.current[connectionId] = setTimeout(() => {
        setRoleSaved((s) => ({ ...s, [connectionId]: false }))
        delete savedTimers.current[connectionId]
      }, ROLE_SAVED_MS)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const verify = async (connectionId: string): Promise<void> => {
    setVerifying((v) => ({ ...v, [connectionId]: true }))
    try {
      const result = await window.rds.verifyOrg(connectionId)
      setVerifyResults((r) => ({ ...r, [connectionId]: result }))
      if (result.ok) setOrgs(await window.rds.listOrgs())
    } finally {
      setVerifying((v) => ({ ...v, [connectionId]: false }))
    }
  }

  const resolveLoginUrl = (): string => {
    if (hostChoice === 'production') return LOGIN_HOSTS.production
    if (hostChoice === 'sandbox') return LOGIN_HOSTS.sandbox
    const h = customHost.trim()
    return /^https?:\/\//.test(h) ? h : `https://${h}`
  }

  const signIn = async (): Promise<void> => {
    if (hostChoice === 'custom' && !customHost.trim()) {
      setError('Enter your My Domain host (e.g. mycompany.my.salesforce.com).')
      return
    }
    setSigningIn(true)
    setError(null)
    try {
      const updated = await callIpc(() =>
        window.rds.oauthBegin({
          loginUrl: resolveLoginUrl(),
          label: oauthLabel.trim() || undefined
        })
      )
      setOrgs(updated)
      setOauthLabel('')
      setCustomHost('')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSigningIn(false)
    }
  }

  const reauthenticate = async (o: OrgConnection): Promise<void> => {
    if (!o.loginUrl) return
    setBusy((b) => ({ ...b, [o.id]: true }))
    setError(null)
    try {
      setOrgs(
        await callIpc(() =>
          window.rds.oauthBegin({ loginUrl: o.loginUrl!, reauthConnectionId: o.id })
        )
      )
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy((b) => ({ ...b, [o.id]: false }))
    }
  }

  const disconnect = async (o: OrgConnection): Promise<void> => {
    setBusy((b) => ({ ...b, [o.id]: true }))
    setError(null)
    try {
      setOrgs(await callIpc(() => window.rds.oauthDisconnect(o.id)))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy((b) => ({ ...b, [o.id]: false }))
    }
  }

  // S52 F3: remove a stale CLI row (superseded alias / logged-out auth). Main
  // refuses while a deployment still references it — the error names the fix.
  const remove = async (o: OrgConnection): Promise<void> => {
    setBusy((b) => ({ ...b, [o.id]: true }))
    setError(null)
    try {
      setOrgs(await callIpc(() => window.rds.orgRemove(o.id)))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy((b) => ({ ...b, [o.id]: false }))
    }
  }

  const isStale = (o: OrgConnection): boolean =>
    o.supersededBy != null || o.cliStatus === 'Not in CLI'
  const liveOrgs = orgs.filter((o) => !isStale(o))
  const staleOrgs = orgs.filter(isStale)

  return (
    <>
      <h1>Org Connections</h1>
      <p className="sub">
        Use orgs from your Salesforce CLI, or add one directly with OAuth (opens your browser).
        Assign roles to use them in deployments — source orgs are read-only by design; LaunchDarkly
        production is permanently pinned read-only.
      </p>

      {error && <div className="banner">{error}</div>}

      <div className="toolbar">
        <button className="btn primary" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh from sf CLI'}
        </button>
      </div>

      <div className="card oauth-add" style={{ margin: '12px 0', padding: 12 }}>
        <strong>Add an org via OAuth</strong>
        <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <select
            aria-label="Login host"
            value={hostChoice}
            onChange={(e) => setHostChoice(e.target.value as HostChoice)}
          >
            <option value="production">Production (login.salesforce.com)</option>
            <option value="sandbox">Sandbox (test.salesforce.com)</option>
            <option value="custom">Custom My Domain…</option>
          </select>
          {hostChoice === 'custom' && (
            <input
              aria-label="My Domain host"
              placeholder="mycompany.my.salesforce.com"
              value={customHost}
              onChange={(e) => setCustomHost(e.target.value)}
            />
          )}
          <input
            aria-label="Label"
            placeholder="Label (optional)"
            value={oauthLabel}
            onChange={(e) => setOauthLabel(e.target.value)}
          />
          <button className="btn primary" onClick={() => void signIn()} disabled={signingIn}>
            {signingIn ? 'Waiting for browser…' : 'Sign in'}
          </button>
        </div>
      </div>

      <table className="orgs">
        <thead>
          <tr>
            <th>Connection</th>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {liveOrgs.map((o) => {
            const vr = verifyResults[o.id]
            const isOAuth = o.authKind === 'oauth'
            const rowBusy = !!busy[o.id]
            return (
              <tr key={o.id}>
                <td>
                  {o.label}
                  <span className={`pill ${isOAuth ? 'oauth' : 'cli'}`} style={{ marginLeft: 8 }}>
                    {isOAuth ? 'OAuth' : 'CLI'}
                  </span>
                  {o.prodPinned && (
                    <span className="pill prod" style={{ marginLeft: 8 }}>
                      PROD · read-only
                    </span>
                  )}
                </td>
                <td className="muted">{o.username}</td>
                <td>
                  {o.prodPinned ? (
                    <span className="pill source">source</span>
                  ) : (
                    <>
                      <select
                        className="role"
                        value={o.role}
                        onChange={(e) => void setRole(o.id, e.target.value as OrgRole)}
                      >
                        <option value="unassigned">unassigned</option>
                        <option value="source">source (read-only)</option>
                        <option value="target">target</option>
                      </select>
                      {roleSaved[o.id] && (
                        <span className="status-ok role-saved" role="status">
                          {' '}
                          ✓ Saved
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td>
                  {isOAuth ? (
                    <span className={o.status === 'Active' ? 'status-ok' : 'status-warn'}>
                      {o.status}
                    </span>
                  ) : (
                    <span className={o.cliStatus === 'Connected' ? 'status-ok' : 'status-warn'}>
                      {o.cliStatus}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    className="btn"
                    onClick={() => void verify(o.id)}
                    disabled={!!verifying[o.id] || rowBusy}
                  >
                    {verifying[o.id] ? '…' : 'Verify'}
                  </button>{' '}
                  {isOAuth && (
                    <>
                      <button
                        className="btn"
                        onClick={() => void reauthenticate(o)}
                        disabled={rowBusy}
                      >
                        {rowBusy ? '…' : 'Re-authenticate'}
                      </button>{' '}
                      <button
                        className="btn danger"
                        onClick={() => void disconnect(o)}
                        disabled={rowBusy}
                      >
                        Disconnect
                      </button>{' '}
                    </>
                  )}
                  {vr &&
                    (vr.ok ? (
                      <span className="status-ok">✓ {vr.username}</span>
                    ) : (
                      <span className="status-err" title={vr.error}>
                        ✗ {vr.error?.slice(0, 60)}
                      </span>
                    ))}
                </td>
              </tr>
            )
          })}
          {liveOrgs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No orgs yet — “Refresh from sf CLI” or add one via OAuth.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {staleOrgs.length > 0 && (
        <details className="stale-orgs">
          <summary>
            Stale connections ({staleOrgs.length}) — aliases the sf CLI no longer lists
          </summary>
          <p className="muted">
            A renamed alias or a refreshed sandbox leaves the old row behind. Superseded rows
            still work for the deployments that use them and are hidden from new-deployment
            pickers; remove them once nothing references them.
          </p>
          <table className="orgs">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Username</th>
                <th>Role</th>
                <th>Why stale</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staleOrgs.map((o) => (
                <tr key={o.id}>
                  <td>{o.label}</td>
                  <td className="muted">{o.username}</td>
                  <td>
                    <span className={`pill ${o.role}`}>{o.role}</span>
                  </td>
                  <td className="muted">
                    {o.supersededBy ? `superseded by ${o.supersededBy}` : 'not in the sf CLI any more'}
                  </td>
                  <td>
                    <button
                      className="btn danger"
                      onClick={() => void remove(o)}
                      disabled={!!busy[o.id]}
                    >
                      {busy[o.id] ? '…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  )
}
