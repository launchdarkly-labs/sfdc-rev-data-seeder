// @vitest-environment jsdom
/**
 * S59 — the template builder: Type defaults to Data seed and locks after save;
 * Read from defaults to Source orgs with a scope switch and an "Add new orgs"
 * link; objects pick into tiers; order suggestion reorders; batch size bounds;
 * the catalog's action selects with managed rows not actionable; opt-in
 * setting patches.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TemplateBuilderPage } from '../../src/renderer/src/pages/templates/TemplateBuilder'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import type { ObjectInfo, OrgConnection } from '../../src/shared/types'
import type { AutomationCatalog, TemplateDetail } from '../../src/shared/templates/types'
import { SAMPLE_POST_REFRESH_TEMPLATE } from '../../src/shared/templates/samples'

function org(id: string, role: OrgConnection['role'], over: Partial<OrgConnection> = {}): OrgConnection {
  return {
    id,
    label: id,
    cliAlias: id,
    loginUrl: null,
    username: `${id}@x`,
    orgId: `00D${id.padEnd(15, '0')}`.slice(0, 18),
    instanceUrl: '',
    role,
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

const ORGS = [org('srcbox', 'source'), org('sb3', 'target'), org('old_sb', 'target', { supersededBy: 'sb3' })]
const OBJECTS: ObjectInfo[] = [
  { apiName: 'SBQQ__PriceRule__c', label: 'Price Rule', custom: true, queryable: true, createable: true },
  { apiName: 'SBQQ__PriceCondition__c', label: 'Price Condition', custom: true, queryable: true, createable: true },
  { apiName: 'Account', label: 'Account', custom: false, queryable: true, createable: true }
]
const CATALOG: AutomationCatalog = {
  orgId: '00Dsrcbox',
  flows: [
    { apiName: 'Acme_Notify', label: 'Notify', processType: 'AutoLaunchedFlow', triggerType: 'RecordAfterSave', object: 'Opportunity', isActive: true, activeVersionNumber: 3, latestVersionNumber: 3, managed: false, namespace: null },
    { apiName: 'SBQQ__Managed', label: 'Managed', processType: 'Flow', triggerType: null, object: null, isActive: true, activeVersionNumber: 1, latestVersionNumber: 1, managed: true, namespace: 'SBQQ' }
  ],
  triggers: [
    { id: '01q1', name: 'AcmeOrderSync', object: 'Order', status: 'Active', bodyState: 'live', managed: false, namespace: null },
    { id: '01q2', name: 'SBQQ__QuoteTrigger', object: 'SBQQ__Quote__c', status: 'Active', bodyState: 'live', managed: true, namespace: 'SBQQ' }
  ],
  errors: []
}

let saved: Array<{ id?: number; kind: string; name: string; payload: unknown }>
let catalogCalls: string[]
let existing: TemplateDetail | null

beforeEach(() => {
  saved = []
  catalogCalls = []
  existing = null
  ;(window as unknown as { rds: unknown }).rds = {
    listOrgs: vi.fn(async () => ORGS),
    describeGlobal: vi.fn(async () => OBJECTS),
    describeObject: vi.fn(async () => []),
    templateGet: vi.fn(async () => existing),
    templateListAll: vi.fn(async () => [
      { id: 5, kind: 'seed', name: 'Acme CPQ configuration', description: null, builtFrom: null, detail: '', seedGroups: ['default', 'forms'], cpqGatedObjects: [], createdAt: 1, updatedAt: 1, lastRun: null }
    ]),
    templateAutomationCatalog: vi.fn(async (input: { connectionId: string }) => {
      catalogCalls.push(input.connectionId)
      return CATALOG
    }),
    templateSeedOrder: vi.fn(async (input: { objects: string[] }) => ({
      order: [...input.objects].sort((a, b) => (a.includes('Condition') ? 1 : 0) - (b.includes('Condition') ? 1 : 0)),
      deferredHints: {}
    })),
    templateSaveRunnable: vi.fn(async (input: { id?: number; kind: string; name: string; payload: unknown }) => {
      saved.push(input)
      return { id: input.id ?? 11, kind: input.kind, name: input.name, description: null, builtFrom: null, detail: '', seedGroups: [], cpqGatedObjects: [], createdAt: 1, updatedAt: 1, lastRun: null, payload: input.payload }
    }),
    filterValidate: vi.fn(async () => ({ ok: true, count: 1, soql: '', strippedClause: null, hint: null }))
  }
})
afterEach(cleanup)

function renderBuilder(path = '/templates/new'): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/templates/new" element={<TemplateBuilderPage />} />
          <Route path="/templates/:id/edit" element={<TemplateBuilderPage />} />
          <Route path="/templates" element={<h1>list</h1>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

describe('TemplateBuilder — header + Read from', () => {
  it('defaults Type to Data seed and Read from to Source orgs (the first source), with an Add new orgs link', async () => {
    renderBuilder()
    expect(await screen.findByRole('heading', { name: 'New template' })).toBeInTheDocument()
    expect(screen.getByLabelText('Template type')).toHaveValue('seed')
    expect(screen.getByLabelText('Read from scope')).toHaveValue('source')
    await waitFor(() => expect(screen.getByLabelText('Read from org')).toHaveValue('srcbox'))
    expect(screen.getByRole('link', { name: 'Add new orgs →' })).toHaveAttribute('href', '/connections')
  })

  it('switching the scope to Target orgs lists live targets only (superseded rows hidden)', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await screen.findByRole('heading', { name: 'New template' })
    await user.selectOptions(screen.getByLabelText('Read from scope'), 'target')
    const options = within(screen.getByLabelText('Read from org')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['— pick an org —', 'sb3 (target)'])
  })

  it('Save refuses an empty template and names the problems', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await screen.findByRole('heading', { name: 'New template' })
    await user.click(screen.getByRole('button', { name: 'Save template' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('2 problems')
    expect(alert).toHaveTextContent('name is required')
    expect(alert).toHaveTextContent('tiers add at least one object')
    expect(saved).toEqual([])
  })
})

describe('TemplateBuilder — Data seed', () => {
  it('picks objects into tiers, suggests an order, bounds the batch size, and saves with the builtFrom hint', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await screen.findByRole('heading', { name: 'New template' })
    await user.type(screen.getByLabelText('Template name'), 'My seed')
    // Objects tab: the read-from org's global describe, picked in a deliberately wrong order.
    const list = await screen.findByRole('list', { name: 'Objects' })
    await user.click(within(list).getByLabelText(/SBQQ__PriceCondition__c/))
    await user.click(within(list).getByLabelText(/SBQQ__PriceRule__c/))
    await user.click(screen.getByRole('tab', { name: 'Order & tiers' }))
    let rows = screen.getAllByTestId(/^tier-/)
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['tier-SBQQ__PriceCondition__c', 'tier-SBQQ__PriceRule__c'])
    await user.click(screen.getByRole('button', { name: 'Suggest order' }))
    await waitFor(() => {
      rows = screen.getAllByTestId(/^tier-/)
      expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['tier-SBQQ__PriceRule__c', 'tier-SBQQ__PriceCondition__c'])
    })
    const batch = screen.getByLabelText('Batch size for SBQQ__PriceRule__c')
    expect(batch).toHaveValue(200)
    expect(batch).toHaveAttribute('min', '1')
    expect(batch).toHaveAttribute('max', '200')
    await user.clear(batch)
    await user.type(batch, '1')
    await user.click(screen.getByRole('button', { name: 'Save template' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    const payload = saved[0]!.payload as { tiers: Array<{ object: string; batchSize?: number }>; builtFrom: { label: string } }
    expect(saved[0]!.kind).toBe('seed')
    expect(payload.tiers.map((t) => t.object)).toEqual(['SBQQ__PriceRule__c', 'SBQQ__PriceCondition__c'])
    expect(payload.tiers[0]!.batchSize).toBe(1)
    expect(payload.tiers[1]!.batchSize).toBeUndefined()
    expect(payload.builtFrom.label).toBe('srcbox')
  })

  it('the CPQ configuration preset fills the tiers and settings', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await screen.findByRole('heading', { name: 'New template' })
    await user.click(screen.getByRole('button', { name: 'CPQ configuration preset' }))
    expect(await screen.findByText(/32 objects in the template/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Objects (32)' })).toBeInTheDocument()
  })

  it('editing an existing template locks the Type and loads its payload', async () => {
    existing = {
      id: 4,
      kind: 'seed',
      name: 'Existing seed',
      description: 'd',
      builtFrom: { orgId: ORGS[0]!.orgId, label: 'srcbox' },
      detail: '',
      seedGroups: ['default'],
      cpqGatedObjects: [],
      createdAt: 1,
      updatedAt: 1,
      lastRun: null,
      payload: { schemaVersion: 1, source: { expectedOrgId: null }, runDefaults: { disableTargetAutomation: true }, keepIdTargets: [], copiedObjectsMustMatchSource: [], relinkCopiedObjects: [], deferredFields: {}, deferredPlaceholders: {}, tiers: [{ object: 'Account' }], subsets: [], expectedFailures: [], verify: { counts: true, danglingLookups: true, secondPassParity: true } }
    }
    renderBuilder('/templates/4/edit')
    expect(await screen.findByRole('heading', { name: 'Edit: Existing seed' })).toBeInTheDocument()
    expect(screen.getByLabelText('Template type')).toBeDisabled()
    expect(screen.getByLabelText('Template type')).toHaveValue('seed')
    expect(screen.getByRole('tab', { name: 'Objects (1)' })).toBeInTheDocument()
  })
})

describe('TemplateBuilder — Post-refresh', () => {
  it('reads the catalog from the read-from org; managed rows are not actionable; actions store by API name; opt-in patches', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await screen.findByRole('heading', { name: 'New template' })
    await user.type(screen.getByLabelText('Template name'), 'PR')
    await user.selectOptions(screen.getByLabelText('Template type'), 'postRefresh')
    const flows = await screen.findByRole('table', { name: 'Flows' })
    await waitFor(() => expect(catalogCalls).toEqual(['srcbox']))
    expect(within(flows).getByLabelText('Action for flow Acme_Notify')).toBeInTheDocument()
    expect(within(flows).queryByLabelText('Action for flow SBQQ__Managed')).toBeNull()
    expect(within(flows).getAllByText('managed')).toHaveLength(1)
    await user.selectOptions(within(flows).getByLabelText('Action for flow Acme_Notify'), 'deactivate')
    const triggers = screen.getByRole('table', { name: 'Triggers' })
    expect(within(triggers).queryByLabelText('Action for trigger SBQQ__QuoteTrigger')).toBeNull()
    await user.selectOptions(within(triggers).getByLabelText('Action for trigger AcmeOrderSync'), 'deactivate')
    expect(screen.getByRole('button', { name: 'Selected (2)' })).toBeInTheDocument()
    // A setting patch, opt-in.
    await user.click(screen.getByRole('button', { name: 'Add setting patch' }))
    await user.type(screen.getByLabelText('Patch label'), 'Quiet the chat')
    await user.type(screen.getByLabelText('Patch object'), 'Acme_Settings__c')
    await user.type(screen.getByLabelText('Patch field'), 'Key__c')
    await user.click(screen.getByLabelText(/opt-in/))
    // A seed template with its groups.
    await user.click(screen.getByRole('button', { name: 'Add seed template' }))
    expect(screen.getByLabelText('Seed template 1')).toHaveValue('Acme CPQ configuration')
    await user.click(screen.getByRole('button', { name: 'Save template' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    const p = saved[0]!.payload as typeof SAMPLE_POST_REFRESH_TEMPLATE
    expect(saved[0]!.kind).toBe('postRefresh')
    expect(p.automation.flows).toEqual([{ apiName: 'Acme_Notify', action: 'deactivate' }])
    expect(p.automation.triggers).toEqual([{ name: 'AcmeOrderSync', action: 'deactivate' }])
    expect(p.automation.settingPatches[0]).toMatchObject({ label: 'Quiet the chat', object: 'Acme_Settings__c', field: 'Key__c', optIn: true, transform: { kind: 'prefix', value: 'SBOFF_' } })
    expect(p.seedTemplates).toEqual([{ name: 'Acme CPQ configuration' }])
  })
})
