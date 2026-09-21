import { describe, it, expect } from 'vitest'
import {
  transformStage1,
  type Stage1Context,
  type GoldenFieldInfo
} from '../src/main/engine/deploy/transform/stage1'
import {
  generateExternalId,
  reverse,
  to18,
  EXTERNAL_ID_FIELD
} from '../src/main/engine/deploy/transform/sfid'

/**
 * E4X.3 unit suite for `transformStage1` — the `transformRecordV2` core
 * (DataDeploymentService.cls:876-1034 minus synthesis). One case per strategy
 * branch plus the guard/edge behaviors the task AC calls out: null/blank source
 * values, 15-char input Ids, Apex case-insensitive `==` (trap 1), Java-exact
 * blank (NBSP is NOT whitespace), and untouched source-value passthrough (trap 8).
 *
 * The full byte-for-byte golden replay against captured Apex fixtures is E4X.8;
 * here `sfid` (E4X.1, separately tested) is the oracle for computed ExtIds, so
 * these assert stage-1 *wiring* + branch selection, not the codec itself.
 */

// Real 18/15-char ldseed Ids (same provenance as sfid.test.ts).
const ACCT_18 = '001fn000003abcdAAQ'
const ACCT_15 = '001fn000003abcd'
const USER_A_18 = '005fn000003twuUAAQ'
const USER_B_18 = '005fn000003tx2XAAQ'

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
  partial: Partial<Stage1Context> & { objectName: string; fields: GoldenFieldInfo[] }
): Stage1Context {
  return {
    deferredFields: [],
    mappings: {},
    nameMatchMaps: {},
    targetUserId: null,
    inactiveUserIds: [],
    targetFieldsByName: {}, // S50 (BUG-14): no enforced lookup filters by default
    ...partial
  }
}

const ref = (
  apiName: string,
  referenceTo: string,
  relationshipName: string | null
): GoldenFieldInfo =>
  fi({ apiName, isReference: true, referenceTo: [referenceTo], relationshipName })

describe('transformStage1 — self ExternalId', () => {
  it('sets the ExtId field from the source Id (18-char)', () => {
    const out = transformStage1({ Id: ACCT_18 }, ctx({ objectName: 'Account', fields: [] }))
    expect(out[EXTERNAL_ID_FIELD]).toBe(generateExternalId(ACCT_18))
    expect(out[EXTERNAL_ID_FIELD]).toBe(reverse(ACCT_18))
  })

  it('expands a 15-char source Id to 18 before reversing', () => {
    const out = transformStage1({ Id: ACCT_15 }, ctx({ objectName: 'Account', fields: [] }))
    // 15-char path: reverse(to18(id15)) — independent oracle, not just generateExternalId.
    expect(out[EXTERNAL_ID_FIELD]).toBe(reverse(to18(ACCT_15)))
  })

  it('omits the ExtId key entirely when the source Id is absent/null', () => {
    expect(transformStage1({}, ctx({ objectName: 'Account', fields: [] }))).not.toHaveProperty(
      EXTERNAL_ID_FIELD
    )
    expect(
      transformStage1({ Id: null }, ctx({ objectName: 'Account', fields: [] }))
    ).not.toHaveProperty(EXTERNAL_ID_FIELD)
  })
})

