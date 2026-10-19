// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionsPage } from '../../src/renderer/src/pages/Connections'
import { encodeRdsError, type OrgConnection, type OAuthBeginInput } from '../../src/shared/types'
import { PROD_ORG_ID_PREFIX } from '../../src/shared/types'

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

const cliRow = conn({ id: 'srcbox', label: 'srcbox', authKind: 'cli' })
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
    }),
    settingsGet: vi.fn(async () => null),
    settingsSet: vi.fn(async () => undefined)
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
  const live = conn({ id: 'srcbox_911', label: 'srcbox_911', role: 'source' })
  const superseded = conn({
    id: 'srcbox_829',
    label: 'srcbox_829',
    role: 'source',
    supersededBy: 'srcbox_911'
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
    await screen.findByText('srcbox_911')
    // Stale rows are not in the main table's role selects (the other combobox
    // on the page is the OAuth login-host picker).
    const roleSelects = screen.getAllByRole('combobox').filter((el) => el.classList.contains('role'))
    expect(roleSelects).toHaveLength(1)
    expect(screen.getByText(/Stale connections \(2\)/)).toBeInTheDocument()
    expect(screen.getByText('superseded by srcbox_911')).toBeInTheDocument()
    expect(screen.getByText('not in the sf CLI any more')).toBeInTheDocument()

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons).toHaveLength(2)
    await user.click(removeButtons[0]!)
    await waitFor(() => expect(removed).toBe('srcbox_829'))
    await waitFor(() => expect(screen.queryByText('srcbox_829')).toBeNull())
    expect(screen.getByText(/Stale connections \(1\)/)).toBeInTheDocument()
  })

  it('shows the clean refusal when a deployment still references the row', async () => {
    const user = userEvent.setup()
    ;(window as unknown as { rds: { orgRemove: unknown } }).rds.orgRemove = vi.fn(async () => {
      throw new Error(
        encodeRdsError({
          code: 'INVALID_STATE',
          message: "'srcbox_829' is still used by a deployment — delete that deployment first, then remove the connection."
        })
      )
    })
    render(<ConnectionsPage />)
    await screen.findByText('srcbox_911')
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
    await waitFor(() =>
      expect(screen.getByText(/still used by a deployment/)).toBeInTheDocument()
    )
    expect(screen.getByText('srcbox_829')).toBeInTheDocument() // still listed
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
    expect(rds.setOrgRole).toHaveBeenCalledWith('srcbox', 'target')
    // ux A-12: the tick is decorative (aria-hidden); the word carries the meaning.
    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
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
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument()
  })
})

// S64 P6 (D6): the production pin is a runtime setting edited here.
describe('ConnectionsPage — production pin', () => {
  const rds = (): { settingsGet: ReturnType<typeof vi.fn>; settingsSet: ReturnType<typeof vi.fn>; listOrgs: ReturnType<typeof vi.fn> } =>
    (window as unknown as { rds: never }).rds

  it('shows the compiled default when nothing is stored', async () => {
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    const input = screen.getByLabelText('Production org Id') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe(PROD_ORG_ID_PREFIX))
    expect(screen.getByText(/the default this build ships with/)).toBeInTheDocument()
    expect(screen.queryByText('Reset to default')).not.toBeInTheDocument()
    // Nothing to save until the value changes.
    expect(screen.getByRole('button', { name: 'Save pin' })).toBeDisabled()
  })

  it('shows a stored pin (normalised to 15 characters) and offers Reset', async () => {
    rds().settingsGet = vi.fn(async () => '00D000000Fake99EAA')
    render(<ConnectionsPage />)
    const input = screen.getByLabelText('Production org Id') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('00D000000Fake99'))
    expect(await screen.findByText('Reset to default')).toBeInTheDocument()
  })

  it('saves a new Org Id through IPC and re-reads the connection list', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    const input = screen.getByLabelText('Production org Id') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe(PROD_ORG_ID_PREFIX))
    const listCalls = rds().listOrgs.mock.calls.length

    await user.clear(input)
    await user.type(input, ' 00D000000Fake99EAA ')
    await user.click(screen.getByRole('button', { name: 'Save pin' }))

    await waitFor(() => expect(rds().settingsSet).toHaveBeenCalledWith('prodOrgIdPrefix', '00D000000Fake99'))
    expect(await screen.findByText(/Saved — pinned/)).toBeInTheDocument()
    expect(rds().listOrgs.mock.calls.length).toBeGreaterThan(listCalls)
    expect(screen.getByText('Reset to default')).toBeInTheDocument()
  })

  it('refuses a value that is not an Org Id without calling IPC', async () => {
    const user = userEvent.setup()
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    const input = screen.getByLabelText('Production org Id') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe(PROD_ORG_ID_PREFIX))

    await user.clear(input)
    await user.type(input, 'production')
    await user.click(screen.getByRole('button', { name: 'Save pin' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Org Id/)
    expect(rds().settingsSet).not.toHaveBeenCalled()
  })

  it('surfaces a main-side rejection as the message, not a raw envelope', async () => {
    const user = userEvent.setup()
    rds().settingsSet = vi.fn(async () => {
      throw new Error(encodeRdsError({ code: 'INVALID_STATE', message: 'A production pin must be a Salesforce Org Id.' }))
    })
    render(<ConnectionsPage />)
    await screen.findByText('my-sandbox')
    const input = screen.getByLabelText('Production org Id') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe(PROD_ORG_ID_PREFIX))

    await user.clear(input)
    await user.type(input, '00D000000Fake99')
    await user.click(screen.getByRole('button', { name: 'Save pin' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A production pin must be a Salesforce Org Id.')
    expect(screen.queryByText(/Saved — pinned/)).not.toBeInTheDocument()
  })

  it('Reset to default writes the compiled constant', async () => {
    const user = userEvent.setup()
    rds().settingsGet = vi.fn(async () => '00D000000Fake99')
    render(<ConnectionsPage />)
    await user.click(await screen.findByText('Reset to default'))
    await waitFor(() => expect(rds().settingsSet).toHaveBeenCalledWith('prodOrgIdPrefix', PROD_ORG_ID_PREFIX))
    await waitFor(() => expect((screen.getByLabelText('Production org Id') as HTMLInputElement).value).toBe(PROD_ORG_ID_PREFIX))
  })
})
