import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrgConnection, OrgRole, VerifyResult } from '../../../shared/types'
import { LOGIN_HOSTS } from '../../../shared/types'
import {
  DEFAULT_PROD_ORG_ID_PREFIX,
  normalizeProdOrgIdPrefix,
  PROD_PIN_HELP,
  PROD_PIN_SETTING_KEY
} from '../../../shared/prodPin'
import { callIpc, toRdsError } from '../ipc/client'
import { EmptyState } from '../ui/EmptyState'

type HostChoice = 'production' | 'sandbox' | 'custom'

/** How long the per-row “Saved” marker stays up after a role write. */
const ROLE_SAVED_MS = 2000

/** Decode any rejection to the clean human message (never the raw RDS_ERR envelope). */
const errMsg = (e: unknown): string => toRdsError(e).message

export function ConnectionsPage(): React.JSX.Element {
  const [orgs, setOrgs] = useState<OrgConnection[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // S64 (P2): a missing `sf` CLI gets guidance, not a raw spawn error.
  const [cliMissing, setCliMissing] = useState(false)
  // S64 (P2): the org list grows with every sandbox refresh alias — filter it.
  const [query, setQuery] = useState('')
  const [hideUnassigned, setHideUnassigned] = useState(false)
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
  // S64 P6 (D6): the production pin is a runtime setting with the compiled default.
  const [pin, setPin] = useState<string>(DEFAULT_PROD_ORG_ID_PREFIX)
  const [pinDraft, setPinDraft] = useState<string>(DEFAULT_PROD_ORG_ID_PREFIX)
  const [pinSaving, setPinSaving] = useState(false)
  const [pinSaved, setPinSaved] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)

  useEffect(
    () => () => {
      Object.values(savedTimers.current).forEach(clearTimeout)
    },
    []
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCliMissing(false)
    try {
      setOrgs(await callIpc(() => window.rds.refreshOrgs()))
    } catch (e) {
      if (toRdsError(e).code === 'CLI_MISSING') setCliMissing(true)
      else setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stored = await window.rds.settingsGet(PROD_PIN_SETTING_KEY)
        const effective = normalizeProdOrgIdPrefix(stored) ?? DEFAULT_PROD_ORG_ID_PREFIX
        if (!cancelled) {
          setPin(effective)
          setPinDraft(effective)
        }
      } catch {
        /* an older main without the setting — the default stands */
      }
    })()
    return () => {
      cancelled = true
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

  /** Persist a pin, then re-read the list: pins are evaluated per row at read time. */
  const savePin = async (value: string): Promise<void> => {
    const normalized = normalizeProdOrgIdPrefix(value)
    if (!normalized) {
      setPinError('Enter a Salesforce Org Id: 00D followed by 12 letters or digits, or the 18-character form.')
      return
    }
    setPinSaving(true)
    setPinError(null)
    setPinSaved(false)
    try {
      await callIpc(() => window.rds.settingsSet(PROD_PIN_SETTING_KEY, normalized))
      setPin(normalized)
      setPinDraft(normalized)
      setPinSaved(true)
      setOrgs(await window.rds.listOrgs())
    } catch (e) {
      setPinError(errMsg(e))
    } finally {
      setPinSaving(false)
    }
  }

  const isStale = (o: OrgConnection): boolean =>
    o.supersededBy != null || o.cliStatus === 'Not in CLI'
  const liveOrgs = orgs.filter((o) => !isStale(o))
  const staleOrgs = orgs.filter(isStale)
  const q = query.trim().toLowerCase()
  const shownOrgs = liveOrgs.filter(
    (o) =>
      (!hideUnassigned || o.role !== 'unassigned' || o.prodPinned) &&
      (q === '' || o.label.toLowerCase().includes(q) || (o.username ?? '').toLowerCase().includes(q))
  )

  return (
    <>
      <h1>Connections</h1>
      <p className="sub">
        Use orgs from your Salesforce CLI, or add one directly with OAuth (opens your browser).
        Assign roles to use them in deployments — source orgs are read-only by design; production orgs are pinned read-only.
      </p>

      {cliMissing && (
        <div className="banner warn" role="alert" data-testid="cli-missing">
          <strong>The Salesforce CLI was not found.</strong> This app lists the orgs you have signed in to with
          the <code>sf</code> CLI. Install it from{' '}
          <a href="https://developer.salesforce.com/tools/salesforcecli" target="_blank" rel="noreferrer">
            developer.salesforce.com/tools/salesforcecli
          </a>
          , run <code>sf org login web -a &lt;alias&gt;</code> for each org, then click{' '}
          <em>Refresh from sf CLI</em>.
        </div>
      )}
      {error && <div className="banner">{error}</div>}

      <div className="toolbar">
        <button className="btn primary" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh from sf CLI'}
        </button>
      </div>

      <div className="oauth-add">
        <strong>Add an org via OAuth</strong>
        <div className="oauth-add-row">
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

      <div className="toolbar filter-bar">
        <input
          className="text-input"
          type="search"
          aria-label="Filter connections"
          placeholder="Filter by alias or username…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check inline">
          <input type="checkbox" checked={hideUnassigned} onChange={(e) => setHideUnassigned(e.target.checked)} /> Hide
          unassigned
        </label>
        <span className="muted">
          {shownOrgs.length} of {liveOrgs.length}
        </span>
      </div>

      <div className="table-wrap">
      <table className="table">
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
          {shownOrgs.map((o) => {
            const vr = verifyResults[o.id]
            const isOAuth = o.authKind === 'oauth'
            const rowBusy = !!busy[o.id]
            return (
              <tr key={o.id}>
                <td>
                  {o.label}
                  <span className={`pill ml-2 ${isOAuth ? 'oauth' : 'cli'}`}>
                    {isOAuth ? 'OAuth' : 'CLI'}
                  </span>
                  {o.prodPinned && (
                    <span className="pill prod ml-2">
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
                          <span aria-hidden="true">✓</span> Saved
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
                      <span className="status-ok">
                        <span aria-hidden="true">✓</span> Verified as {vr.username}
                      </span>
                    ) : (
                      <details className="status-err verify-error">
                        <summary>
                          <span aria-hidden="true">✗</span> Verify failed
                        </summary>
                        <div className="error-text">{vr.error}</div>
                      </details>
                    ))}
                </td>
              </tr>
            )
          })}
          {liveOrgs.length === 0 && (
            <tr>
              <td colSpan={5}>
                <EmptyState
                  title="No orgs yet"
                  hint="Click “Refresh from sf CLI” to list the orgs you have signed in to, or add one via OAuth above."
                />
              </td>
            </tr>
          )}
          {liveOrgs.length > 0 && shownOrgs.length === 0 && (
            <tr>
              <td colSpan={5}>
                <EmptyState
                  title="No connections match the filter."
                  hint="Clear the filter or untick “Hide unassigned”."
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>

      <section className="prod-pin" aria-labelledby="prod-pin-heading" data-testid="prod-pin">
        <strong id="prod-pin-heading">Production pin</strong>
        <p className="muted prod-pin-help">{PROD_PIN_HELP}</p>
        <div className="oauth-add-row">
          <input
            className="text-input mono"
            aria-label="Production org Id"
            value={pinDraft}
            spellCheck={false}
            onChange={(e) => {
              setPinDraft(e.target.value)
              setPinSaved(false)
              setPinError(null)
            }}
          />
          <button
            className="btn primary"
            onClick={() => void savePin(pinDraft)}
            disabled={pinSaving || pinDraft.trim() === pin}
          >
            {pinSaving ? 'Saving…' : 'Save pin'}
          </button>
          {pin !== DEFAULT_PROD_ORG_ID_PREFIX && (
            <button className="btn" onClick={() => void savePin(DEFAULT_PROD_ORG_ID_PREFIX)} disabled={pinSaving}>
              Reset to default
            </button>
          )}
          {pinSaved && (
            <span className="status-ok" role="status">
              <span aria-hidden="true">✓</span> Saved — pinned <code>{pin}</code>
            </span>
          )}
        </div>
        {pinError && (
          <p className="error" role="alert">
            {pinError}
          </p>
        )}
        <p className="muted prod-pin-help">
          Current pin: <code>{pin}</code>
          {pin === DEFAULT_PROD_ORG_ID_PREFIX ? ' (the default this build ships with).' : '.'} A pinned connection
          shows the <em>PROD · read-only</em> badge above.
        </p>
      </section>

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
          <table className="table table--compact">
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
