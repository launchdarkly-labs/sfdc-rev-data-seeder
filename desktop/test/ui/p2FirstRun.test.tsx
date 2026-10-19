// @vitest-environment jsdom
/**
 * S64 P2 — the first-run and safety fixes from the UX review:
 *  - a Completed deployment's Plan step says RE-RUN and asks before deploying (visual.md #1)
 *  - New Deployment with no orgs points at Connections instead of two empty selects (IA-1)
 *  - a missing `sf` CLI is guidance, not `spawn sf ENOENT` (compat §3)
 *  - Templates › Rename works (window.prompt is not implemented in Electron) (IA-12)
 *  - Home shows the getting-started checklist when nothing exists yet (IA-1)
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { NewDeploymentPage } from '../../src/renderer/src/pages/NewDeployment'
import { ConnectionsPage } from '../../src/renderer/src/pages/Connections'
import { TemplatesPage } from '../../src/renderer/src/pages/templates/TemplatesPage'
import { HomePage } from '../../src/renderer/src/pages/Home'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { ConfirmProvider } from '../../src/renderer/src/ui/ConfirmDialog'
import { emptyWizardConfig } from '../../src/shared/wizard'
import { encodeRdsError, type DraftDetail, type OrgConnection, type PlanView } from '../../src/shared/types'
import type { TemplateSummary } from '../../src/shared/templates/types'

afterEach(cleanup)

function setRds(api: Record<string, unknown>): void {
  ;(window as unknown as { rds: unknown }).rds = api
}

function providers(initial: string, routes: React.ReactNode): React.JSX.Element {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  )
}

const emptySnapshot = {
  items: [],
  validationRuleCount: 0,
  flowCount: 0,
  triggerCount: 0,
  duplicateRuleCount: 0,
  hasCpqTriggerSetting: false,
  cpqTriggerGatedObjects: [],
  flowScopeFallback: false,
  sectionErrors: []
}

describe('Plan step on a deployment that already ran', () => {
  function install(status: string): { deployStart: ReturnType<typeof vi.fn> } {
    const deployStart = vi.fn(async () => ({ jobId: 'j1' }))
    const plan: PlanView = {
      deploymentId: 1,
      objects: [
        {
          objectName: 'Account',
          sortOrder: 0,
          recordCount: 7,
          apiStrategy: 'REST',
          gatingTier: null,
          isJunction: false,
          hasCircularReference: false,
          deferredFields: [],
          scopedFilterDisplay: null,
          junctionParents: null,
          requiresTriggerBypass: false,
          recommendedBatchSize: 200
        }
      ],
      totalObjects: 1,
      totalRecords: 7,
      autoInjectedJunctions: [],
      warnings: []
    }
    setRds({
      draftLoad: async (): Promise<DraftDetail> => ({
        name: 'Acme',
        sourceConnectionId: 'src',
        targetConnectionId: 'tgt',
        sourceLabel: 'src',
        targetLabel: 'tgt',
        step: 'plan',
        // keyless: no readiness gate to satisfy in the fixture
        config: { ...emptyWizardConfig(), selectedObjects: ['Account'], useExternalIds: false },
        status
      }),
      draftSave: async () => {},
      jobList: async () => [],
      onJobEvent: () => () => undefined,
      templateListAll: async () => [],
      automationDiscover: async () => emptySnapshot,
      planGet: async () => plan,
      planReorder: async () => plan,
      deployStart
    })
    return { deployStart }
  }

  const renderPlan = (): void => {
    render(providers('/deployments/1/wizard/plan', <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />))
  }

  it('labels the button Re-run, explains what a re-run does, and asks before starting', async () => {
    const user = userEvent.setup()
    const { deployStart } = install('Completed')
    renderPlan()
    const button = await screen.findByRole('button', { name: 'Re-run deploy' })
    expect(screen.getByTestId('rerun-note')).toHaveTextContent(/already ran \(Completed\)/)
    expect(screen.getByTestId('rerun-note')).toHaveTextContent(/id map/)
    await waitFor(() => expect(button).toBeEnabled())

    await user.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Re-run this deployment?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deployStart).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Re-run deploy' }))
    const dialog2 = await screen.findByRole('dialog', { name: 'Re-run this deployment?' })
    await user.click(within(dialog2).getByRole('button', { name: 'Re-run deploy' }))
    await waitFor(() => expect(deployStart).toHaveBeenCalledWith(1))
  })

  it('a Planned deployment keeps the plain Deploy button and no re-run note', async () => {
    install('Planned')
    renderPlan()
    expect(await screen.findByRole('button', { name: 'Deploy' })).toBeInTheDocument()
    expect(screen.queryByTestId('rerun-note')).not.toBeInTheDocument()
  })

  it('shows the step position and a breadcrumb back to Deployments / the monitor', async () => {
    install('Completed')
    renderPlan()
    await screen.findByRole('heading', { name: 'Acme' })
    expect(screen.getByText(/Step 8 of 8/)).toBeInTheDocument() // keyless: no Readiness step
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Deployments' })).toHaveAttribute('href', '/')
    expect(within(crumbs).getByRole('link', { name: 'Monitor' })).toHaveAttribute('href', '/deployments/1')
  })
})

describe('New Deployment with no orgs connected', () => {
  it('replaces the form with a pointer to Connections', async () => {
    setRds({ listOrgs: async () => [], draftCreate: vi.fn() })
    render(providers('/deployments/new', <Route path="/deployments/new" element={<NewDeploymentPage />} />))
    const note = await screen.findByTestId('no-orgs')
    expect(within(note).getByRole('link', { name: 'Connect your orgs' })).toHaveAttribute('href', '/connections')
    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument()
  })
})

describe('Connections when the Salesforce CLI is missing', () => {
  it('shows install guidance instead of the raw spawn error', async () => {
    setRds({
      listOrgs: vi.fn(async () => []),
      refreshOrgs: vi.fn(async () => {
        throw new Error(encodeRdsError({ code: 'CLI_MISSING', message: 'The Salesforce CLI (sf) was not found on this Mac.' }))
      })
    })
    render(<ConnectionsPage />)
    const banner = await screen.findByTestId('cli-missing')
    expect(banner).toHaveTextContent(/Salesforce CLI was not found/)
    expect(within(banner).getByRole('link')).toHaveAttribute('href', expect.stringContaining('salesforcecli'))
    expect(screen.queryByText(/ENOENT/)).not.toBeInTheDocument()
  })

  it('filters the list by alias or username and can hide unassigned rows', async () => {
    const user = userEvent.setup()
    const row = (over: Partial<OrgConnection>): OrgConnection => ({
      id: 'a',
      label: 'a',
      cliAlias: 'a',
      loginUrl: null,
      username: 'u@x.io',
      orgId: '00Dxxx',
      instanceUrl: '',
      role: 'unassigned',
      authKind: 'cli',
      status: 'Active',
      cliStatus: 'Connected',
      isSandbox: true,
      lastVerifiedAt: null,
      prodPinned: false,
      supersededBy: null,
      ...over
    })
    const rows = [
      row({ id: 'srcbox_911', label: 'srcbox_911', role: 'source', username: 'me@acme.src' }),
      row({ id: 'tgt_a', label: 'tgt_a', role: 'target', username: 'me@acme.tgt' }),
      row({ id: 'spare', label: 'spare', role: 'unassigned', username: 'me@acme.spare' })
    ]
    setRds({ listOrgs: vi.fn(async () => rows), refreshOrgs: vi.fn(async () => rows) })
    render(<ConnectionsPage />)
    await screen.findByText('spare')
    expect(screen.getByText('3 of 3')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Filter connections'), 'acme.tgt')
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.queryByText('spare')).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('Filter connections'))
    await user.click(screen.getByLabelText(/Hide unassigned/))
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(screen.queryByText('spare')).not.toBeInTheDocument()
  })
})

describe('Templates › Rename', () => {
  it('renames through a modal with a text field (no window.prompt)', async () => {
    const user = userEvent.setup()
    const t: TemplateSummary = {
      id: 3,
      kind: 'objects',
      name: 'Core objects',
      description: null,
      builtFrom: null,
      detail: '11 objects (wizard)',
      seedGroups: [],
      cpqGatedObjects: [],
      createdAt: 1,
      updatedAt: 2,
      lastRun: null
    }
    const templateRename = vi.fn(async () => undefined)
    setRds({ templateListAll: vi.fn(async () => [t]), templateRename })
    render(providers('/templates', <Route path="/templates" element={<TemplatesPage />} />))
    await user.click(await screen.findByRole('button', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename "Core objects"' })
    const input = within(dialog).getByLabelText('New template name')
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled() // unchanged name
    await user.clear(input)
    await user.type(input, 'Core v2')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(templateRename).toHaveBeenCalledWith({ id: 3, name: 'Core v2' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Home first run', () => {
  it('shows the getting-started checklist when there are no orgs and no deployments', async () => {
    setRds({ draftList: async () => [], listOrgs: async () => [], jobList: async () => [], onJobEvent: () => () => undefined })
    render(providers('/', <Route path="/" element={<HomePage />} />))
    const welcome = await screen.findByTestId('welcome')
    expect(within(welcome).getByRole('link', { name: 'Open Connections' })).toHaveAttribute('href', '/connections')
    expect(screen.queryByText(/create one/)).not.toBeInTheDocument()
  })

  it('falls back to the plain empty state once an org exists', async () => {
    setRds({
      draftList: async () => [],
      listOrgs: async () => [{ id: 'x' }],
      jobList: async () => [],
      onJobEvent: () => () => undefined
    })
    render(providers('/', <Route path="/" element={<HomePage />} />))
    expect(await screen.findByRole('link', { name: 'create one' })).toBeInTheDocument()
    expect(screen.queryByTestId('welcome')).not.toBeInTheDocument()
  })
})
