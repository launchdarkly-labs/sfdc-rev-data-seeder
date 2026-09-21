/**
 * E2.6 — plan freeze: A5 intersection wiring, ordered mapping repairs
 * (A7 → A9 → A10) as warnings, deferred recompute (A12) + skip-prune,
 * consistency validation refusal, junction bypass, canonical serialization.
 *
 * Topology is Acme-shaped: Account → Contact/Opportunity → OLI, plus a
 * CPQ-ish forward-ref pair (Quote → Contract with Contract AFTER Quote) and
 * the OCR junction. The Apex oracle lines are cited in planFreeze.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalPlanJson,
  freezePlan,
  missingOwnExtIdError,
  EXT_ID_REFUSAL_MARKER,
  PlanFreezeError,
  type FreezeInput,
  type FreezeObjectInput
} from '../src/main/engine/deploy/planFreeze'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'
import type { DescribeField } from '../src/main/engine/deploy/transform/fieldFilter'
import type { PlannedObject } from '../src/main/engine/analysis'
import { emptyWizardConfig, type WizardConfig } from '../src/shared/wizard'

function f(apiName: string, over: Partial<DescribeField> = {}): DescribeField {
  return {
    apiName,
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
    picklistValues: null,
    ...over
  }
}

function ref(apiName: string, refTo: string, over: Partial<DescribeField> = {}): DescribeField {
  return f(apiName, {
    isReference: true,
    referenceTo: [refTo],
    relationshipName: apiName.endsWith('__c')
      ? apiName.replace(/__c$/, '__r')
      : apiName.replace(/Id$/, ''),
    ...over
  })
}

function planned(
  objectName: string,
  sortOrder: number,
  over: Partial<PlannedObject> = {}
): PlannedObject {
  return {
    objectName,
    sortOrder,
    hasCircularReference: false,
    deferredFields: [],
    scope: { kind: 'all' },
    scopedFilterDisplay: null,
    recordCount: 10,
    apiStrategy: 'REST',
    gatingTier: null,
    requiresTriggerBypass: false,
    requiresAutomationDisable: false,
    restPageSize: 200,
    recommendedBatchSize: 200,
    isJunction: false,
    junctionParents: null,
    junctionParentFields: null,
    ...over
  }
}

/** The seeder's upsert key as the TARGET describe shows it (S53 item 3 gate). */
const EXT_ID_ON_TARGET = f(EXTERNAL_ID_FIELD, { isExternalId: true })

/**
 * Same describe on both sides unless targetFields overridden. The target side
 * always carries the upsert-key field: since S53 the freeze REFUSES a
 * non-junction object whose target describe lacks it, so every fixture that is
 * not about that gate must model a provisioned target. (Source-only: the field
 * is never SELECTed from the source — stage-1 stamps it from the record Id.)
 */
function obj(
  planned_: PlannedObject,
  sourceFields: DescribeField[],
  targetFields?: DescribeField[],
  opts: { extIdOnTarget?: boolean } = {}
): FreezeObjectInput {
  const target = targetFields ?? sourceFields
  const withKey =
    opts.extIdOnTarget === false || target.some((x) => x.apiName === EXTERNAL_ID_FIELD)
      ? target
      : [...target, EXT_ID_ON_TARGET]
  return { planned: planned_, sourceFields, targetFields: withKey }
}

const ACCOUNT_FIELDS = [f('Name'), ref('ParentId', 'Account'), ref('OwnerId', 'User')]
const CONTACT_FIELDS = [f('LastName'), ref('AccountId', 'Account')]
const OPP_FIELDS = [f('Name'), f('StageName'), ref('AccountId', 'Account')]
const OLI_FIELDS = [
  f('Quantity', { dataType: 'double' }),
  ref('OpportunityId', 'Opportunity'),
  ref('PricebookEntryId', 'PricebookEntry')
]
const QUOTE_FIELDS = [
  f('Name'),
  ref('SBQQ__Account__c', 'Account'),
  ref('SBQQ__MasterContract__c', 'Contract')
]
const CONTRACT_FIELDS = [f('Status'), ref('AccountId', 'Account')]

function buildInput(over: {
  objects?: FreezeObjectInput[]
  config?: Partial<WizardConfig>
  targetHasExtId?: string[]
}): FreezeInput {
  const objects = over.objects ?? [
    obj(planned('Account', 1), ACCOUNT_FIELDS),
    obj(planned('Contact', 2), CONTACT_FIELDS),
    obj(planned('Opportunity', 3), OPP_FIELDS),
    obj(planned('OpportunityLineItem', 4), OLI_FIELDS)
  ]
  const selected = objects.filter((o) => !o.planned.isJunction).map((o) => o.planned.objectName)
  return {
    objects,
    config: { ...emptyWizardConfig(), selectedObjects: selected, ...over.config },
    targetHasExtId: new Set(over.targetHasExtId ?? selected)
  }
}

