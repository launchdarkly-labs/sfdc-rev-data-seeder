import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MATCH_FIELDS,
  DIRECT_ID_DEFAULT_REFS,
  NAME_MATCH_OBJECTS,
  defaultMatchField,
  getDefaultStrategy,
  isHiddenRefField,
  isStrategyLocked,
  lockBadge,
  NO_TARGET_KEYS,
  outOfScopeKeyState,
  reconcileTemplateMappings,
  strategyOptionsFor,
  type TargetKeyInfo
} from '../src/shared/mappingPolicy'
import type { FieldMapping } from '../src/shared/wizard'

// Pure port of deploymentMappings.js — must mirror the Apex resolution matrix
// exactly (transformMap.md §2, AC ≥15 cases incl. the 7 CPQ catalog directId
// defaults and the hidden RecordTypeId).

describe('getDefaultStrategy — default-strategy resolution matrix', () => {
  const scope = ['Account', 'Opportunity', 'Contact']

  it('no ref target → skip', () => {
    expect(getDefaultStrategy(undefined, 'Account', scope)).toBe('skip')
  })

  it('self-reference → skip (even when the object is in scope)', () => {
    expect(getDefaultStrategy('Account', 'Account', scope)).toBe('skip')
  })

  it('stable-Id standard objects default to directId (directId beats name-match)', () => {
    for (const obj of ['RecordType', 'Pricebook2', 'Product2', 'User', 'Group', 'UserRole']) {
      expect(getDefaultStrategy(obj, 'Opportunity', scope)).toBe('directId')
    }
  })

  it('PricebookEntry → directId (required-on-insert)', () => {
    expect(getDefaultStrategy('PricebookEntry', 'OpportunityLineItem', scope)).toBe('directId')
  })

  it('all 7 CPQ catalog objects default to directId', () => {
    const cpq = [
      'SBQQ__ProductOption__c',
      'SBQQ__Dimension__c',
      'SBQQ__BlockPrice__c',
      'SBQQ__DiscountSchedule__c',
      'SBQQ__DiscountTier__c',
      'SBQQ__ContractedPrice__c',
      'SBQQ__Cost__c'
    ]
    for (const obj of cpq) {
      expect(getDefaultStrategy(obj, 'SBQQ__QuoteLine__c', scope)).toBe('directId')
    }
    expect(cpq.every((o) => DIRECT_ID_DEFAULT_REFS.has(o))).toBe(true)
  })

  it('name-match-only standard objects default to nameMatch', () => {
    // Profile / BusinessHours / Organization are in NAME_MATCH but NOT in DIRECT_ID.
    for (const obj of ['Profile', 'BusinessHours', 'Organization']) {
      expect(getDefaultStrategy(obj, 'Account', scope)).toBe('nameMatch')
    }
  })

  it('an in-scope custom parent → externalId', () => {
    expect(getDefaultStrategy('Opportunity', 'Contact', scope)).toBe('externalId')
  })

  it('an out-of-scope, non-stable object → skip', () => {
    expect(getDefaultStrategy('Case', 'Contact', scope)).toBe('skip')
  })
})

describe('isStrategyLocked — object-scope lock rules', () => {
  const scope = ['Account', 'Opportunity']

  it('no ref → not locked', () => {
    expect(isStrategyLocked(undefined, 'Account', scope)).toBe(false)
  })

  it('self-reference → locked', () => {
    expect(isStrategyLocked('Account', 'Account', scope)).toBe(true)
  })

  it('name-match standard object → not locked (deployable without being in scope)', () => {
    expect(isStrategyLocked('User', 'Opportunity', scope)).toBe(false)
    expect(isStrategyLocked('Profile', 'Opportunity', scope)).toBe(false)
  })

  it('directId-default (incl. CPQ catalog) → not locked out of scope', () => {
    expect(isStrategyLocked('Product2', 'Opportunity', scope)).toBe(false)
    expect(isStrategyLocked('SBQQ__ProductOption__c', 'SBQQ__QuoteLine__c', scope)).toBe(false)
  })

  it('in-scope parent → not locked', () => {
    expect(isStrategyLocked('Account', 'Opportunity', scope)).toBe(false)
  })

  it('out-of-scope, non-stable object → locked', () => {
    expect(isStrategyLocked('Case', 'Opportunity', scope)).toBe(true)
  })
})

