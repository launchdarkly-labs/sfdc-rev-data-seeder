import { useEffect, useState } from 'react'
import { useToast } from '../ui/Toast'
import { toRdsError } from '../ipc/client'
import { applyTheme, isThemePreference, THEME_KEY, type ThemePreference } from '../theme'
import { API_VERSION } from '../../../shared/apiVersion'

const OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'system', label: 'Match the system', hint: 'Follows macOS Appearance.' },
  { value: 'dark', label: 'Dark', hint: 'The default look.' },
  { value: 'light', label: 'Light', hint: 'For bright rooms and screenshots in documents.' }
]

/**
 * S64 (P4): the first real Settings page — theme preference and a few facts a
 * newcomer asks for (version, where the data lives). Replaces the M1 stub.
 */
export function SettingsPage(): React.JSX.Element {
  const toast = useToast()
  const [pref, setPref] = useState<ThemePreference>('dark')

  useEffect(() => {
    let cancelled = false
    void window.rds
      .settingsGet(THEME_KEY)
      .then((v) => {
        if (!cancelled && isThemePreference(v)) setPref(v)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const choose = (value: ThemePreference): void => {
    setPref(value)
    applyTheme(value)
    void window.rds.settingsSet(THEME_KEY, value).catch((e: unknown) => toast(toRdsError(e).message, 'error'))
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Appearance and where this app keeps its data.</p>

      <section className="settings-section" aria-labelledby="settings-theme">
        <h2 id="settings-theme">Appearance</h2>
        <div className="theme-options" role="radiogroup" aria-labelledby="settings-theme">
          {OPTIONS.map((o) => (
            <label key={o.value} className={`theme-option${pref === o.value ? ' selected' : ''}`}>
              <input
                type="radio"
                name="theme"
                value={o.value}
                checked={pref === o.value}
                onChange={() => choose(o.value)}
              />
              <span>
                <strong>{o.label}</strong>
                <span className="muted"> {o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-about">
        <h2 id="settings-about">About</h2>
        <dl className="settings-facts">
          <dt>Version</dt>
          <dd>{__APP_VERSION__}</dd>
          <dt>Salesforce API</dt>
          <dd>
            v{API_VERSION} — every REST, Tooling and Metadata call this build makes uses this version.
          </dd>
          <dt>Data</dt>
          <dd>
            Connections, deployments, run ledgers and templates live in a local SQLite file under the app&rsquo;s data
            folder (<code>~/Library/Application Support/rds-desktop/rds-desktop.db</code>). Copy or delete that folder to
            back up or reset the app. Nothing is sent anywhere but the orgs you connect.
          </dd>
          <dt>Salesforce CLI</dt>
          <dd>
            Org sign-ins come from the <code>sf</code> CLI on this Mac; the app never stores a password. Access tokens are
            minted on demand and held in memory only.
          </dd>
        </dl>
      </section>
    </>
  )
}
