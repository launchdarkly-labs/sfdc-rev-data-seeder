// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NewDeploymentPage } from '../../src/renderer/src/pages/NewDeployment'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { encodeRdsError, type OrgConnection } from '../../src/shared/types'

function conn(id: string, role: OrgConnection['role'], prodPinned = false): OrgConnection {
  return {
    id,
    label: id,
    cliAlias: id,
    loginUrl: null,
    username: `${id}@x.io`,
    orgId: prodPinned ? '00D41000000UvVnXXX' : `00D${id}`,
    instanceUrl: '',
    role,
    authKind: 'cli',
    status: 'Active',
    cliStatus: 'Connected',
    isSandbox: !prodPinned,
    lastVerifiedAt: null,
    prodPinned,
    supersededBy: null
  }
}

let created: { name: string; sourceConnectionId: string; targetConnectionId: string } | null

beforeEach(() => {
  created = null
  ;(window as unknown as { rds: unknown }).rds = {
    listOrgs: async () => [
      conn('prod', 'source', true),
      conn('darkb', 'source'),
      conn('sb1', 'target'),
      conn('scratch', 'unassigned')
    ],
    draftCreate: async (input: {
      name: string
      sourceConnectionId: string
      targetConnectionId: string
    }) => {
      created = input
      // S52 F1: the create reports which roles it wrote; 'scratch' is unassigned.
      return {
        id: 7,
        assigned: { source: input.sourceConnectionId === 'scratch', target: false }
      }
    }
  }
})
afterEach(cleanup)

function renderPage(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/new']}>
        <Routes>
          <Route path="/deployments/new" element={<NewDeploymentPage />} />
          <Route path="/deployments/:id/wizard/:step" element={<div>WIZARD ROUTE</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

describe('NewDeploymentPage', () => {
  it('excludes prod from the target picker but allows it as source', async () => {
    renderPage()
    await screen.findByText('Source (read-only)')
    const selects = screen.getAllByRole('combobox')
    const [sourceSel, targetSel] = selects
    // Source options include prod; target options do not.
    expect(sourceSel!.textContent).toContain('prod')
    expect(targetSel!.textContent).not.toContain('prod')
    // Target includes target-role + unassigned.
    expect(targetSel!.textContent).toContain('sb1')
    expect(targetSel!.textContent).toContain('scratch')
  })

  it('blocks same-org and creates + navigates otherwise', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Source (read-only)')
    const [sourceSel, targetSel] = screen.getAllByRole('combobox')

    await user.type(screen.getByPlaceholderText(/Acme/), 'My Deploy')
    await user.selectOptions(sourceSel!, 'scratch')
    await user.selectOptions(targetSel!, 'scratch')
    expect(screen.getByText(/must be different orgs/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled()

    await user.selectOptions(targetSel!, 'sb1')
    const createBtn = screen.getByRole('button', { name: /Create/ })
    expect(createBtn).toBeEnabled()
    await user.click(createBtn)

    await waitFor(() => expect(screen.getByText('WIZARD ROUTE')).toBeInTheDocument())
    expect(created).toEqual({
      name: 'My Deploy',
      sourceConnectionId: 'scratch',
      targetConnectionId: 'sb1'
    })
  })

  it('S52 F1: labels an unassigned pick and toasts the role the create wrote', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Source (read-only)')
    const [sourceSel, targetSel] = screen.getAllByRole('combobox')
    // The picker says what picking an unassigned org will do.
    expect(sourceSel!.textContent).toContain('scratch (will become Source)')
    expect(targetSel!.textContent).toContain('scratch (will become Target)')
    // Rows that already have a role carry no such suffix.
    expect(sourceSel!.textContent).not.toContain('darkb (will become')

    await user.type(screen.getByPlaceholderText(/Acme/), 'Roles')
    await user.selectOptions(sourceSel!, 'scratch')
    await user.selectOptions(targetSel!, 'sb1')
    await user.click(screen.getByRole('button', { name: /Create/ }))
    await waitFor(() => expect(screen.getByText('WIZARD ROUTE')).toBeInTheDocument())
    // The toast names exactly what was written — and only that side.
    expect(screen.getByText('scratch set as Source')).toBeInTheDocument()
  })

  it('S52 F3: superseded and not-in-CLI rows stay out of both pickers', async () => {
    ;(window as unknown as { rds: { listOrgs: unknown } }).rds.listOrgs = async () => [
      conn('darkb_911', 'unassigned'),
      { ...conn('darkb_829', 'source'), supersededBy: 'darkb_911' },
      { ...conn('gone', 'target'), cliStatus: 'Not in CLI' },
      conn('sb1', 'target')
    ]
    renderPage()
    await screen.findByText('Source (read-only)')
    const [sourceSel, targetSel] = screen.getAllByRole('combobox')
    expect(sourceSel!.textContent).toContain('darkb_911')
    expect(sourceSel!.textContent).not.toContain('darkb_829')
    expect(targetSel!.textContent).toContain('sb1')
    expect(targetSel!.textContent).not.toContain('gone')
  })

  it('surfaces a create failure reactively (no stale-closure swallow)', async () => {
    const user = userEvent.setup()
    ;(window as unknown as { rds: { draftCreate: unknown } }).rds.draftCreate = async () => {
      throw new Error(encodeRdsError({ code: 'UNKNOWN', message: 'disk is full' }))
    }
    renderPage()
    await screen.findByText('Source (read-only)')
    const [sourceSel, targetSel] = screen.getAllByRole('combobox')
    await user.type(screen.getByPlaceholderText(/Acme/), 'My Deploy')
    await user.selectOptions(sourceSel!, 'darkb')
    await user.selectOptions(targetSel!, 'sb1')
    await user.click(screen.getByRole('button', { name: /Create/ }))

    // Error renders from state (not swallowed); we stayed on the form.
    await waitFor(() =>
      expect(screen.getByText(/Could not create: disk is full/)).toBeInTheDocument()
    )
    expect(screen.queryByText('WIZARD ROUTE')).not.toBeInTheDocument()
  })
})
