// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

describe('routing', () => {
  it('renders Home at the index route', () => {
    renderAt('#/')
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
  })

  it.each([
    ['#/connections', 'Org Connections'],
    ['#/extids', 'External IDs'],
    ['#/history', 'History'],
    ['#/tools', 'Tools'],
    ['#/settings', 'Settings'],
    ['#/howto', 'How To'],
    ['#/welcome', 'Welcome']
  ])('renders %s', (hash, heading) => {
    renderAt(hash)
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('deep-links cold into the wizard, loading the draft', async () => {
    renderAt('#/deployments/42/wizard/scope')
    // Draft loads async; the shell then renders the deployment name + step nav.
    expect(await screen.findByRole('heading', { name: 'Test Deploy' })).toBeInTheDocument()
    expect(screen.getByText('src → tgt · Draft')).toBeInTheDocument()
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
    expect(screen.getByRole('link', { name: 'Org Connections' })).toBeInTheDocument()
  })

  // The wizard route existed from 5B.1 but had no nav entry, so the only way in
  // was to type the hash by hand. These two pin the entry points.
  it('links to New Deployment and How To from the sidebar', () => {
    renderAt('#/')
    expect(screen.getByRole('link', { name: 'New Deployment' })).toHaveAttribute(
      'href',
      '#/deployments/new'
    )
    expect(screen.getByRole('link', { name: 'How To' })).toHaveAttribute('href', '#/howto')
  })

  it('discloses the ExtId field and the CPQ attestation on the How To page', () => {
    renderAt('#/howto')
    expect(screen.getByText('Data_Deployment_External_Id__c')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^CPQ:/ })).toBeInTheDocument()
    expect(screen.getByText(/protected setting with no API/)).toBeInTheDocument()
  })
})
