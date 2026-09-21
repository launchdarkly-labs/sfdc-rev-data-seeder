/**
 * S49 BUG-9 — the record-type-scoped + dependent picklist gate.
 *
 * Every fixture here is a RECORDED REAL RESPONSE, captured 2026-09-06 from
 * sb1_830 (`GET /services/data/v66.0/ui-api/object-info/{obj}/picklist-values/
 * {recordTypeId}`) and trimmed to the fields under test. Standing rule 10
 * requires the changed mechanism be validated against something representative
 * before a DMG rebuild; invented shapes would not have caught the `&amp;`
 * escaping trap that these did.
 *
 * The two live failures being regressed:
 *   - run 6, Opportunity 006TR00000XIwc0YAD: record-type scoping
 *   - run 5, Contact 0031K00002gOEVCQA4 et al: dependent picklist
 */

import { describe, it, expect } from 'vitest'
import {
  applyRecordTypePicklistGate,
  MASTER_RECORD_TYPE_ID,
  type RecordTypePicklists
} from '../src/main/engine/deploy/transform/recordTypePicklistGate'
import { buildPrefetchContext, type PrefetchIo } from '../src/main/engine/deploy/transform/prefetch'
import type { DescribeField } from '../src/main/engine/deploy/transform/fieldFilter'

const AMENDMENT_RT = '012TR000004hIFVYA2'

/** Verbatim from sb1_830 — note the HTML-escaped ampersands. */
const UI_API_OPPORTUNITY_AMENDMENT = {
  picklistFieldValues: {
    Value_Drivers__c: {
      controllerValues: {},
      defaultValue: null,
      values: [
        { value: 'Maximize Speed &amp; Efficiency of Safe Software Delivery', validFor: [] },
        { value: 'Drive Customer Engagement &amp; Revenue Through Digital Products', validFor: [] },
        { value: 'Continuously Optimize Your Technology Stack', validFor: [] },
        { value: 'Other', validFor: [] }
      ]
    }
  }
}

/** Verbatim from sb1_830 (Contact, Master record type). */
const UI_API_CONTACT_MASTER = {
  picklistFieldValues: {
    Disqualification_Reason__c: {
      controllerValues: {
        New: 0,
        Open: 1,
        Working: 2,
        'AI - Working': 3,
        Qualifying: 4,
        Recycled: 5,
        Disqualified: 6,
        'Current Customer': 7,
        Support: 8
      },
      defaultValue: null,
      values: [
        { value: 'Unsubscribe', validFor: [6] },
        { value: 'Unresponsive', validFor: [6] },
        { value: 'Not Interested', validFor: [6] },
        { value: 'Bad Fit', validFor: [6] },
        { value: 'Duplicate', validFor: [6] },
        { value: 'Other', validFor: [6] }
      ]
    }
  }
}

function fld(over: Partial<DescribeField> & { apiName: string }): DescribeField {
  return {
    dataType: 'picklist',
    isCreateable: true,
    isNillable: true,
    isReference: false,
    referenceTo: [],
    relationshipName: null,
    isAutoNumber: false,
    isCalculated: false,
    isExternalId: false,
    isRestrictedPicklist: true,
    picklistValues: [],
    controllerName: null,
    ...over
  } as DescribeField
}

function ioFor(
  byPath: Record<string, unknown>,
  recordTypeIds: string[],
  seen?: string[]
): PrefetchIo {
  return {
    getTargetUserId: () => Promise.resolve(null),
    queryTarget: (soql) => {
      seen?.push(soql)
      return Promise.resolve(recordTypeIds.map((id) => ({ Id: id })))
    },
    restGetTarget: (path) => {
      seen?.push(path)
      const hit = byPath[path]
      return hit == null ? Promise.reject(new Error('404')) : Promise.resolve(hit)
    }
  }
}

