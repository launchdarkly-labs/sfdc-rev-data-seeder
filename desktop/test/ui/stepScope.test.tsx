// @vitest-environment jsdom
/**
 * S57 (B2 / B3) — the Scope step's empty-scope gate and missing-parent advisor.
 * Fixture = the run-24 shape on sb1-915-git (2026-09-18): Account + Contact +
 * CampaignMember in scope, Campaign out, CampaignId required.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, type WizardConfig } from '../../src/shared/wizard'
import type { DraftDetail, FieldInfo } from '../../src/shared/types'

function field(apiName: string, refTo?: string, over: Partial<FieldInfo> = {}): FieldInfo {
  return {
    apiName,
    label: apiName,
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
    length: null,
    ...over
  }
}

const DESCRIBES: Record<string, FieldInfo[]> = {
  Account: [field('Name'), field('ParentId', 'Account'), field('OwnerId', 'User')],
  Contact: [field('LastName'), field('AccountId', 'Account')],
  CampaignMember: [
    field('CampaignId', 'Campaign', { isNillable: false }),
    field('ContactId', 'Contact'),
    field('LeadId', 'Lead'),
    field('Status')
  ],
  Campaign: [field('Name'), field('OwnerId', 'User')]
}

let saved: WizardConfig[]
let counts: Record<string, number | 'error'>
let keyed: { hasField: string[]; keyedRows: string[] }

function install(config: Partial<WizardConfig>): void {
  saved = []
  ;(window as unknown as { rds: unknown }).rds = {
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'renewAcctests',
      sourceConnectionId: 'darkb_911',
      targetConnectionId: 'sb1-915-git',
      sourceLabel: 'darkb_911',
      targetLabel: 'sb1-915-git',
      step: 'scope',
      config: { ...emptyWizardConfig(), ...config },
      status: 'Draft'
    }),
    draftSave: async (input: { config: WizardConfig }) => {
      saved.push(input.config)
    },
    listOrgs: async () => [],
    describeObject: async (_c: string, obj: string) => DESCRIBES[obj] ?? [],
    targetKeyedObjects: async () => keyed,
    filterValidate: async (input: { objectName: string; filterClause: string }) => {
      const c = counts[input.objectName]
      if (c === 'error') return { ok: false, error: 'MALFORMED_QUERY', soql: '', strippedClause: null }
      return { ok: true, count: c ?? 1, soql: '', strippedClause: null, hint: null }
    }
  }
}

function renderScope(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/36/wizard/scope']}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

const lastSaved = (): WizardConfig => saved[saved.length - 1]!

beforeEach(() => {
  counts = {}
  keyed = { hasField: [], keyedRows: [] }
})
afterEach(cleanup)

describe('StepScope — S57 B3: nothing will deploy ⇒ Next disabled', () => {
  it('V1: the only filter is at 0 and every other object hangs under it', async () => {
    counts = { Account: 0 }
    install({
      selectedObjects: ['Account', 'Contact'],
      filters: { Account: "WHERE Id = '006TR00000gALnoYAG'" }
    })
    renderScope()
    await screen.findByRole('heading', { name: 'Scope' })
    await screen.findByTestId('scope-empty')
    expect(screen.getByTestId('scope-empty')).toHaveTextContent(/Nothing will deploy/)
    expect(screen.getByRole('button', { name: 'Next: readiness' })).toBeDisabled()
  })

  it('one matching record keeps Next enabled (V3)', async () => {
    counts = { Account: 1 }
    install({ selectedObjects: ['Account', 'Contact'], filters: { Account: "WHERE Id = '0014100000EKIyaAAH'" } })
    renderScope()
    await screen.findByRole('heading', { name: 'Scope' })
    await screen.findByText(/1 record/)
    expect(screen.queryByTestId('scope-empty')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next: readiness' })).toBeEnabled()
  })

  it('an unfiltered ROOT keeps Next enabled even when the filtered object is at 0 (dep 37)', async () => {
    counts = { Account: 0 }
    install({ selectedObjects: ['Account', 'Campaign'], filters: { Account: "WHERE Id = '006TR00000gALnoYAG'" } })
    renderScope()
    await screen.findByRole('heading', { name: 'Scope' })
    await screen.findByText(/0 records — nothing will deploy for Account/)
    expect(screen.queryByTestId('scope-empty')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next: readiness' })).toBeEnabled()
  })

  it('an invalid clause never blocks (the error is its own message)', async () => {
    counts = { Account: 'error' }
    install({ selectedObjects: ['Account'], filters: { Account: 'WHERE zz' } })
    renderScope()
    await screen.findByText(/MALFORMED_QUERY/)
    expect(screen.queryByTestId('scope-empty')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next: readiness' })).toBeEnabled()
  })
})

async function showAdvisor(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Show' }))
}

describe('StepScope — S57 B2: parents outside this deployment', () => {
  it('is collapsed by default with a count, and Show/Hide toggles the cards (Jack, 2026-09-18)', async () => {
    const user = userEvent.setup()
    install({ selectedObjects: ['Account', 'Contact', 'CampaignMember'] })
    renderScope()
    const show = await screen.findByRole('button', { name: 'Show' })
    expect(screen.getByText(/Parents outside this deployment/)).toHaveTextContent('(2, some required)')
    expect(screen.queryByTestId('advisor-Campaign')).not.toBeInTheDocument()
    await user.click(show)
    expect(await screen.findByTestId('advisor-Campaign')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('advisor-Campaign')).not.toBeInTheDocument()
  })

  it('run 24: names Campaign as REQUIRED for CampaignMember and offers to add it', async () => {
    install({ selectedObjects: ['Account', 'Contact', 'CampaignMember'] })
    renderScope()
    await showAdvisor()
    const card = await screen.findByTestId('advisor-Campaign')
    expect(card).toHaveTextContent("CampaignMember references Campaign, which isn't in this deployment.")
    expect(card).toHaveTextContent(/CampaignMember\.CampaignId is required, so every CampaignMember row will fail/)
    expect(card).toHaveTextContent('You should probably add Campaign.')
    expect(card.className).toContain('required')
    // Lead is optional → a blank link, not a failure.
    const lead = screen.getByTestId('advisor-Lead')
    expect(lead).toHaveTextContent('The link will be left blank on the target.')
    // Contact/Account/User are in scope or stable — no cards for them.
    expect(screen.queryByTestId('advisor-Contact')).not.toBeInTheDocument()
    expect(screen.queryByTestId('advisor-User')).not.toBeInTheDocument()
  })

  it('"Add Campaign" puts it in the scope with an empty filter row to fill', async () => {
    const user = userEvent.setup()
    install({ selectedObjects: ['Account', 'Contact', 'CampaignMember'] })
    renderScope()
    await showAdvisor()
    const card = await screen.findByTestId('advisor-Campaign')
    // Parent-scoped child ⇒ no derivable filter, the note says so.
    expect(card).toHaveTextContent(/scoped through its parent/)
    await user.click(within(card).getByRole('button', { name: 'Add Campaign' }))
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(lastSaved().selectedObjects).toEqual(['Account', 'Contact', 'CampaignMember', 'Campaign'])
    expect(lastSaved().filters['Campaign']).toBe('')
  })

  it('a filtered child yields a ready-made semi-join filter and a one-click add', async () => {
    const user = userEvent.setup()
    counts = { CampaignMember: 146 }
    install({
      selectedObjects: ['Contact', 'CampaignMember'],
      filters: { CampaignMember: "WHERE CampaignId = '701TR00000zxSZuYAM'" }
    })
    renderScope()
    await showAdvisor()
    const card = await screen.findByTestId('advisor-Campaign')
    const expected = "WHERE Id IN (SELECT CampaignId FROM CampaignMember WHERE CampaignId = '701TR00000zxSZuYAM')"
    expect(card).toHaveTextContent(expected)
    await user.click(within(card).getByRole('button', { name: 'Add Campaign with that filter' }))
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(lastSaved().selectedObjects).toContain('Campaign')
    expect(lastSaved().filters['Campaign']).toBe(expected)
  })

  it('B1: keyed Campaign rows on the target ⇒ "leaving it out is fine", green card', async () => {
    keyed = { hasField: ['Campaign'], keyedRows: ['Campaign'] }
    install({ selectedObjects: ['Contact', 'CampaignMember'] })
    renderScope()
    await showAdvisor()
    const card = await screen.findByTestId('advisor-Campaign')
    await waitFor(() => expect(card).toHaveTextContent(/already holds RDS-keyed Campaign rows/))
    expect(card).not.toHaveTextContent('You should probably add Campaign.')
    expect(card.className).toContain('keyed')
  })

  it('"Leave it out" dismisses the card for this visit', async () => {
    const user = userEvent.setup()
    install({ selectedObjects: ['Contact', 'CampaignMember'] })
    renderScope()
    await showAdvisor()
    const card = await screen.findByTestId('advisor-Campaign')
    await user.click(within(card).getByRole('button', { name: 'Leave it out' }))
    await waitFor(() => expect(screen.queryByTestId('advisor-Campaign')).not.toBeInTheDocument())
    expect(saved).toEqual([]) // nothing persisted — a local dismissal
  })
})
