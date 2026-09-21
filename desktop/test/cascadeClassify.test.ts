/**
 * S49 BUG-10 — cascade classification for a REQUIRED_FIELD_MISSING caused by a
 * parent that failed in this same run (classify.ts pattern (c)).
 *
 * The live shape being regressed, from run 6:
 * Opportunity `006TR00000XIwc0YAD` failed on a bad restricted-picklist value
 * (BUG-9). Its 9 OpportunityLineItems and 1 OpportunityTeamMember then failed
 * with `REQUIRED_FIELD_MISSING: Required fields are missing: [OpportunityId]`,
 * because `stripMissingParentRefs` had removed the now-unresolvable parent
 * reference. `v_run_counters` reported `records_failed_root = 11, cascade = 0`.
 * The truth was 1 root + 10 cascades.
 */

import { describe, it, expect } from 'vitest'
import { buildFailedByObject, isCascadeFromStrippedParent } from '../src/main/engine/deploy/classify'
import { generateExternalId } from '../src/main/engine/deploy/transform/sfid'
import type { StrippedRef } from '../src/main/engine/deploy/transform/parentStrip'
import type { GoldenFieldInfo } from '../src/main/engine/deploy/golden/fixture'

/** The Opportunity that actually failed in run 6. */
const FAILED_OPP = '006TR00000XIwc0YAD'
const OTHER_OPP = '006TR00000bkf7kYAA'

const oliFields: GoldenFieldInfo[] = [
  {
    apiName: 'OpportunityId',
    dataType: 'reference',
    isCreateable: true,
    isNillable: false,
    isReference: true,
    referenceTo: ['Opportunity'],
    relationshipName: 'Opportunity',
    isAutoNumber: false,
    isCalculated: false,
    isExternalId: false,
    isRestrictedPicklist: false
  }
]

const strippedOppRef = (oppSourceId: string): StrippedRef[] => [
  {
    relationshipName: 'Opportunity',
    refObject: 'Opportunity',
    parentExtId: generateExternalId(oppSourceId),
    fieldName: 'OpportunityId',
    nillable: false // OLI.OpportunityId is REQUIRED — this is the cascade case
  }
]

describe('isCascadeFromStrippedParent — BUG-10', () => {
  const failedByObject = buildFailedByObject(
    ['Opportunity', 'OpportunityLineItem', 'OpportunityTeamMember'],
    [{ objectApiName: 'Opportunity', sourceId: FAILED_OPP }]
  )

  it('classifies REQUIRED_FIELD_MISSING as CASCADE when the stripped parent failed', () => {
    expect(
      isCascadeFromStrippedParent(
        ['OpportunityId'],
        strippedOppRef(FAILED_OPP),
        oliFields,
        failedByObject
      )
    ).toBe(true)
  })

  it('stays ROOT when the stripped parent did NOT fail (out of scope, say)', () => {
    expect(
      isCascadeFromStrippedParent(
        ['OpportunityId'],
        strippedOppRef(OTHER_OPP),
        oliFields,
        failedByObject
      )
    ).toBe(false)
  })

  it('stays ROOT when nothing was stripped from this record', () => {
    expect(isCascadeFromStrippedParent(['OpportunityId'], [], oliFields, failedByObject)).toBe(false)
    expect(
      isCascadeFromStrippedParent(['OpportunityId'], undefined, oliFields, failedByObject)
    ).toBe(false)
  })

  it('stays ROOT when the missing field is unrelated to the stripped ref', () => {
    // A genuinely missing required field is the user's problem, not a cascade.
    expect(
      isCascadeFromStrippedParent(['Name'], strippedOppRef(FAILED_OPP), oliFields, failedByObject)
    ).toBe(false)
  })

  it('stays ROOT when the API named no fields at all', () => {
    expect(
      isCascadeFromStrippedParent([], strippedOppRef(FAILED_OPP), oliFields, failedByObject)
    ).toBe(false)
  })

  it('matches a 15-char parent id against an 18-char failed id', () => {
    const failed15 = buildFailedByObject(
      ['Opportunity'],
      [{ objectApiName: 'Opportunity', sourceId: FAILED_OPP.substring(0, 15) }]
    )
    expect(
      isCascadeFromStrippedParent(
        ['OpportunityId'],
        strippedOppRef(FAILED_OPP),
        oliFields,
        failed15
      )
    ).toBe(true)
  })

  it('reproduces the run-6 split: 1 root + 10 cascades, not 11 roots', () => {
    // 9 OLIs + 1 OTM, each with the parent stripped, plus the root Opportunity.
    const children = Array.from({ length: 10 }, () => strippedOppRef(FAILED_OPP))
    const cascades = children.filter((refs) =>
      isCascadeFromStrippedParent(['OpportunityId'], refs, oliFields, failedByObject)
    ).length
    expect(cascades).toBe(10)
  })
})