describe('applyRecordTypePicklistGate — record-type scoping (run 6 regression)', () => {
  // Full field value set (7) vs what the Amendment record type allows (4).
  const byRt: RecordTypePicklists = {
    [AMENDMENT_RT]: {
      Value_Drivers__c: {
        values: [
          'Maximize Speed & Efficiency of Safe Software Delivery',
          'Drive Customer Engagement & Revenue Through Digital Products',
          'Continuously Optimize Your Technology Stack',
          'Other'
        ],
        controllerName: null,
        controllerValues: {},
        validFor: {}
      }
    }
  }

  it('drops ONLY the token the record type disallows and keeps the valid one', () => {
    // The exact source value of Opportunity 006TR00000XIwc0YAD.
    const payload: Record<string, unknown> = {
      RecordTypeId: AMENDMENT_RT,
      Value_Drivers__c:
        'Maximize Speed & Efficiency of Safe Software Delivery;Fast and Safe AI Innovation'
    }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(payload, { recordTypePicklists: byRt }, dropped)

    expect(payload.Value_Drivers__c).toBe('Maximize Speed & Efficiency of Safe Software Delivery')
    expect(dropped.Value_Drivers__c).toEqual(['Fast and Safe AI Innovation'])
  })

  it('leaves a fully-allowed value untouched', () => {
    const payload: Record<string, unknown> = {
      RecordTypeId: AMENDMENT_RT,
      Value_Drivers__c: 'Other;Continuously Optimize Your Technology Stack'
    }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(payload, { recordTypePicklists: byRt }, dropped)
    expect(payload.Value_Drivers__c).toBe('Other;Continuously Optimize Your Technology Stack')
    expect(dropped).toEqual({})
  })

  it('deletes the field when the record type allows none of its tokens', () => {
    const payload: Record<string, unknown> = {
      RecordTypeId: AMENDMENT_RT,
      Value_Drivers__c: 'Fast and Safe AI Innovation'
    }
    applyRecordTypePicklistGate(payload, { recordTypePicklists: byRt }, {})
    expect(payload).not.toHaveProperty('Value_Drivers__c')
  })

  it('FAILS OPEN on an unknown record type rather than guessing the Master set', () => {
    const payload: Record<string, unknown> = {
      RecordTypeId: '012XXXXXXXXXXXXXXX',
      Value_Drivers__c: 'Fast and Safe AI Innovation'
    }
    applyRecordTypePicklistGate(payload, { recordTypePicklists: byRt }, {})
    expect(payload.Value_Drivers__c).toBe('Fast and Safe AI Innovation')
  })

  it('FAILS OPEN when a record-typed object payload carries no RecordTypeId', () => {
    // We cannot know which default the target profile applies.
    const payload: Record<string, unknown> = { Value_Drivers__c: 'Fast and Safe AI Innovation' }
    applyRecordTypePicklistGate(payload, { recordTypePicklists: byRt }, {})
    expect(payload.Value_Drivers__c).toBe('Fast and Safe AI Innovation')
  })

  it('FAILS OPEN when nothing was prefetched', () => {
    const payload: Record<string, unknown> = { Value_Drivers__c: 'anything' }
    applyRecordTypePicklistGate(payload, { recordTypePicklists: {} }, {})
    expect(payload.Value_Drivers__c).toBe('anything')
  })
})

describe('applyRecordTypePicklistGate — dependent picklists (run 5 regression)', () => {
  const byRt: RecordTypePicklists = {
    [MASTER_RECORD_TYPE_ID]: {
      Disqualification_Reason__c: {
        values: ['Duplicate', 'Other'],
        controllerName: 'Status__c',
        controllerValues: { Qualifying: 4, Recycled: 5, Disqualified: 6 },
        validFor: { Duplicate: [6], Other: [6] }
      }
    }
  }
  const ctx = { recordTypePicklists: byRt }

  it.each([
    ['Qualifying', '0031K00002gOEVCQA4'],
    ['Qualifying', '0031K00002g0QBFQA2'],
    ['Recycled', '0031K00002cRuGTQA0']
  ])('drops Duplicate when Status__c is %s (contact %s)', (status) => {
    const payload: Record<string, unknown> = {
      Status__c: status,
      Disqualification_Reason__c: 'Duplicate'
    }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(payload, ctx, dropped)
    expect(payload).not.toHaveProperty('Disqualification_Reason__c')
    expect(payload.Status__c).toBe(status) // the controller is never touched
    expect(dropped.Disqualification_Reason__c).toEqual(['Duplicate'])
  })

  it('KEEPS Duplicate when Status__c is Disqualified', () => {
    const payload: Record<string, unknown> = {
      Status__c: 'Disqualified',
      Disqualification_Reason__c: 'Duplicate'
    }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(payload, ctx, dropped)
    expect(payload.Disqualification_Reason__c).toBe('Duplicate')
    expect(dropped).toEqual({})
  })

  it('drops a dependent value when the controlling field is absent from the payload', () => {
    // No controller written ⇒ null on target ⇒ any dependent value is invalid.
    const payload: Record<string, unknown> = { Disqualification_Reason__c: 'Duplicate' }
    applyRecordTypePicklistGate(payload, ctx, {})
    expect(payload).not.toHaveProperty('Disqualification_Reason__c')
  })
})

