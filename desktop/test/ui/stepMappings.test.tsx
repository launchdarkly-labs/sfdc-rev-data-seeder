// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
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

import type { DraftDetail, FieldInfo, SampleGetResult, Template } from '../../src/shared/types'

function field(apiName: string, refTo?: string): FieldInfo {
  return {
    apiName,
    // Distinct from apiName so a row's label and its api-name span don't collide in queries.
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

// Opportunity scope: [Opportunity, Account]. AccountId → in-scope (externalId),
// OwnerId → User (directId default + setToMe), RecordTypeId → hidden,
// ParentOpp__c → self-ref (locked), CaseLink__c → out-of-scope Case (locked).
const OPP_FIELDS: FieldInfo[] = [
  field('Amount'),
  field('AccountId', 'Account'),
  field('OwnerId', 'User'),
  field('RecordTypeId', 'RecordType'),
  field('ParentOpp__c', 'Opportunity'),
  field('CaseLink__c', 'Case')
]

let saved: Array<{ step: string; config: Record<string, unknown> }>
let sampleResult: SampleGetResult
let templateStore: Template[]
/** S57 (B1): what the fake target says about out-of-scope objects (default: nothing). */
let targetKeyed: { hasField: string[]; keyedRows: string[] }
let targetKeyedCalls: string[][]

function install(): void {
  saved = []
  templateStore = []
  targetKeyed = { hasField: [], keyedRows: [] }
  targetKeyedCalls = []
  sampleResult = { ok: true, values: { AccountId: '001XXaaa', OwnerId: '005ZZbbb' } }
  ;(window as unknown as { rds: unknown }).rds = {
    targetKeyedObjects: async (input: { objectNames: string[] }) => {
      targetKeyedCalls.push([...input.objectNames].sort())
      return targetKeyed
    },
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'src',
      targetConnectionId: 'tgt',
      sourceLabel: 'src',
      targetLabel: 'tgt',
      step: 'mappings',
      config: {
        ...emptyWizardConfig(),
        selectedObjects: ['Opportunity', 'Account'],
        readiness: readinessReady(['Opportunity', 'Account'])
      },
      status: 'Planned'
    }),
    draftSave: async (input: { step: string; config: Record<string, unknown> }) => {
      saved.push({ step: input.step, config: input.config })
    },
    verifyOrg: async () => ({ ok: true, username: 'me@target.example' }),
    describeObject: async (_c: string, obj: string) => (obj === 'Opportunity' ? OPP_FIELDS : []),
    sampleGet: async () => sampleResult,
    mappingsSuggest: async () => ({
      idsMatch: true,
      recommendation: 'directId',
      recommendationByObject: {},
      checked: {}
    }),
    templateList: async (kind: string) => templateStore.filter((t) => t.kind === kind),
    templateSave: async (input: { kind: string; name: string; payload: unknown }) => {
      const existing = templateStore.find((t) => t.kind === input.kind && t.name === input.name)
      if (existing) {
        existing.payload = input.payload
        return existing
      }
      const row: Template = {
        id: templateStore.length + 1,
        kind: input.kind as Template['kind'],
        name: input.name,
        payload: input.payload,
        createdAt: 0,
        updatedAt: 0
      }
      templateStore.push(row)
      return row
    },
    templateRename: async (input: { id: number; name: string }) => {
      const t = templateStore.find((x) => x.id === input.id)
      if (t) t.name = input.name
    },
    templateDelete: async (id: number) => {
      const i = templateStore.findIndex((x) => x.id === id)
      if (i >= 0) templateStore.splice(i, 1)
    }
  }
}

