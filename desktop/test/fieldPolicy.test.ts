import { describe, it, expect } from 'vitest'
import {
  SUGGESTED_KEEP_NAMESPACES,
  fieldExclusion,
  fieldNamespace,
  isDeployableField,
  isFieldLocked,
  isOutOfScopeRefLocked,
  reconcileFieldsTemplate,
  suggestExcludedNamespaces,
  cpqObjectInScope
} from '../src/shared/fieldPolicy'
import type { FieldInfo } from '../src/shared/types'
import { emptyWizardConfig } from '../src/shared/wizard'

const fi = (over: Partial<FieldInfo>): FieldInfo => ({
  apiName: 'F',
  label: 'F',
  type: 'string',
  isReference: false,
  referenceTo: [],
  isCreateable: true,
  isUpdateable: true,
  isNillable: true,
  isExternalId: false,
  isAutoNumber: false,
  isCalculated: false,
  isRestrictedPicklist: false,
  picklistValues: [],
  length: null,
  ...over
})

describe('fieldNamespace', () => {
  it('extracts a managed-package namespace (two __)', () => {
    expect(fieldNamespace('SBQQ__Price__c')).toBe('SBQQ')
    expect(fieldNamespace('sbaa__ApprovalRule__c')).toBe('sbaa')
  })
  it('returns null for local custom + standard fields', () => {
    expect(fieldNamespace('Foo__c')).toBeNull()
    expect(fieldNamespace('Name')).toBeNull()
    expect(fieldNamespace('AccountId')).toBeNull()
  })
})

describe('isDeployableField', () => {
  it('is true for a createable, non-auto, non-calculated field', () => {
    expect(isDeployableField(fi({}))).toBe(true)
  })
  it('is false for auto-number, calculated, or non-createable', () => {
    expect(isDeployableField(fi({ isAutoNumber: true }))).toBe(false)
    expect(isDeployableField(fi({ isCalculated: true }))).toBe(false)
    expect(isDeployableField(fi({ isCreateable: false }))).toBe(false)
  })
  it('drops system-managed (audit) fields even when the org describes them createable', () => {
    expect(isDeployableField(fi({ apiName: 'CreatedById', isCreateable: true }))).toBe(false)
    expect(isDeployableField(fi({ apiName: 'CreatedDate', isCreateable: true }))).toBe(false)
    expect(isDeployableField(fi({ apiName: 'Id', isCreateable: true }))).toBe(false)
  })
})

describe('fieldExclusion — precedence + reasons', () => {
  const base = emptyWizardConfig()

  it('not excluded by default', () => {
    expect(fieldExclusion('Name', 'Account', base, null)).toEqual({ excluded: false })
  })

  it('namespace exclusion locks the field and takes precedence over an explicit toggle', () => {
    const cfg = {
      ...base,
      excludedNamespaces: ['SBQQ'],
      excludedFields: { Account: ['SBQQ__Foo__c'] }
    }
    expect(fieldExclusion('SBQQ__Foo__c', 'Account', cfg, null)).toEqual({
      excluded: true,
      reason: 'namespace'
    })
  })

  it('explicit per-field exclusion', () => {
    const cfg = { ...base, excludedFields: { Account: ['Amount'] } }
    expect(fieldExclusion('Amount', 'Account', cfg, null)).toEqual({
      excluded: true,
      reason: 'field'
    })
  })

  it('populated-only excludes a field absent from the sample (only when the set is loaded)', () => {
    const cfg = { ...base, populatedOnly: true }
    expect(fieldExclusion('Amount', 'Account', cfg, new Set(['Name']))).toEqual({
      excluded: true,
      reason: 'unpopulated'
    })
    // populated set not yet loaded → not excluded
    expect(fieldExclusion('Amount', 'Account', cfg, null)).toEqual({ excluded: false })
    // present in the sample → not excluded
    expect(fieldExclusion('Name', 'Account', cfg, new Set(['Name']))).toEqual({ excluded: false })
  })
})