describe('planFreeze — mapping resolution (sparse overrides → what Apex parseMappings saw)', () => {
  it('resolves policy defaults: in-scope ref → externalId, User → directId, PBE → directId', () => {
    const plan = freezePlan(buildInput({}))
    const account = plan.objects.find((o) => o.objectName === 'Account')!
    const contact = plan.objects.find((o) => o.objectName === 'Contact')!
    const oli = plan.objects.find((o) => o.objectName === 'OpportunityLineItem')!

    expect(contact.mappings['AccountId']).toEqual({
      strategy: 'externalId',
      matchField: null,
      customValue: null
    })
    // User is in DIRECT_ID_DEFAULT_REFS, which getDefaultStrategy checks BEFORE
    // NAME_MATCH_OBJECTS — sibling-sandbox Id sharing makes directId the default.
    expect(account.mappings['OwnerId']).toEqual({
      strategy: 'directId',
      matchField: null,
      customValue: null
    })
    expect(oli.mappings['PricebookEntryId']!.strategy).toBe('directId')
  })

  it('a nameMatch override gets the policy default matchField when none is set', () => {
    const input = buildInput({
      config: { mappings: { Account: { OwnerId: { strategy: 'nameMatch' } } } }
    })
    const plan = freezePlan(input)
    const account = plan.objects.find((o) => o.objectName === 'Account')!
    expect(account.mappings['OwnerId']).toEqual({
      strategy: 'nameMatch',
      matchField: 'Username',
      customValue: null
    })
  })

  it('locked refs resolve skip even against a stale non-skip override', () => {
    // Contract is NOT in scope here → Quote.SBQQ__MasterContract__c is locked.
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('SBQQ__Quote__c', 2), QUOTE_FIELDS)
      ],
      config: {
        mappings: { SBQQ__Quote__c: { SBQQ__MasterContract__c: { strategy: 'externalId' } } }
      }
    })
    const plan = freezePlan(input)
    const quote = plan.objects.find((o) => o.objectName === 'SBQQ__Quote__c')!
    expect(quote.mappings['SBQQ__MasterContract__c']!.strategy).toBe('skip')
  })

  it('RecordTypeId is kept as a field but never appears in mappings (force-nameMatch)', () => {
    const fields = [f('Name'), ref('RecordTypeId', 'RecordType')]
    const plan = freezePlan(buildInput({ objects: [obj(planned('Account', 1), fields)] }))
    const account = plan.objects[0]!
    expect(account.fields).toContain('RecordTypeId')
    expect(account.mappings['RecordTypeId']).toBeUndefined()
  })
})