function renderMappings(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/1/wizard/mappings']}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

async function expandOpportunity(): Promise<void> {
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Mappings' })
  await user.click(screen.getByRole('button', { name: /Opportunity/ }))
}

beforeEach(install)
afterEach(cleanup)

describe('StepMappings (5B.5)', () => {
  it('lists reference fields on expand, hides RecordTypeId, and skips non-reference fields', async () => {
    renderMappings()
    await expandOpportunity()
    await waitFor(() => expect(screen.getByText('AccountId')).toBeInTheDocument())
    expect(screen.getByText('OwnerId')).toBeInTheDocument()
    expect(screen.getByText('ParentOpp__c')).toBeInTheDocument()
    expect(screen.getByText('CaseLink__c')).toBeInTheDocument()
    // RecordTypeId is force-resolved by the engine — never shown.
    expect(screen.queryByText('RecordTypeId')).not.toBeInTheDocument()
    // Non-reference fields never appear in the mapping table.
    expect(screen.queryByText('Amount')).not.toBeInTheDocument()
  })

  it('locks self-ref and out-of-scope refs to Skip with no editable strategy', async () => {
    renderMappings()
    await expandOpportunity()
    await waitFor(() => expect(screen.getByText('AccountId')).toBeInTheDocument())
    // ParentOpp__c (self) + CaseLink__c (out of scope) are both locked.
    expect(screen.getAllByText(/Skip 🔒/)).toHaveLength(2)
    // Only the two resolvable refs (AccountId, OwnerId) get a strategy dropdown.
    const strategySelects = screen
      .getAllByRole('combobox')
      .filter((el) => el.getAttribute('aria-label')?.startsWith('Strategy for'))
    expect(strategySelects).toHaveLength(2)
    expect(screen.queryByLabelText('Strategy for CaseLink__c')).not.toBeInTheDocument()
  })

  it('applies single-source defaults: in-scope parent → externalId, User → directId', async () => {
    renderMappings()
    await expandOpportunity()
    const acct = (await screen.findByLabelText('Strategy for AccountId')) as HTMLSelectElement
    const owner = screen.getByLabelText('Strategy for OwnerId') as HTMLSelectElement
    expect(acct.value).toBe('externalId')
    expect(owner.value).toBe('directId')
  })

  it('persists a strategy override into config.mappings (sparse) via draftSave', async () => {
    const user = userEvent.setup()
    renderMappings()
    await expandOpportunity()
    const acct = await screen.findByLabelText('Strategy for AccountId')
    await user.selectOptions(acct, 'nameMatch')
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const last = saved[saved.length - 1]!
    const mappings = last.config.mappings as Record<
      string,
      Record<string, { strategy: string; matchField?: string }>
    >
    expect(mappings.Opportunity!.AccountId).toEqual({ strategy: 'nameMatch', matchField: 'Name' })
    // Only the touched field is stored — everything else stays default (sparse).
    expect(Object.keys(mappings.Opportunity!)).toEqual(['AccountId'])
  })

  it('resolves the target connected user for Set to Me (User refs only)', async () => {
    const user = userEvent.setup()
    renderMappings()
    await expandOpportunity()
    const owner = await screen.findByLabelText('Strategy for OwnerId')
    await user.selectOptions(owner, 'setToMe')
    expect(await screen.findByText(/= me@target\.example/)).toBeInTheDocument()
  })

  it('surfaces a typed sample-query error instead of a silent blank', async () => {
    sampleResult = { ok: false, error: 'INVALID_FIELD: no such column' }
    renderMappings()
    await expandOpportunity()
    expect(await screen.findByText(/Sample values unavailable: INVALID_FIELD/)).toBeInTheDocument()
  })

  it('hides source-only reference fields (source∩target intersection)', async () => {
    const SOURCE_ONLY: FieldInfo[] = [...OPP_FIELDS, field('SecondOwner__c', 'User')]
    ;(
      window as unknown as {
        rds: { describeObject: (c: string, o: string) => Promise<FieldInfo[]> }
      }
    ).rds.describeObject = async (conn: string, obj: string) => {
      if (obj !== 'Opportunity') return []
      // Source has SecondOwner__c; the target does not — it must not be mappable.
      return conn === 'src' ? SOURCE_ONLY : OPP_FIELDS
    }
    renderMappings()
    await expandOpportunity()
    await waitFor(() => expect(screen.getByText('AccountId')).toBeInTheDocument())
    expect(screen.queryByText('SecondOwner__c')).not.toBeInTheDocument()
  })

  it('preserves an edited match field across a strategy toggle away and back', async () => {
    const user = userEvent.setup()
    renderMappings()
    await expandOpportunity()
    const acct = await screen.findByLabelText('Strategy for AccountId')
    await user.selectOptions(acct, 'nameMatch')
    const key = (await screen.findByLabelText('Match field for AccountId')) as HTMLInputElement
    await user.clear(key)
    await user.type(key, 'My_Key__c')
    await user.selectOptions(acct, 'skip')
    await user.selectOptions(acct, 'nameMatch')
    const key2 = (await screen.findByLabelText('Match field for AccountId')) as HTMLInputElement
    expect(key2.value).toBe('My_Key__c')
  })

  it('caps a custom Id value at 18 characters (Id-overflow guard)', async () => {
    const user = userEvent.setup()
    renderMappings()
    await expandOpportunity()
    const acct = await screen.findByLabelText('Strategy for AccountId')
    await user.selectOptions(acct, 'customId')
    const val = (await screen.findByLabelText('Custom value for AccountId')) as HTMLInputElement
    expect(val.maxLength).toBe(18)
    // A programmatic change bypasses maxLength — the slice guard must still clamp.
    fireEvent.change(val, { target: { value: '001234567890123456789EXTRA' } })
    await waitFor(() => {
      const last = saved[saved.length - 1]!
      const m = (last.config.mappings as Record<string, Record<string, { customValue?: string }>>)
        .Opportunity?.AccountId
      expect(m?.customValue?.length).toBe(18)
    })
  })

  it('applies Id-overlap suggestions to directId-default refs, leaving other refs alone', async () => {
    // Divergent orgs → User (directId-default) should flip to nameMatch; AccountId
    // (an in-scope custom ref, not directId-default) must be untouched.
    ;(
      window as unknown as {
        rds: { mappingsSuggest: () => Promise<unknown> }
      }
    ).rds.mappingsSuggest = async () => ({
      idsMatch: false,
      recommendation: 'nameMatch',
      recommendationByObject: {},
      checked: {}
    })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.click(screen.getByRole('button', { name: /Suggest mappings/ }))
    await screen.findByText(/Applied suggestions/)
    await user.click(screen.getByRole('button', { name: /Opportunity/ }))
    const owner = (await screen.findByLabelText('Strategy for OwnerId')) as HTMLSelectElement
    await waitFor(() => expect(owner.value).toBe('nameMatch'))
    expect((screen.getByLabelText('Strategy for AccountId') as HTMLSelectElement).value).toBe(
      'externalId'
    )
  })

  it('reports BOTH counts when a catalog ref diverges under a directId org-wide verdict', async () => {
    // idsMatch=true (stable Ids shared) but User flipped to nameMatch per-object →
    // the note must not claim "share record Ids — N Direct ID" and hide the flip.
    ;(
      window as unknown as { rds: { mappingsSuggest: () => Promise<unknown> } }
    ).rds.mappingsSuggest = async () => ({
      idsMatch: true,
      recommendation: 'directId',
      recommendationByObject: { User: 'nameMatch' },
      checked: {}
    })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.click(screen.getByRole('button', { name: /Suggest mappings/ }))
    // OwnerId (User) flipped to Name Match; the note reports it despite idsMatch=true.
    expect(await screen.findByText(/1 to Name Match/)).toBeInTheDocument()
    expect(screen.queryByText(/share record Ids/)).not.toBeInTheDocument()
  })

  it('does not write overrides for source-only refs when applying suggestions', async () => {
    const SOURCE_ONLY: FieldInfo[] = [...OPP_FIELDS, field('SecondOwner__c', 'User')]
    ;(
      window as unknown as {
        rds: {
          describeObject: (c: string, o: string) => Promise<FieldInfo[]>
          mappingsSuggest: () => Promise<unknown>
        }
      }
    ).rds.describeObject = async (conn: string, obj: string) => {
      if (obj !== 'Opportunity') return []
      return conn === 'src' ? SOURCE_ONLY : OPP_FIELDS // target lacks SecondOwner__c
    }
    ;(
      window as unknown as { rds: { mappingsSuggest: () => Promise<unknown> } }
    ).rds.mappingsSuggest = async () => ({
      idsMatch: false,
      recommendation: 'nameMatch',
      recommendationByObject: {},
      checked: {}
    })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.click(screen.getByRole('button', { name: /Suggest mappings/ }))
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const mappings = saved[saved.length - 1]!.config.mappings as Record<
      string,
      Record<string, unknown>
    >
    // OwnerId (source∩target) got a suggestion; source-only SecondOwner__c did NOT.
    expect(mappings.Opportunity).toHaveProperty('OwnerId')
    expect(mappings.Opportunity).not.toHaveProperty('SecondOwner__c')
  })

  it('freezes the strategy selects while a Suggest probe is applying (no lost-update race)', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    ;(
      window as unknown as { rds: { mappingsSuggest: () => Promise<unknown> } }
    ).rds.mappingsSuggest = async () => {
      await gate
      return { idsMatch: true, recommendation: 'directId', recommendationByObject: {}, checked: {} }
    }
    const user = userEvent.setup()
    renderMappings()
    await expandOpportunity()
    const acct = (await screen.findByLabelText('Strategy for AccountId')) as HTMLSelectElement
    expect(acct.disabled).toBe(false)
    await user.click(screen.getByRole('button', { name: /Suggest mappings/ }))
    // While probing, the per-field select is frozen so a concurrent edit can't be clobbered.
    await waitFor(() => expect(acct.disabled).toBe(true))
    release()
    await waitFor(() => expect(acct.disabled).toBe(false))
  })

  it('resets all overrides to policy defaults', async () => {
    const user = userEvent.setup()
    renderMappings()
    await expandOpportunity()
    const acct = await screen.findByLabelText('Strategy for AccountId')
    await user.selectOptions(acct, 'nameMatch') // create an override
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    await user.click(screen.getByRole('button', { name: /Reset to defaults/ }))
    await waitFor(() => expect(saved[saved.length - 1]!.config.mappings).toEqual({}))
    // The select returns to its computed default.
    await waitFor(() =>
      expect((screen.getByLabelText('Strategy for AccountId') as HTMLSelectElement).value).toBe(
        'externalId'
      )
    )
  })

  it('saves the current mappings as a named template', async () => {
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.type(screen.getByLabelText('Template name'), 'My Preset')
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    await screen.findByText(/Saved template "My Preset"/)
    expect(screen.getByRole('option', { name: 'My Preset' })).toBeInTheDocument()
  })

  it('applies a template, dropping entries whose ref is out of scope (with a corrected count)', async () => {
    templateStore.push({
      id: 1,
      kind: 'mappings',
      name: 'Preset',
      payload: {
        Opportunity: {
          OwnerId: { strategy: 'nameMatch', matchField: 'Username' }, // User → deployable, unlocked
          CaseLink__c: { strategy: 'nameMatch' } // Case → out of scope → dropped
        }
      },
      createdAt: 0,
      updatedAt: 0
    })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.selectOptions(screen.getByLabelText('Saved mapping template'), '1')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/1 mapping skipped/)
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const m = saved[saved.length - 1]!.config.mappings as Record<
      string,
      Record<string, { strategy: string }>
    >
    expect(m.Opportunity!.OwnerId!.strategy).toBe('nameMatch')
    expect(m.Opportunity!.CaseLink__c).toBeUndefined()
  })

  it('reports (and does not silently drop) an object it cannot describe during apply', async () => {
    templateStore.push({
      id: 2,
      kind: 'mappings',
      name: 'Cross',
      payload: {
        Opportunity: { OwnerId: { strategy: 'nameMatch', matchField: 'Username' } },
        Account: { OwnerId: { strategy: 'nameMatch' } }
      },
      createdAt: 0,
      updatedAt: 0
    })
    ;(
      window as unknown as {
        rds: { describeObject: (c: string, o: string) => Promise<FieldInfo[]> }
      }
    ).rds.describeObject = async (_c: string, obj: string) => {
      if (obj === 'Account') throw new Error('describe failed')
      return obj === 'Opportunity' ? OPP_FIELDS : []
    }
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.selectOptions(screen.getByLabelText('Saved mapping template'), '2')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    // The failed object is named in the note — not silently dropped as "success".
    expect(await screen.findByText(/retry: Account/)).toBeInTheDocument()
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const m = saved[saved.length - 1]!.config.mappings as Record<
      string,
      Record<string, { strategy: string }>
    >
    expect(m.Opportunity!.OwnerId!.strategy).toBe('nameMatch') // describable object applied
    expect(m.Account).toBeUndefined() // failed object not applied
  })

  it('deletes the selected template', async () => {
    templateStore.push({
      id: 5,
      kind: 'mappings',
      name: 'Junk',
      payload: {},
      createdAt: 0,
      updatedAt: 0
    })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.selectOptions(screen.getByLabelText('Saved mapping template'), '5')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText(/Deleted "Junk"/)
    expect(screen.queryByRole('option', { name: 'Junk' })).not.toBeInTheDocument()
  })

  it('shows an empty-scope hint when no objects are selected', async () => {
    ;(window as unknown as { rds: { draftLoad: () => Promise<DraftDetail> } }).rds.draftLoad =
      async (): Promise<DraftDetail> => ({
        name: 'Empty',
        sourceConnectionId: 'src',
        targetConnectionId: 'tgt',
        sourceLabel: 'src',
        targetLabel: 'tgt',
        step: 'mappings',
        config: { ...emptyWizardConfig(), selectedObjects: [] },
        status: 'Planned'
      })
    renderMappings()
    expect(await screen.findByText(/No objects in scope yet/)).toBeInTheDocument()
  })
})

