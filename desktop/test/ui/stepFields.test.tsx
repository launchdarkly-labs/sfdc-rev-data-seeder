// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, readinessScopeKey } from '../../src/shared/wizard'
/** S54 (L1): a Readiness verdict that OPENS the gate for exactly this scope. */
function readinessReady(objects: string[]) {
  return {
    scopeKey: readinessScopeKey({ selectedObjects: objects }),
    ready: true,
    blockingObjects: [],
    checkedAt: '2026-09-13T00:00:00.000Z'
  }
}

import type {
  DraftDetail,
  FieldInfo,
  FieldsPopulatedResult,
  Template
} from '../../src/shared/types'

function field(apiName: string, over: Partial<FieldInfo> = {}): FieldInfo {
  return {
    apiName,
    label: `${apiName} (lbl)`,
    type: 'string',
    isReference: false,
    referenceTo: [],
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

// Opportunity: Name/Amount (local), SBQQ__Foo__c (keep ns), FOO__Bar__c (non-keep ns),
// AutoNum__c + Formula__c (not deployable), SourceOnly__c (absent on target),
// TgtReadOnly__c (writable on source but a formula on target → must be dropped),
// AccountId (ref → out-of-scope Account: locked-skipped), OwnerId (ref → stable User: free).
const SRC_FIELDS: FieldInfo[] = [
  field('Name'),
  field('Amount'),
  field('SBQQ__Foo__c'),
  field('FOO__Bar__c'),
  field('AutoNum__c', { isAutoNumber: true }),
  field('Formula__c', { isCalculated: true }),
  field('SourceOnly__c'),
  field('TgtReadOnly__c'),
  field('AccountId', { isReference: true, referenceTo: ['Account'] }),
  field('OwnerId', { isReference: true, referenceTo: ['User'] })
]
const TGT_FIELDS: FieldInfo[] = [
  field('Name'),
  field('Amount'),
  field('SBQQ__Foo__c'),
  field('FOO__Bar__c'),
  field('AutoNum__c', { isAutoNumber: true }),
  field('Formula__c', { isCalculated: true }),
  field('TgtReadOnly__c', { isCalculated: true }), // read-only (formula) on the target
  field('AccountId', { isReference: true, referenceTo: ['Account'] }),
  field('OwnerId', { isReference: true, referenceTo: ['User'] })
]

let saved: Array<{ step: string; config: Record<string, unknown> }>
let populatedResult: FieldsPopulatedResult
let savedTemplates: Template[]
let nextTemplateId: number
let draftConfigOverride: Record<string, unknown>

function install(): void {
  saved = []
  populatedResult = { ok: true, populated: ['Name'] }
  savedTemplates = []
  nextTemplateId = 1
  draftConfigOverride = {}
  ;(window as unknown as { rds: unknown }).rds = {
    targetKeyedObjects: async () => ({ hasField: [], keyedRows: [] }),
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'src',
      targetConnectionId: 'tgt',
      sourceLabel: 'src',
      targetLabel: 'tgt',
      step: 'fields',
      config: {
        ...emptyWizardConfig(),
        selectedObjects: ['Opportunity'],
        readiness: readinessReady(['Opportunity']),
        ...draftConfigOverride
      },
      status: 'Planned'
    }),
    draftSave: async (input: { step: string; config: Record<string, unknown> }) => {
      saved.push({ step: input.step, config: input.config })
    },
    describeObject: async (conn: string, obj: string) =>
      obj === 'Opportunity' ? (conn === 'src' ? SRC_FIELDS : TGT_FIELDS) : [],
    fieldsPopulated: async () => populatedResult,
    templateList: async (kind: string) => savedTemplates.filter((t) => t.kind === kind),
    templateSave: async (input: { kind: string; name: string; payload: unknown }) => {
      const t: Template = {
        id: nextTemplateId++,
        kind: input.kind as Template['kind'],
        name: input.name,
        payload: input.payload,
        createdAt: 1,
        updatedAt: 1
      }
      savedTemplates.push(t)
      return t
    },
    templateRename: async (input: { id: number; name: string }) => {
      const t = savedTemplates.find((x) => x.id === input.id)
      if (t) t.name = input.name
    },
    templateDelete: async (id: number) => {
      savedTemplates = savedTemplates.filter((t) => t.id !== id)
    }
  }
}