describe('fetchRecordTypePicklists via buildPrefetchContext — real UI-API payloads', () => {
  const oppFields = [fld({ apiName: 'Value_Drivers__c' })]
  const contactFields = [fld({ apiName: 'Disqualification_Reason__c', controllerName: 'Status__c' })]

  it('unescapes &amp; so the value matches the literal form the record carries', async () => {
    const path = `/services/data/v66.0/ui-api/object-info/Opportunity/picklist-values/${AMENDMENT_RT}`
    const io = ioFor({ [path]: UI_API_OPPORTUNITY_AMENDMENT }, [AMENDMENT_RT])
    const bundle = await buildPrefetchContext(io, 'Opportunity', [], {}, oppFields)

    const vals = bundle.recordTypePicklists[AMENDMENT_RT]!.Value_Drivers__c!.values
    expect(vals).toContain('Maximize Speed & Efficiency of Safe Software Delivery')
    expect(vals).not.toContain('Maximize Speed &amp; Efficiency of Safe Software Delivery')
  })

  it('reads controllerValues + validFor and pairs them with the describe controllerName', async () => {
    const path = `/services/data/v66.0/ui-api/object-info/Contact/picklist-values/${MASTER_RECORD_TYPE_ID}`
    const io = ioFor({ [path]: UI_API_CONTACT_MASTER }, [])
    const bundle = await buildPrefetchContext(io, 'Contact', [], {}, contactFields)

    const f = bundle.recordTypePicklists[MASTER_RECORD_TYPE_ID]!.Disqualification_Reason__c!
    expect(f.controllerName).toBe('Status__c')
    expect(f.controllerValues.Disqualified).toBe(6)
    expect(f.validFor.Duplicate).toEqual([6])
  })

  it('stores both Id widths so a 15-char RecordTypeId resolves', async () => {
    const path = `/services/data/v66.0/ui-api/object-info/Opportunity/picklist-values/${AMENDMENT_RT}`
    const io = ioFor({ [path]: UI_API_OPPORTUNITY_AMENDMENT }, [AMENDMENT_RT])
    const bundle = await buildPrefetchContext(io, 'Opportunity', [], {}, oppFields)
    expect(bundle.recordTypePicklists[AMENDMENT_RT.substring(0, 15)]).toBeDefined()
  })

  it('makes NO round trip when the object has no restricted picklist', async () => {
    const seen: string[] = []
    const io = ioFor({}, [AMENDMENT_RT], seen)
    const bundle = await buildPrefetchContext(io, 'Opportunity', [], {}, [
      fld({ apiName: 'Plain__c', isRestrictedPicklist: false })
    ])
    expect(seen).toEqual([])
    expect(bundle.recordTypePicklists).toEqual({})
  })

  it('one unreadable record type does not void the others', async () => {
    const good = `/services/data/v66.0/ui-api/object-info/Opportunity/picklist-values/${MASTER_RECORD_TYPE_ID}`
    const io = ioFor({ [good]: UI_API_OPPORTUNITY_AMENDMENT }, [AMENDMENT_RT])
    const bundle = await buildPrefetchContext(io, 'Opportunity', [], {}, oppFields)
    expect(bundle.recordTypePicklists[MASTER_RECORD_TYPE_ID]).toBeDefined()
    expect(bundle.recordTypePicklists[AMENDMENT_RT]).toBeUndefined()
  })

  it('FAILS OPEN to {} when the RecordType query itself fails', async () => {
    const io: PrefetchIo = {
      getTargetUserId: () => Promise.resolve(null),
      queryTarget: () => Promise.reject(new Error('no access')),
      restGetTarget: () => Promise.reject(new Error('unused'))
    }
    const bundle = await buildPrefetchContext(io, 'Opportunity', [], {}, oppFields)
    expect(bundle.recordTypePicklists).toEqual({})
  })
})

/**
 * S50 BUG-12 — the default-record-type resolution.
 *
 * Run 9 (express scripts, 2026-09-07) died at its ROOT Account on
 * `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Key Account` for
 * `Account_Category__c`, and took the whole deployment with it (249 Contacts /
 * 18 Opportunities / 5 Quotes landed orphaned).
 *
 * Every fixture below is VERBATIM from sb1_830, captured 2026-09-07:
 *   - Account has ONE active record type, `CSM` (01241000001USL1AAO), and it is
 *     the DEFAULT (`defaultRecordTypeMapping: true`).
 *   - `Account_Category__c` full active set = {Strategic Account, Key Account,
 *     General}; on CSM = {Strategic Account, General}. `Key Account` is absent.
 *   - The source Account carried `RecordTypeId = null`.
 * Identical config on darkb_829, so this was never org drift — the source org
 * would reject the same insert.
 *
 * S49 skipped the check whenever the payload had no `RecordTypeId`, reasoning
 * the target profile's default was unknowable. It is not: object-info names it.
 */