describe('transformStage1 — field guards', () => {
  const rec = { Id: ACCT_18, Foo__c: 'keep', Bar: 'drop' }

  it('drops non-createable / autoNumber / calculated / Id / ExtId / system-managed / deferred', () => {
    const fields = [
      fi({ apiName: 'Foo__c' }),
      fi({ apiName: 'NonCreate', isCreateable: false }),
      fi({ apiName: 'AutoNum', isAutoNumber: true }),
      fi({ apiName: 'Formula', isCalculated: true }),
      fi({ apiName: 'Id' }),
      fi({ apiName: EXTERNAL_ID_FIELD }),
      fi({ apiName: 'CreatedById' }), // SYSTEM_MANAGED_FIELDS
      fi({ apiName: 'Deferred__c' })
    ]
    const record = {
      ...rec,
      NonCreate: 'x',
      AutoNum: 'x',
      Formula: 'x',
      CreatedById: USER_A_18,
      Deferred__c: 'x',
      [EXTERNAL_ID_FIELD]: 'sourceExtIdShouldBeIgnored'
    }
    const out = transformStage1(
      record,
      ctx({ objectName: 'Account', fields, deferredFields: ['Deferred__c'] })
    )
    expect(out).toEqual({
      [EXTERNAL_ID_FIELD]: generateExternalId(ACCT_18),
      Foo__c: 'keep'
    })
  })

  it('applies guards case-insensitively (Apex == on field names — trap 1)', () => {
    const out = transformStage1(
      { Id: ACCT_18, id: 'x' },
      ctx({ objectName: 'Account', fields: [fi({ apiName: 'id' })] })
    )
    // 'id' guard-matches 'Id' → dropped; only the self-ExtId remains.
    expect(out).toEqual({ [EXTERNAL_ID_FIELD]: generateExternalId(ACCT_18) })
  })
})

describe('transformStage1 — regular field copy + blank drop', () => {
  const base = ctx({ objectName: 'Account', fields: [fi({ apiName: 'Name' })] })

  it('copies a non-null, non-blank value', () => {
    expect(transformStage1({ Id: ACCT_18, Name: 'Acme' }, base).Name).toBe('Acme')
  })

  it('drops null and whitespace-only string values', () => {
    expect(transformStage1({ Id: ACCT_18, Name: null }, base)).not.toHaveProperty('Name')
    expect(transformStage1({ Id: ACCT_18, Name: '   ' }, base)).not.toHaveProperty('Name')
    expect(transformStage1({ Id: ACCT_18, Name: '' }, base)).not.toHaveProperty('Name')
  })

  it('keeps a non-Java-whitespace-only string (NBSP is NOT blank — Session-30 parity)', () => {
    const nbsp = ' '
    expect(transformStage1({ Id: ACCT_18, Name: nbsp }, base).Name).toBe(nbsp)
  })

  it('passes numeric/boolean/zero values through untouched (trap 8)', () => {
    const fields = [
      fi({ apiName: 'Amt', dataType: 'currency' }),
      fi({ apiName: 'Flag', dataType: 'boolean' }),
      fi({ apiName: 'Cnt', dataType: 'int' })
    ]
    const out = transformStage1(
      { Id: ACCT_18, Amt: 1234.5678, Flag: false, Cnt: 0 },
      ctx({ objectName: 'Account', fields })
    )
    expect(out.Amt).toBe(1234.5678)
    expect(out.Flag).toBe(false)
    expect(out.Cnt).toBe(0)
  })
})

describe('transformStage1 — Contract Status → Draft', () => {
  it('forces Draft regardless of the source Status', () => {
    const out = transformStage1(
      { Id: ACCT_18, Status: 'Activated' },
      ctx({ objectName: 'Contract', fields: [fi({ apiName: 'Status', dataType: 'picklist' })] })
    )
    expect(out.Status).toBe('Draft')
  })

  it('matches the object name case-insensitively (trap 1)', () => {
    const out = transformStage1(
      { Id: ACCT_18, Status: 'Activated' },
      ctx({ objectName: 'contract', fields: [fi({ apiName: 'Status', dataType: 'picklist' })] })
    )
    expect(out.Status).toBe('Draft')
  })

  it('does NOT override Status on a non-Contract object', () => {
    const out = transformStage1(
      { Id: ACCT_18, Status: 'Open' },
      ctx({ objectName: 'Case', fields: [fi({ apiName: 'Status', dataType: 'picklist' })] })
    )
    expect(out.Status).toBe('Open')
  })
})

