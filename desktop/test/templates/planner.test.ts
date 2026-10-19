import { describe, it, expect } from 'vitest'
import {
  buildRecord,
  classifyRef,
  deferredFieldsFor,
  fieldPlan,
  plannerContext,
  sameValue,
  sourceSoql
} from '../../src/main/engine/templates/seed/planner'
import { emptySeedTemplate, type SeedTemplate } from '../../src/shared/templates/types'
import { fld, ref } from './fakes'

const TEMPLATE: SeedTemplate = {
  ...emptySeedTemplate(),
  keepIdTargets: ['User', 'Product2'],
  tiers: [{ object: 'Rule__c' }, { object: 'Condition__c' }, { object: 'Action__c', group: 'extra' }]
}

describe('classifyRef', () => {
  const ctx = plannerContext(TEMPLATE, TEMPLATE.tiers.filter((t) => (t.group ?? 'default') === 'default'))
  it('earlier tier → remap, same/later tier → defer, keep-Id → keep, else check, poly → poly', () => {
    expect(classifyRef(ctx, 'Condition__c', ['Rule__c'])).toBe('remap')
    expect(classifyRef(ctx, 'Rule__c', ['Rule__c'])).toBe('defer') // self-reference
    expect(classifyRef(ctx, 'Rule__c', ['Condition__c'])).toBe('defer') // forward
    expect(classifyRef(ctx, 'Rule__c', ['User'])).toBe('keep')
    expect(classifyRef(ctx, 'Rule__c', ['Account'])).toBe('check')
    expect(classifyRef(ctx, 'Rule__c', ['Account', 'Contact'])).toBe('poly')
  })
  it('a template tier NOT in this run: earlier → remap (through the map), later → check', () => {
    expect(classifyRef(ctx, 'Action__c', ['Rule__c'])).toBe('remap')
    expect(classifyRef(ctx, 'Rule__c', ['Action__c'])).toBe('check')
  })
})

describe('fieldPlan', () => {
  const ctx = plannerContext(TEMPLATE, TEMPLATE.tiers)
  it('excludes system/calculated/autonumber/address fields, reports missing + no-access, classifies refs', () => {
    const source = {
      name: 'Condition__c',
      fields: [
        fld('Id'),
        fld('OwnerId'),
        fld('Name'),
        fld('Formula__c', { calculated: true }),
        fld('Auto__c', { autoNumber: true }),
        fld('Addr__c', { type: 'address' }),
        fld('ReadOnly__c', { createable: false, updateable: false }),
        fld('Missing__c'),
        fld('Locked__c'),
        ref('Rule__c', 'Rule__c', { nillable: false }),
        ref('OwnerUser__c', 'User'),
        fld('Active__c', { type: 'boolean' })
      ]
    }
    const target = {
      name: 'Condition__c',
      fields: [
        fld('Name'),
        fld('Locked__c', { createable: false }),
        ref('Rule__c', 'Rule__c', { nillable: false }),
        ref('OwnerUser__c', 'User'),
        fld('Active__c', { type: 'boolean' })
      ]
    }
    const plan = fieldPlan(ctx, 'Condition__c', source, target)
    expect(plan.cols).toEqual(['Name', 'Rule__c', 'OwnerUser__c', 'Active__c'])
    expect(plan.missing).toEqual(['Missing__c'])
    expect(plan.noAccess).toEqual(['Locked__c'])
    expect(plan.refs.Rule__c).toEqual({ to: ['Rule__c'], kind: 'remap', required: true })
    expect(plan.refs.OwnerUser__c).toEqual({ to: ['User'], kind: 'keep', required: false })
    expect(plan.types.Active__c).toBe('boolean')
    expect(sourceSoql({ object: 'Condition__c', where: 'Name != null' }, plan)).toBe(
      'SELECT Id, Name, Rule__c, OwnerUser__c, Active__c FROM Condition__c WHERE Name != null'
    )
  })
  it('a required ref with defaultedOnCreate is not required', () => {
    const plan = fieldPlan(
      ctx,
      'Rule__c',
      { name: 'Rule__c', fields: [ref('RecordTypeId', 'RecordType', { nillable: false })] },
      { name: 'Rule__c', fields: [ref('RecordTypeId', 'RecordType', { nillable: false, defaultedOnCreate: true })] }
    )
    expect(plan.refs.RecordTypeId!.required).toBe(false)
  })
})

