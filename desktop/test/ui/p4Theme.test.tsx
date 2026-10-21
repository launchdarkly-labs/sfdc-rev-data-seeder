// @vitest-environment jsdom
/**
 * S64 P4 — theme preference, the Settings page and the icon set.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPage } from '../../src/renderer/src/pages/Settings'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { Icon, RdsMark } from '../../src/renderer/src/ui/Icon'
import { applyTheme, initTheme, resolveTheme } from '../../src/renderer/src/theme'
import { API_VERSION } from '../../src/shared/apiVersion'

function stubMatchMedia(light: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((q: string) => ({
      matches: q.includes('light') ? light : !light,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
}

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('theme.ts', () => {
  beforeEach(() => stubMatchMedia(true))

  it('resolves system to the OS preference and pins dark / light', () => {
    expect(resolveTheme('system')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })

  it('writes the resolved theme to <html data-theme>', () => {
    expect(applyTheme('light')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('initTheme reads the stored preference and falls back to dark when the read fails', async () => {
    ;(window as unknown as { rds: unknown }).rds = { settingsGet: vi.fn(async () => 'light') }
    expect(await initTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    ;(window as unknown as { rds: unknown }).rds = {
      settingsGet: vi.fn(async () => {
        throw new Error('no ipc')
      })
    }
    expect(await initTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('SettingsPage', () => {
  beforeEach(() => stubMatchMedia(false))

  it('shows the stored preference, persists a change and applies it immediately', async () => {
    const user = userEvent.setup()
    const settingsSet = vi.fn(async () => undefined)
    ;(window as unknown as { rds: unknown }).rds = { settingsGet: vi.fn(async () => 'dark'), settingsSet }
    render(
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    )
    expect(await screen.findByRole('radio', { name: /Dark/ })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /^Light/ }))
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('theme', 'light'))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(screen.getByRole('radio', { name: /^Light/ })).toBeChecked()
  })

  it('states the version and where the data lives', async () => {
    ;(window as unknown as { rds: unknown }).rds = { settingsGet: vi.fn(async () => null), settingsSet: vi.fn() }
    render(
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>
    )
    expect(await screen.findByText('test')).toBeInTheDocument() // __APP_VERSION__ under vitest
    // The userData folder is the package name (observed on disk), not the product name.
    expect(screen.getByText(/Application Support\/rds-desktop\/rds-desktop\.db/)).toBeInTheDocument()
    // S64 P6 (6.2): the one API version the build speaks is stated here.
    expect(screen.getByText('Salesforce API')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`^v${API_VERSION.replace('.', '\\.')} —`))).toBeInTheDocument()
  })
})

describe('Icon', () => {
  it('is decorative by default and labelled when asked', () => {
    const { container, rerender } = render(<Icon name="check" />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
    rerender(<Icon name="warn" label="Needs attention" />)
    expect(screen.getByRole('img', { name: 'Needs attention' })).toBeInTheDocument()
  })

  it('the brand mark uses the FILL accent token, not a literal colour', () => {
    // S68: `--accent-strong` is the brand-blue fill; `--accent` is the lightened
    // text blue on dark and would make the tile the wrong colour.
    const { container } = render(<RdsMark />)
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('var(--accent-strong)')
  })
})
