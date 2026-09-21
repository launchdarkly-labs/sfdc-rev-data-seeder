// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
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

interface Stub {
  draft: DraftDetail | null
  intersection: ObjectIntersectionResult
  /** S52 F2: connection rows the Orgs step reads roles from (default: none). */
  orgs?: OrgConnection[]
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
    jobList: async () => []
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
    sourceConnectionId: 'darkb',
    targetConnectionId: 'sb1',
    sourceLabel: 'darkb',
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
    expect(screen.getByText('darkb → sb1 · Draft')).toBeInTheDocument()
    // All 7 steps reachable for a Draft.
    for (const label of ['Orgs', 'Scope', 'Readiness', 'Mappings', 'Fields', 'Summary', 'Plan']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('shows the intersection banner on Step 1', async () => {
    renderWizard('orgs')
    expect(await screen.findByText('9 deployable')).toBeInTheDocument()
    expect(screen.getByText('3 source-only (excluded)')).toBeInTheDocument()
    expect(screen.getByText('1 target-only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next: choose objects/ })).toBeEnabled()
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
    expect(screen.getByRole('button', { name: /Next: choose objects/ })).toBeDisabled()
    expect(screen.getByText(/share no deployable objects/)).toBeInTheDocument()
  })

  // S52 F2 — deployments 21/22 were created before F1 with an unassigned target
  // and would have been refused at deploy start, seven steps later.
  it('shows the pair roles and fixes an unassigned target in one click', async () => {
    const user = userEvent.setup()
    installStub({
      draft: draft(),
      intersection: { objects: [], common: 9, sourceOnly: 0, targetOnly: 0 },
      orgs: [org('darkb', 'source'), org('sb1', 'unassigned')]
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
      orgs: [org('darkb', 'source'), org('sb1', 'target')]
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
      orgs: [org('darkb', 'source'), org('sb1', 'source')]
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
    expect(screen.getByRole('button', { name: /Next: scope/ })).toBeDisabled()

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
      expect(screen.getByRole('button', { name: /Next: scope \(1 selected\)/ })).toBeEnabled()
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
    await user.type(screen.getByLabelText('Objects template name'), 'DM Core')
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

    await user.selectOptions(screen.getByLabelText('Saved objects template'), '90')
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

    await user.selectOptions(screen.getByLabelText('Saved objects template'), '91')
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

    await user.selectOptions(screen.getByLabelText('Saved objects template'), '92')
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
