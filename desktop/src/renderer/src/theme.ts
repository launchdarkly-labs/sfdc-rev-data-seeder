/**
 * S64 (P4): theme preference. Three values — 'system' follows the OS, 'dark'
 * and 'light' pin one. The resolved theme is written to <html data-theme>,
 * which app.css reads ([data-theme="light"] redefines the colour tokens).
 * The preference persists through the settings IPC; this module only applies it.
 */
export type ThemePreference = 'system' | 'dark' | 'light'
export const THEME_KEY = 'theme'

let unlistenSystem: (() => void) | null = null

function systemPrefersLight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
}

export function resolveTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return pref
}

export function applyTheme(pref: ThemePreference): 'dark' | 'light' {
  unlistenSystem?.()
  unlistenSystem = null
  const resolved = resolveTheme(pref)
  document.documentElement.dataset.theme = resolved
  if (pref === 'system' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => {
      document.documentElement.dataset.theme = mq.matches ? 'light' : 'dark'
    }
    mq.addEventListener?.('change', onChange)
    unlistenSystem = () => mq.removeEventListener?.('change', onChange)
  }
  return resolved
}

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'dark' || v === 'light'
}

/** Read the persisted preference and apply it; dark when nothing is stored or IPC is unavailable. */
export async function initTheme(): Promise<ThemePreference> {
  let pref: ThemePreference = 'dark'
  try {
    const stored = await window.rds.settingsGet(THEME_KEY)
    if (isThemePreference(stored)) pref = stored
  } catch {
    /* first paint must never wait on a failed read */
  }
  applyTheme(pref)
  return pref
}
