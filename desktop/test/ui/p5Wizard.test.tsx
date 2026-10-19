// @vitest-environment jsdom
/**
 * S64 P5 (plan row 5.6) — wizard performance: the describe cache shared across
 * steps, the Fields step's parallel describes, and the debounced draft save.
 * Fixture aliases are neutral (srcbox_a / tgt_a).
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { createDescribeCache } from '../../src/renderer/src/pages/wizard/describeCache'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, readinessScopeKey } from '../../src/shared/wizard'
import type { DraftDetail, FieldInfo } from '../../src/shared/types'

function field(apiName: string, refTo?: string): FieldInfo {
  return {
    apiName,
    label: `${apiName} (lbl)`,
    type: refTo ? 'reference' : 'string',
    isReference: !!refTo,
    referenceTo: refTo ? [refTo] : [],
    isCreateable: true,
    isUpdateable: true,
    isNillable: true,
    isExternalId: false,
    isAutoNumber: false,
    isCalculated: false,
    isRestrictedPicklist: false,
    picklistValues: [],
    length: null
  }
}

const OBJECTS = ['Account', 'Contact', 'Opportunity']
const DESCRIBES: Record<string, FieldInfo[]> = {
  Account: [field('Name'), field('OwnerId', 'User'), field('Industry')],
  Contact: [field('LastName'), field('AccountId', 'Account'), field('Email')],
  Opportunity: [field('Name'), field('Amount'), field('AccountId', 'Account')]
}

let describeCalls: Array<[string, string]>
let saved: Array<{ step: string; config: Record<string, unknown> }>
/** When set, every describe waits on this gate instead of resolving at once. */
let describeGate: { promise: Promise<void>; open: () => void } | null

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function install(step: string, configOverride: Record<string, unknown> = {}): void {
  describeCalls = []
  saved = []
  describeGate = null
  ;(window as unknown as { rds: unknown }).rds = {
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'srcbox_a',
      targetConnectionId: 'tgt_a',
      sourceLabel: 'srcbox_a',
      targetLabel: 'tgt_a',
      step: step as DraftDetail['step'],
      config: {
        ...emptyWizardConfig(),
        selectedObjects: OBJECTS,
        readiness: {
          scopeKey: readinessScopeKey({ selectedObjects: OBJECTS }),
          ready: true,
          blockingObjects: [],
          checkedAt: '2026-10-19T00:00:00.000Z'
        },
        ...configOverride
      },
      status: 'Planned'
    }),
    draftSave: async (input: { step: string; config: Record<string, unknown> }) => {
      saved.push({ step: input.step, config: input.config })
    },
    describeObject: async (conn: string, obj: string) => {
      describeCalls.push([conn, obj])
      if (describeGate) await describeGate.promise
      return DESCRIBES[obj] ?? []
    },
    listOrgs: async () => [],
    filterValidate: async () => ({ ok: true, count: 1, soql: '', strippedClause: null, hint: null }),
    targetKeyedObjects: async () => ({ hasField: [], keyedRows: [] }),
    verifyOrg: async () => ({ ok: true, username: 'me@target.example' }),
    sampleGet: async () => ({ ok: true, values: {} }),
    fieldsPopulated: async () => ({ ok: true, populated: ['Name'] }),
    templateList: async () => [],
    templateListAll: async () => []
  }
}

