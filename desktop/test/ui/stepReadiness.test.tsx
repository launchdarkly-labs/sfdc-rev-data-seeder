// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, type WizardConfig } from '../../src/shared/wizard'
import type { DraftDetail, ObjectReadiness, ReadinessReport } from '../../src/shared/types'

const ready = (name: string): ObjectReadiness => ({
  objectName: name,
  isJunction: false,
  hasExtIdField: true,
  extIdIsExternalId: true,
  needsExtIdField: false
})
const missing = (name: string): ObjectReadiness => ({
  objectName: name,
  isJunction: false,
  hasExtIdField: false,
  extIdIsExternalId: false,
  needsExtIdField: true
})
const junction = (name: string): ObjectReadiness => ({
  objectName: name,
  isJunction: true,
  hasExtIdField: false,
  extIdIsExternalId: false,
  needsExtIdField: false
})
const notFlagged = (name: string): ObjectReadiness => ({
  objectName: name,
  isJunction: false,
  hasExtIdField: true,
  extIdIsExternalId: false,
  needsExtIdField: true
})
const undescribable = (name: string): ObjectReadiness => ({
  objectName: name,
  isJunction: false,
  hasExtIdField: false,
  extIdIsExternalId: false,
  needsExtIdField: false,
  describeError: 'INVALID_TYPE: no such object'
})

function report(objects: ObjectReadiness[]): ReadinessReport {
  return {
    objects,
    objectCount: objects.length,
    junctionCount: objects.filter((o) => o.isJunction).length,
    missingExtIdCount: objects.filter((o) => o.needsExtIdField).length,
    ready: objects.every((o) => !o.needsExtIdField)
  }
}

let createArgs: Array<[number, string]>
let provisionArgs: number[]
let provisionFailures: Array<{ objectName: string; error: string }>
let currentReport: ReadinessReport
let savedConfigs: Array<WizardConfig>

function installWith(objects: ObjectReadiness[]): void {
  createArgs = []
  provisionArgs = []
  provisionFailures = []
  currentReport = report(objects)
  savedConfigs = []
  ;(window as unknown as { rds: unknown }).rds = {
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'darkb',
      targetConnectionId: 'sb1',
      sourceLabel: 'darkb',
      targetLabel: 'sb1',
      step: 'readiness',
      config: { ...emptyWizardConfig(), selectedObjects: objects.map((o) => o.objectName) },
      status: 'Planned'
    }),
    draftSave: async (input: { config: WizardConfig }) => {
      savedConfigs.push(input.config)
    },
    // StepMappings (navigated to below) verifies the target on mount + describes on expand.
    verifyOrg: async () => ({ ok: true, username: 'me@target' }),
    describeObject: async () => [],
    sampleGet: async () => ({ ok: true, values: {} }),
    readinessCheck: async () => currentReport,
    readinessCreateExtId: async (deploymentId: number, objectName: string) => {
      createArgs.push([deploymentId, objectName])
      // Simulate the field now existing: the next readinessCheck reflects it.
      currentReport = report(
        currentReport.objects.map((o) => (o.objectName === objectName ? ready(objectName) : o))
      )
      return ready(objectName)
    },
    readinessProvisionExtIds: async (deploymentId: number) => {
      provisionArgs.push(deploymentId)
      if (provisionFailures.length > 0) {
        return {
          created: [],
          alreadyPresent: [],
          granted: [],
          skippedJunctions: [],
          failures: provisionFailures,
          permissionSetCreated: false,
          assignmentCreated: false,
          permissionSetName: 'RDS_Deployment_Access',
          report: currentReport
        }
      }
      // Everything creatable becomes ready; not-flagged + junctions are untouched.
      const created = currentReport.objects
        .filter((o) => o.needsExtIdField && !o.hasExtIdField && !o.describeError)
        .map((o) => o.objectName)
      currentReport = report(
        currentReport.objects.map((o) => (created.includes(o.objectName) ? ready(o.objectName) : o))
      )
      return {
        created,
        alreadyPresent: [],
        granted: created,
        skippedJunctions: currentReport.objects
          .filter((o) => o.isJunction)
          .map((o) => o.objectName),
        failures: [],
        permissionSetCreated: true,
        assignmentCreated: true,
        permissionSetName: 'RDS_Deployment_Access',
        report: currentReport
      }
    }
  }
}

function install(): void {
  installWith([ready('Account'), missing('Contact'), junction('OpportunityContactRole')])
}

