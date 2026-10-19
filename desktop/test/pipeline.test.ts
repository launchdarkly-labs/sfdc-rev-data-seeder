import { describe, it, expect } from 'vitest'
import { transformRecordV3 } from '../src/main/engine/deploy/transform/pipeline'
import type { SynthClock } from '../src/main/engine/deploy/transform/synthesis'
import type { GoldenContext, GoldenFieldInfo } from '../src/main/engine/deploy/golden/fixture'
import { reverse, EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'

/**
 * E4X.4 — transformRecordV3 pipeline integration suite (DDS L1120-1208).
 * Proves the four units compose in the exact Apex order: stage-1 core →
 * required-field synthesis → picklist gate → PBE gate, producing a GoldenOutcome.
 */

const ACCT_18 = '001fn000003abcdAAQ' // first 8 → '001fn000'
const OLI_18 = '00kfn000001lineAAAA'.slice(0, 18)
const PBE_18 = 'a0Bfn0000001abcAAM'
const SUB_18 = 'a0Bfn0000009zzzAAM'

const FIXED_CLOCK: SynthClock = {
  today: () => '2026-07-27',
  nowGmt: () => '2026-07-27T13:45:59.123Z'
}

function fi(partial: Partial<GoldenFieldInfo> & { apiName: string }): GoldenFieldInfo {
  return {
    dataType: 'string',
    isCreateable: true,
    isNillable: true,
    isReference: false,
    referenceTo: [],
    relationshipName: null,
    isAutoNumber: false,
    isCalculated: false,
    isExternalId: false,
    isRestrictedPicklist: false,
    ...partial
  }
}

function ctx(
  p: Partial<GoldenContext> & { objectName: string; fields: GoldenFieldInfo[] }
): GoldenContext {
  return {
    deferredFields: [],
    mappings: {},
    nameMatchMaps: {},
    useBulkFormat: false,
    targetUserId: null,
    inactiveUserIds: [],
    targetFieldsByName: {},
    targetPicklistAllowedValues: {},
    inactivePbeIds: [],
    pbeSubstitutes: {},
    ...p
  }
}

describe('transformRecordV3 — stage-1 + synthesis', () => {
  it('copies fields, sets the self-ExtId, and synthesizes a required target field', () => {
    const out = transformRecordV3(
      { Id: ACCT_18, Name: 'Acme' },
      ctx({
        objectName: 'Account',
        fields: [fi({ apiName: 'Name' })],
        targetFieldsByName: {
          Industry__c: fi({ apiName: 'Industry__c', isNillable: false, dataType: 'string' })
        }
      }),
      FIXED_CLOCK
    )
    expect(out.skipped).toBe(false)
    expect(out.skipReason).toBeNull()
    expect(out.payload).toEqual({
      [EXTERNAL_ID_FIELD]: reverse(ACCT_18),
      Name: 'Acme',
      // S49 (BUG-5): sentinel is now the FULL lowercased source Id, not its
      // 8-char head — the head is identical for every record in the org.
      Industry__c: 'rds-001fn000003abcdaaq'
    })
    expect(out.droppedPicklistValues).toEqual({})
  })
})

describe('transformRecordV3 — stage 2 (picklist gate)', () => {
  it('drops a disallowed picklist value copied by stage 1 and records the sample', () => {
    const out = transformRecordV3(
      { Id: ACCT_18, Stage: 'Bogus' },
      ctx({
        objectName: 'Opportunity',
        fields: [fi({ apiName: 'Stage', dataType: 'picklist', isRestrictedPicklist: true })],
        targetPicklistAllowedValues: { Stage: ['Won', 'Lost'] }
      }),
      FIXED_CLOCK
    )
    expect(out.payload).not.toHaveProperty('Stage')
    expect(out.payload).toHaveProperty(EXTERNAL_ID_FIELD)
    expect(out.droppedPicklistValues).toEqual({ Stage: ['Bogus'] })
    expect(out.skipped).toBe(false)
  })

  it('keeps an allowed picklist value', () => {
    const out = transformRecordV3(
      { Id: ACCT_18, Stage: 'Won' },
      ctx({
        objectName: 'Opportunity',
        fields: [fi({ apiName: 'Stage', dataType: 'picklist', isRestrictedPicklist: true })],
        targetPicklistAllowedValues: { Stage: ['Won', 'Lost'] }
      }),
      FIXED_CLOCK
    )
    expect(out.payload?.Stage).toBe('Won')
    expect(out.droppedPicklistValues).toEqual({})
  })
})

describe('transformRecordV3 — stage 3 (PBE gate, OLI)', () => {
  const oliCtx = (over: Partial<GoldenContext> = {}): GoldenContext =>
    ctx({
      objectName: 'OpportunityLineItem',
      fields: [
        fi({
          apiName: 'PricebookEntryId',
          isReference: true,
          referenceTo: ['PricebookEntry'],
          relationshipName: 'PricebookEntry'
        }),
        fi({ apiName: 'Quantity', dataType: 'double' })
      ],
      mappings: {
        PricebookEntryId: { strategy: 'directId', matchField: null, customValue: null }
      },
      ...over
    })

  it('swaps an inactive PBE for its active substitute', () => {
    const out = transformRecordV3(
      { Id: OLI_18, PricebookEntryId: PBE_18, Quantity: 2 },
      oliCtx({ inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_18]: SUB_18 } }),
      FIXED_CLOCK
    )
    expect(out.skipped).toBe(false)
    expect(out.payload?.PricebookEntryId).toBe(SUB_18)
    expect(out.payload?.Quantity).toBe(2)
  })

  it('skips the whole OLI when there is no substitute (payload → null)', () => {
    const out = transformRecordV3(
      { Id: OLI_18, PricebookEntryId: PBE_18, Quantity: 2 },
      oliCtx({ inactivePbeIds: [PBE_18], pbeSubstitutes: {} }),
      FIXED_CLOCK
    )
    expect(out.skipped).toBe(true)
    expect(out.skipReason).toBe('inactive_pbe_no_substitute')
    expect(out.payload).toBeNull()
  })
})

