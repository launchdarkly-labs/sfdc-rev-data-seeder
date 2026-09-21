import { describe, it, expect } from 'vitest'
import {
  WIZARD_STEPS,
  stepIndex,
  stepCapForStatus,
  clampStep,
  canDeleteDeployment,
  canEditPlan,
  emptyWizardConfig,
  isDeployBusy,
  isDeployFinished,
  DELETABLE_STATUSES,
  reconcileObjectsTemplate
} from '../src/shared/wizard'

describe('wizard step rules', () => {
  it('caps a Stalled deployment at the Fields step', () => {
    expect(stepCapForStatus('Stalled')).toBe('fields')
    expect(stepCapForStatus('Draft')).toBe('plan')
    expect(stepCapForStatus('Planned')).toBe('plan')
  })

  it('S46 D1: finished deployments reopen to the Plan step (fix & redeploy)', () => {
    for (const s of ['Completed', 'Failed', 'Cancelled']) expect(stepCapForStatus(s)).toBe('plan')
  })
})

describe('S46 D1 status vocabulary', () => {
  it('isDeployBusy = the four live mirrored statuses, nothing else', () => {
    for (const s of ['Deploying', 'Retrying', 'Disabling Automation', 'Restoring Automation']) {
      expect(isDeployBusy(s)).toBe(true)
    }
    for (const s of ['Draft', 'Planned', 'Completed', 'Failed', 'Cancelled', 'Stalled', 'Frozen']) {
      expect(isDeployBusy(s)).toBe(false)
    }
  })

  it('canEditPlan = Planned + the three terminal statuses; never busy, Draft, or Stalled', () => {
    for (const s of ['Planned', 'Completed', 'Failed', 'Cancelled'])
      expect(canEditPlan(s)).toBe(true)
    for (const s of ['Draft', 'Stalled', 'Deploying', 'Retrying', 'Restoring Automation']) {
      expect(canEditPlan(s)).toBe(false)
    }
  })

  it('isDeployFinished covers terminal + Stalled (parked)', () => {
    for (const s of ['Completed', 'Failed', 'Cancelled', 'Stalled'])
      expect(isDeployFinished(s)).toBe(true)
    for (const s of ['Draft', 'Planned', 'Deploying']) expect(isDeployFinished(s)).toBe(false)
  })

  it('DELETABLE_STATUSES was NOT widened (Apex DataSeederController:461-464 parity — Failed/Cancelled/Completed stay undeletable)', () => {
    expect([...DELETABLE_STATUSES]).toEqual(['Draft', 'Planned', 'Stalled'])
  })

  it('clamps a requested step to the status cap', () => {
    expect(clampStep('plan', 'Stalled')).toBe('fields')
    expect(clampStep('summary', 'Stalled')).toBe('fields')
    expect(clampStep('scope', 'Stalled')).toBe('scope') // below cap, unchanged
    expect(clampStep('plan', 'Draft')).toBe('plan')
  })

  // PIN THE WHOLE ORDER, not just the ends. `stepIndex` derives position from
  // this tuple, and stepCapForStatus / the nav / the :step route / every
  // stepIndex comparison move with it — so inserting a step in the wrong slot
  // silently reorders the wizard. The loose version of this test (first ===
  // 'orgs', last === 'plan', contains 'readiness') would have passed for the
  // S49 'objects' insertion no matter WHERE it landed.
  it('orders the steps exactly orgs → objects → scope → … → plan', () => {
    expect([...WIZARD_STEPS]).toEqual([
      'orgs',
      'objects',
      'scope',
      'readiness',
      'mappings',
      'fields',
      'summary',
      'plan'
    ])
  })

  it('falls back to the first step for an unrecognised step (blank-body guard)', () => {
    expect(clampStep('bogus' as never, 'Draft')).toBe('orgs')
    expect(clampStep('bogus' as never, 'Stalled')).toBe('orgs')
  })

  it('keeps objects strictly between orgs and scope', () => {
    expect(stepIndex('objects')).toBe(stepIndex('orgs') + 1)
    expect(stepIndex('scope')).toBe(stepIndex('objects') + 1)
  })

  it('the Stalled cap still lands on fields after the insertion', () => {
    // 'objects' is upstream of 'fields', so a Stalled draft can still reach it.
    expect(stepIndex('objects')).toBeLessThan(stepIndex(stepCapForStatus('Stalled')))
  })
})