describe('planFreeze — ordered repairs A7 → A9 → A10 (warnings, not silent mutations)', () => {
  it('A7: explicit skip on OLI.PricebookEntryId promotes to directId with the Apex log text', () => {
    const input = buildInput({
      config: {
        mappings: { OpportunityLineItem: { PricebookEntryId: { strategy: 'skip' } } }
      }
    })
    const plan = freezePlan(input)
    const oli = plan.objects.find((o) => o.objectName === 'OpportunityLineItem')!
    expect(oli.mappings['PricebookEntryId']!.strategy).toBe('directId')
    expect(
      plan.warnings.some((w) =>
        w.startsWith('OLI.PricebookEntryId mapping promoted skip → directId')
      )
    ).toBe(true)
  })

  it('A7 does not fire when PBE resolves to its directId default', () => {
    const plan = freezePlan(buildInput({}))
    expect(plan.warnings.some((w) => w.includes('PricebookEntryId'))).toBe(false)
  })

  it('A9: explicit skip on an in-deployment ref with target ExtId promotes to externalId', () => {
    const input = buildInput({
      config: {
        mappings: { Contact: { AccountId: { strategy: 'skip' } } }
      }
    })
    const plan = freezePlan(input)
    const contact = plan.objects.find((o) => o.objectName === 'Contact')!
    expect(contact.mappings['AccountId']!.strategy).toBe('externalId')
    // The base fixture's Account.ParentId self-ref also auto-promotes — find Contact's.
    const w = plan.warnings.find((x) => x.includes('Auto-promoted') && x.includes('on Contact'))!
    expect(w).toContain('skip → externalId on Contact')
    expect(w).toContain('AccountId → Account')
    expect(w).toContain('Forward/self references resolve in the second pass.')
  })

  it('A9 leaves out-of-scope and ExtId-less refs alone', () => {
    const input = buildInput({
      targetHasExtId: ['Contact', 'Opportunity', 'OpportunityLineItem'], // Account lacks ExtId
      config: { mappings: { Contact: { AccountId: { strategy: 'skip' } } } }
    })
    const plan = freezePlan(input)
    expect(
      plan.objects.find((o) => o.objectName === 'Contact')!.mappings['AccountId']!.strategy
    ).toBe('skip')
    expect(plan.warnings.some((w) => w.includes('Auto-promoted'))).toBe(false)
  })

  it('A10: externalId ref whose target lacks the ExtId field downgrades to skip with a warning', () => {
    // Opportunity.AccountId defaults to externalId (Account in scope) but the
    // target org has no ExtId field on Account.
    const input = buildInput({
      targetHasExtId: ['Contact', 'Opportunity', 'OpportunityLineItem']
    })
    const plan = freezePlan(input)
    const opp = plan.objects.find((o) => o.objectName === 'Opportunity')!
    expect(opp.mappings['AccountId']!.strategy).toBe('skip')
    expect(
      plan.warnings.some((w) =>
        w.includes('Opportunity.AccountId mapping downgraded externalId → skip')
      )
    ).toBe(true)
  })

  it('self-reference chain: locked skip → A9 promotes → A12 defers (self-refs DEPLOY via second pass)', () => {
    const plan = freezePlan(buildInput({}))
    const account = plan.objects.find((o) => o.objectName === 'Account')!
    expect(account.mappings['ParentId']!.strategy).toBe('externalId') // A9 promoted the locked-skip self-ref
    expect(account.deferredFields).toContain('ParentId') // A12 deferred it
    expect(account.hasCircularReference).toBe(true)
  })
})