describe('isFieldLocked', () => {
  it('locks derived exclusions, not the user toggle', () => {
    expect(isFieldLocked('namespace')).toBe(true)
    expect(isFieldLocked('unpopulated')).toBe(true)
    expect(isFieldLocked('skippedRef')).toBe(true)
    expect(isFieldLocked('field')).toBe(false)
    expect(isFieldLocked(undefined)).toBe(false)
  })
})

describe('skipped-ref lock (5B.6-b)', () => {
  const scope = ['Opportunity', 'Contact']

  it('locks a ref to an out-of-scope, non-stable object (delegates to mappingPolicy)', () => {
    expect(isOutOfScopeRefLocked('Account', 'Opportunity', scope)).toBe(true) // out of scope
    expect(isOutOfScopeRefLocked('Contact', 'Opportunity', scope)).toBe(false) // in scope
    expect(isOutOfScopeRefLocked('User', 'Opportunity', scope)).toBe(false) // stable nameMatch
    expect(isOutOfScopeRefLocked('Product2', 'Opportunity', scope)).toBe(false) // directId default
    // Self-refs are DEFERRED by the engine (revisit pass) — they deploy, so no lock.
    expect(isOutOfScopeRefLocked('Opportunity', 'Opportunity', scope)).toBe(false)
    expect(isOutOfScopeRefLocked(null, 'Opportunity', scope)).toBe(false) // not a reference
  })

  it('fieldExclusion reports skippedRef FIRST (strongest lock — the transform strips it)', () => {
    const cfg = {
      ...emptyWizardConfig(),
      excludedNamespaces: ['FOO'],
      excludedFields: { Opportunity: ['FOO__Acct__c'] }
    }
    // Even namespace-excluded AND user-excluded, the skippedRef reason wins.
    const ex = fieldExclusion('FOO__Acct__c', 'Opportunity', cfg, null, {
      refTo: 'Account',
      selectedObjects: scope
    })
    expect(ex).toEqual({ excluded: true, reason: 'skippedRef' })
    // Without ref context the namespace lock still applies (back-compat callers).
    expect(fieldExclusion('FOO__Acct__c', 'Opportunity', cfg, null).reason).toBe('namespace')
  })

  it('a user-chosen skip on an unlocked IN-SCOPE ref does NOT lock — plan freeze A9-promotes it and it deploys', () => {
    const cfg = emptyWizardConfig()
    // Contact is IN scope (unlocked) and the user mapped this ref to Skip:
    // freezePlan's A9 repair (Apex DDQ L1470-1487) promotes it back to
    // externalId, so the field deploys — the Fields step must not show it as
    // excluded (E2.6 review fix; the pre-freeze 5B.6-b behavior locked it).
    expect(
      fieldExclusion('ContactId', 'Opportunity', cfg, null, {
        refTo: 'Contact',
        selectedObjects: scope,
        overrideStrategy: 'skip'
      })
    ).toEqual({ excluded: false })
    // An explicit skip on an out-of-scope STABLE object stays skipped (A9
    // requires the referenced object to be in the deployment) — still locked.
    expect(
      fieldExclusion('OwnerId', 'Opportunity', cfg, null, {
        refTo: 'User',
        selectedObjects: scope,
        overrideStrategy: 'skip'
      })
    ).toEqual({ excluded: true, reason: 'skippedRef' })
    // A non-skip override on an unlocked ref keeps the field free.
    expect(
      fieldExclusion('ContactId', 'Opportunity', cfg, null, {
        refTo: 'Contact',
        selectedObjects: scope,
        overrideStrategy: 'nameMatch'
      })
    ).toEqual({ excluded: false })
  })

  it('a STALE non-skip override cannot unlock a policy-locked ref (locked ? skip : chosen)', () => {
    const cfg = emptyWizardConfig()
    // Account fell out of scope after the user had set externalId — deploy-time
    // effective strategy is still 'skip' (StepMappings: locked ? skip : chosen).
    expect(
      fieldExclusion('AccountId', 'Opportunity', cfg, null, {
        refTo: 'Account',
        selectedObjects: scope,
        overrideStrategy: 'externalId'
      })
    ).toEqual({ excluded: true, reason: 'skippedRef' })
  })

  it('self-refs are never skippedRef-locked, even with a stored skip override', () => {
    const cfg = emptyWizardConfig()
    expect(
      fieldExclusion('ParentOppId', 'Opportunity', cfg, null, {
        refTo: 'Opportunity',
        selectedObjects: scope
      })
    ).toEqual({ excluded: false })
  })
})