describe('delete guard', () => {
  it('allows deletion of Draft / Planned', () => {
    expect(canDeleteDeployment('Draft', false).ok).toBe(true)
    expect(canDeleteDeployment('Planned', false).ok).toBe(true)
  })

  it('blocks non-deletable statuses', () => {
    expect(canDeleteDeployment('Deploying', false).ok).toBe(false)
    expect(canDeleteDeployment('Completed', false).ok).toBe(false)
    expect(canDeleteDeployment('Deploying', false).reason).toMatch(/cannot be deleted/i)
  })

  it('blocks a Stalled deployment with unconfirmed automation restore', () => {
    const blocked = canDeleteDeployment('Stalled', true)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/restore/i)
    expect(canDeleteDeployment('Stalled', false).ok).toBe(true)
  })

  // S52 F4 — deployment 23 was refused at deploy start ("cannot be a deploy
  // target") and sat at Failed forever with no way to remove it.
  it('allows a PRE-RUN Failed / Cancelled deployment (nothing touched the target)', () => {
    expect(canDeleteDeployment('Failed', false, false).ok).toBe(true)
    expect(canDeleteDeployment('Cancelled', false, false).ok).toBe(true)
  })

  it('keeps a Failed / Cancelled deployment that HAS a run (its evidence stays)', () => {
    const r = canDeleteDeployment('Failed', false, true)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/run history/)
    expect(canDeleteDeployment('Cancelled', false, true).ok).toBe(false)
  })

  it('an unaware caller (no hasRun) gets the conservative answer for Failed', () => {
    expect(canDeleteDeployment('Failed', false).ok).toBe(false)
  })

  it('Completed is never deletable, run or not', () => {
    expect(canDeleteDeployment('Completed', false, false).ok).toBe(false)
    expect(canDeleteDeployment('Completed', false, true).ok).toBe(false)
  })
})

describe('emptyWizardConfig', () => {
  it('is a clean starting draft', () => {
    const c = emptyWizardConfig()
    expect(c.selectedObjects).toEqual([])
    // S50 (A4): `filterMode` was removed — the UI wrote it and nothing in the
    // main process ever read it, so "All records" silently gave parent scoping.
    expect(c).not.toHaveProperty('filterMode')
    expect(c.cpqAttestation).toBe(false)
    expect(c.populatedOnly).toBe(false)
  })
})

/**
 * UI-5 — `objects` templates. The whole risk of applying a saved object list is
 * schema drift between the save and the apply: the picker only ever offers
 * objects deployable in BOTH orgs, so an entry that no longer qualifies must be
 * dropped and named, never silently selected.
 */
describe('reconcileObjectsTemplate', () => {
  const available = ['Account', 'Contact', 'Opportunity']

  it('keeps entries that are still deployable in both orgs', () => {
    const r = reconcileObjectsTemplate({ objects: ['Account', 'Contact'] }, available)
    expect(r.objects).toEqual(['Account', 'Contact'])
    expect(r.dropped).toEqual([])
  })

  it('DROPS an entry that is no longer deployable, and names it', () => {
    // The package was uninstalled from the target since the template was saved.
    const r = reconcileObjectsTemplate(
      { objects: ['Account', 'SBQQ__Quote__c', 'Contact'] },
      available
    )
    expect(r.objects).toEqual(['Account', 'Contact'])
    // Named, not just counted — "1 dropped" cannot tell a harmless package
    // difference from the object the user actually needed.
    expect(r.dropped).toEqual(['SBQQ__Quote__c'])
  })

  it('preserves the template order rather than the availability order', () => {
    const r = reconcileObjectsTemplate({ objects: ['Opportunity', 'Account'] }, available)
    expect(r.objects).toEqual(['Opportunity', 'Account'])
  })

  it('de-dupes, so a hand-edited template cannot select the same object twice', () => {
    const r = reconcileObjectsTemplate({ objects: ['Account', 'Account'] }, available)
    expect(r.objects).toEqual(['Account'])
  })

  it('never throws on a malformed payload — a bad template degrades to empty', () => {
    for (const bad of [undefined, null, {}, { objects: 'Account' }, { objects: [1, 2] }, 42]) {
      const r = reconcileObjectsTemplate(bad, available)
      expect(r.objects).toEqual([])
    }
    // Non-string members are discarded, not coerced.
    expect(reconcileObjectsTemplate({ objects: ['Account', 7] }, available).objects).toEqual([
      'Account'
    ])
  })

  it('drops everything when nothing is available (both orgs share no objects)', () => {
    const r = reconcileObjectsTemplate({ objects: ['Account'] }, [])
    expect(r.objects).toEqual([])
    expect(r.dropped).toEqual(['Account'])
  })
})