describe('planFreeze — deferred set (skip-prune + A12 recompute)', () => {
  it('A12: a forward in-deployment ref under externalId gets deferred with a warning', () => {
    // Contract deploys AFTER Quote → Quote.SBQQ__MasterContract__c is a forward ref.
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('SBQQ__Quote__c', 2), QUOTE_FIELDS),
        obj(planned('Contract', 3), CONTRACT_FIELDS)
      ]
    })
    const plan = freezePlan(input)
    const quote = plan.objects.find((o) => o.objectName === 'SBQQ__Quote__c')!
    expect(quote.deferredFields).toContain('SBQQ__MasterContract__c')
    expect(quote.hasCircularReference).toBe(true)
    expect(
      plan.warnings.some(
        (w) =>
          w.includes('Deferred-field recompute added') &&
          w.includes('SBQQ__Quote__c') &&
          w.includes('SBQQ__MasterContract__c')
      )
    ).toBe(true)
  })

  it('A12 leaves backward refs and nameMatch/customId/setToMe strategies alone', () => {
    const plan = freezePlan(buildInput({}))
    const contact = plan.objects.find((o) => o.objectName === 'Contact')!
    expect(contact.deferredFields).toEqual([]) // AccountId is a backward ref
    const account = plan.objects.find((o) => o.objectName === 'Account')!
    expect(account.deferredFields).not.toContain('OwnerId') // nameMatch never defers
  })

  it('a deferred field DROPPED by A5 whose strategy resolves skip is PRUNED, not refused (review fix)', () => {
    // Analysis defers Account.ParentId (self-ref); populated-only then drops it
    // from the intersection (derived 'unpopulated' lock). The Apex-era LWC had
    // saved ParentId:skip (locked self-ref), so the Apex prune removed it and
    // deployed cleanly — freeze must do the same, not throw PlanFreezeError.
    const input = buildInput({
      objects: [
        obj(
          planned('Account', 1, { hasCircularReference: true, deferredFields: ['ParentId'] }),
          ACCOUNT_FIELDS
        )
      ],
      config: { populatedOnly: true }
    })
    input.objects[0]!.populatedFields = ['Name', 'OwnerId'] // no sampled account has a parent
    const plan = freezePlan(input)
    const account = plan.objects[0]!
    expect(account.fields).not.toContain('ParentId') // A5 dropped it
    expect(account.deferredFields).not.toContain('ParentId') // pruned like Apex
    // An explicit user exclusion of the same field behaves identically.
    const excluded = buildInput({
      objects: [
        obj(
          planned('Account', 1, { hasCircularReference: true, deferredFields: ['ParentId'] }),
          ACCOUNT_FIELDS
        )
      ],
      config: { excludedFields: { Account: ['ParentId'] } }
    })
    expect(freezePlan(excluded).objects[0]!.deferredFields).not.toContain('ParentId')
  })

  it('S46 mode A: a deferred field dropped by A5 with a NON-skip strategy is DROPPED with a reasoned warning (was a refusal)', () => {
    // Contact.AccountId resolves externalId (Account in scope) and the user
    // excluded it on the Fields step. Analysis never sees exclusions, so the
    // field is still deferred; the Apex second pass would have PATCHed it
    // anyway. The desktop honors the exclusion (deployDesign §1.2 amendment).
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(
          planned('Contact', 2, { hasCircularReference: true, deferredFields: ['AccountId'] }),
          CONTACT_FIELDS
        )
      ],
      config: { excludedFields: { Contact: ['AccountId'] } }
    })
    const plan = freezePlan(input)
    const contact = plan.objects.find((o) => o.objectName === 'Contact')!
    expect(contact.fields).not.toContain('AccountId')
    expect(contact.deferredFields).toEqual([])
    expect(contact.hasCircularReference).toBe(true) // left as analysis set it
    const w = plan.warnings.find((x) => x.startsWith('Contact.AccountId:'))!
    expect(w).toContain('excluded on the Fields step')
    expect(w).toContain('dropped from the second pass')
    expect(w).toContain('un-exclude it on the Fields step')
    expect(w).toContain('Skip on the Mappings step')
  })

  it('S46 incident fixture: namespace-excluded Account→Contact lookups freeze with one warning each (AdvocateHub)', () => {
    // Suggest Exclusions excluded the AdvocateHub namespace; analysis deferred
    // both lookups (Contact sorts after Account). Deployment 4 refused here.
    const accountFields = [
      ...ACCOUNT_FIELDS,
      ref('AdvocateHub__Referral_Source__c', 'Contact'),
      ref('AdvocateHub__Referrer_Contact__c', 'Contact')
    ]
    const input = buildInput({
      objects: [
        obj(
          planned('Account', 1, {
            hasCircularReference: true,
            deferredFields: [
              'ParentId',
              'AdvocateHub__Referral_Source__c',
              'AdvocateHub__Referrer_Contact__c'
            ]
          }),
          accountFields
        ),
        obj(planned('Contact', 2), CONTACT_FIELDS)
      ],
      config: { excludedNamespaces: ['AdvocateHub'] }
    })
    const plan = freezePlan(input)
    const account = plan.objects.find((o) => o.objectName === 'Account')!
    expect(account.deferredFields).toEqual(['ParentId']) // the self-ref still defers
    expect(account.hasCircularReference).toBe(true)
    const dropped = plan.warnings.filter((w) => w.includes('analysis deferred this lookup'))
    expect(dropped).toHaveLength(2)
    for (const w of dropped) {
      expect(w).toContain('excluded with the AdvocateHub namespace on the Fields step')
    }
    // The refusal text that dead-ended deployment 4 is gone for good.
    expect(plan.warnings.some((w) => w.includes('re-run analysis'))).toBe(false)
  })

  it('S46 mode A: the warning names the real reason — unpopulated (populated-only) and not-on-target', () => {
    const unpop = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('Contact', 2, { deferredFields: ['AccountId'] }), CONTACT_FIELDS)
      ],
      config: { populatedOnly: true }
    })
    unpop.objects[1]!.populatedFields = ['LastName'] // no sampled contact has an account
    const w1 = freezePlan(unpop).warnings.find((x) => x.startsWith('Contact.AccountId:'))!
    expect(w1).toContain('excluded as unpopulated in the source sample (populated-only)')
    expect(w1).toContain('un-exclude it on the Fields step')

    // Target lacks the field entirely: byte-exact filterFields reason, and NO
    // "un-exclude" advice (there is nothing the user can change).
    const missing = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('Contact', 2, { deferredFields: ['AccountId'] }), CONTACT_FIELDS, [
          f('LastName')
        ])
      ]
    })
    const w2 = freezePlan(missing).warnings.find((x) => x.startsWith('Contact.AccountId:'))!
    expect(w2).toContain('but it is not on target')
    expect(w2).toContain('Nothing to change')
    expect(w2).not.toContain('un-exclude')
  })

  it('S46: a deferred field that NO LONGER EXISTS on the source describe still refuses (stale plan → re-run analysis)', () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('Contact', 2, { deferredFields: ['Gone__c'] }), CONTACT_FIELDS)
      ]
    })
    expect(() => freezePlan(input)).toThrow(PlanFreezeError)
    expect(() => freezePlan(input)).toThrow(
      /deferred field Gone__c no longer exists on the source object \(stale plan\) — re-run analysis/
    )
  })

  it('S46: no refusal text ever tells the user to un-exclude a field (A2 honest remedies)', () => {
    const stale = buildInput({
      objects: [obj(planned('Account', 1, { deferredFields: ['Name'] }), ACCOUNT_FIELDS)]
    })
    try {
      freezePlan(stale)
      expect.unreachable('freezePlan should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PlanFreezeError)
      for (const msg of (e as PlanFreezeError).errors) expect(msg).not.toMatch(/un-exclude/)
    }
  })

  it('analysis-carried deferred fields survive (union), and skip-mapped ones are pruned', () => {
    // Analysis deferred BOTH fields; the user then locked one out of scope.
    const quoteFields = [
      f('Name'),
      ref('SBQQ__MasterContract__c', 'Contract'),
      ref('SBQQ__Opportunity2__c', 'Opportunity')
    ]
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(
          planned('SBQQ__Quote__c', 2, {
            hasCircularReference: true,
            deferredFields: ['SBQQ__MasterContract__c', 'SBQQ__Opportunity2__c']
          }),
          quoteFields
        ),
        obj(planned('Contract', 3), CONTRACT_FIELDS)
        // Opportunity NOT in scope → SBQQ__Opportunity2__c resolves locked-skip → pruned.
      ]
    })
    const plan = freezePlan(input)
    const quote = plan.objects.find((o) => o.objectName === 'SBQQ__Quote__c')!
    expect(quote.deferredFields).toContain('SBQQ__MasterContract__c')
    expect(quote.deferredFields).not.toContain('SBQQ__Opportunity2__c')
  })
})

