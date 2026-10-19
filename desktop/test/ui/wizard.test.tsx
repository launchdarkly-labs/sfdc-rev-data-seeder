// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig } from '../../src/shared/wizard'
import type {
  DraftDetail,
  ObjectIntersectionResult,
  OrgConnection,
  Template
} from '../../src/shared/types'
import type { TemplateSummary } from '../../src/shared/templates/types'

interface Stub {
  draft: DraftDetail | null
  intersection: ObjectIntersectionResult
  /** S52 F2: connection rows the Orgs step reads roles from (default: none). */
  orgs?: OrgConnection[]
  /** S62: runnable template summaries for the Templates step (default: none). */
  runnable?: TemplateSummary[]
}

let assignRolesCalls = 0

const saved: { step: string; config: unknown }[] = []
let templateStore: Template[] = []
let nextTemplateId = 1

function installStub(s: Stub): void {
  saved.length = 0
  templateStore = []
  nextTemplateId = 1
  assignRolesCalls = 0
  const orgs = s.orgs ?? []
  ;(window as unknown as { rds: unknown }).rds = {
    draftLoad: async () => s.draft,
    // S57 (B2/B3): the Scope step describes both orgs and asks the target about
    // out-of-scope parents; empty answers keep these tests about their own subject.
    describeObject: async () => [],
    targetKeyedObjects: async () => ({ hasField: [], keyedRows: [] }),
    filterValidate: async () => ({ ok: true, count: 1, soql: '', strippedClause: null, hint: null }),
    listOrgs: async () => orgs,
    // Mirrors the store: assign only the unassigned side(s), report what was written.
    deploymentAssignRoles: async () => {
      assignRolesCalls += 1
      const src = orgs.find((o) => o.id === s.draft?.sourceConnectionId)
      const tgt = orgs.find((o) => o.id === s.draft?.targetConnectionId)
      const assigned = { source: src?.role === 'unassigned', target: tgt?.role === 'unassigned' }
      if (src && assigned.source) src.role = 'source'
      if (tgt && assigned.target) tgt.role = 'target'
      return assigned
    },
    draftSave: async (input: { step: string; config: unknown }) => {
      saved.push(input)
    },
    objectsIntersection: async () => s.intersection,
    // UI-5 templates. Mirrors main's upsert-on-(kind,name) semantics so a
    // second Save with the same name overwrites instead of duplicating.
    templateList: async (kind: string) => templateStore.filter((t) => t.kind === kind),
    templateSave: async (input: { kind: string; name: string; payload: unknown }) => {
      const existing = templateStore.find((t) => t.kind === input.kind && t.name === input.name)
      if (existing) {
        existing.payload = input.payload
        return existing
      }
      const t = {
        id: nextTemplateId++,
        kind: input.kind,
        name: input.name,
        payload: input.payload
      } as Template
      templateStore.push(t)
      return t
    },
    templateRename: async (input: { id: number; name: string }) => {
      const t = templateStore.find((x) => x.id === input.id)!
      t.name = input.name
      return t
    },
    templateDelete: async (id: number) => {
      templateStore = templateStore.filter((t) => t.id !== id)
    },
    onJobEvent: () => () => undefined,
    jobList: async () => [],
    // S62 (U-2): the Templates step lists runnable templates and reads post-refresh payloads.
    templateListAll: async () => s.runnable ?? [],
    templateGet: async (id: number) => {
      const t = (s.runnable ?? []).find((x) => x.id === id)
      if (!t) throw new Error(`no template ${id}`)
      return { ...t, payload: t.kind === 'postRefresh' ? { seedTemplates: [{ name: 'LD CPQ configuration', groups: ['cpq'] }] } : { tiers: [] } }
    }
  }
}

function deployable(apiName: string): ObjectIntersectionResult['objects'][number] {
  return { apiName, label: apiName, custom: false, namespace: null, inSource: true, inTarget: true }
}

