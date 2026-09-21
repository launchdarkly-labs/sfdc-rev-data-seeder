/**
 * S57 (B2 / B3) — the scope advisor. Fixtures are the run-24 shape on
 * sb1-915-git (2026-09-18): CampaignMember in scope, Campaign out, CampaignId
 * required → 228/228 REQUIRED_FIELD_MISSING. See docs/session-57-build-plan/PLAN.md.
 */
import { describe, expect, it } from 'vitest'
import {
  buildParentSuggestions,
  filteredObjects,
  outOfScopeRefs,
  parentObjectsWithinScope,
  requiredReferenceWarnings,
  scopeEmptyMessage,
  scopeIsEmpty,
  semiJoinFilterFor,
  suggestionBody,
  suggestionHeadline,
  type RefFieldLike
} from '../src/shared/scopeAdvisor'
import type { TargetKeyInfo } from '../src/shared/mappingPolicy'

const f = (apiName: string, over: Partial<RefFieldLike> = {}): RefFieldLike => ({
  apiName,
  isReference: false,
  referenceTo: [],
  isCreateable: true,
  isNillable: true,
  ...over
})
const ref = (apiName: string, refTo: string, over: Partial<RefFieldLike> = {}): RefFieldLike =>
  f(apiName, { isReference: true, referenceTo: [refTo], ...over })

// Source describes (darkb_911 shape, trimmed).
const SRC: Record<string, RefFieldLike[]> = {
  Account: [f('Name'), ref('ParentId', 'Account'), ref('OwnerId', 'User'), ref('RecordTypeId', 'RecordType')],
  Contact: [ref('AccountId', 'Account'), ref('ReportsToId', 'Contact'), ref('Clay_Past_Account__c', 'Account')],
  CampaignMember: [
    ref('CampaignId', 'Campaign', { isNillable: false }),
    ref('ContactId', 'Contact'),
    ref('LeadId', 'Lead'),
    ref('AccountId', 'Account'),
    f('Status')
  ],
  Campaign: [ref('ParentId', 'Campaign'), ref('OwnerId', 'User')]
}
// Target describes: CampaignId is required on the target too; everything deployable.
const TGT: Record<string, RefFieldLike[]> = SRC

describe('parentObjectsWithinScope (B3 input)', () => {
  it('lists the other selected objects each object looks up to; self and out-of-scope are ignored', () => {
    const p = parentObjectsWithinScope(['Account', 'Contact', 'CampaignMember'], SRC)
    expect(p['Account']).toEqual([]) // ParentId is self, OwnerId → User is not selected
    expect(p['Contact']).toEqual(['Account'])
    expect(p['CampaignMember']).toEqual(['Contact', 'Account']) // Campaign/Lead not selected
  })
  it('skips non-createable lookups (formula/system lookups are not scope edges)', () => {
    const p = parentObjectsWithinScope(['A', 'B'], {
      A: [ref('B__c', 'B', { isCreateable: false })],
      B: []
    })
    expect(p['A']).toEqual([])
  })
})