describe('planFreeze — A5 wiring (exclusions via fieldPolicy) + drop log', () => {
  it('user exclusions, namespace exclusions, and populated-only all drop silently; target drops are logged', () => {
    const sourceFields = [
      f('Name'),
      f('Fax'),
      f('Gearset__Tracking__c'),
      f('Rarely_Used__c'),
      f('OnlyOnSource__c')
    ]
    const targetFields = [f('Name'), f('Fax'), f('Gearset__Tracking__c'), f('Rarely_Used__c')]
    const input = buildInput({
      objects: [obj(planned('Account', 1), sourceFields, targetFields)],
      config: {
        excludedFields: { Account: ['Fax'] },
        excludedNamespaces: ['Gearset'],
        populatedOnly: true
      }
    })
    input.objects[0]!.populatedFields = ['Name', 'Fax', 'Gearset__Tracking__c', 'OnlyOnSource__c']
    const plan = freezePlan(input)
    const account = plan.objects[0]!
    expect(account.fields).toEqual(['Name'])
    // Exclusion drops are SILENT (Apex A5); only the target-side drop logs.
    expect(account.droppedFields).toEqual(['OnlyOnSource__c (not on target)'])
  })

  it('read-only-on-target and foreign external Id drops keep the Apex reasons byte-exact', () => {
    const sourceFields = [f('Name'), f('Score__c'), f('GearsetExternalId__c')]
    const targetFields = [
      f('Name'),
      f('Score__c', { isCalculated: true }),
      f('GearsetExternalId__c', { isExternalId: true })
    ]
    const plan = freezePlan(
      buildInput({ objects: [obj(planned('Account', 1), sourceFields, targetFields)] })
    )
    expect(plan.objects[0]!.droppedFields).toEqual([
      'Score__c (read-only on target: formula/rollup)',
      'GearsetExternalId__c (foreign external Id; would collide on re-deploy)'
    ])
  })
})