describe('buildRecord', () => {
  const ctx = plannerContext(TEMPLATE, TEMPLATE.tiers)
  const plan = fieldPlan(
    ctx,
    'Rule__c',
    {
      name: 'Rule__c',
      fields: [
        fld('Name'),
        fld('Active__c', { type: 'boolean' }),
        fld('ConditionsMet__c'),
        ref('Parent__c', 'Rule__c'),
        ref('Account__c', 'Account'),
        ref('Owner__c', 'User'),
        ref('Cond__c', 'Condition__c', { nillable: false }),
        ref('RecordTypeId', 'RecordType'),
        ref('What__c', 'Account')
      ]
    },
    {
      name: 'Rule__c',
      fields: [
        fld('Name'),
        fld('Active__c', { type: 'boolean' }),
        fld('ConditionsMet__c'),
        ref('Parent__c', 'Rule__c'),
        ref('Account__c', 'Account'),
        ref('Owner__c', 'User'),
        ref('Cond__c', 'Condition__c', { nillable: false }),
        ref('RecordTypeId', 'RecordType'),
        ref('What__c', 'Account', { nillable: false })
      ]
    }
  )
  // Cond__c → Condition__c is a LATER tier → defer (even though required).
  const base = {
    deferredFields: new Set(['Active__c', 'ConditionsMet__c']),
    placeholders: { ConditionsMet__c: 'All' },
    idMap: new Map<string, string>(),
    exists: new Set(['001exists'])
  }

  it('deferred booleans load false, placeholders stand in, values are kept for the second pass', () => {
    const b = buildRecord(
      { Id: 'r1', Name: 'n', Active__c: true, ConditionsMet__c: 'Custom', Parent__c: null, Account__c: null, Owner__c: '005u', Cond__c: 'c1', RecordTypeId: null, What__c: '001exists' },
      plan,
      base
    )
    expect(b.error).toBeNull()
    expect(b.payload).toEqual({ Name: 'n', Active__c: false, ConditionsMet__c: 'All', Parent__c: null, Account__c: null, Owner__c: '005u', Cond__c: null, What__c: '001exists' })
    expect('RecordTypeId' in b.payload!).toBe(false) // null RecordTypeId omitted
    expect(b.later).toEqual({ Active__c: true, ConditionsMet__c: 'Custom', Cond__c: 'c1' })
    expect(b.nulled).toEqual([])
  })

  it('self-references defer; check refs keep existing ids and null missing optional ones', () => {
    const b = buildRecord({ Id: 'r1', Name: 'n', Parent__c: 'r0', Account__c: '001gone', Owner__c: null, Cond__c: null, What__c: '001exists' }, plan, base)
    expect(b.payload!.Parent__c).toBeNull()
    expect(b.later.Parent__c).toBe('r0')
    expect(b.payload!.Account__c).toBeNull()
    expect(b.nulled).toEqual(['Account__c'])
  })

  it('a required check ref to a record missing on the target skips the row', () => {
    const b = buildRecord({ Id: 'r1', Name: 'n', What__c: '001gone' }, plan, base)
    expect(b.payload).toBeNull()
    expect(b.error).toMatch(/required What__c → 001gone doesn't exist/)
  })

  it('check refs prefer an already-mapped id (a tier from another group) over the probe', () => {
    const b = buildRecord({ Id: 'r1', Name: 'n', Account__c: 'srcA' }, plan, { ...base, idMap: new Map([['srcA', 'tgtA']]) })
    expect(b.payload!.Account__c).toBe('tgtA')
  })

  it('remap: mapped → target id; unmapped optional → nulled; unmapped required → skipped', () => {
    const p = fieldPlan(
      ctx,
      'Condition__c',
      { name: 'Condition__c', fields: [ref('Rule__c', 'Rule__c', { nillable: false }), ref('Opt__c', 'Rule__c')] },
      { name: 'Condition__c', fields: [ref('Rule__c', 'Rule__c', { nillable: false }), ref('Opt__c', 'Rule__c')] }
    )
    const ok = buildRecord({ Id: 'c', Rule__c: 'r1', Opt__c: 'r9' }, p, { ...base, idMap: new Map([['r1', 't1']]) })
    expect(ok.payload).toEqual({ Rule__c: 't1', Opt__c: null })
    expect(ok.nulled).toEqual(['Opt__c'])
    const bad = buildRecord({ Id: 'c', Rule__c: 'r2' }, p, base)
    expect(bad.error).toMatch(/required Rule__c → r2 was not loaded/)
  })

  it('deferredFieldsFor = configured ∩ cols, plus defer-kind refs', () => {
    expect(deferredFieldsFor(plan, ['Active__c', 'ConditionsMet__c', 'NotACol__c'])).toEqual(['Active__c', 'ConditionsMet__c', 'Parent__c', 'Cond__c'])
  })
})

describe('sameValue', () => {
  it('blank == null, trimmed text, bool coercion, numeric tolerance', () => {
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(' a\r\n', 'a\n')).toBe(true)
    expect(sameValue(true, 'true')).toBe(true)
    expect(sameValue(1.0000000001, 1)).toBe(true)
    expect(sameValue('a', 'b')).toBe(false)
  })
})