describe('lockBadge', () => {
  it('names the self-reference case', () => {
    expect(lockBadge('Account', 'Account')).toBe('Self-reference (auto-skip)')
  })
  it('names the out-of-scope case', () => {
    expect(lockBadge('Case', 'Contact')).toBe('Ref → Case (not in deployment)')
  })
})

describe('isHiddenRefField — RecordTypeId is never shown', () => {
  it('hides RecordTypeId → RecordType', () => {
    expect(isHiddenRefField('RecordTypeId', 'RecordType')).toBe(true)
  })
  it('does not hide a normal lookup', () => {
    expect(isHiddenRefField('AccountId', 'Account')).toBe(false)
  })
  it('does not hide a custom RecordType-named field pointing elsewhere', () => {
    expect(isHiddenRefField('My_RecordTypeId__c', 'RecordType')).toBe(false)
  })
})

describe('strategyOptionsFor', () => {
  it('offers Set to Me only for User references', () => {
    const userOpts = strategyOptionsFor('User').map((o) => o.value)
    const accOpts = strategyOptionsFor('Account').map((o) => o.value)
    expect(userOpts).toContain('setToMe')
    expect(accOpts).not.toContain('setToMe')
  })
  it('always offers the 5 base strategies', () => {
    const base = strategyOptionsFor('Account').map((o) => o.value)
    expect(base).toEqual(['externalId', 'nameMatch', 'skip', 'directId', 'customId'])
  })
})

describe('defaultMatchField', () => {
  it('uses documented per-object keys', () => {
    expect(defaultMatchField('User')).toBe('Username')
    expect(defaultMatchField('RecordType')).toBe('DeveloperName')
    expect(defaultMatchField('Product2')).toBe('ProductCode')
  })
  it('falls back to Name for anything unlisted', () => {
    expect(defaultMatchField('Account')).toBe('Name')
    expect(defaultMatchField(undefined)).toBe('Name')
  })
  it('table only carries the documented objects', () => {
    expect(Object.keys(DEFAULT_MATCH_FIELDS).sort()).toEqual(
      ['Group', 'Pricebook2', 'Product2', 'Profile', 'RecordType', 'User', 'UserRole'].sort()
    )
  })
})

describe('reconcileTemplateMappings — scope re-validation on apply', () => {
  const nm: FieldMapping = { strategy: 'nameMatch', matchField: 'Name' }
  const refs = (pairs: Array<[string, string]>): { fieldName: string; refTo: string }[] =>
    pairs.map(([fieldName, refTo]) => ({ fieldName, refTo }))

  it('applies in-scope entries whose refs are deployable and unlocked', () => {
    const template = { Opportunity: { AccountId: nm } }
    const r = reconcileTemplateMappings(
      template,
      { Opportunity: refs([['AccountId', 'Account']]) },
      ['Opportunity', 'Account']
    )
    expect(r.corrected).toBe(0)
    expect(r.mappings.Opportunity).toEqual({ AccountId: nm })
  })

  it('drops (and counts) an entry whose ref is now locked (out of scope)', () => {
    const template = { Opportunity: { CaseLink__c: nm } }
    const r = reconcileTemplateMappings(
      template,
      { Opportunity: refs([['CaseLink__c', 'Case']]) },
      ['Opportunity'] // Case not in scope → locked
    )
    expect(r.corrected).toBe(1)
    expect(r.mappings.Opportunity).toBeUndefined()
  })

  it('ignores objects that are not in the current scope', () => {
    const template = { Contract: { AccountId: nm } }
    const r = reconcileTemplateMappings(template, {}, ['Opportunity'])
    expect(r.corrected).toBe(0)
    expect(r.mappings).toEqual({})
  })

  it('silently drops entries for fields that are no longer deployable refs (schema drift)', () => {
    const template = { Opportunity: { Gone__c: nm } }
    const r = reconcileTemplateMappings(
      template,
      { Opportunity: refs([['AccountId', 'Account']]) }, // Gone__c not present
      ['Opportunity', 'Account']
    )
    expect(r.corrected).toBe(0) // not counted — it's drift, not a scope correction
    expect(r.mappings.Opportunity).toBeUndefined()
  })
})

describe('policy set membership (regression pins)', () => {
  it('NAME_MATCH_OBJECTS carries the 9 documented standard objects', () => {
    expect(NAME_MATCH_OBJECTS.size).toBe(9)
  })
  it('DIRECT_ID_DEFAULT_REFS carries 7 standard + 7 CPQ = 14', () => {
    expect(DIRECT_ID_DEFAULT_REFS.size).toBe(14)
  })
})