/**
 * UI-6 — the note carries its outcome, and the in-flight state lives in a
 * spinner rather than a label swap.
 *
 * `.footprint` previously had NO CSS rules at all, so a genuinely useful
 * summary ("54 to Direct ID, 11 to Name Match") rendered as unnoticed body
 * text; and successes/failures shared one un-toned string, so any check mark
 * would have decorated "Suggest failed: …" too.
 */
describe('StepMappings — UI-6 outcome note + in-flight spinner', () => {
  beforeEach(install)
  afterEach(cleanup)

  const noteEl = async (): Promise<HTMLElement> =>
    await waitFor(() => {
      const el = document.querySelector('.outcome')
      if (!el) throw new Error('note not rendered yet')
      return el as HTMLElement
    })

  it('a SUCCESSFUL action gets a check mark and the ok tone — and is NOT announced as an alert', async () => {
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.click(screen.getByRole('button', { name: /Suggest mappings/ }))
    const p = await noteEl()
    expect(p).toHaveClass('outcome-ok')
    expect(p.textContent).toContain('✓')
    expect(p.textContent).toContain('Orgs share record Ids')
    // role=alert is for failures only; interrupting a screen reader to say
    // "that worked" is noise.
    expect(p).not.toHaveAttribute('role')
  })

  it('a FAILED action gets the error tone, a warning glyph, and role=alert', async () => {
    ;(
      window as unknown as { rds: { mappingsSuggest: () => Promise<unknown> } }
    ).rds.mappingsSuggest = async () => {
      throw new Error('probe exploded')
    }
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.click(screen.getByRole('button', { name: /Suggest mappings/ }))
    const p = await noteEl()
    expect(p).toHaveClass('outcome-error')
    expect(p.textContent).toContain('⚠')
    expect(p.textContent).toContain('Suggest failed')
    expect(p).toHaveAttribute('role', 'alert')
    // The tick must never reach a failure — the whole reason the note is toned.
    expect(p.textContent).not.toContain('✓')
  })

  it('spins INSIDE the Suggest button while in flight, and keeps the label stable', async () => {
    let release: (() => void) | undefined
    ;(
      window as unknown as { rds: { mappingsSuggest: () => Promise<unknown> } }
    ).rds.mappingsSuggest = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            idsMatch: true,
            recommendation: 'directId',
            recommendationByObject: {},
            checked: {}
          })
      })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    const btn = screen.getByRole('button', { name: /Suggest mappings/ })
    expect(btn.querySelector('.spinner')).toBeNull()
    await user.click(btn)
    await waitFor(() => expect(btn.querySelector('.spinner')).not.toBeNull())
    // The label does NOT swap to "Working…": changing the text also changed the
    // button's width and made the row jump.
    expect(btn.textContent).toContain('Suggest mappings')
    expect(btn.textContent).not.toContain('Working')
    release!()
    await waitFor(() => expect(btn.querySelector('.spinner')).toBeNull())
  })

  it('does NOT spin the Suggest button during a TEMPLATE action (the spinner names the right work)', async () => {
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    const btn = screen.getByRole('button', { name: /Suggest mappings/ })
    await user.type(screen.getByLabelText('Template name'), 'Preset A')
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    await screen.findByText(/Saved template "Preset A"/)
    // The save shares the `busy` freeze (UI-3) but is not a Suggest, so the
    // Suggest button must never have claimed the work.
    expect(btn.querySelector('.spinner')).toBeNull()
  })
})