describe('transformStage1 — externalId strategy', () => {
  const acctRef = ref('AccountId', 'Account', 'Account')

  it('emits a relationship-shaped parent ExtId reference', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_18 },
      ctx({
        objectName: 'Contact',
        fields: [acctRef],
        mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
      })
    )
    expect(out.Account).toEqual({ [EXTERNAL_ID_FIELD]: generateExternalId(ACCT_18) })
    expect(out).not.toHaveProperty('AccountId')
  })

  it('expands a 15-char parent lookup Id to 18 before reversing', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_15 },
      ctx({
        objectName: 'Contact',
        fields: [acctRef],
        mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
      })
    )
    expect(out.Account).toEqual({ [EXTERNAL_ID_FIELD]: reverse(to18(ACCT_15)) })
  })

  it('drops the field when the relationship name is blank', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_18 },
      ctx({
        objectName: 'Contact',
        fields: [ref('AccountId', 'Account', null)],
        mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
      })
    )
    expect(out).not.toHaveProperty('Account')
    expect(out).not.toHaveProperty('AccountId')
  })

  it('drops the field when the source lookup is null or blank', () => {
    const c = ctx({
      objectName: 'Contact',
      fields: [acctRef],
      mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
    })
    expect(transformStage1({ Id: ACCT_18, AccountId: null }, c)).not.toHaveProperty('Account')
    expect(transformStage1({ Id: ACCT_18, AccountId: '   ' }, c)).not.toHaveProperty('Account')
  })
})

describe('transformStage1 — nameMatch strategy', () => {
  const acctRef = ref('AccountId', 'Account', 'Account')
  const withMap = (map: Record<string, Record<string, string>>): Stage1Context =>
    ctx({
      objectName: 'Contact',
      fields: [acctRef],
      mappings: { AccountId: { strategy: 'nameMatch', matchField: 'Name', customValue: null } },
      nameMatchMaps: map
    })

  it('resolves the source Id to a target Id via the pre-built map', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_18 },
      withMap({ Account: { [ACCT_18]: '001TARGETtarget01' } })
    )
    expect(out.AccountId).toBe('001TARGETtarget01')
  })

  it('drops the field on a no-match (Salesforce assigns a default, e.g. RecordType)', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_18 },
      withMap({ Account: { someOtherId: 't' } })
    )
    expect(out).not.toHaveProperty('AccountId')
  })

  it('drops the field when there is no map for the referenced object', () => {
    const out = transformStage1({ Id: ACCT_18, AccountId: ACCT_18 }, withMap({}))
    expect(out).not.toHaveProperty('AccountId')
  })
})

describe('transformStage1 — RecordTypeId force-nameMatch', () => {
  it('always nameMatches RecordTypeId even when a directId mapping is saved', () => {
    const out = transformStage1(
      { Id: ACCT_18, RecordTypeId: '012SOURCErtSrc01' },
      ctx({
        objectName: 'Account',
        fields: [ref('RecordTypeId', 'RecordType', 'RecordType')],
        // A stale saved mapping that MUST be ignored.
        mappings: { RecordTypeId: { strategy: 'directId', matchField: null, customValue: null } },
        nameMatchMaps: { RecordType: { '012SOURCErtSrc01': '012TARGETrtTgt01' } }
      })
    )
    expect(out.RecordTypeId).toBe('012TARGETrtTgt01')
  })
})