describe('planFreeze — junction bypass + validation refusal + serialization', () => {
  // S49 (BUG-7): junctions still bypass mappings/repairs, but they now DO get
  // the A5 field filter. `fields: []` forced junction.ts onto a hardcoded
  // Role/IsPrimary list, silently dropping everything else (329 of one account's 366
  // source OCRs carried NektarActions__c; the target got 0).
  it('junction objects bypass mappings and repairs, but DO get the A5 field filter', () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(
          planned('OpportunityContactRole', 2, {
            isJunction: true,
            junctionParents: ['Opportunity', 'Contact'],
            junctionParentFields: ['OpportunityId', 'ContactId']
          }),
          [ref('OpportunityId', 'Opportunity'), ref('ContactId', 'Contact')]
        )
      ]
    })
    const plan = freezePlan(input)
    const ocr = plan.objects.find((o) => o.objectName === 'OpportunityContactRole')!
    // parent FKs survive A5; the junction executor strips them itself (traversal)
    expect(ocr.fields).toEqual(['OpportunityId', 'ContactId'])
    // still NO mappings — both parents resolve by relationship traversal
    expect(ocr.mappings).toEqual({})
    expect(ocr.junctionParents).toEqual(['Opportunity', 'Contact'])
  })

  it("carries a junction's non-parent custom fields through the freeze (BUG-7)", () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(
          planned('OpportunityContactRole', 2, {
            isJunction: true,
            junctionParents: ['Opportunity', 'Contact'],
            junctionParentFields: ['OpportunityId', 'ContactId']
          }),
          [
            ref('OpportunityId', 'Opportunity'),
            ref('ContactId', 'Contact'),
            f('Role'),
            f('NektarActions__c')
          ]
        )
      ]
    })
    const ocr = freezePlan(input).objects.find((o) => o.objectName === 'OpportunityContactRole')!
    expect(ocr.fields).toContain('NektarActions__c')
    expect(ocr.fields).toContain('Role')
    expect(ocr.mappings).toEqual({})
  })

  it('refuses duplicate sort orders (ambiguous walk order)', () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('Contact', 1), CONTACT_FIELDS)
      ]
    })
    expect(() => freezePlan(input)).toThrow(PlanFreezeError)
    expect(() => freezePlan(input)).toThrow(/duplicate sort order 1/)
  })

  it('refuses a deferred entry that is not a reference field (stale plan)', () => {
    const input = buildInput({
      objects: [obj(planned('Account', 1, { deferredFields: ['Name'] }), ACCOUNT_FIELDS)]
    })
    expect(() => freezePlan(input)).toThrow(/deferred field Name is not a reference field/)
  })

  it('collects ALL validation errors before refusing', () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1, { deferredFields: ['Name'] }), ACCOUNT_FIELDS),
        obj(planned('Contact', 1), CONTACT_FIELDS)
      ]
    })
    try {
      freezePlan(input)
      expect.unreachable('freezePlan should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PlanFreezeError)
      expect((e as PlanFreezeError).errors).toHaveLength(2)
    }
  })

  it('orders objects by sortOrder and totals include junctions', () => {
    const input = buildInput({
      objects: [
        obj(planned('Contact', 2, { recordCount: 5 }), CONTACT_FIELDS),
        obj(planned('Account', 1, { recordCount: 7 }), ACCOUNT_FIELDS)
      ]
    })
    const plan = freezePlan(input)
    expect(plan.objects.map((o) => o.objectName)).toEqual(['Account', 'Contact'])
    expect(plan.totalObjects).toBe(2)
    expect(plan.totalRecords).toBe(12)
  })

  it('canonicalPlanJson is key-order-invariant but array-order-preserving', () => {
    const plan = freezePlan(buildInput({}))
    const json1 = canonicalPlanJson(plan)
    // Deep-rebuild the plan with reversed key insertion order at every level.
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v as Record<string, unknown>)
                .reverse()
                .map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])])
            )
          : v
    const json2 = canonicalPlanJson(reverseKeys(plan) as typeof plan)
    expect(json2).toBe(json1)
    // Walk order is meaningful — reversing the objects array must CHANGE the bytes.
    const reordered = { ...plan, objects: [...plan.objects].reverse() }
    expect(canonicalPlanJson(reordered)).not.toBe(json1)
  })
})

describe('planFreeze — S49 guard: a known junction must be planned as a junction (BUG-4)', () => {
  const OCR_FIELDS = [ref('OpportunityId', 'Opportunity'), ref('ContactId', 'Contact'), f('Role')]

  it('REFUSES a plan where OpportunityContactRole has isJunction:false', () => {
    // The live failure this guard exists for: deployment 7 selected OCR
    // explicitly, analysis left isJunction:false, and all 366 records failed on
    // upsert because a junction cannot host Data_Deployment_External_Id__c.
    const input = buildInput({
      objects: [
        obj(planned('Opportunity', 1), OPP_FIELDS),
        obj(planned('OpportunityContactRole', 2, { isJunction: false }), OCR_FIELDS)
      ]
    })
    expect(() => freezePlan(input)).toThrow(PlanFreezeError)
    expect(() => freezePlan(input)).toThrow(
      /known junction object but was planned as a non-junction/
    )
  })

  it('accepts the same plan when isJunction is true', () => {
    const input = buildInput({
      objects: [
        obj(planned('Opportunity', 1), OPP_FIELDS),
        obj(
          planned('OpportunityContactRole', 2, {
            isJunction: true,
            junctionParents: ['Opportunity', 'Contact'],
            junctionParentFields: ['OpportunityId', 'ContactId']
          }),
          OCR_FIELDS
        )
      ]
    })
    const plan = freezePlan(input)
    expect(plan.objects.find((o) => o.objectName === 'OpportunityContactRole')!.isJunction).toBe(
      true
    )
  })

  it('leaves non-junction objects untouched', () => {
    expect(() => freezePlan(buildInput({}))).not.toThrow()
  })
})