describe('scopeIsEmpty (B3 — the V1 gate)', () => {
  const parents = parentObjectsWithinScope(['Account', 'Contact', 'CampaignMember'], SRC)

  it('V1: the only filter is at 0 and every other object hangs under it ⇒ empty', () => {
    expect(
      scopeIsEmpty({
        selectedObjects: ['Account', 'Contact', 'CampaignMember'],
        filters: { Account: "WHERE Id = '006TR00000gALnoYAG'" },
        probes: { Account: { kind: 'count', count: 0 } },
        parentsByObject: parents
      })
    ).toBe(true)
  })
  it('a single selected object at 0 is empty too (Jack\'s V1 draft)', () => {
    expect(
      scopeIsEmpty({
        selectedObjects: ['Account'],
        filters: { Account: "WHERE Id = '006TR00000gALnoYAG'" },
        probes: { Account: { kind: 'count', count: 0 } },
        parentsByObject: { Account: [] }
      })
    ).toBe(true)
  })
  it('one non-zero filter keeps the gate open', () => {
    expect(
      scopeIsEmpty({
        selectedObjects: ['Account', 'Contact'],
        filters: { Account: "WHERE Id = '001'", Contact: "WHERE Id = '003'" },
        probes: { Account: { kind: 'count', count: 0 }, Contact: { kind: 'count', count: 3 } },
        parentsByObject: parents
      })
    ).toBe(false)
  })
  it('an unfiltered ROOT keeps the gate open (dep 37: Campaign took every record)', () => {
    const withCampaign = parentObjectsWithinScope(['Account', 'Campaign'], SRC)
    expect(
      scopeIsEmpty({
        selectedObjects: ['Account', 'Campaign'],
        filters: { Account: "WHERE Id = '006TR00000gALnoYAG'" },
        probes: { Account: { kind: 'count', count: 0 } },
        parentsByObject: withCampaign
      })
    ).toBe(false)
  })
  it('busy / errored / unvalidated filters and missing describes keep the gate open', () => {
    const base = {
      selectedObjects: ['Account'],
      filters: { Account: "WHERE Id = 'x'" },
      parentsByObject: { Account: [] }
    }
    expect(scopeIsEmpty({ ...base, probes: { Account: { kind: 'busy' } } })).toBe(false)
    expect(scopeIsEmpty({ ...base, probes: { Account: { kind: 'error' } } })).toBe(false)
    expect(scopeIsEmpty({ ...base, probes: {} })).toBe(false)
    expect(
      scopeIsEmpty({ ...base, probes: { Account: { kind: 'count', count: 0 } }, parentsByObject: null })
    ).toBe(false)
  })
  it('no filters at all is never "empty" (nothing has been narrowed)', () => {
    expect(
      scopeIsEmpty({ selectedObjects: ['Account'], filters: {}, probes: {}, parentsByObject: { Account: [] } })
    ).toBe(false)
    expect(filteredObjects(['Account', 'Contact'], { Account: '  ', Contact: 'WHERE x' })).toEqual(['Contact'])
  })
  it('words the banner', () => {
    expect(scopeEmptyMessage(['Account'])).toMatch(/the filter on Account returns 0 records/)
    expect(scopeEmptyMessage(['Account', 'Contact'])).toMatch(/all return 0 records/)
  })
})

describe('outOfScopeRefs + buildParentSuggestions (B2 — the run-24 case)', () => {
  const scope = ['Account', 'Contact', 'CampaignMember']

  it('finds Campaign (required) and Lead (optional); ignores User/RecordType/self/in-scope', () => {
    const refs = outOfScopeRefs(scope, SRC, TGT)
    expect(refs).toEqual([
      { objectName: 'CampaignMember', fieldName: 'CampaignId', refTo: 'Campaign', required: true },
      { objectName: 'CampaignMember', fieldName: 'LeadId', refTo: 'Lead', required: false }
    ])
  })

  it('a field missing or read-only on the target is not a suggestion (not deployable)', () => {
    const tgt = { ...TGT, CampaignMember: TGT['CampaignMember']!.filter((x) => x.apiName !== 'LeadId') }
    expect(outOfScopeRefs(scope, SRC, tgt).map((r) => r.refTo)).toEqual(['Campaign'])
  })

  it('suggests a semi-join filter when the child has a plain filter', () => {
    const refs = outOfScopeRefs(scope, SRC, TGT)
    const [campaign] = buildParentSuggestions({
      refs,
      filters: { CampaignMember: "WHERE CampaignId = '701TR00000zxSZuYAM'" }
    })
    expect(campaign!.refTo).toBe('Campaign')
    expect(campaign!.required).toBe(true)
    expect(campaign!.suggestedFilter).toBe(
      "WHERE Id IN (SELECT CampaignId FROM CampaignMember WHERE CampaignId = '701TR00000zxSZuYAM')"
    )
    expect(campaign!.filterNote).toBeNull()
    expect(campaign!.keyedOnTarget).toBe(false)
  })

  it('parent-scoped child (no filter) ⇒ no filter, an explanatory note', () => {
    const refs = outOfScopeRefs(scope, SRC, TGT)
    const [campaign] = buildParentSuggestions({ refs, filters: { Account: "WHERE Id IN ('001')" } })
    expect(campaign!.suggestedFilter).toBeNull()
    expect(campaign!.filterNote).toMatch(/scoped through its parent/)
    expect(campaign!.filterNote).toMatch(/takes every record in the source org/)
  })

  it('a semi-join child filter cannot be nested (live: "Nesting of semi join sub-selects is not supported")', () => {
    const refs = outOfScopeRefs(scope, SRC, TGT)
    const [campaign] = buildParentSuggestions({
      refs,
      filters: { CampaignMember: 'WHERE ContactId IN (SELECT Id FROM Contact WHERE AccountId = \'001\')' }
    })
    expect(campaign!.suggestedFilter).toBeNull()
    expect(campaign!.filterNote).toMatch(/cannot nest/)
  })

  it('semiJoinFilterFor refuses clauses that do not start with WHERE', () => {
    const r = { objectName: 'CampaignMember', fieldName: 'CampaignId', refTo: 'Campaign', required: true }
    expect(semiJoinFilterFor(r, "Id = '1'")).toBeNull()
    expect(semiJoinFilterFor(r, '')).toBeNull()
    expect(semiJoinFilterFor(r, undefined)).toBeNull()
  })

  it('B1: keyed rows on the target flip the advice to "leaving it out is fine"', () => {
    const keyed: TargetKeyInfo = { hasField: new Set(['Campaign']), keyedRows: new Set(['Campaign']) }
    const refs = outOfScopeRefs(scope, SRC, TGT)
    const [campaign, lead] = buildParentSuggestions({ refs, filters: {}, targetKeys: keyed })
    expect(campaign!.keyedOnTarget).toBe(true)
    expect(suggestionBody(campaign!).join(' ')).toMatch(/already holds RDS-keyed Campaign rows/)
    expect(suggestionBody(campaign!).join(' ')).not.toMatch(/You should probably add Campaign/)
    expect(lead!.keyedOnTarget).toBe(false)
    expect(suggestionBody(lead!)).toEqual([
      'The link will be left blank on the target.',
      'You should probably add Lead.'
    ])
  })

  it('words the card', () => {
    const refs = outOfScopeRefs(scope, SRC, TGT)
    const [campaign] = buildParentSuggestions({ refs, filters: {} })
    expect(suggestionHeadline(campaign!)).toBe(
      "CampaignMember references Campaign, which isn't in this deployment."
    )
    expect(suggestionBody(campaign!)[0]).toMatch(
      /CampaignMember\.CampaignId is required, so every CampaignMember row will fail \(REQUIRED_FIELD_MISSING\)/
    )
    expect(suggestionBody(campaign!)[1]).toBe('You should probably add Campaign.')
  })
})