describe('transformStage1 — directId strategy + inactive-user substitution', () => {
  const ownerRef = ref('OwnerId', 'User', 'Owner')
  const dispatch = (over: Partial<Stage1Context> = {}): Stage1Context =>
    ctx({
      objectName: 'Account',
      fields: [ownerRef],
      mappings: { OwnerId: { strategy: 'directId', matchField: null, customValue: null } },
      ...over
    })

  it('copies the raw source Id verbatim by default', () => {
    expect(transformStage1({ Id: ACCT_18, OwnerId: USER_A_18 }, dispatch()).OwnerId).toBe(USER_A_18)
  })

  it('substitutes the connected user when the target User is inactive', () => {
    const out = transformStage1(
      { Id: ACCT_18, OwnerId: USER_A_18 },
      dispatch({ inactiveUserIds: [USER_A_18], targetUserId: USER_B_18 })
    )
    expect(out.OwnerId).toBe(USER_B_18)
  })

  it('sends the raw (inactive) value when there is no connected user to substitute', () => {
    const out = transformStage1(
      { Id: ACCT_18, OwnerId: USER_A_18 },
      dispatch({ inactiveUserIds: [USER_A_18], targetUserId: null })
    )
    expect(out.OwnerId).toBe(USER_A_18)
  })

  // ── S50 BUG-14 ──────────────────────────────────────────────────────────
  // Run 11 (express scripts, 2026-09-07) died on its ROOT Account with
  // `FIELD_FILTER_VALIDATION_EXCEPTION: The Technical Account Manager is not
  // the correct type of User for this field`. The source TAM is an
  // inactive user, so this branch substituted the connected user —
  // who does not satisfy that field's ENFORCED lookup filter. A substitution
  // that exists to avoid one hard failure manufactured another, on the root
  // record, and took the whole deployment down with it.
  describe('enforced lookup filters (BUG-14)', () => {
    const TAM = 'Technical_Account_Manager__c'
    const tamRef = ref(TAM, 'User', 'Technical_Account_Manager__r')
    const withFilter = (enforced: boolean | undefined): Stage1Context =>
      ctx({
        objectName: 'Account',
        fields: [tamRef],
        mappings: { [TAM]: { strategy: 'directId', matchField: null, customValue: null } },
        inactiveUserIds: [USER_A_18],
        targetUserId: USER_B_18,
        targetFieldsByName:
          enforced === undefined ? {} : { [TAM]: { ...tamRef, hasEnforcedLookupFilter: enforced } }
      })

    it('DROPS rather than substitutes when the target lookup enforces a filter', () => {
      const dropped: string[] = []
      const out = transformStage1({ Id: ACCT_18, [TAM]: USER_A_18 }, withFilter(true), dropped)
      // Blank beats wrong: the substitute is false data either way ("Jack is
      // the TAM" is not true), and it also fails the filter.
      expect(out).not.toHaveProperty(TAM)
      expect(dropped).toEqual([TAM])
    })

    it('still substitutes when the filter is OPTIONAL (UI-only, API accepts anything)', () => {
      const dropped: string[] = []
      const out = transformStage1({ Id: ACCT_18, [TAM]: USER_A_18 }, withFilter(false), dropped)
      expect(out[TAM]).toBe(USER_B_18)
      expect(dropped).toEqual([])
    })

    it('still substitutes when the target field is unknown (older fixtures)', () => {
      const dropped: string[] = []
      const out = transformStage1({ Id: ACCT_18, [TAM]: USER_A_18 }, withFilter(undefined), dropped)
      expect(out[TAM]).toBe(USER_B_18)
      expect(dropped).toEqual([])
    })

    it('leaves an ACTIVE user alone even on an enforced-filter field', () => {
      // No substitution is attempted, so there is nothing for the guard to do —
      // the real user, who presumably satisfies the filter, is sent verbatim.
      const dropped: string[] = []
      const c = withFilter(true)
      const out = transformStage1({ Id: ACCT_18, [TAM]: USER_B_18 }, c, dropped)
      expect(out[TAM]).toBe(USER_B_18)
      expect(dropped).toEqual([])
    })
  })

  it('does NOT substitute for a non-User reference even if the Id is in the inactive set', () => {
    const out = transformStage1(
      { Id: ACCT_18, ParentAcct__c: ACCT_18 },
      ctx({
        objectName: 'Account',
        fields: [ref('ParentAcct__c', 'Account', 'ParentAcct__r')],
        mappings: {
          ParentAcct__c: { strategy: 'directId', matchField: null, customValue: null }
        },
        inactiveUserIds: [ACCT_18],
        targetUserId: USER_B_18
      })
    )
    expect(out.ParentAcct__c).toBe(ACCT_18)
  })

  it('treats a mis-cased strategy literal as directId (Apex == is case-insensitive)', () => {
    const out = transformStage1(
      { Id: ACCT_18, OwnerId: USER_A_18 },
      ctx({
        objectName: 'Account',
        fields: [ownerRef],
        mappings: { OwnerId: { strategy: 'DirectId', matchField: null, customValue: null } }
      })
    )
    expect(out.OwnerId).toBe(USER_A_18)
  })
})