describe('planFreeze — S53 gate: the object’s OWN upsert key must be usable on target (item 3)', () => {
  // Readiness only WARNED about a missing Data_Deployment_External_Id__c and the
  // freeze never looked at the object's own key — a missing or FLS-hidden field
  // therefore produced a run in which 100% of that object's records failed with
  // "does not match an External ID". The gate turns that into one refusal.
  const noKey = (fields: DescribeField[]): DescribeField[] =>
    fields.filter((x) => x.apiName !== EXTERNAL_ID_FIELD)
  const NO_KEY = { extIdOnTarget: false }

  it('REFUSES when the target describe has no ExtId field at all (names the Readiness step)', () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS),
        obj(planned('Contact', 2), CONTACT_FIELDS, noKey(CONTACT_FIELDS), NO_KEY)
      ],
      targetHasExtId: ['Account'] // Tooling agrees: Contact has no field
    })
    expect(() => freezePlan(input)).toThrow(PlanFreezeError)
    expect(() => freezePlan(input)).toThrow(new RegExp(`Contact ${EXT_ID_REFUSAL_MARKER}`))
    expect(() => freezePlan(input)).toThrow(/does not exist on the target object/)
  })

  it('names field-level security when Tooling sees the field but the describe does not', () => {
    const msg = missingOwnExtIdError('Contact', noKey(CONTACT_FIELDS), new Set(['Contact']))
    expect(msg).toContain('hidden from the connected user by field-level security')
    expect(msg).toContain('RDS_Deployment_Access')
  })

  it('REFUSES a field that exists but is not flagged External ID', () => {
    const target = [...noKey(CONTACT_FIELDS), f(EXTERNAL_ID_FIELD, { isExternalId: false })]
    const msg = missingOwnExtIdError('Contact', target, new Set(['Contact']))
    expect(msg).toContain('not flagged External ID')
  })

  it('passes when the describe shows the field as an External ID', () => {
    expect(
      missingOwnExtIdError('Contact', CONTACT_FIELDS.concat(EXT_ID_ON_TARGET), new Set())
    ).toBe(null)
  })

  it('junctions are exempt (they cannot host the field)', () => {
    const OCR_FIELDS = [ref('OpportunityId', 'Opportunity'), ref('ContactId', 'Contact'), f('Role')]
    const input = buildInput({
      objects: [
        obj(planned('Opportunity', 1), OPP_FIELDS),
        obj(
          planned('OpportunityContactRole', 2, {
            isJunction: true,
            junctionParents: ['Opportunity', 'Contact'],
            junctionParentFields: ['OpportunityId', 'ContactId']
          }),
          OCR_FIELDS,
          noKey(OCR_FIELDS),
          NO_KEY
        )
      ]
    })
    expect(() => freezePlan(input)).not.toThrow()
  })

  it('reports every offending object in one refusal', () => {
    const input = buildInput({
      objects: [
        obj(planned('Account', 1), ACCOUNT_FIELDS, noKey(ACCOUNT_FIELDS), NO_KEY),
        obj(planned('Contact', 2), CONTACT_FIELDS, noKey(CONTACT_FIELDS), NO_KEY)
      ],
      targetHasExtId: []
    })
    try {
      freezePlan(input)
      throw new Error('expected refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(PlanFreezeError)
      const errs = (e as PlanFreezeError).errors
      expect(errs.some((m) => m.startsWith('Account '))).toBe(true)
      expect(errs.some((m) => m.startsWith('Contact '))).toBe(true)
    }
  })
})