describe('requiredReferenceWarnings (FB-3 — analysis + freeze)', () => {
  const base = {
    objectName: 'CampaignMember',
    sourceFields: SRC['CampaignMember']!,
    targetFields: TGT['CampaignMember']!,
    overrides: undefined
  }

  it('run 24: Campaign out of scope, CampaignId required ⇒ one warning naming the fix', () => {
    const w = requiredReferenceWarnings({ ...base, selectedObjects: ['Account', 'Contact', 'CampaignMember'] })
    expect(w).toEqual([
      'CampaignMember.CampaignId is required and Campaign is not in this deployment — every CampaignMember row will fail with REQUIRED_FIELD_MISSING. Add Campaign on the Scope step.'
    ])
  })
  it('run 25: Campaign in scope ⇒ silent', () => {
    expect(
      requiredReferenceWarnings({ ...base, selectedObjects: ['Campaign', 'Account', 'Contact', 'CampaignMember'] })
    ).toEqual([])
  })
  it('B1: keyed rows on the target ⇒ the default resolves, so silent', () => {
    const keyed: TargetKeyInfo = { hasField: new Set(['Campaign']), keyedRows: new Set(['Campaign']) }
    expect(
      requiredReferenceWarnings({ ...base, selectedObjects: ['Contact', 'CampaignMember'], targetKeys: keyed })
    ).toEqual([])
  })
  it('B1: field on target but no keyed rows ⇒ warns and offers the deploy-the-parent-first path', () => {
    const fieldOnly: TargetKeyInfo = { hasField: new Set(['Campaign']), keyedRows: new Set() }
    const [w] = requiredReferenceWarnings({
      ...base,
      selectedObjects: ['Contact', 'CampaignMember'],
      targetKeys: fieldOnly
    })
    expect(w).toMatch(/or deploy Campaign first so the reference can resolve against RDS-keyed rows/)
  })
  it('an explicit Skip override on an in-scope required ref is called out as a mapping problem', () => {
    const [w] = requiredReferenceWarnings({
      ...base,
      selectedObjects: ['Campaign', 'Contact', 'CampaignMember'],
      overrides: { CampaignId: { strategy: 'skip' } }
    })
    expect(w).toMatch(/is not being resolved/)
    expect(w).toMatch(/set to Skip — change it on the Mappings step/)
  })
  it('nillable references never warn; self-refs and RecordTypeId are ignored', () => {
    expect(
      requiredReferenceWarnings({
        objectName: 'Account',
        sourceFields: SRC['Account']!,
        targetFields: [...TGT['Account']!, ref('ParentId', 'Account', { isNillable: false })],
        selectedObjects: ['Account'],
        overrides: undefined
      })
    ).toEqual([])
  })
})
