// @vitest-environment jsdom
/**
 * S64 P3 — small pieces behind the Deployments page and the Templates list:
 * the one-line error with Show more (ux T-12) and the relative-time helper
 * that replaces absolute stamps in list cells (ux T-11).
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorLine } from '../../src/renderer/src/pages/Home'
import { relativeTime } from '../../src/renderer/src/pages/templates/templateUi'

afterEach(cleanup)

describe('ErrorLine', () => {
  it('shows the first line, keeps the full text on title, and expands on Show more', async () => {
    const user = userEvent.setup()
    render(<ErrorLine text={'Gate refused: X\nline two\nline three'} />)
    const line = screen.getByText('Gate refused: X')
    expect(line.textContent).not.toContain('line two')
    expect(line.closest('.error-line')).toHaveAttribute('title', 'Gate refused: X\nline two\nline three')
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(/line three/)).toBeInTheDocument()
    expect(line.closest('.error-line')).toHaveClass('expanded')
    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText(/line three/)).toBeNull()
  })

  it('has no toggle when the message is a single short line', () => {
    render(<ErrorLine text="Just one line" />)
    expect(screen.getByText('Just one line')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers Show more for a single line longer than the collapsed cut', () => {
    render(<ErrorLine text={'x'.repeat(260)} />)
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
    expect(screen.getByText(/…$/)).toBeInTheDocument()
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0)
  const ago = (ms: number): number => now - ms
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it.each<[number, string]>([
    [0, 'just now'],
    [30_000, 'just now'],
    [MIN, '1 minute ago'],
    [5 * MIN, '5 minutes ago'],
    [HOUR, '1 hour ago'],
    [3 * HOUR, '3 hours ago'],
    [DAY, 'yesterday'],
    [3 * DAY, '3 days ago'],
    [45 * DAY, '2 months ago'] // ~1.5 months rounds up
  ])('%d ms ago → %s', (ms, label) => {
    expect(relativeTime(ago(ms), now)).toBe(label)
  })

  it('handles years, nulls and future stamps (clock skew) without going negative', () => {
    expect(relativeTime(ago(400 * DAY), now)).toBe('1 year ago')
    expect(relativeTime(ago(800 * DAY), now)).toBe('2 years ago')
    expect(relativeTime(null, now)).toBe('—')
    expect(relativeTime(undefined, now)).toBe('—')
    expect(relativeTime(now + HOUR, now)).toBe('just now')
  })
})