// ── S57 (B1): out-of-scope parents the TARGET can key ──────────────────────────
// Run 24 on sb1-915-git: CampaignMember in scope, Campaign not, CampaignId locked
// to Skip → 228/228 REQUIRED_FIELD_MISSING although run 23 had put that very
// Campaign on the target WITH its RDS key. Jack's D1: auto External ID when the
// target holds keyed rows; unlocked-but-Skip when it only has the field.
describe('S57 B1 — target-keyed out-of-scope references', () => {
  const scope = ['CampaignMember', 'Contact']
  const keyed: TargetKeyInfo = {
    hasField: new Set(['Campaign', 'Account']),
    keyedRows: new Set(['Campaign'])
  }

  it('without target knowledge the pre-S57 rule holds: locked to skip', () => {
    expect(isStrategyLocked('Campaign', 'CampaignMember', scope)).toBe(true)
    expect(getDefaultStrategy('Campaign', 'CampaignMember', scope)).toBe('skip')
    expect(isStrategyLocked('Campaign', 'CampaignMember', scope, NO_TARGET_KEYS)).toBe(true)
  })

  it('keyed rows on the target ⇒ unlocked AND default External ID (D1)', () => {
    expect(isStrategyLocked('Campaign', 'CampaignMember', scope, keyed)).toBe(false)
    expect(getDefaultStrategy('Campaign', 'CampaignMember', scope, keyed)).toBe('externalId')
    expect(outOfScopeKeyState('Campaign', scope, keyed)).toBe('keyedRows')
    expect(lockBadge('Campaign', 'CampaignMember', keyed)).toMatch(/resolves against RDS-keyed Campaign rows/)
  })

  it('field present but no keyed rows ⇒ unlocked, default stays Skip, badge says why', () => {
    expect(isStrategyLocked('Account', 'CampaignMember', scope, keyed)).toBe(false)
    expect(getDefaultStrategy('Account', 'CampaignMember', scope, keyed)).toBe('skip')
    expect(outOfScopeKeyState('Account', scope, keyed)).toBe('fieldOnly')
    expect(lockBadge('Account', 'CampaignMember', keyed)).toMatch(/no keyed Account rows yet/)
  })

  it('no field on the target ⇒ still locked (A10 would downgrade anyway)', () => {
    expect(isStrategyLocked('Lead', 'CampaignMember', scope, keyed)).toBe(true)
    expect(getDefaultStrategy('Lead', 'CampaignMember', scope, keyed)).toBe('skip')
    expect(outOfScopeKeyState('Lead', scope, keyed)).toBe('none')
    expect(lockBadge('Lead', 'CampaignMember', keyed)).toBe('Ref → Lead (not in deployment)')
  })

  it('in-scope, self, NAME_MATCH and DIRECT_ID rules are untouched by target knowledge', () => {
    expect(getDefaultStrategy('Contact', 'CampaignMember', scope, keyed)).toBe('externalId')
    expect(isStrategyLocked('CampaignMember', 'CampaignMember', scope, keyed)).toBe(true)
    expect(getDefaultStrategy('User', 'CampaignMember', scope, keyed)).toBe('directId')
    expect(isStrategyLocked('User', 'CampaignMember', scope, keyed)).toBe(false)
    expect(outOfScopeKeyState('Contact', scope, keyed)).toBe('inScope')
  })

  it('offers only External ID / Skip for a ref unlocked by the target key', () => {
    expect(strategyOptionsFor('Campaign', true).map((o) => o.value)).toEqual(['externalId', 'skip'])
    expect(strategyOptionsFor('Campaign').map((o) => o.value)).toContain('nameMatch')
  })

  it('template reconcile keeps an entry the target can key, drops one it cannot', () => {
    const template: Record<string, Record<string, FieldMapping>> = {
      CampaignMember: {
        CampaignId: { strategy: 'externalId' },
        LeadId: { strategy: 'externalId' }
      }
    }
    const refs = {
      CampaignMember: [
        { fieldName: 'CampaignId', refTo: 'Campaign' },
        { fieldName: 'LeadId', refTo: 'Lead' }
      ]
    }
    const r = reconcileTemplateMappings(template, refs, scope, keyed)
    expect(r.mappings).toEqual({ CampaignMember: { CampaignId: { strategy: 'externalId' } } })
    expect(r.corrected).toBe(1)
    // Pre-S57 behaviour when nothing is known about the target: both dropped.
    expect(reconcileTemplateMappings(template, refs, scope).corrected).toBe(2)
  })
})
