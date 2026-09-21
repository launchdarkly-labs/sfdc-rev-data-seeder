import { describe, it, expect } from 'vitest'
import {
  plannedObjectToRow,
  rowToPlannedObject,
  plannedObjectToView
} from '../src/main/planMapping'
import type { PlannedObject } from '../src/main/engine/analysis'

function fixture(overrides: Partial<PlannedObject> = {}): PlannedObject {
  return {
    objectName: 'Account',
    sortOrder: 1,
    hasCircularReference: false,
    deferredFields: [],
    scope: { kind: 'raw', where: "Id = '0011K00002GwMRVQA3'" },
    scopedFilterDisplay: "WHERE Id = '0011K00002GwMRVQA3'",
    recordCount: 42,
    apiStrategy: 'REST',
    gatingTier: 'semi',
    requiresTriggerBypass: false,
    requiresAutomationDisable: false,
    restPageSize: 200,
    recommendedBatchSize: 200,
    isJunction: false,
    junctionParents: null,
    junctionParentFields: null,
    ...overrides
  }
}

describe('planMapping', () => {
  it('round-trips a PlannedObject through a deployment_objects row', () => {
    const p = fixture({ deferredFields: ['ParentId', 'AccountId'], hasCircularReference: true })
    const row = plannedObjectToRow(7, p)
    expect(row.deployment_id).toBe(7)
    expect(row.object_api_name).toBe('Account')
    expect(row.has_circular_refs).toBe(1)
    expect(row.scoped_record_count).toBe(42)
    expect(row.api_strategy).toBe('REST')
    // plan_json is authoritative — full fidelity survives the round-trip.
    expect(rowToPlannedObject(row)).toEqual(p)
  })

  it('projects junction parents into columns + view', () => {
    const p = fixture({
      objectName: 'OpportunityContactRole',
      sortOrder: 9,
      isJunction: true,
      junctionParents: ['Opportunity', 'Contact'],
      junctionParentFields: ['OpportunityId', 'ContactId'],
      recommendedBatchSize: 200
    })
    const row = plannedObjectToRow(1, p)
    expect(row.is_junction).toBe(1)
    expect(JSON.parse(row.junction_parents!)).toEqual(['Opportunity', 'Contact'])

    const view = plannedObjectToView(p)
    expect(view).toMatchObject({
      objectName: 'OpportunityContactRole',
      isJunction: true,
      junctionParents: ['Opportunity', 'Contact'],
      recommendedBatchSize: 200
    })
    // the view intentionally drops the structured scope (deploy-engine only).
    expect('scope' in view).toBe(false)
  })

  it('throws if plan_json is missing (never silently lose fidelity)', () => {
    const row = plannedObjectToRow(1, fixture())
    row.plan_json = null
    expect(() => rowToPlannedObject(row)).toThrow(/plan_json/)
  })
})
