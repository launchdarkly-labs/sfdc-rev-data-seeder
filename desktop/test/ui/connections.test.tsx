// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionsPage } from '../../src/renderer/src/pages/Connections'
import { encodeRdsError, type OrgConnection, type OAuthBeginInput } from '../../src/shared/types'

function conn(over: Partial<OrgConnection>): OrgConnection {
  return {
    id: 'id',
    label: 'id',
    cliAlias: 'id',
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
  }
}

const cliRow = conn({ id: 'darkb', label: 'darkb', authKind: 'cli' })
const oauthRow = conn({
  id: 'uuid-1',
  label: 'my-sandbox',
  cliAlias: null,
  authKind: 'oauth',
  loginUrl: 'https://test.salesforce.com',
  status: 'Active',
  username: 'admin@sb'
})

let beginInput: OAuthBeginInput | null
let disconnected: string | null

beforeEach(() => {
  beginInput = null
  disconnected = null
  ;(window as unknown as { rds: unknown }).rds = {
    listOrgs: vi.fn(async () => [cliRow, oauthRow]),
    refreshOrgs: vi.fn(async () => [cliRow, oauthRow]),
    setOrgRole: vi.fn(async () => [cliRow, oauthRow]),
    verifyOrg: vi.fn(async () => ({ ok: true, orgId: '00Dxxx', username: 'admin@sb' })),
    oauthBegin: vi.fn(async (input: OAuthBeginInput) => {
      beginInput = input
      return [cliRow, oauthRow]
    }),
    oauthDisconnect: vi.fn(async (id: string) => {
      disconnected = id
      return [cliRow]
    })
  }
})

afterEach(cleanup)

describe('ConnectionsPage — dual-mode', () => {
  it('shows CLI vs OAuth pills and OAuth-only actions', async () => {
    render(<ConnectionsPage />)
    expect(await screen.findByText('my-sandbox')).toBeInTheDocument()
    expect(screen.getByText('OAuth')).toBeInTheDocument()
    expect(screen.getByText('CLI')).toBeInTheDocument()
    // Re-authenticate + Disconnect exist for the OAuth row only (one each).
    expect(screen.getByRole('button', { name: 'Re-authenticate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('signs in via OAuth with the production host and an optional label', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    await user.type(screen.getByLabelText('Label'), 'Prod org')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(beginInput).not.toBeNull())
    expect(beginInput).toEqual({ loginUrl: 'https://login.salesforce.com', label: 'Prod org' })
  })

  it('requires a My Domain host when Custom is chosen', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    await user.selectOptions(screen.getByLabelText('Login host'), 'custom')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Enter your My Domain host/i)).toBeInTheDocument()
    expect(beginInput).toBeNull() // never called
  })

  it('normalizes a bare custom host to https and passes it through', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    await user.selectOptions(screen.getByLabelText('Login host'), 'custom')
    await user.type(screen.getByLabelText('My Domain host'), 'acme.my.salesforce.com')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(beginInput).not.toBeNull())
    expect(beginInput?.loginUrl).toBe('https://acme.my.salesforce.com')
  })

  it('re-authenticates in place with the row login host + its id', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    await user.click(screen.getByRole('button', { name: 'Re-authenticate' }))
    await waitFor(() => expect(beginInput).not.toBeNull())
    expect(beginInput).toEqual({
      loginUrl: 'https://test.salesforce.com',
      reauthConnectionId: 'uuid-1'
    })
  })

  it('disconnects the OAuth org and drops it from the list', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(disconnected).toBe('uuid-1'))
    await waitFor(() => expect(screen.queryByText('my-sandbox')).not.toBeInTheDocument())
  })

  it('shows the CLEAN decoded message (not the raw RDS_ERR envelope) on a rejection', async () => {
    const user = userEvent.setup()
    const clean = 'This connection is used by a deployment — remove it first.'
    ;(window.rds as unknown as { oauthDisconnect: unknown }).oauthDisconnect = vi.fn(async () => {
      // Main-side wrapHandler encodes the envelope into the Error message.
      throw new Error(encodeRdsError({ code: 'INVALID_STATE', message: clean }))
    })
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText(clean)).toBeInTheDocument()
    expect(screen.queryByText(/RDS_ERR::/)).not.toBeInTheDocument()
  })
})