// ── S57 (B1): a parent outside the scope that the TARGET can key ──────────────
// Run 24 (sb1-915-git): CampaignMember.CampaignId locked to Skip although the
// Campaign was already on the target with its RDS key → 228/228 failures. Here
// the analogue is Opportunity.CaseLink__c → Case, with Case out of scope.
describe('StepMappings — S57 B1 target-keyed out-of-scope refs', () => {
  it('asks the target only about out-of-scope, non-stable parents (Case — not User/Account/self)', async () => {
    renderMappings()
    await expandOpportunity()
    await waitFor(() => expect(targetKeyedCalls.length).toBeGreaterThan(0))
    expect(targetKeyedCalls[0]).toEqual(['Case'])
  })

  it('keyed Case rows on the target ⇒ CaseLink__c unlocks, defaults to External ID, offers only External ID / Skip', async () => {
    targetKeyed = { hasField: ['Case'], keyedRows: ['Case'] }
    renderMappings()
    await expandOpportunity()
    const sel = (await screen.findByLabelText('Strategy for CaseLink__c')) as HTMLSelectElement
    expect(sel.value).toBe('externalId')
    expect(within(sel).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual([
      'externalId',
      'skip'
    ])
    // Only the self-ref stays locked now.
    expect(screen.getAllByText(/Skip 🔒/)).toHaveLength(1)
    expect(screen.getByTestId('target-key-CaseLink__c')).toHaveTextContent(
      /resolves against RDS-keyed Case rows already on the target/
    )
  })

  it('field on the target but no keyed rows ⇒ unlocked, default Skip, badge says why', async () => {
    targetKeyed = { hasField: ['Case'], keyedRows: [] }
    renderMappings()
    await expandOpportunity()
    const sel = (await screen.findByLabelText('Strategy for CaseLink__c')) as HTMLSelectElement
    expect(sel.value).toBe('skip')
    expect(screen.getByTestId('target-key-CaseLink__c')).toHaveTextContent(/no keyed Case rows yet/)
  })

  it('applying a template keeps an out-of-scope External ID entry the target can key', async () => {
    targetKeyed = { hasField: ['Case'], keyedRows: ['Case'] }
    templateStore.push({
      id: 1,
      kind: 'mappings',
      name: 'Preset',
      payload: { Opportunity: { CaseLink__c: { strategy: 'externalId' } } },
      createdAt: 0,
      updatedAt: 0
    })
    const user = userEvent.setup()
    renderMappings()
    await screen.findByRole('heading', { name: 'Mappings' })
    await user.selectOptions(screen.getByLabelText('Saved mapping template'), '1')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/Applied template "Preset"\./)
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const m = saved[saved.length - 1]!.config.mappings as Record<
      string,
      Record<string, { strategy: string }>
    >
    expect(m.Opportunity!.CaseLink__c!.strategy).toBe('externalId')
  })
})