function renderFields(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/1/wizard/fields']}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

async function expandOpportunity(): Promise<void> {
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Fields' })
  await user.click(await screen.findByRole('button', { name: /Opportunity/ }))
}

const cfg = (): Record<string, unknown> => saved[saved.length - 1]!.config
const excludedFor = (obj: string): string[] =>
  (cfg().excludedFields as Record<string, string[]>)[obj] ?? []

beforeEach(install)
afterEach(cleanup)

describe('StepFields (5B.6)', () => {
  it('lists deployable source∩target fields, dropping auto-number/formula/source-only', async () => {
    renderFields()
    await expandOpportunity()
    await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument())
    expect(screen.getByText('Amount')).toBeInTheDocument()
    expect(screen.getByText('SBQQ__Foo__c')).toBeInTheDocument()
    expect(screen.queryByText('AutoNum__c')).not.toBeInTheDocument() // not deployable
    expect(screen.queryByText('Formula__c')).not.toBeInTheDocument() // calculated
    expect(screen.queryByText('SourceOnly__c')).not.toBeInTheDocument() // not on target
    expect(screen.queryByText('TgtReadOnly__c')).not.toBeInTheDocument() // read-only on target
  })

  it('excludes an individual field (writes excludedFields)', async () => {
    const user = userEvent.setup()
    renderFields()
    await expandOpportunity()
    await user.click(await screen.findByLabelText('Include Amount'))
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(excludedFor('Opportunity')).toContain('Amount')
  })

  it('namespace exclusion locks its fields and survives Include all', async () => {
    const user = userEvent.setup()
    renderFields()
    await expandOpportunity()
    await user.click(await screen.findByLabelText('Exclude namespace FOO'))
    const bar = (await screen.findByLabelText('Include FOO__Bar__c')) as HTMLInputElement
    await waitFor(() => expect(bar.disabled).toBe(true))
    expect(bar.checked).toBe(false)
    // Include all clears explicit field exclusions but the namespace lock persists.
    await user.click(screen.getByRole('button', { name: 'Include all' }))
    const bar2 = screen.getByLabelText('Include FOO__Bar__c') as HTMLInputElement
    expect(bar2.disabled).toBe(true)
    expect(bar2.checked).toBe(false)
  })

  // S57 (FB-7): the scope here is Opportunity only — no CPQ object — so SBQQ is
  // excluded along with FOO. (Pre-S57 it was kept regardless of scope.)
  it('Suggest exclusions excludes every managed namespace when no CPQ object is in scope', async () => {
    const user = userEvent.setup()
    renderFields()
    await screen.findByRole('heading', { name: 'Fields' })
    await user.click(await screen.findByRole('button', { name: 'Suggest exclusions' }))
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(cfg().excludedNamespaces).toEqual(['FOO', 'SBQQ'])
  })

  it('degrades open when the populated probe fails (never fail-closed to "all excluded")', async () => {
    ;(
      window as unknown as { rds: { fieldsPopulated: () => Promise<unknown> } }
    ).rds.fieldsPopulated = async () => {
      throw new Error('probe failed')
    }
    const user = userEvent.setup()
    renderFields()
    await screen.findByRole('heading', { name: 'Fields' })
    await user.click(screen.getByLabelText(/Populated fields only/))
    await expandOpportunity()
    // Probe rejected → populated set unknown → nothing is excluded/locked.
    const amount = (await screen.findByLabelText('Include Amount')) as HTMLInputElement
    await waitFor(() => expect(amount.checked).toBe(true))
    expect(amount.disabled).toBe(false)
  })

  it('populated-only locks unpopulated fields', async () => {
    const user = userEvent.setup()
    renderFields()
    await screen.findByRole('heading', { name: 'Fields' })
    await user.click(screen.getByLabelText(/Populated fields only/))
    await expandOpportunity()
    // Only Name is populated → Amount is locked-excluded as "not populated".
    const amount = (await screen.findByLabelText('Include Amount')) as HTMLInputElement
    await waitFor(() => expect(amount.disabled).toBe(true))
    expect(amount.checked).toBe(false)
    const name = screen.getByLabelText('Include Name') as HTMLInputElement
    expect(name.disabled).toBe(false)
    expect(name.checked).toBe(true)
  })

  it('locks a ref to an out-of-scope object (skipped by mapping); stable refs stay free (5B.6-b)', async () => {
    renderFields()
    await expandOpportunity()
    // AccountId → Account (not in scope, not a stable default) → locked-excluded.
    const acct = (await screen.findByLabelText('Include AccountId')) as HTMLInputElement
    expect(acct.disabled).toBe(true)
    expect(acct.checked).toBe(false)
    expect(
      screen.getByText(/ref → Account out of scope \(skipped by mapping\)/)
    ).toBeInTheDocument()
    // OwnerId → User (stable nameMatch/directId default) → normal includable field.
    const owner = screen.getByLabelText('Include OwnerId') as HTMLInputElement
    expect(owner.disabled).toBe(false)
    expect(owner.checked).toBe(true)
    // Exclude all stores EVERY deployable field — an entry on a locked ref is
    // inert while locked but preserves the intent if the lock later lifts.
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Exclude all' }))
    await waitFor(() => expect(excludedFor('Opportunity')).toContain('Amount'))
    expect(excludedFor('Opportunity')).toContain('AccountId')
  })

  it('a user-chosen Skip mapping locks the field with its own badge (5B.6-b review fix)', async () => {
    draftConfigOverride = {
      mappings: { Opportunity: { OwnerId: { strategy: 'skip' } } }
    }
    renderFields()
    await expandOpportunity()
    const owner = (await screen.findByLabelText('Include OwnerId')) as HTMLInputElement
    expect(owner.disabled).toBe(true)
    expect(owner.checked).toBe(false)
    expect(screen.getByText(/skipped by your mapping/)).toBeInTheDocument()
  })

  it('template Apply merges per object — exclusions on uncovered objects survive', async () => {
    draftConfigOverride = { excludedFields: { Contact: ['Fax'] } } // untouched by the template
    savedTemplates = [
      {
        id: 3,
        kind: 'fields',
        name: 'opp-only',
        payload: {
          excludedFields: { Opportunity: ['Amount'] },
          excludedNamespaces: [],
          populatedOnly: false
        },
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const user = userEvent.setup()
    renderFields()
    await screen.findByRole('heading', { name: 'Fields' })
    await user.selectOptions(await screen.findByLabelText('Saved fields template'), '3')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText('Applied template "opp-only".')
    await waitFor(() =>
      expect(cfg().excludedFields as Record<string, string[]>).toEqual({
        Contact: ['Fax'],
        Opportunity: ['Amount']
      })
    )
  })

  it('saves and applies a fields template with scope re-validation (5B.6-b)', async () => {
    const user = userEvent.setup()
    renderFields()
    await expandOpportunity()
    // Exclude Amount, then save the current selection as a template.
    await user.click(await screen.findByLabelText('Include Amount'))
    await waitFor(() => expect(excludedFor('Opportunity')).toContain('Amount'))
    await user.type(screen.getByLabelText('Fields template name'), 'cpq-slim')
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    await screen.findByText('Saved template "cpq-slim".')
    expect(savedTemplates).toHaveLength(1)
    expect(
      (savedTemplates[0]!.payload as { excludedFields: Record<string, string[]> }).excludedFields
    ).toEqual({ Opportunity: ['Amount'] })

    // Reset the exclusion, then apply the template back.
    await user.click(screen.getByRole('button', { name: 'Include all' }))
    await waitFor(() => expect(excludedFor('Opportunity')).toEqual([]))
    await user.selectOptions(screen.getByLabelText('Saved fields template'), '1')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText('Applied template "cpq-slim".')
    await waitFor(() => expect(excludedFor('Opportunity')).toEqual(['Amount']))
  })

  it('template apply drops exclusions for out-of-scope objects and says so', async () => {
    savedTemplates = [
      {
        id: 7,
        kind: 'fields',
        name: 'stale',
        payload: {
          excludedFields: { Opportunity: ['Amount'], Account: ['Name'] },
          excludedNamespaces: ['FOO'],
          populatedOnly: false
        },
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const user = userEvent.setup()
    renderFields()
    await screen.findByRole('heading', { name: 'Fields' })
    await user.selectOptions(await screen.findByLabelText('Saved fields template'), '7')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/exclusions for 1 out-of-scope object dropped/)
    await waitFor(() =>
      expect(cfg().excludedFields as Record<string, string[]>).toEqual({
        Opportunity: ['Amount']
      })
    )
    expect(cfg().excludedNamespaces).toEqual(['FOO'])
  })
})