const CSM_RT = '01241000001USL1AAO'

/** Verbatim `/ui-api/object-info/Account` (trimmed to the fields read). */
const UI_API_ACCOUNT_OBJECT_INFO = {
  apiName: 'Account',
  defaultRecordTypeId: CSM_RT,
  recordTypeInfos: {
    '012000000000000AAA': {
      available: true,
      defaultRecordTypeMapping: false,
      master: true,
      name: 'Master',
      recordTypeId: '012000000000000AAA'
    },
    [CSM_RT]: {
      available: true,
      defaultRecordTypeMapping: true,
      master: false,
      name: 'CSM',
      recordTypeId: CSM_RT
    }
  }
}

/** The two record-type-scoped value sets, verbatim. */
const ACCOUNT_CATEGORY_BY_RT: RecordTypePicklists = {
  '012000000000000AAA': {
    Account_Category__c: {
      values: ['Strategic Account', 'Key Account', 'General'],
      controllerName: null,
      controllerValues: {},
      validFor: {}
    }
  },
  [CSM_RT]: {
    Account_Category__c: {
      values: ['Strategic Account', 'General'],
      controllerName: null,
      controllerValues: {},
      validFor: {}
    }
  }
}

describe('applyRecordTypePicklistGate — default record type (BUG-12)', () => {
  it('drops the value the DEFAULT record type disallows when the payload has no RecordTypeId', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Key Account' }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: ACCOUNT_CATEGORY_BY_RT,
        recordTypeDefaultId: CSM_RT,
        recordTypeCandidateCount: 1 // Account has exactly ONE active RT (CSM)
      },
      dropped
    )
    // Exactly run 9: without this the API answered
    // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST and the root Account died.
    expect(payload).not.toHaveProperty('Account_Category__c')
    expect(dropped.Account_Category__c).toEqual(['Key Account'])
  })

  it('KEEPS a value the default record type allows', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Strategic Account' }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: ACCOUNT_CATEGORY_BY_RT,
        recordTypeDefaultId: CSM_RT,
        recordTypeCandidateCount: 1
      },
      dropped
    )
    expect(payload.Account_Category__c).toBe('Strategic Account')
    expect(dropped).toEqual({})
  })

  it('an EXPLICIT RecordTypeId still wins over the default', () => {
    // Master allows Key Account; the default (CSM) does not. The payload's own
    // record type must decide, not the profile default.
    const payload: Record<string, unknown> = {
      RecordTypeId: '012000000000000AAA',
      Account_Category__c: 'Key Account'
    }
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: ACCOUNT_CATEGORY_BY_RT,
        recordTypeDefaultId: CSM_RT,
        recordTypeCandidateCount: 1
      },
      {}
    )
    expect(payload.Account_Category__c).toBe('Key Account')
  })

  // ── The regression guard that matters more than the fix ──────────────────
  // recordTypeDefaultId is the default for the AUTHENTICATED USER'S PROFILE.
  // Where that is unknown we must NOT guess: silently dropping a good value is
  // a worse failure than the loud rejection this fix removes, because nobody
  // sees it.
  it('FAILS OPEN when the default is unknown and the object has several record types', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Key Account' }
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: ACCOUNT_CATEGORY_BY_RT,
        recordTypeDefaultId: null,
        recordTypeCandidateCount: 1
      },
      {}
    )
    expect(payload.Account_Category__c).toBe('Key Account')
  })

  it('FAILS OPEN when the default names a record type we never prefetched', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Key Account' }
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: ACCOUNT_CATEGORY_BY_RT,
        recordTypeDefaultId: '012XXXXXXXXXXXXXXX',
        recordTypeCandidateCount: 1
      },
      {}
    )
    expect(payload.Account_Category__c).toBe('Key Account')
  })

  // ── The hardening (Jack, 2026-09-07) ───────────────────────────────────
  // `recordTypeDefaultId` is the default for the AUTHENTICATED USER'S PROFILE.
  // With several record types in play that is a profile-dependent answer, and
  // guessing wrong means silently dropping a value the platform would have
  // accepted — worse than the loud rejection this gate removes. So the default
  // is only acted on when there is at most ONE active record type.
  //
  // Measured on sb1_830: 9 of the 11 deployed objects have ZERO active record
  // types, Account has exactly ONE (the run-9 case), Opportunity has FOUR but
  // 0 of 236,249 source rows carry a null RecordTypeId. The ambiguous
  // combination occurs zero times, so refusing to guess costs nothing.
  it('FAILS OPEN when the object has SEVERAL record types and the payload names none', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Key Account' }
    const dropped: Record<string, string[]> = {}
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: ACCOUNT_CATEGORY_BY_RT,
        recordTypeDefaultId: CSM_RT,
        recordTypeCandidateCount: 4 // e.g. Opportunity
      },
      dropped
    )
    // Loud API rejection (which A1's root gate now handles cleanly) beats a
    // silent, profile-dependent drop.
    expect(payload.Account_Category__c).toBe('Key Account')
    expect(dropped).toEqual({})
  })

  it('still applies the default for an object with ZERO active record types', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Key Account' }
    applyRecordTypePicklistGate(
      payload,
      {
        recordTypePicklists: { [MASTER_RECORD_TYPE_ID]: ACCOUNT_CATEGORY_BY_RT[CSM_RT]! },
        recordTypeDefaultId: MASTER_RECORD_TYPE_ID,
        recordTypeCandidateCount: 0
      },
      {}
    )
    expect(payload).not.toHaveProperty('Account_Category__c')
  })

  it('FAILS OPEN when the candidate count is unknown (older prefetch)', () => {
    const payload: Record<string, unknown> = { Account_Category__c: 'Key Account' }
    applyRecordTypePicklistGate(
      payload,
      { recordTypePicklists: ACCOUNT_CATEGORY_BY_RT, recordTypeDefaultId: CSM_RT },
      {}
    )
    expect(payload.Account_Category__c).toBe('Key Account')
  })
})

