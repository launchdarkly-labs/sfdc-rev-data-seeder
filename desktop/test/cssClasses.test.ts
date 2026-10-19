/**
 * Class ↔ CSS pairing (S64 P1). Every className literal the renderer uses must
 * have a matching selector in app.css, and the file must not regress the
 * accessibility floor. This is the automated check the project lacked while
 * `.scope-rules`, `.banner.warn`, `.footprint`, `.plan-warnings` and
 * `.banner.info` each shipped unstyled (five occurrences across S49–S63).
 *
 * Extraction is deliberately simple: static className strings, the static
 * parts of template literals, and quoted literals inside className
 * expressions. Dynamic suffixes (`badge-${tone}`) are ignored; the variant
 * selectors they resolve to are covered by the component tests instead.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RENDERER = join(__dirname, '..', 'src', 'renderer', 'src')
const CSS_PATH = join(RENDERER, 'app.css')
/** Every stylesheet the renderer imports (app.css + the per-phase files under styles/). */
function allCss(): string {
  const files = [CSS_PATH]
  const stylesDir = join(RENDERER, 'styles')
  try {
    for (const name of readdirSync(stylesDir)) if (name.endsWith('.css')) files.push(join(stylesDir, name))
  } catch {
    /* no styles dir */
  }
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

/** Structural hooks (test ids / semantic wrappers) that intentionally carry no styling. */
const UNSTYLED_HOOKS = new Set(['seed-builder', 'tier-row', 'seed-table'])

/** Tokens that fall out of the regex but are not class names. */
const NOISE = new Set(['true', 'false', 'undefined', 'null'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx|ts)$/.test(name)) out.push(full)
  }
  return out
}

/** className usages → class token → first file:line that uses it. */
function classesUsed(): Map<string, string> {
  const used = new Map<string, string>()
  const tok = /^[a-z][a-z0-9-]*$/i
  for (const file of walk(RENDERER)) {
    const rel = relative(RENDERER, file)
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{([^}]*(?:\{[^}]*\}[^}]*)*)\})/g)) {
          const quoted = m[1] ?? m[2]
          const candidates: string[] = []
          if (quoted !== undefined) candidates.push(quoted)
          else if (m[3] !== undefined) {
            // literals inside the expression, with ${…} holes removed and
            // comparison operands (`status === 'Active'`) dropped first
            const expr = m[3].replace(/(===|!==|==|!=)\s*(['"])[^'"]*\2/g, '')
            for (const lit of expr.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
              candidates.push((lit[1] ?? lit[2] ?? lit[3] ?? '').replace(/\$\{[^}]*\}/g, ' '))
            }
          }
          for (const c of candidates) {
            for (const t of c.split(/\s+/)) {
              if (!t || t.endsWith('-') || NOISE.has(t) || !tok.test(t)) continue
              if (!used.has(t)) used.set(t, `${rel}:${i + 1}`)
            }
          }
        }
      })
  }
  return used
}

/** Every `.class` token that appears in a selector of app.css. */
function classesDefined(css: string): Set<string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const defined = new Set<string>()
  for (const m of noComments.matchAll(/([^{}]+)\{/g)) {
    const sel = (m[1] ?? '').trim()
    if (sel.startsWith('@') || sel === 'to' || sel === 'from') continue
    for (const c of sel.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) if (c[1]) defined.add(c[1])
  }
  return defined
}

describe('renderer classes ↔ app.css', () => {
  const css = allCss()
  const defined = classesDefined(css)
  const used = classesUsed()

  it('every className used in the renderer has a rule (or is a declared unstyled hook)', () => {
    const missing = [...used.entries()]
      .filter(([c]) => !defined.has(c) && !UNSTYLED_HOOKS.has(c))
      .map(([c, where]) => `${c} (${where})`)
      .sort()
    expect(missing, 'add a rule to app.css or list the class in UNSTYLED_HOOKS').toEqual([])
  })

  it('declared unstyled hooks are still in use (prune the list when they go)', () => {
    for (const hook of UNSTYLED_HOOKS) expect(used.has(hook), hook).toBe(true)
  })

  it('the status .pill and the selection .sel-pill are distinct classes', () => {
    expect(defined.has('sel-pill')).toBe(true)
    // one base `.pill {` definition, so a second block can never silently restyle the first
    expect(css.match(/^\.pill \{/gm)?.length).toBe(1)
  })
})

describe('accessibility floor in app.css', () => {
  const css = allCss()
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('declares color-scheme and styles links (no UA-blue links on a dark page)', () => {
    expect(body).toMatch(/color-scheme:\s*dark/)
    expect(body).toMatch(/^a \{[^}]*color:/m)
  })

  it('has a global :focus-visible ring and never removes the outline', () => {
    expect(body).toMatch(/:focus-visible \{[^}]*outline:\s*2px/)
    expect(body).not.toMatch(/outline:\s*none/)
  })

  it('renders nothing below the 12px floor', () => {
    const sizes = [...body.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
    expect(sizes.filter((s) => s < 12)).toEqual([])
    expect(body).not.toMatch(/--fs-xs:\s*1[01]px/)
  })
})