function renderReadiness(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/1/wizard/readiness']}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

beforeEach(install)
afterEach(cleanup)

describe('StepReadiness (5B.4)', () => {
  it('shows the footprint + per-object ExtId status (ready / missing / junction n/a)', async () => {
    renderReadiness()
    expect(await screen.findByText(/External Id present/)).toBeInTheDocument()
    expect(screen.getByText(/missing External Id field/)).toBeInTheDocument()
    expect(screen.getByText(/n\/a \(junction\)/)).toBeInTheDocument()
    // Footprint: 3 objects · 1 junction · 1 needs a field (singular verb).
    expect(screen.getByText(/1 object needs an External Id field/)).toBeInTheDocument()
  })

  // S46: one button for the whole scope, not one per row. Creating the field is
  // only half the job — FLS is granted once per permission set, not per object.
  it('provisions the whole scope from a single button, then refetches', async () => {
    const user = userEvent.setup()
    renderReadiness()
    await screen.findByText(/missing External Id field/)
    expect(screen.queryByRole('button', { name: 'Create field' })).not.toBeInTheDocument()

    // The button names the count of creatable objects (Contact only here).
    await user.click(screen.getByRole('button', { name: 'Create 1 External Id field' }))
    await waitFor(() => expect(provisionArgs).toEqual([1]))
    await waitFor(() =>
      expect(screen.queryByText(/missing External Id field/)).not.toBeInTheDocument()
    )
    expect(screen.getByText(/target ready/)).toBeInTheDocument()
    expect(screen.getByText(/Granted access on 1 object/)).toBeInTheDocument()
    expect(screen.getByText(/RDS_Deployment_Access/)).toBeInTheDocument()
  })

  it('pluralizes and counts every creatable object in one action', async () => {
    const user = userEvent.setup()
    installWith([missing('Account'), missing('Contact'), missing('Opportunity')])
    renderReadiness()
    await screen.findByText(/3 objects need an External Id field/)
    await user.click(screen.getByRole('button', { name: 'Create 3 External Id fields' }))
    await waitFor(() => expect(provisionArgs).toEqual([1]))
    expect(await screen.findByText(/Created 3 fields/)).toBeInTheDocument()
  })

  it('disables the button when nothing is creatable', async () => {
    installWith([ready('Account'), junction('OpportunityContactRole')])
    renderReadiness()
    expect(
      await screen.findByRole('button', { name: 'All External Id fields present' })
    ).toBeDisabled()
  })

  // A field that exists but isn't flagged External Id must be converted by hand —
  // metadata.create would duplicate it — so it is excluded from the button count.
  it('excludes not-flagged fields from the count and explains them', async () => {
    installWith([notFlagged('Account'), missing('Contact')])
    renderReadiness()
    expect(
      await screen.findByRole('button', { name: 'Create 1 External Id field' })
    ).toBeInTheDocument()
    expect(screen.getByText(/not flagged as an External Id/)).toBeInTheDocument()
  })

  it('surfaces a per-object failure on its row', async () => {
    const user = userEvent.setup()
    installWith([missing('OpportunityTeamMember')])
    provisionFailures = [
      { objectName: 'OpportunityTeamMember', error: 'INVALID_FIELD: cannot add custom fields' }
    ]
    renderReadiness()
    await screen.findByText(/missing External Id field/)
    await user.click(screen.getByRole('button', { name: 'Create 1 External Id field' }))
    expect(await screen.findByText(/1 object failed/)).toBeInTheDocument()
    expect(screen.getByText(/cannot add custom fields/)).toBeInTheDocument()
  })

  // ── S54 (L1): Readiness is a HARD STOP ─────────────────────────────────
  it('L1: a missing field is RED, blocks Next, and names the object in the stop message', async () => {
    renderReadiness() // Account ready, Contact missing, OCR junction
    const missingCell = await screen.findByText('✗ missing External Id field')
    expect(missingCell).toHaveClass('status-err')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/^You can't proceed/)
    expect(alert).toHaveTextContent('Contact')
    expect(alert).toHaveTextContent(/Provision the External ID fields/)
    expect(screen.queryByText(/You can continue/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next: mappings' })).toBeDisabled()
    // The step nav past Readiness is closed too.
    for (const label of ['Mappings', 'Fields', 'Summary', 'Plan']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-disabled', 'true')
    }
    expect(screen.getByRole('button', { name: 'Scope' })).not.toHaveAttribute('aria-disabled')
  })

  it('L1: a closed nav step routes back to Readiness with the reason, never to the step', async () => {
    const user = userEvent.setup()
    renderReadiness()
    await screen.findByText('✗ missing External Id field')
    await user.click(screen.getByRole('button', { name: 'Plan' }))
    expect(screen.getByRole('heading', { name: 'Readiness' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Plan' })).not.toBeInTheDocument()
  })

  it('L1: the verdict is persisted on the draft keyed by scope (so Summary/Plan can read it)', async () => {
    renderReadiness()
    await screen.findByText('✗ missing External Id field')
    await waitFor(() => expect(savedConfigs.length).toBeGreaterThan(0))
    const last = savedConfigs[savedConfigs.length - 1]!
    expect(last.readiness).toMatchObject({
      scopeKey: 'Account,Contact,OpportunityContactRole',
      ready: false,
      blockingObjects: ['Contact']
    })
  })

  it('L1: once every object is ready, Next opens and the user reaches Mappings', async () => {
    const user = userEvent.setup()
    installWith([ready('Account'), ready('Opportunity'), junction('OpportunityContactRole')])
    renderReadiness()
    expect(await screen.findByText(/Target ready for this scope/)).toBeInTheDocument()
    const next = screen.getByRole('button', { name: 'Next: mappings' })
    await waitFor(() => expect(next).toBeEnabled())
    await user.click(next)
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Mappings' })).toBeInTheDocument()
    )
  })

  it('L1: Provision flips the gate — Next is disabled before and enabled after', async () => {
    const user = userEvent.setup()
    renderReadiness()
    await screen.findByText('✗ missing External Id field')
    expect(screen.getByRole('button', { name: 'Next: mappings' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Create 1 External Id field/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next: mappings' })).toBeEnabled()
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('L1: an undescribable object blocks too (the freeze would refuse it)', async () => {
    installWith([ready('Account'), undescribable('SBQQ__Quote__c')])
    renderReadiness()
    await screen.findByText(/could not describe on target/)
    expect(screen.getByRole('button', { name: 'Next: mappings' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('SBQQ__Quote__c')
  })

  it('shows guidance (not an erroring Create button) when a field exists but is not flagged', async () => {
    installWith([notFlagged('Account')])
    renderReadiness()
    expect(await screen.findByText(/field exists but is not an External Id/)).toBeInTheDocument()
    expect(screen.getByText(/Mark the existing field as an External Id/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create field' })).not.toBeInTheDocument()
  })

  it('surfaces a per-object describe error without collapsing the rest of the report', async () => {
    installWith([ready('Account'), undescribable('SBQQ__Quote__c')])
    renderReadiness()
    expect(await screen.findByText(/could not describe on target/)).toBeInTheDocument()
    // The healthy object is still assessed + shown.
    expect(screen.getByText(/External Id present/)).toBeInTheDocument()
  })
})

// ── S57 (B4): an object that can never carry the key ──────────────────────────
describe('StepReadiness — S57 B4 cannot-host rows', () => {
  const cannotHost = (name: string): ObjectReadiness => ({
    objectName: name,
    isJunction: false,
    hasExtIdField: false,
    extIdIsExternalId: false,
    needsExtIdField: true,
    cannotHostCustomField: true
  })

  it('says why the row is permanently red, excludes it from the Create count, and names it in the gate', async () => {
    installWith([ready('Account'), missing('Contact'), cannotHost('CampaignMemberStatus')])
    renderReadiness()
    expect(await screen.findByText(/can't carry a custom field$/)).toBeInTheDocument()
    expect(
      screen.getByText(/CampaignMemberStatus can't carry a custom field, so this tool has no way to key it/)
    ).toBeInTheDocument()
    // Only Contact is creatable.
    expect(screen.getByRole('button', { name: 'Create 1 External Id field' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/provisioning will never fix it; deselect it to continue/)
    expect(screen.getByRole('button', { name: 'Next: mappings' })).toBeDisabled()
  })

  it('"Deselect" removes the object from the scope (and its filter/mappings) so the check re-runs', async () => {
    const user = userEvent.setup()
    installWith([ready('Account'), cannotHost('CampaignMemberStatus')])
    renderReadiness()
    await user.click(await screen.findByRole('button', { name: 'Deselect CampaignMemberStatus' }))
    await waitFor(() => expect(savedConfigs.length).toBeGreaterThan(0))
    const last = savedConfigs[savedConfigs.length - 1]!
    expect(last.selectedObjects).toEqual(['Account'])
    expect(last.filters['CampaignMemberStatus']).toBeUndefined()
  })
})
