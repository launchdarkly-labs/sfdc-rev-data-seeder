// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { App } from '../../src/renderer/src/App'
import { emptyWizardConfig } from '../../src/shared/wizard'

// Pages touch window.rds on mount; stub it so routes render without a preload bridge.
beforeEach(() => {
  ;(window as unknown as { rds: unknown }).rds = {
    listOrgs: async () => [],
    refreshOrgs: async () => [],
    setOrgRole: async () => [],
    verifyOrg: async () => ({ ok: true, username: 'x' }),
    describeGlobal: async () => [],
    describeObject: async () => [],
    jobList: async () => [],
    settingsGet: async () => null,
    settingsSet: async () => undefined,
    jobCancel: async () => undefined,
    jobDemo: async () => ({ jobId: 'job-1' }),
    onJobEvent: () => () => undefined,
    draftCreate: async () => 1,
    draftSave: async () => undefined,
    draftLoad: async () => ({
      name: 'Test Deploy',
      sourceConnectionId: 'src',
      targetConnectionId: 'tgt',
      sourceLabel: 'src',
      targetLabel: 'tgt',
      step: 'orgs',
      config: emptyWizardConfig(),
      status: 'Draft'
    }),
    draftList: async () => [],
    draftDelete: async () => undefined,
    planGet: async () => null,
    objectsIntersection: async () => ({ objects: [], common: 0, sourceOnly: 0, targetOnly: 0 }),
    // S59 templates
    templateListAll: async () => [],
    templateGet: async () => {
      throw new Error('not found')
    },
    templateRuns: async () => [],
    deployRunState: async () => ({
      deployment: {
        id: 7,
        name: 'RDS-D-7',
        status: 'Planned',
        errorMessage: null,
        sourceLabel: 'src',
        targetLabel: 'tgt',
        createdAt: 1,
        updatedAt: 1
      },
      run: null,
      counters: null,
      objects: [],
      totalRecords: 0,
      cpqReminder: false,
      restoreUnconfirmed: 0,
      audit: null,
      job: null
    })
  }
})
afterEach(cleanup)

function renderAt(hash: string): void {
  window.location.hash = hash
  render(<App />)
}

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Main' })

describe('routing', () => {
  it('renders Deployments at the index route (S64 P3: Home became the Deployments page)', () => {
    renderAt('#/')
    expect(screen.getByRole('heading', { name: 'Deployments' })).toBeInTheDocument()
  })

  it.each([
    ['#/connections', /Connections$/],
    ['#/extids', 'Deployments'],
    ['#/history', 'Deployments'],
    ['#/tools', 'Deployments'],
    ['#/settings', 'Settings'],
    ['#/howto', 'How To'],
    ['#/welcome', 'Welcome'],
    ['#/templates', 'Templates'],
    ['#/templates/new', 'New template']
  ])('renders %s', (hash, heading) => {
    renderAt(hash)
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('deep-links cold into the wizard, loading the draft', async () => {
    renderAt('#/deployments/42/wizard/scope')
    // Draft loads async; the shell then renders the deployment name + step nav.
    expect(await screen.findByRole('heading', { name: 'Test Deploy' })).toBeInTheDocument()
    expect(screen.getByText(/src → tgt · Draft/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scope' })).toBeInTheDocument()
  })

  it('deep-links into a deployment detail with its id (S46: the real monitor page, loaded from rds:deploy.runState)', async () => {
    renderAt('#/deployments/7')
    expect(await screen.findByRole('heading', { name: 'RDS-D-7' })).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
  })

  it('shows a not-found page for an unknown route', () => {
    renderAt('#/no-such-place')
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument()
  })

  it('renders the sidebar nav on every shell route', () => {
    renderAt('#/')
    expect(screen.getByText('Rev Data Seeder')).toBeInTheDocument()
    expect(within(nav()).getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '#/connections')
  })

  // S64 P3 (ux IA-3): the nav lists PLACES. "New deployment" is an action and is a
  // button on the Deployments page, not a nav entry.
  it('offers New deployment on the Deployments page, and How To from the sidebar', () => {
    renderAt('#/')
    expect(within(nav()).queryByRole('link', { name: /New Deployment/i })).toBeNull()
    expect(screen.getByRole('link', { name: 'New deployment' })).toHaveAttribute('href', '#/deployments/new')
    expect(within(nav()).getByRole('link', { name: 'How To' })).toHaveAttribute('href', '#/howto')
  })

  // S59: the Templates tab is a left-nav entry, right after Deployments.
  it('links to Templates from the sidebar, and How To explains the two template types', () => {
    renderAt('#/')
    expect(screen.getByRole('link', { name: 'Templates' })).toHaveAttribute('href', '#/templates')
    // nav items only — the brand is a link too (S64 P4), so filter by its class
    const labels = within(nav())
      .getAllByRole('link')
      .filter((l) => l.classList.contains('nav-item'))
      .map((l) => l.textContent)
    expect(labels).toEqual(['Deployments', 'Templates', 'Connections', 'How To', 'Settings'])
    renderAt('#/howto')
    expect(screen.getByRole('heading', { name: 'Templates: post-refresh and data seed' })).toBeInTheDocument()
    expect(screen.getByText(/Post-refresh automation changes are PERSISTENT/)).toBeInTheDocument()
    expect(screen.getByText(/Seed-time automation disables are TEMPORARY/)).toBeInTheDocument()
    expect(screen.getByText(/A clean dry run is not a promise/)).toBeInTheDocument()
  })

  // S64 P3 (ux IA-3): the Deployments item stays lit inside a deployment.
  it.each(['#/', '#/deployments/7', '#/deployments/42/wizard/scope', '#/deployments/new'])(
    'highlights Deployments in the sidebar at %s',
    async (hash) => {
      renderAt(hash)
      const link = within(nav()).getByRole('link', { name: 'Deployments' })
      await waitFor(() => expect(link).toHaveClass('active'))
      expect(within(nav()).getByRole('link', { name: 'Templates' })).not.toHaveClass('active')
    }
  )

  it('highlights only Templates on a templates route', () => {
    renderAt('#/templates/new')
    expect(within(nav()).getByRole('link', { name: 'Templates' })).toHaveClass('active')
    expect(within(nav()).getByRole('link', { name: 'Deployments' })).not.toHaveClass('active')
  })

  // S64 P3 (ux IA-14): Idle is plain text, not a link to Home.
  it('shows Idle in the sidebar footer as text, not a link', () => {
    renderAt('#/')
    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Idle' })).toBeNull()
  })

  it('discloses the ExtId field and the CPQ attestation on the How To page', () => {
    renderAt('#/howto')
    expect(screen.getByText('Data_Deployment_External_Id__c')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^CPQ:/ })).toBeInTheDocument()
    expect(screen.getByText(/protected setting with no API/)).toBeInTheDocument()
  })
})