describe('transformStage1 — customId + setToMe (source-independent)', () => {
  it('emits the fixed customValue', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: 'ignored' },
      ctx({
        objectName: 'Contact',
        fields: [ref('AccountId', 'Account', 'Account')],
        mappings: {
          AccountId: { strategy: 'customId', matchField: null, customValue: '001FIXEDvalue001' }
        }
      })
    )
    expect(out.AccountId).toBe('001FIXEDvalue001')
  })

  it('drops the field when the customValue is blank', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: 'ignored' },
      ctx({
        objectName: 'Contact',
        fields: [ref('AccountId', 'Account', 'Account')],
        mappings: { AccountId: { strategy: 'customId', matchField: null, customValue: '   ' } }
      })
    )
    expect(out).not.toHaveProperty('AccountId')
  })

  it('setToMe emits the connected user, or drops the field if unresolved', () => {
    const c = (targetUserId: string | null): Stage1Context =>
      ctx({
        objectName: 'Account',
        fields: [ref('OwnerId', 'User', 'Owner')],
        mappings: { OwnerId: { strategy: 'setToMe', matchField: null, customValue: null } },
        targetUserId
      })
    expect(transformStage1({ Id: ACCT_18, OwnerId: USER_A_18 }, c(USER_B_18)).OwnerId).toBe(USER_B_18)
    expect(transformStage1({ Id: ACCT_18, OwnerId: USER_A_18 }, c(null))).not.toHaveProperty(
      'OwnerId'
    )
  })
})

describe('transformStage1 — skip / self-lookup / unmapped default', () => {
  it('drops an explicitly skipped reference', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_18 },
      ctx({
        objectName: 'Contact',
        fields: [ref('AccountId', 'Account', 'Account')],
        mappings: { AccountId: { strategy: 'skip', matchField: null, customValue: null } }
      })
    )
    expect(out).not.toHaveProperty('AccountId')
    expect(out).not.toHaveProperty('Account')
  })

  it('skips a self-lookup (refObj === objectName) to avoid a circular reference', () => {
    const out = transformStage1(
      { Id: ACCT_18, ParentId: ACCT_18 },
      ctx({
        objectName: 'Account',
        fields: [ref('ParentId', 'Account', 'Parent')]
        // no mapping → self-lookup → skip
      })
    )
    expect(out).not.toHaveProperty('ParentId')
    expect(out).not.toHaveProperty('Parent')
  })

  it('defaults an unmapped non-self reference to skip', () => {
    const out = transformStage1(
      { Id: ACCT_18, AccountId: ACCT_18 },
      ctx({ objectName: 'Contact', fields: [ref('AccountId', 'Account', 'Account')] })
    )
    expect(out).not.toHaveProperty('AccountId')
    expect(out).not.toHaveProperty('Account')
  })
})

describe('transformStage1 — OpportunityLineItem price exclusivity', () => {
  const fields = [
    fi({ apiName: 'UnitPrice', dataType: 'currency' }),
    fi({ apiName: 'TotalPrice', dataType: 'currency' })
  ]

  it('drops TotalPrice when both prices are present', () => {
    const out = transformStage1(
      { Id: ACCT_18, UnitPrice: 100, TotalPrice: 200 },
      ctx({ objectName: 'OpportunityLineItem', fields })
    )
    expect(out.UnitPrice).toBe(100)
    expect(out).not.toHaveProperty('TotalPrice')
  })

  it('keeps TotalPrice when UnitPrice is absent', () => {
    const out = transformStage1(
      { Id: ACCT_18, TotalPrice: 200 },
      ctx({ objectName: 'OpportunityLineItem', fields })
    )
    expect(out.TotalPrice).toBe(200)
  })

  it('does not touch prices on a non-OLI object', () => {
    const out = transformStage1(
      { Id: ACCT_18, UnitPrice: 100, TotalPrice: 200 },
      ctx({ objectName: 'Account', fields })
    )
    expect(out.UnitPrice).toBe(100)
    expect(out.TotalPrice).toBe(200)
  })
})