function renderWizard(step: string): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/deployments/1/wizard/${step}`]}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

describe('WizardShell — S46 D1 busy lock', () => {
  it.each(['Deploying', 'Retrying', 'Disabling Automation', 'Restoring Automation'])(
    'a %s deployment renders the read-only notice with a monitor link instead of the steps',
    async (status) => {
      installStub({
        draft: draft({ status, step: 'plan' }),
        intersection: { objects: [], common: 0, sourceOnly: 0, targetOnly: 0 }
      })
      renderWizard('plan')
      expect(await screen.findByRole('heading', { name: 'Acme' })).toBeInTheDocument()
      expect(screen.getByText(/wizard is read-only until the run finishes/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open the deployment monitor' })).toHaveAttribute(
        'href',
        '/deployments/1'
      )
      expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull()
      expect(saved).toEqual([]) // nothing persisted while locked
    }
  )
})

function draft(overrides: Partial<DraftDetail> = {}): DraftDetail {
  return {
    name: 'Acme',
    sourceConnectionId: 'srcbox',
    targetConnectionId: 'sb1',
    sourceLabel: 'srcbox',
    targetLabel: 'sb1',
    step: 'orgs',
    config: emptyWizardConfig(),
    status: 'Draft',
    ...overrides
  }
}

afterEach(cleanup)

describe('WizardShell', () => {
  beforeEach(() =>
    installStub({
      draft: draft(),
      intersection: { objects: [], common: 9, sourceOnly: 3, targetOnly: 1 }
    })
  )

  it('renders the draft header + full step nav for a Draft', async () => {
    renderWizard('orgs')
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeInTheDocument()
    expect(screen.getByText(/srcbox → sb1 · Draft/)).toBeInTheDocument()
    // All 7 steps reachable for a Draft.
    for (const label of ['Orgs', 'Objects', 'Scope', 'Readiness', 'Mappings', 'Fields', 'Stages', 'Summary', 'Plan']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('shows the intersection banner on Step 1', async () => {
    renderWizard('orgs')
    expect(await screen.findByText('9 deployable')).toBeInTheDocument()
    expect(screen.getByText('3 source-only (excluded)')).toBeInTheDocument()
    expect(screen.getByText('1 target-only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next: Objects/ })).toBeEnabled()
  })

  it('shows a not-found message for a missing draft', async () => {
    installStub({
      draft: null,
      intersection: { objects: [], common: 0, sourceOnly: 0, targetOnly: 0 }
    })
    renderWizard('orgs')
    expect(await screen.findByRole('heading', { name: 'Deployment not found' })).toBeInTheDocument()
  })
})

describe('WizardShell — S54 L1 readiness gate', () => {
  it('a draft whose scope was never readiness-checked cannot open Plan: it lands on Readiness', async () => {
    installStub({
      draft: draft({
        status: 'Planned',
        step: 'plan',
        config: { ...emptyWizardConfig(), selectedObjects: ['Account'] } // no readiness record
      }),
      intersection: { objects: [], common: 5, sourceOnly: 0, targetOnly: 0 }
    })
    ;(window as unknown as { rds: Record<string, unknown> }).rds.readinessCheck = async () => ({
      objects: [
        {
          objectName: 'Account',
          isJunction: false,
          hasExtIdField: false,
          extIdIsExternalId: false,
          needsExtIdField: true
        }
      ],
      objectCount: 1,
      junctionCount: 0,
      missingExtIdCount: 1,
      ready: false
    })
    renderWizard('plan')
    await screen.findByRole('heading', { name: 'Acme' })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Readiness' })).toBeInTheDocument()
    )
    expect(screen.queryByRole('heading', { name: 'Plan' })).not.toBeInTheDocument()
    // Nav past Readiness is visibly closed; nav up to it is not.
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Readiness' })).not.toHaveAttribute('aria-disabled')
  })

  it('a green readiness for a DIFFERENT scope is stale: adding an object re-arms the gate', async () => {
    installStub({
      draft: draft({
        status: 'Planned',
        step: 'summary',
        config: {
          ...emptyWizardConfig(),
          selectedObjects: ['Account', 'Contact'],
          readiness: {
            scopeKey: 'Account',
            ready: true,
            blockingObjects: [],
            checkedAt: '2026-09-13T00:00:00.000Z'
          }
        }
      }),
      intersection: { objects: [], common: 5, sourceOnly: 0, targetOnly: 0 }
    })
    // The re-check for the NEW scope finds Contact unkeyed → the gate stays closed.
    ;(window as unknown as { rds: Record<string, unknown> }).rds.readinessCheck = async () => ({
      objects: [
        {
          objectName: 'Account',
          isJunction: false,
          hasExtIdField: true,
          extIdIsExternalId: true,
          needsExtIdField: false
        },
        {
          objectName: 'Contact',
          isJunction: false,
          hasExtIdField: false,
          extIdIsExternalId: false,
          needsExtIdField: true
        }
      ],
      objectCount: 2,
      junctionCount: 0,
      missingExtIdCount: 1,
      ready: false
    })
    renderWizard('summary')
    await screen.findByRole('heading', { name: 'Acme' })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Readiness' })).toBeInTheDocument()
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Contact')
    expect(screen.queryByRole('heading', { name: 'Analyze & summary' })).not.toBeInTheDocument()
  })
})

describe('WizardShell — Stalled cap', () => {
  beforeEach(() =>
    installStub({
      draft: draft({ status: 'Stalled', step: 'fields' }),
      intersection: { objects: [], common: 5, sourceOnly: 0, targetOnly: 0 }
    })
  )

  it('caps the step nav at Fields (no Summary/Plan)', async () => {
    renderWizard('fields')
    await screen.findByRole('heading', { name: 'Acme' })
    expect(screen.getByRole('button', { name: 'Fields' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Summary' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Plan' })).not.toBeInTheDocument()
  })

  it('clamps an over-cap step request back to Fields', async () => {
    renderWizard('plan') // requested beyond the Stalled cap
    // Clamps to 'fields', which now renders the real Fields step (5B.6) — not Plan.
    await screen.findByRole('heading', { name: 'Acme' })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fields' })).toBeInTheDocument())
  })
})

function org(id: string, role: OrgConnection['role'], prodPinned = false): OrgConnection {
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

describe('StepOrgs gate', () => {
  it('disables Next when there are no common objects', async () => {
    installStub({
      draft: draft(),
      intersection: { objects: [], common: 0, sourceOnly: 4, targetOnly: 2 }
    })
    renderWizard('orgs')
    await screen.findByText('0 deployable')
    expect(screen.getByRole('button', { name: /Next: Objects/ })).toBeDisabled()
    expect(screen.getByText(/share no deployable objects/)).toBeInTheDocument()
  })

  // S52 F2 — deployments 21/22 were created before F1 with an unassigned target
  // and would have been refused at deploy start, seven steps later.
  it('shows the pair roles and fixes an unassigned target in one click', async () => {
    const user = userEvent.setup()
    installStub({
      draft: draft(),
      intersection: { objects: [], common: 9, sourceOnly: 0, targetOnly: 0 },
      orgs: [org('srcbox', 'source'), org('sb1', 'unassigned')]
    })
    renderWizard('orgs')
    await screen.findByText('9 deployable')
    expect(screen.getByText(/Roles need attention/)).toBeInTheDocument()
    expect(screen.getByText(/sb1 has no role yet — it will be set to Target/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Assign roles' }))
    await waitFor(() => expect(screen.getByText('sb1 set as Target')).toBeInTheDocument())
    expect(assignRolesCalls).toBe(1)
    // The banner clears once the refetched rows are right.
    await waitFor(() => expect(screen.queryByText(/Roles need attention/)).toBeNull())
    expect(screen.getAllByText('target').length).toBeGreaterThan(0)
  })

  it('is silent when both roles are already right', async () => {
    installStub({
      draft: draft(),
      intersection: { objects: [], common: 9, sourceOnly: 0, targetOnly: 0 },
      orgs: [org('srcbox', 'source'), org('sb1', 'target')]
    })
    renderWizard('orgs')
    await screen.findByText('9 deployable')
    expect(screen.queryByText(/Roles need attention/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assign roles' })).toBeNull()
  })

  it('a demoted pair is NOT auto-fixed — it points at the Connections page', async () => {
    installStub({
      draft: draft(),
      intersection: { objects: [], common: 9, sourceOnly: 0, targetOnly: 0 },
      orgs: [org('srcbox', 'source'), org('sb1', 'source')]
    })
    renderWizard('orgs')
    await screen.findByText('9 deployable')
    expect(screen.getByText(/sb1 is a source org.*Connections page/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign roles' })).toBeNull()
  })
})

// S49 (UI-2a): object selection moved from 'scope' to its own 'objects' step.
describe('StepObjects (Step 2)', () => {
  beforeEach(() =>
    installStub({
      draft: draft({ step: 'objects' }),
      intersection: {
        objects: [deployable('Account'), deployable('Contact')],
        common: 2,
        sourceOnly: 0,
        targetOnly: 0
      }
    })
  )

  it('persists object selection to the draft and gates Next on ≥1 selected', async () => {
    const user = userEvent.setup()
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    // Nothing selected → Next disabled.
    expect(screen.getByRole('button', { name: /Next: Scope/ })).toBeDisabled()

    await user.click(screen.getByText('Account'))
    await waitFor(() =>
      expect(
        saved.some(
          (s) =>
            s.step === 'objects' &&
            (s.config as { selectedObjects: string[] }).selectedObjects.includes('Account')
        )
      ).toBe(true)
    )
    // waitFor, not a bare expect: the label re-renders on a later tick than the
    // draftSave the previous waitFor observed, so a synchronous assertion here
    // races the render and fails intermittently.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Next: Scope \(1 selected\)/ })).toBeEnabled()
    )
  })

  /**
   * UI-5 — object templates. The `'objects'` TemplateKind shipped in S49 and was
   * wired to nothing, so the same object set was rebuilt by hand every time.
   */
  it('saves the current selection as a template, reporting the object count', async () => {
    const user = userEvent.setup()
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    // Save is refused with an empty selection: a template that deselects
    // everything on apply is a footgun, not a preset.
    await user.type(screen.getByLabelText('Objects preset name'), 'DM Core')
    expect(screen.getByRole('button', { name: 'Save as' })).toBeDisabled()

    await user.click(screen.getByText('Account'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Save as' }))

    expect(await screen.findByText(/Saved template "DM Core" — 1 object\./)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'DM Core' })).toBeInTheDocument()
  })

  it('applying a template REPLACES the selection and persists it', async () => {
    const user = userEvent.setup()
    templateStore.push({
      id: 90,
      kind: 'objects',
      name: 'Contact only',
      payload: { objects: ['Contact'] }
    } as Template)
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    await user.click(screen.getByText('Account'))
    await waitFor(() => expect(screen.getByRole('button', { name: /1 selected/ })).toBeEnabled())

    await user.selectOptions(screen.getByLabelText('Saved objects preset'), '90')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    // REPLACE, not merge — otherwise a template could only ever grow the
    // selection and could never be used to deploy less.
    expect(
      await screen.findByText(/Applied "Contact only" — 1 object selected\./)
    ).toBeInTheDocument()
    await waitFor(() => {
      const last = saved.filter((x) => x.step === 'objects').at(-1)!
      expect((last.config as { selectedObjects: string[] }).selectedObjects).toEqual(['Contact'])
    })
  })

  it('S59 F2 / FB-11: applying a template that carries CampaignMemberStatus drops it, says why, and offers to save the template clean', async () => {
    const user = userEvent.setup()
    installStub({
      draft: draft({ step: 'objects' }),
      intersection: {
        objects: [deployable('Campaign'), deployable('CampaignMemberStatus'), deployable('CampaignMember')],
        common: 3,
        sourceOnly: 0,
        targetOnly: 0
      }
    })
    templateStore.push({
      id: 92,
      kind: 'objects',
      name: 'Core plus members',
      payload: { objects: ['Campaign', 'CampaignMemberStatus', 'CampaignMember'] }
    } as Template)
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })
    await user.selectOptions(screen.getByLabelText('Saved objects preset'), '92')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const note = await screen.findByText(/can never carry the External Id field and was dropped/)
    expect(note.textContent).toContain('CampaignMemberStatus')
    await waitFor(() => {
      const last = saved.filter((x) => x.step === 'objects').at(-1)!
      expect((last.config as { selectedObjects: string[] }).selectedObjects).toEqual(['Campaign', 'CampaignMember'])
    })
    // One click writes the template back without the unkeyable object.
    const cleanup = screen.getByTestId('template-cleanup')
    expect(cleanup).toHaveTextContent(/allows no custom fields on/)
    await user.click(within(cleanup).getByRole('button', { name: 'Save the template without it' }))
    expect(await screen.findByText(/Updated template "Core plus members" without CampaignMemberStatus — 2 objects\./)).toBeInTheDocument()
    expect(templateStore.find((t) => t.id === 92)!.payload).toEqual({ objects: ['Campaign', 'CampaignMember'] })
    expect(screen.queryByTestId('template-cleanup')).not.toBeInTheDocument()
  })

  it('applying a STALE template drops objects not deployable in both orgs and NAMES them', async () => {
    const user = userEvent.setup()
    templateStore.push({
      id: 91,
      kind: 'objects',
      name: 'Stale',
      // SBQQ__Quote__c is not in this org pair's intersection.
      payload: { objects: ['Account', 'SBQQ__Quote__c'] }
    } as Template)
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    await user.selectOptions(screen.getByLabelText('Saved objects preset'), '91')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    const note = await screen.findByText(/not deployable in both orgs and dropped/)
    expect(note.textContent).toContain('SBQQ__Quote__c')
    // The survivor is still applied — a stale entry must not fail the whole apply.
    await waitFor(() => {
      const last = saved.filter((x) => x.step === 'objects').at(-1)!
      expect((last.config as { selectedObjects: string[] }).selectedObjects).toEqual(['Account'])
    })
  })

  it("applying a NARROWER template drops the removed objects' filters (orphan-filter rule)", async () => {
    const user = userEvent.setup()
    templateStore.push({
      id: 92,
      kind: 'objects',
      name: 'Account only',
      payload: { objects: ['Account'] }
    } as Template)
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    await user.click(screen.getByText('Account'))
    await user.click(screen.getByText('Contact'))
    await waitFor(() => expect(screen.getByRole('button', { name: /2 selected/ })).toBeEnabled())

    await user.selectOptions(screen.getByLabelText('Saved objects preset'), '92')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    // Apply routes through setSelected, so Contact's WHERE clause cannot
    // survive Contact leaving the selection and ride into the frozen plan.
    await waitFor(() => {
      const last = saved.filter((x) => x.step === 'objects').at(-1)!
      const cfg = last.config as { selectedObjects: string[]; filters: Record<string, string> }
      expect(cfg.selectedObjects).toEqual(['Account'])
      expect(cfg.filters).not.toHaveProperty('Contact')
    })
  })

  it('shows the selected object as a removable pill and removing it clears the selection', async () => {
    const user = userEvent.setup()
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    await user.click(screen.getByText('Account'))
    await screen.findByRole('region', { name: 'Selected objects' })
    await user.click(screen.getByRole('button', { name: 'Remove Account' }))

    await waitFor(() =>
      expect(
        saved.some(
          (s) =>
            s.step === 'objects' &&
            (s.config as { selectedObjects: string[] }).selectedObjects.length === 0
        )
      ).toBe(true)
    )
  })

  // UI-2e orphan-filter rule: selection and filters live on different steps
  // now, so nothing else would ever reconcile them.
  it('DROPS an object filter when that object is deselected', async () => {
    const user = userEvent.setup()
    installStub({
      draft: draft({
        step: 'objects',
        config: {
          ...emptyWizardConfig(),
          selectedObjects: ['Account'],
          filters: { Account: 'Name != null' }
        }
      }),
      intersection: {
        objects: [deployable('Account'), deployable('Contact')],
        common: 2,
        sourceOnly: 0,
        targetOnly: 0
      }
    })
    renderWizard('objects')
    await screen.findByRole('heading', { name: 'Choose objects' })

    await user.click(screen.getByRole('button', { name: 'Remove Account' }))
    await waitFor(() =>
      expect(
        saved.some(
          (s) =>
            s.step === 'objects' &&
            Object.keys((s.config as { filters: Record<string, string> }).filters).length === 0
        )
      ).toBe(true)
    )
  })
})

describe('StepScope (Step 3)', () => {
  it('sends you back to Objects when nothing is selected yet (old /scope bookmark)', async () => {
    installStub({
      draft: draft({ step: 'scope' }),
      intersection: {
        objects: [deployable('Account')],
        common: 1,
        sourceOnly: 0,
        targetOnly: 0
      }
    })
    renderWizard('scope')
    await screen.findByRole('heading', { name: 'Scope' })
    expect(screen.getByRole('button', { name: 'Choose objects' })).toBeInTheDocument()
  })

  it('renders scope mode + an "add a filter" control, not one row per object', async () => {
    installStub({
      draft: draft({
        step: 'scope',
        config: { ...emptyWizardConfig(), selectedObjects: ['Account', 'Contact'] }
      }),
      intersection: {
        objects: [deployable('Account'), deployable('Contact')],
        common: 2,
        sourceOnly: 0,
        targetOnly: 0
      }
    })
    renderWizard('scope')
    await screen.findByRole('heading', { name: 'Scope' })

    // No filter rows until one is added — this is the whole UI-2d change.
    expect(screen.queryByTestId('filter-Account')).not.toBeInTheDocument()
    expect(screen.queryByTestId('filter-Contact')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Add a filter for' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeDisabled()
  })

  it('adds a filter row for the chosen object only', async () => {
    const user = userEvent.setup()
    installStub({
      draft: draft({
        step: 'scope',
        config: { ...emptyWizardConfig(), selectedObjects: ['Account', 'Contact'] }
      }),
      intersection: {
        objects: [deployable('Account'), deployable('Contact')],
        common: 2,
        sourceOnly: 0,
        targetOnly: 0
      }
    })
    renderWizard('scope')
    await screen.findByRole('heading', { name: 'Scope' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter for' }), 'Contact')
    await user.click(screen.getByRole('button', { name: 'Add filter' }))

    await screen.findByTestId('filter-Contact')
    expect(screen.queryByTestId('filter-Account')).not.toBeInTheDocument()
  })
})

describe('WizardShell — S61 U-5 keyless drafts have no Readiness step', () => {
  it('the step nav omits Readiness and a stale /readiness link lands on Mappings', async () => {
    installStub({
      draft: draft({ config: { ...emptyWizardConfig(), selectedObjects: ['Account'], useExternalIds: false }, step: 'scope' }),
      intersection: { objects: [], common: 9, sourceOnly: 3, targetOnly: 1 }
    })
    renderWizard('readiness')
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Readiness' })).toBeNull()
    for (const label of ['Orgs', 'Objects', 'Scope', 'Mappings', 'Fields', 'Stages', 'Summary', 'Plan']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(await screen.findByRole('heading', { name: 'Mappings' })).toBeInTheDocument()
    // The readiness gate never closes a keyless draft: Plan is not marked gated.
    expect(screen.getByRole('button', { name: 'Plan' })).not.toHaveAttribute('aria-disabled')
  })
})


describe('WizardShell — S62 (U-2) Templates step', () => {
  const summaries: TemplateSummary[] = [
    { id: 3, kind: 'seed', name: 'LD CPQ configuration', description: null, builtFrom: null, detail: '39 objects in 2 groups', seedGroups: ['cpq', 'gf'], cpqGatedObjects: ['SBQQ__PriceRule__c'], createdAt: 1, updatedAt: 1, lastRun: null },
    { id: 4, kind: 'postRefresh', name: 'LD dev sandbox', description: null, builtFrom: null, detail: '22 flows, 6 triggers, 1 seed template', seedGroups: [], cpqGatedObjects: [], createdAt: 1, updatedAt: 1, lastRun: null },
    { id: 9, kind: 'objects', name: 'Core', description: null, builtFrom: null, detail: '', seedGroups: [], cpqGatedObjects: [], createdAt: 1, updatedAt: 1, lastRun: null }
  ]
  it('with no templates it says so and still lets the user continue', async () => {
    installStub({ draft: draft({ step: 'templates' }), intersection: { objects: [], common: 1, sourceOnly: 0, targetOnly: 0 } })
    renderWizard('templates')
    expect(await screen.findByRole('heading', { name: 'Templates to run with this deployment' })).toBeInTheDocument()
    expect(await screen.findByText(/No runnable templates yet/)).toBeInTheDocument()
    expect(screen.getByTestId('stage-sequence')).toHaveTextContent('1. Data deployment')
    expect(screen.getByRole('button', { name: 'Next: Summary' })).toBeEnabled()
  })
  it('placing a post-refresh template BEFORE the data persists its steps (automation + embedded seeds) and updates the run order', async () => {
    installStub({ draft: draft({ step: 'templates' }), intersection: { objects: [], common: 1, sourceOnly: 0, targetOnly: 0 }, runnable: summaries })
    renderWizard('templates')
    await screen.findByRole('heading', { name: 'Templates to run with this deployment' })
    // Only runnable kinds are listed — the 'objects' template is not a stage.
    expect(await screen.findByTestId('template-stage-4')).toBeInTheDocument()
    expect(screen.getByTestId('template-stage-3')).toBeInTheDocument()
    expect(screen.queryByTestId('template-stage-9')).toBeNull()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'When to run LD dev sandbox' }), 'before')
    await waitFor(() => expect(screen.getByTestId('stage-sequence')).toHaveTextContent('1. LD dev sandbox → 2. Data deployment'))
    // S64 P5 (5.6e): config saves are debounced — wait for the write, don't read it synchronously.
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    const last = saved[saved.length - 1]!.config as { templateSteps?: { before: Array<{ templateId: number; kind: string; steps: { automation: boolean; seeds: Array<{ name: string; groups: string[] }> } }>; after: unknown[] } }
    expect(last.templateSteps!.before).toHaveLength(1)
    expect(last.templateSteps!.before[0]).toMatchObject({ templateId: 4, kind: 'postRefresh', steps: { automation: true, seeds: [{ name: 'LD CPQ configuration', groups: ['cpq'] }] } })
    expect(last.templateSteps!.after).toEqual([])
    // The embedded seed's gated objects are called out for the Plan step.
    expect(screen.getByTestId('template-stage-4')).toHaveTextContent(/Triggers Disabled/)
    // Unticking the embedded seed removes it from the stage's steps.
    await userEvent.click(within(screen.getByTestId('template-stage-4')).getByRole('checkbox', { name: /Seed: LD CPQ configuration/ }))
    await waitFor(() => {
      const last2 = saved[saved.length - 1]!.config as { templateSteps: { before: Array<{ steps: { seeds: unknown[] } }> } }
      expect(last2.templateSteps.before[0]!.steps.seeds).toEqual([])
    })
    // "Not used" takes it out again.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'When to run LD dev sandbox' }), 'none')
    await waitFor(() => expect(screen.getByTestId('stage-sequence')).toHaveTextContent('1. Data deployment'))
  })
})