// ── S57 (B1 + FB-3): out-of-scope parents the TARGET can key ─────────────────
// Run 24 on sb1-915-git: CampaignMember in scope, Campaign not, CampaignId
// required → 228/228 REQUIRED_FIELD_MISSING although run 23 had put that very
// Campaign on the target with its RDS key. The freeze must resolve exactly what
// the Mappings step showed (same policy call, same two sets).
describe('S57 B1 — freeze resolves out-of-scope refs against the target key', () => {
  const CM_FIELDS = [
    f('Status'),
    ref('CampaignId', 'Campaign', { isNillable: false }),
    ref('ContactId', 'Contact'),
    ref('LeadId', 'Lead')
  ]
  const CONTACT = [f('LastName'), ref('AccountId', 'Account')]
  function cmInput(over: { keyedRows?: string[]; hasExtId?: string[]; mappings?: WizardConfig['mappings'] }) {
    return {
      ...buildInput({
        objects: [obj(planned('Contact', 1), CONTACT), obj(planned('CampaignMember', 2), CM_FIELDS)],
        targetHasExtId: over.hasExtId ?? ['Contact', 'CampaignMember', 'Campaign'],
        config: over.mappings ? { mappings: over.mappings } : {}
      }),
      targetKeyedRows: new Set(over.keyedRows ?? [])
    }
  }
  const cm = (plan: ReturnType<typeof freezePlan>) =>
    plan.objects.find((o) => o.objectName === 'CampaignMember')!

  it('nothing known about the target ⇒ pre-S57: skip, plus the FB-3 required-ref warning', () => {
    const plan = freezePlan(buildInput({
      objects: [obj(planned('Contact', 1), CONTACT), obj(planned('CampaignMember', 2), CM_FIELDS)],
      targetHasExtId: ['Contact', 'CampaignMember']
    }))
    expect(cm(plan).mappings['CampaignId']!.strategy).toBe('skip')
    expect(cm(plan).mappings['LeadId']!.strategy).toBe('skip')
    expect(plan.warnings).toContainEqual(
      'CampaignMember.CampaignId is required and Campaign is not in this deployment — every CampaignMember row will fail with REQUIRED_FIELD_MISSING. Add Campaign on the Scope step.'
    )
    // LeadId is nillable — a blank link, not a failure: no warning.
    expect(plan.warnings.filter((w) => w.includes('LeadId'))).toEqual([])
  })

  it('keyed Campaign rows on the target ⇒ externalId (Jack\'s D1), no warning, not deferred', () => {
    const plan = freezePlan(cmInput({ keyedRows: ['Campaign'] }))
    expect(cm(plan).mappings['CampaignId']).toEqual({
      strategy: 'externalId',
      matchField: null,
      customValue: null
    })
    expect(cm(plan).deferredFields).not.toContain('CampaignId') // parent already exists → first pass
    expect(plan.warnings.filter((w) => w.includes('CampaignId'))).toEqual([])
    // In-scope Contact is unaffected; Lead (no field on target) stays skip.
    expect(cm(plan).mappings['ContactId']!.strategy).toBe('externalId')
    expect(cm(plan).mappings['LeadId']!.strategy).toBe('skip')
  })

  it('field on the target but no keyed rows ⇒ default skip; an explicit External ID override is honoured', () => {
    const noOverride = freezePlan(cmInput({}))
    expect(cm(noOverride).mappings['CampaignId']!.strategy).toBe('skip')
    expect(noOverride.warnings).toContainEqual(
      expect.stringMatching(/or deploy Campaign first so the reference can resolve against RDS-keyed rows/)
    )
    const withOverride = freezePlan(
      cmInput({ mappings: { CampaignMember: { CampaignId: { strategy: 'externalId' } } } })
    )
    expect(cm(withOverride).mappings['CampaignId']!.strategy).toBe('externalId')
    expect(withOverride.warnings.filter((w) => w.includes('CampaignId'))).toEqual([])
  })

  it('a stale nameMatch override on an out-of-scope-but-keyable ref is NOT honoured (only External ID / Skip resolve a parent by key)', () => {
    const plan = freezePlan(
      cmInput({ keyedRows: ['Campaign'], mappings: { CampaignMember: { CampaignId: { strategy: 'nameMatch' } } } })
    )
    expect(cm(plan).mappings['CampaignId']!.strategy).toBe('externalId')
  })

  it('A10 still downgrades when the target lacks the field, even if keyed rows are (wrongly) claimed', () => {
    const plan = freezePlan(cmInput({ keyedRows: ['Campaign'], hasExtId: ['Contact', 'CampaignMember'] }))
    expect(cm(plan).mappings['CampaignId']!.strategy).toBe('skip')
  })
})