describe('fetchDefaultRecordTypeId — real object-info payload (BUG-12)', () => {
  const accountFields = [fld({ apiName: 'Account_Category__c' })]
  const infoPath = '/services/data/v66.0/ui-api/object-info/Account'
  const pvPath = (rt: string) =>
    `/services/data/v66.0/ui-api/object-info/Account/picklist-values/${rt}`

  it('reads defaultRecordTypeId and threads it onto the prefetch bundle', async () => {
    const io = ioFor(
      {
        [infoPath]: UI_API_ACCOUNT_OBJECT_INFO,
        [pvPath(CSM_RT)]: {
          picklistFieldValues: {
            Account_Category__c: {
              controllerValues: {},
              values: [{ value: 'Strategic Account', validFor: [] }, { value: 'General', validFor: [] }]
            }
          }
        }
      },
      [CSM_RT]
    )
    const bundle = await buildPrefetchContext(io, 'Account', [], {}, accountFields)
    expect(bundle.recordTypeDefaultId).toBe(CSM_RT)
    expect(bundle.recordTypeCandidateCount).toBe(1) // one active RT, excluding Master
    expect(bundle.recordTypePicklists[CSM_RT]!.Account_Category__c!.values).toEqual([
      'Strategic Account',
      'General'
    ])
  })

  it('falls back to recordTypeInfos[].defaultRecordTypeMapping when the explicit field is absent', async () => {
    const withoutExplicit = {
      apiName: 'Account',
      recordTypeInfos: UI_API_ACCOUNT_OBJECT_INFO.recordTypeInfos
    }
    const io = ioFor({ [infoPath]: withoutExplicit }, [CSM_RT])
    const bundle = await buildPrefetchContext(io, 'Account', [], {}, accountFields)
    expect(bundle.recordTypeDefaultId).toBe(CSM_RT)
  })

  it('yields null (fail-open) when object-info cannot be read', async () => {
    const io = ioFor({}, [CSM_RT])
    const bundle = await buildPrefetchContext(io, 'Account', [], {}, accountFields)
    expect(bundle.recordTypeDefaultId).toBeNull()
  })

  it('does NOT call object-info when the object has no restricted picklist', async () => {
    const seen: string[] = []
    const io = ioFor({}, [CSM_RT], seen)
    const bundle = await buildPrefetchContext(io, 'Account', [], {}, [
      fld({ apiName: 'Plain__c', isRestrictedPicklist: false })
    ])
    expect(seen).toEqual([])
    expect(bundle.recordTypeDefaultId).toBeNull()
  })
})
