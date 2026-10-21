/**
 * Design-token contrast (S64 P1). Reads the colour tokens straight out of
 * app.css and checks the WCAG 2.x contrast ratios the UI depends on, for the
 * dark default AND the opt-in light theme. jsdom cannot evaluate color-mix or
 * computed styles, so this works on the declared hex values — which is also
 * what a branding pass (P4) changes.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'app.css'), 'utf8')

function block(selector: string): Record<string, string> {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = css.match(re)
  if (!m) throw new Error(`no block for ${selector}`)
  const vars: Record<string, string> = {}
  for (const d of (m[1] ?? '').matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    vars[d[1] ?? ''] = (d[2] ?? '').trim()
  }
  return vars
}

function resolve(vars: Record<string, string>, name: string, depth = 0): string {
  const v = vars[name]
  if (!v) throw new Error(`token ${name} not declared`)
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/)
  if (ref?.[1]) return depth > 5 ? v : resolve(vars, ref[1], depth + 1)
  return v
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(channel(0)) + 0.7152 * lin(channel(2)) + 0.0722 * lin(channel(4))
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const dark = block(':root')
const light = { ...dark, ...block(":root[data-theme='light']") }

describe.each([
  ['dark (default)', dark],
  ['light (opt-in)', light]
])('token contrast — %s', (_name, t) => {
  const c = (fg: string, bg: string) => contrast(resolve(t, fg), resolve(t, bg))

  it('body text on the page and on panels is AAA (≥ 7:1)', () => {
    expect(c('--text', '--bg')).toBeGreaterThanOrEqual(7)
    expect(c('--text', '--panel')).toBeGreaterThanOrEqual(7)
  })

  it('muted text on the page and on panels is AA (≥ 4.5:1)', () => {
    expect(c('--muted', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--muted', '--panel')).toBeGreaterThanOrEqual(4.5)
  })

  it('links are AA against the page', () => {
    expect(c('--link', '--bg')).toBeGreaterThanOrEqual(4.5)
  })

  it('primary and danger button labels are AA on their fills', () => {
    expect(c('--on-accent', '--accent-strong')).toBeGreaterThanOrEqual(4.5)
    expect(c('--on-danger', '--danger-strong')).toBeGreaterThanOrEqual(4.5)
  })

  // S68: the accent is also TEXT (badges, selected rows, KPI values, links in
  // tables — 25 call sites) and a border, not only a button fill. The amber
  // passed this by luck of its brightness; the LD blue only passes because the
  // dark theme lightens the text token (`--accent`) and keeps the brand blue for
  // fills (`--accent-strong`). Guard the split so a future recolour cannot put
  // a fill-only colour back into the text slot.
  it('accent as text is AA on the page and on panels (≥ 4.5:1)', () => {
    expect(c('--accent', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--accent', '--panel')).toBeGreaterThanOrEqual(4.5)
  })

  it('status colours read as text on the page (≥ 4.5:1 for 13px text)', () => {
    for (const tok of ['--green', '--amber', '--red']) {
      expect(c(tok, '--bg'), tok).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('token hygiene', () => {
  it('the light theme redefines only colour tokens', () => {
    const lightOnly = block(":root[data-theme='light']")
    for (const name of Object.keys(lightOnly)) {
      expect(name, `${name} is not a colour token`).toMatch(/^--(bg|panel|panel-2|border|text|muted|accent|accent-strong|on-accent|link|green|amber|red|danger-strong|backdrop|shadow-1|shadow-2|shadow-modal)$/)
    }
  })

  it('no token references itself (a P1 regression: --backdrop: var(--backdrop))', () => {
    for (const [name, value] of Object.entries(dark)) {
      expect(value, name).not.toContain(`var(${name})`)
    }
  })

  it('no hard-coded hex colours remain outside the token blocks', () => {
    const afterTokens = css.slice(css.indexOf('* {\n  box-sizing'))
    const hexes = afterTokens.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes).toEqual([])
  })
})