function renderWizard(step: string): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/deployments/1/wizard/${step}`]}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

afterEach(cleanup)

describe('5.6a — describe cache shared across wizard steps', () => {
  it('Scope → Mappings (all expanded) → Fields → Scope describes each object on each org exactly once', async () => {
    install('scope')
    const user = userEvent.setup()
    renderWizard('scope')
    await screen.findByRole('heading', { name: 'Scope' })
    // Scope describes both orgs for every selected object.
    await waitFor(() => expect(describeCalls.length).toBe(2 * OBJECTS.length))

    await user.click(screen.getByRole('button', { name: 'Mappings' }))
    await screen.findByRole('heading', { name: 'Mappings' })
    for (const [i, obj] of OBJECTS.entries()) {
      await user.click(screen.getByRole('button', { name: obj }))
      await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(i + 1))
    }

    await user.click(screen.getByRole('button', { name: 'Fields' }))
    await screen.findByRole('heading', { name: 'Fields' })
    await screen.findByRole('button', { name: /Account/ })

    await user.click(screen.getByRole('button', { name: 'Scope' }))
    await screen.findByRole('heading', { name: 'Scope' })
    // Give any stray re-describe a chance to land before counting.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mappings' })).toBeInTheDocument())

    // Before the cache this traversal cost 8N (6 + 6 + 6 + 6 at N=3); the
    // shell-scoped cache serves the three later entries from memory.
    expect(describeCalls).toHaveLength(2 * OBJECTS.length)
    const keys = new Set(describeCalls.map(([c, o]) => `${c}|${o}`))
    expect(keys.size).toBe(2 * OBJECTS.length)
  })
})

describe('5.6a — createDescribeCache', () => {
  it('memoises the in-flight promise so concurrent callers share one request', async () => {
    let calls = 0
    const cache = createDescribeCache(async () => {
      calls += 1
      return [field('Name')]
    })
    const [a, b] = await Promise.all([cache.describe('c1', 'Account'), cache.describe('c1', 'Account')])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    await cache.describe('c1', 'Account')
    expect(calls).toBe(1)
    expect(cache.size).toBe(1)
  })

  it('keys on connection + object, so the two orgs never share an entry', async () => {
    const seen: string[] = []
    const cache = createDescribeCache(async (c, o) => {
      seen.push(`${c}|${o}`)
      return []
    })
    await cache.describe('src', 'Account')
    await cache.describe('tgt', 'Account')
    await cache.describe('src', 'Contact')
    expect(seen).toEqual(['src|Account', 'tgt|Account', 'src|Contact'])
    expect(cache.size).toBe(3)
  })

  it('drops a rejected entry so the next call retries instead of pinning the failure', async () => {
    let calls = 0
    const cache = createDescribeCache(async () => {
      calls += 1
      if (calls === 1) throw new Error('transient')
      return [field('Name')]
    })
    await expect(cache.describe('c1', 'Account')).rejects.toThrow('transient')
    expect(cache.size).toBe(0)
    const fields = await cache.describe('c1', 'Account')
    expect(fields).toHaveLength(1)
    expect(calls).toBe(2)
    expect(cache.size).toBe(1)
  })
})

describe('5.6b — Fields step describes every object in parallel', () => {
  it('requests all 2N describes before any resolves and reports per-object progress', async () => {
    install('fields')
    const g = gate()
    describeGate = g
    renderWizard('fields')
    await screen.findByRole('heading', { name: 'Fields' })
    // Sequential loading would stop at 2 (one object's pair) until it resolved.
    await waitFor(() => expect(describeCalls.length).toBe(2 * OBJECTS.length))
    expect(screen.getByText('Loading fields…')).toBeInTheDocument()

    await act(async () => {
      g.open()
      await g.promise
    })
    // Every pair resolves at once here, so the progress ends at N / N and the
    // table renders; a sequential loader would have shown 1 / N first.
    await screen.findByRole('button', { name: /Account/ })
    // Account: Name, OwnerId (→ User, stable default), Industry — all included.
    expect(screen.getByRole('button', { name: /Account/ })).toHaveTextContent('(3/3 included)')
    // Contact: AccountId → Account, which IS in scope — not a skipped ref.
    expect(screen.getByRole('button', { name: /Contact/ })).toHaveTextContent('(3/3 included)')
  })

  it('progress counts resolved objects one at a time when their describes land separately', async () => {
    install('fields')
    const gates: Record<string, { promise: Promise<void>; open: () => void }> = {}
    for (const obj of OBJECTS) gates[obj] = gate()
    ;(window as unknown as { rds: { describeObject: unknown } }).rds.describeObject = async (
      conn: string,
      obj: string
    ) => {
      describeCalls.push([conn, obj])
      await gates[obj]!.promise
      return DESCRIBES[obj] ?? []
    }
    renderWizard('fields')
    await screen.findByRole('heading', { name: 'Fields' })
    await waitFor(() => expect(describeCalls.length).toBe(2 * OBJECTS.length))
    await act(async () => {
      gates.Account!.open()
      await gates.Account!.promise
    })
    await screen.findByText('Loading fields — 1 / 3 objects…')
    await act(async () => {
      gates.Contact!.open()
      await gates.Contact!.promise
    })
    await screen.findByText('Loading fields — 2 / 3 objects…')
    await act(async () => {
      gates.Opportunity!.open()
      await gates.Opportunity!.promise
    })
    await screen.findByRole('button', { name: /Opportunity/ })
  })
})

describe('5.6e — debounced draft save', () => {
  it('N rapid edits produce exactly one draftSave carrying the final config', async () => {
    install('fields')
    const user = userEvent.setup()
    renderWizard('fields')
    await screen.findByRole('heading', { name: 'Fields' })
    await user.click(await screen.findByRole('button', { name: /Account/ }))
    await user.click(await screen.findByLabelText('Include Name'))
    await user.click(screen.getByLabelText('Include Industry'))
    await user.click(screen.getByLabelText('Include OwnerId'))
    // Nothing persisted yet — the trailing debounce is still open.
    expect(saved).toEqual([])
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 2000 })
    // Let a stray second save surface before asserting the count.
    await new Promise((r) => setTimeout(r, 650))
    expect(saved).toHaveLength(1)
    expect(saved[0]!.step).toBe('fields')
    expect((saved[0]!.config.excludedFields as Record<string, string[]>).Account).toEqual([
      'Name',
      'Industry',
      'OwnerId'
    ])
  })

  it('goToStep right after an edit flushes once, synchronously, with the edit and the destination step', async () => {
    install('fields')
    const user = userEvent.setup()
    renderWizard('fields')
    await screen.findByRole('heading', { name: 'Fields' })
    await user.click(await screen.findByRole('button', { name: /Account/ }))
    await user.click(await screen.findByLabelText('Include Name'))
    expect(saved).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Back' }))
    // The flush happens before navigation — no waiting on the debounce timer.
    expect(saved).toHaveLength(1)
    expect(saved[0]!.step).toBe('mappings')
    expect((saved[0]!.config.excludedFields as Record<string, string[]>).Account).toEqual(['Name'])
    await screen.findByRole('heading', { name: 'Mappings' })
    await new Promise((r) => setTimeout(r, 650))
    expect(saved).toHaveLength(1)
  })

  it('unmounting the shell flushes a pending save', async () => {
    install('fields')
    const user = userEvent.setup()
    renderWizard('fields')
    await screen.findByRole('heading', { name: 'Fields' })
    await user.click(await screen.findByRole('button', { name: /Account/ }))
    await user.click(await screen.findByLabelText('Include Name'))
    expect(saved).toEqual([])
    cleanup()
    expect(saved).toHaveLength(1)
    expect((saved[0]!.config.excludedFields as Record<string, string[]>).Account).toEqual(['Name'])
    await new Promise((r) => setTimeout(r, 650))
    expect(saved).toHaveLength(1)
  })
})