// S52 F3 — alias rename / sandbox refresh leaves a sibling row behind.
describe('ConnectionsPage — stale connections', () => {
  const live = conn({ id: 'darkb_911', label: 'darkb_911', role: 'source' })
  const superseded = conn({
    id: 'darkb_829',
    label: 'darkb_829',
    role: 'source',
    supersededBy: 'darkb_911'
  })
  const loggedOut = conn({ id: 'old_sb', label: 'old_sb', cliStatus: 'Not in CLI' })
  let removed: string | null

  beforeEach(() => {
    removed = null
    ;(window as unknown as { rds: unknown }).rds = {
      listOrgs: vi.fn(async () => [live, superseded, loggedOut]),
      refreshOrgs: vi.fn(async () => [live, superseded, loggedOut]),
      setOrgRole: vi.fn(async () => [live, superseded, loggedOut]),
      verifyOrg: vi.fn(async () => ({ ok: true })),
      orgRemove: vi.fn(async (id: string) => {
        removed = id
        return [live, loggedOut]
      })
    }
  })

  it('lists stale rows apart from live ones, with the reason, and removes on click', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('darkb_911')
    // Stale rows are not in the main table's role selects (the other combobox
    // on the page is the OAuth login-host picker).
    const roleSelects = screen.getAllByRole('combobox').filter((el) => el.classList.contains('role'))
    expect(roleSelects).toHaveLength(1)
    expect(screen.getByText(/Stale connections \(2\)/)).toBeInTheDocument()
    expect(screen.getByText('superseded by darkb_911')).toBeInTheDocument()
    expect(screen.getByText('not in the sf CLI any more')).toBeInTheDocument()

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons).toHaveLength(2)
    await user.click(removeButtons[0]!)
    await waitFor(() => expect(removed).toBe('darkb_829'))
    await waitFor(() => expect(screen.queryByText('darkb_829')).toBeNull())
    expect(screen.getByText(/Stale connections \(1\)/)).toBeInTheDocument()
  })

  it('shows the clean refusal when a deployment still references the row', async () => {
    const user = userEvent.setup()
    ;(window as unknown as { rds: { orgRemove: unknown } }).rds.orgRemove = vi.fn(async () => {
      throw new Error(
        encodeRdsError({
          code: 'INVALID_STATE',
          message: "'darkb_829' is still used by a deployment — delete that deployment first, then remove the connection."
        })
      )
    })
    render(<ConnectionsPage />)
    await screen.findByText('darkb_911')
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
    await waitFor(() =>
      expect(screen.getByText(/still used by a deployment/)).toBeInTheDocument()
    )
    expect(screen.getByText('darkb_829')).toBeInTheDocument() // still listed
  })
})

describe('ConnectionsPage — role persistence feedback', () => {
  it('writes the role immediately and confirms with a transient Saved marker', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')

    const selects = screen.getAllByRole('combobox', { name: '' })
    const roleSelect = selects.find((s) => s.className.includes('role'))!
    await user.selectOptions(roleSelect, 'target')

    // Persisted through IPC on change — there is no Save button to press.
    const rds = (window as unknown as { rds: { setOrgRole: ReturnType<typeof vi.fn> } }).rds
    expect(rds.setOrgRole).toHaveBeenCalledWith('darkb', 'target')
    expect(await screen.findByText('✓ Saved')).toBeInTheDocument()
  })

  it('does not claim a save when the write is rejected', async () => {
    const user = userEvent.setup()
    ;(window as unknown as { rds: Record<string, unknown> }).rds.setOrgRole = vi.fn(async () => {
      throw new Error(
        encodeRdsError({
          code: 'INVALID_STATE',
          message: 'LaunchDarkly production is permanently read-only and can never be a target.'
        })
      )
    })
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')

    const selects = screen.getAllByRole('combobox', { name: '' })
    const roleSelect = selects.find((s) => s.className.includes('role'))!
    await user.selectOptions(roleSelect, 'target')

    await waitFor(() =>
      expect(screen.getByText(/permanently read-only/)).toBeInTheDocument()
    )
    expect(screen.queryByText('✓ Saved')).not.toBeInTheDocument()
  })
})