describe('reconcileFieldsTemplate (5B.6-b)', () => {
  it('applies in-scope exclusions verbatim; drops + counts out-of-scope objects', () => {
    const r = reconcileFieldsTemplate(
      {
        excludedFields: { Opportunity: ['Amount', 'Amount'], Account: ['Name'], Lead: ['Email'] },
        excludedNamespaces: ['FOO', 'FOO'],
        populatedOnly: true
      },
      ['Opportunity']
    )
    expect(r.excludedFields).toEqual({ Opportunity: ['Amount'] }) // deduped
    expect(r.droppedObjects).toBe(2) // Account + Lead
    expect(r.excludedNamespaces).toEqual(['FOO'])
    expect(r.populatedOnly).toBe(true)
  })

  it('EMPTY entries exclude nothing and are never counted as dropped', () => {
    const r = reconcileFieldsTemplate(
      { excludedFields: { Opportunity: [], Account: [], Lead: ['Email'] }, populatedOnly: false },
      ['Opportunity']
    )
    expect(r.excludedFields).toEqual({})
    expect(r.droppedObjects).toBe(1) // only Lead (non-empty, out of scope)
  })

  it('degrades a malformed/drifted payload to safe defaults, never crashes', () => {
    for (const bad of [null, undefined, 'junk', 42, [], { excludedFields: [1, 2] }]) {
      const r = reconcileFieldsTemplate(bad, ['Opportunity'])
      expect(r.excludedFields).toEqual({})
      expect(r.excludedNamespaces).toEqual([])
      expect(r.populatedOnly).toBe(false)
      expect(r.droppedObjects).toBe(0)
    }
    // Mixed-type field arrays are ignored, valid ones kept.
    const r = reconcileFieldsTemplate(
      { excludedFields: { Opportunity: ['ok'], Contact: [1, 'nope'] }, populatedOnly: 'yes' },
      ['Opportunity', 'Contact']
    )
    expect(r.excludedFields).toEqual({ Opportunity: ['ok'] })
    expect(r.populatedOnly).toBe(false) // only literal true turns it on
  })
})

describe('suggestExcludedNamespaces', () => {
  it('excludes every managed namespace except SBQQ/sbaa, sorted (no scope given = pre-S57 rule)', () => {
    expect(suggestExcludedNamespaces(['SBQQ', 'FOO', 'sbaa', 'BAR', 'FOO'])).toEqual(['BAR', 'FOO'])
  })
  it('keeps the CPQ packages', () => {
    expect(SUGGESTED_KEEP_NAMESPACES.has('SBQQ')).toBe(true)
    expect(SUGGESTED_KEEP_NAMESPACES.has('sbaa')).toBe(true)
    expect(suggestExcludedNamespaces(['SBQQ', 'sbaa'])).toEqual([])
  })
  // S57 (FB-7): dep 37 (Campaign/Account/Contact/CampaignMember) kept SBQQ checked-in
  // while every other managed namespace was excluded — CPQ fields on Account with no
  // CPQ object anywhere in the plan.
  it('S57 FB-7: keeps SBQQ/sbaa only when a CPQ object is in the scope', () => {
    const present = ['SBQQ', 'sbaa', 'FOO']
    expect(suggestExcludedNamespaces(present, ['Campaign', 'Account', 'Contact'])).toEqual([
      'FOO',
      'SBQQ',
      'sbaa'
    ])
    expect(suggestExcludedNamespaces(present, ['Account', 'SBQQ__Quote__c'])).toEqual(['FOO'])
    expect(suggestExcludedNamespaces(present, ['sbaa__Approval__c'])).toEqual(['FOO'])
    expect(cpqObjectInScope(['Opportunity', 'OpportunityLineItem'])).toBe(false)
    expect(cpqObjectInScope(['SBQQ__Subscription__c'])).toBe(true)
  })
})