/**
 * Parity-boundary hardening (E4X.3 adversarial review). The review found ZERO
 * code defects; these lock three parity properties the existing suite didn't
 * exercise, so a future "helpful" refactor that diverges from Apex fails loudly:
 *   (1) customId / setToMe are SOURCE-INDEPENDENT (Apex emit above the source
 *       null-guard, DDS L937-951);
 *   (2) an empty referenceTo (refObj === null) → directId emits raw / nameMatch
 *       drops (Apex L912-913, L976, L996);
 *   (3) Set membership is case-SENSITIVE (Apex Set.contains — must NOT fold case).
 */
describe('transformStage1 — parity-boundary hardening', () => {
  it('customId emits its fixed value even when the mapped source field is absent', () => {
    const out = transformStage1(
      { Id: ACCT_18 }, // no AccountId key at all
      ctx({
        objectName: 'Contact',
        fields: [ref('AccountId', 'Account', 'Account')],
        mappings: {
          AccountId: { strategy: 'customId', matchField: null, customValue: '001FIXEDvalue001' }
        }
      })
    )
    expect(out.AccountId).toBe('001FIXEDvalue001')
  })

  it('setToMe emits the connected user even when the mapped source field is absent', () => {
    const out = transformStage1(
      { Id: ACCT_18 }, // no OwnerId key
      ctx({
        objectName: 'Account',
        fields: [ref('OwnerId', 'User', 'Owner')],
        mappings: { OwnerId: { strategy: 'setToMe', matchField: null, customValue: null } },
        targetUserId: USER_B_18
      })
    )
    expect(out.OwnerId).toBe(USER_B_18)
  })

  it('directId with an empty referenceTo emits the raw value (no User substitution)', () => {
    const noRef = fi({
      apiName: 'Mystery__c',
      isReference: true,
      referenceTo: [],
      relationshipName: 'Mystery__r'
    })
    const out = transformStage1(
      { Id: ACCT_18, Mystery__c: USER_A_18 },
      ctx({
        objectName: 'Account',
        fields: [noRef],
        mappings: { Mystery__c: { strategy: 'directId', matchField: null, customValue: null } },
        // In the inactive set + a connected user available, yet refObj===null
        // means the User-substitution branch cannot fire.
        inactiveUserIds: [USER_A_18],
        targetUserId: USER_B_18
      })
    )
    expect(out.Mystery__c).toBe(USER_A_18)
  })

  it('nameMatch with an empty referenceTo drops the field (refObj !== null guard)', () => {
    const noRef = fi({
      apiName: 'Mystery__c',
      isReference: true,
      referenceTo: [],
      relationshipName: 'Mystery__r'
    })
    const out = transformStage1(
      { Id: ACCT_18, Mystery__c: ACCT_18 },
      ctx({
        objectName: 'Account',
        fields: [noRef],
        mappings: { Mystery__c: { strategy: 'nameMatch', matchField: null, customValue: null } },
        nameMatchMaps: { Account: { [ACCT_18]: 'shouldNotBeUsed' } }
      })
    )
    expect(out).not.toHaveProperty('Mystery__c')
  })

  it('deferred-field membership is case-SENSITIVE (mismatched case is NOT skipped)', () => {
    // Apex Set.contains is case-sensitive; a JS Set.has must behave identically.
    const out = transformStage1(
      { Id: ACCT_18, deferred__c: 'kept' },
      ctx({
        objectName: 'Account',
        fields: [fi({ apiName: 'deferred__c' })],
        deferredFields: ['Deferred__c'] // different case → must NOT match → field copied
      })
    )
    expect(out.deferred__c).toBe('kept')
  })

  it('inactive-user membership is case-SENSITIVE (mis-cased Id is NOT substituted)', () => {
    const out = transformStage1(
      { Id: ACCT_18, OwnerId: USER_A_18 },
      ctx({
        objectName: 'Account',
        fields: [ref('OwnerId', 'User', 'Owner')],
        mappings: { OwnerId: { strategy: 'directId', matchField: null, customValue: null } },
        inactiveUserIds: [USER_A_18.toLowerCase()], // mis-cased → no match → raw emitted
        targetUserId: USER_B_18
      })
    )
    expect(out.OwnerId).toBe(USER_A_18)
  })
})