// ── S54 (L1): the readiness gate ──────────────────────────────────────────
import {
  readinessBlockingObjects,
  readinessGate,
  readinessGateMessage,
  readinessScopeKey,
  stepClosedByReadiness,
  type WizardConfig
} from '../src/shared/wizard'

describe('readiness gate (S54 L1 — Readiness is a HARD STOP)', () => {
  const scoped = (objects: string[]): WizardConfig => ({
    ...emptyWizardConfig(),
    selectedObjects: objects
  })
  const rec = (objects: string[], ready: boolean, blocking: string[] = []) => ({
    scopeKey: readinessScopeKey({ selectedObjects: objects }),
    ready,
    blockingObjects: blocking,
    checkedAt: '2026-09-13T00:00:00.000Z'
  })

  it('scope key is order-independent (re-ordering objects is not a scope change)', () => {
    expect(readinessScopeKey({ selectedObjects: ['Opportunity', 'Account'] })).toBe(
      readinessScopeKey({ selectedObjects: ['Account', 'Opportunity'] })
    )
  })

  it("an empty scope is not this gate's question (Objects step owns it)", () => {
    expect(readinessGate(scoped([])).blocked).toBe(false)
  })

  it('never checked → blocked as unchecked (pre-S54 drafts included)', () => {
    const g = readinessGate(scoped(['Account']))
    expect(g).toEqual({ blocked: true, reason: 'unchecked', objects: [] })
    expect(readinessGateMessage(g)).toMatch(/has not been checked/)
  })

  it('a green for ANOTHER scope does not leak through an added object (stale)', () => {
    const cfg = { ...scoped(['Account', 'Contact']), readiness: rec(['Account'], true) }
    const g = readinessGate(cfg)
    expect(g.reason).toBe('stale')
    expect(g.blocked).toBe(true)
    expect(readinessGateMessage(g)).toMatch(/scope changed/)
  })

  it('checked for this scope and not ready → blocked, naming the objects', () => {
    const cfg = {
      ...scoped(['Account', 'Opportunity']),
      readiness: rec(['Account', 'Opportunity'], false, ['Account', 'Opportunity'])
    }
    const g = readinessGate(cfg)
    expect(g).toEqual({ blocked: true, reason: 'blocked', objects: ['Account', 'Opportunity'] })
    const msg = readinessGateMessage(g)
    expect(msg).toMatch(/^You can't proceed/)
    expect(msg).toContain('Account, Opportunity')
    expect(msg).toContain('Readiness step')
  })

  it('checked for this scope and ready → open', () => {
    const cfg = {
      ...scoped(['Opportunity', 'Account']),
      readiness: rec(['Account', 'Opportunity'], true)
    }
    expect(readinessGate(cfg)).toEqual({ blocked: false, reason: null, objects: [] })
    expect(readinessGateMessage(readinessGate(cfg))).toBe('')
  })

  it('blocking objects = needs-field OR undescribable; junctions and ready rows never block', () => {
    expect(
      readinessBlockingObjects({
        objects: [
          { objectName: 'Account', needsExtIdField: false },
          { objectName: 'Opportunity', needsExtIdField: true },
          { objectName: 'OpportunityContactRole', needsExtIdField: false },
          { objectName: 'Weird__c', needsExtIdField: false, describeError: 'INVALID_TYPE' }
        ]
      })
    ).toEqual(['Opportunity', 'Weird__c'])
  })

  it('closes exactly the steps after Readiness', () => {
    expect(stepClosedByReadiness('orgs')).toBe(false)
    expect(stepClosedByReadiness('scope')).toBe(false)
    expect(stepClosedByReadiness('readiness')).toBe(false)
    expect(stepClosedByReadiness('mappings')).toBe(true)
    expect(stepClosedByReadiness('summary')).toBe(true)
    expect(stepClosedByReadiness('plan')).toBe(true)
  })
})