describe('transformRecordV3 — composition + robustness', () => {
  it('synthesis and the picklist gate coexist on disjoint keys (a synthesizable field is never a picklist)', () => {
    // These two stages operate on provably disjoint payload keys — synthesis
    // only writes synthesizable types (never 'picklist'), and the gate only
    // touches restricted-picklist keys — so both effects appear in one record.
    const out = transformRecordV3(
      { Id: ACCT_18, Stage: 'Bogus' },
      ctx({
        objectName: 'Opportunity',
        fields: [fi({ apiName: 'Stage', dataType: 'picklist', isRestrictedPicklist: true })],
        targetPicklistAllowedValues: { Stage: ['Won'] },
        targetFieldsByName: {
          Amount__c: fi({ apiName: 'Amount__c', isNillable: false, dataType: 'currency' })
        }
      }),
      FIXED_CLOCK
    )
    // Bad picklist dropped; required currency synthesized (never a picklist).
    expect(out.payload).not.toHaveProperty('Stage')
    expect(out.payload?.Amount__c).toBe(0)
    expect(out.droppedPicklistValues).toEqual({ Stage: ['Bogus'] })
  })

  it('runs the picklist gate THEN the PBE gate — an inactive OLI is skipped even after a picklist drop', () => {
    // Pins the picklist→PBE order + that the PBE payload-null wins: the picklist
    // gate records the dropped value, then the PBE gate nulls the whole payload.
    const out = transformRecordV3(
      { Id: OLI_18, PricebookEntryId: PBE_18, Kind__c: 'Bogus' },
      ctx({
        objectName: 'OpportunityLineItem',
        fields: [
          fi({
            apiName: 'PricebookEntryId',
            isReference: true,
            referenceTo: ['PricebookEntry'],
            relationshipName: 'PricebookEntry'
          }),
          fi({ apiName: 'Kind__c', dataType: 'picklist', isRestrictedPicklist: true })
        ],
        mappings: {
          PricebookEntryId: { strategy: 'directId', matchField: null, customValue: null }
        },
        targetPicklistAllowedValues: { Kind__c: ['Won'] },
        inactivePbeIds: [PBE_18],
        pbeSubstitutes: {}
      }),
      FIXED_CLOCK
    )
    expect(out.skipped).toBe(true)
    expect(out.skipReason).toBe('inactive_pbe_no_substitute')
    expect(out.payload).toBeNull()
    expect(out.droppedPicklistValues).toEqual({ Kind__c: ['Bogus'] })
  })

  it('returns a well-formed GoldenOutcome for a bare record + empty context', () => {
    const out = transformRecordV3({ Id: ACCT_18 }, ctx({ objectName: 'Account', fields: [] }), FIXED_CLOCK)
    expect(out).toEqual({
      payload: { [EXTERNAL_ID_FIELD]: reverse(ACCT_18) },
      skipped: false,
      skipReason: null,
      droppedPicklistValues: {}
    })
  })
})
