/**
 * Port of force-app/main/default/classes/DependencyResolverTest.cls, plus
 * extra edge-case tests where Apex coverage was thin (mutual soft cycles,
 * hard cycles, multi-field forward refs, polymorphic refs, junction shapes,
 * non-createable/non-reference field filtering, tie-break determinism).
 */

import { describe, it, expect } from 'vitest'
import { resolve } from '../src/main/engine/dependencyResolver'
import type { DependencyInfo } from '../src/main/engine/dependencyResolver'
import type { FieldInfo } from '../src/shared/types'

/** Builds a full FieldInfo with resolver-irrelevant fields defaulted. */
function field(apiName: string, overrides: Partial<FieldInfo> = {}): FieldInfo {
  return {
    apiName,
    label: apiName,
    type: 'reference',
    isReference: true,
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
    ...overrides
  }
}

/** Nullable lookup (soft dep). */
function lookup(apiName: string, referenceTo: string[]): FieldInfo {
  return field(apiName, { referenceTo, isNillable: true })
}

/** Non-nullable reference (hard dep / master-detail). */
function masterDetail(apiName: string, referenceTo: string[]): FieldInfo {
  return field(apiName, { referenceTo, isNillable: false })
}

function positions(result: DependencyInfo[]): Map<string, number> {
  return new Map(result.map((info, i) => [info.objectName, i]))
}

function byName(result: DependencyInfo[], name: string): DependencyInfo {
  const info = result.find((r) => r.objectName === name)
  if (info == null) throw new Error(`${name} missing from result`)
  return info
}

// ---------------------------------------------------------------------------
// Ports of the Apex test methods
// ---------------------------------------------------------------------------

describe('DependencyResolver (Apex test ports)', () => {
  // testSimpleLinearDependency
  it('orders a simple linear hard dependency: Account before Contact', () => {
    // Account → Contact (Contact has non-nullable AccountId)
    const objects = new Set(['Account', 'Contact'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', []],
      ['Contact', [masterDetail('AccountId', ['Account'])]]
    ])

    const result = resolve(objects, metadata)

    expect(result.length).toBe(2)
    // Account should come before Contact
    expect(result[0]!.objectName).toBe('Account')
    expect(result[1]!.objectName).toBe('Contact')
    expect(result[0]!.sortOrder).toBe(1)
    expect(result[1]!.sortOrder).toBe(2)
  })

  // testCircularSoftDependency
  it('flags circular soft dependency and defers the forward lookup', () => {
    // Account has nullable lookup to Contact, Contact has non-nullable to Account
    const objects = new Set(['Account', 'Contact'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', [lookup('Primary_Contact__c', ['Contact'])]],
      ['Contact', [masterDetail('AccountId', ['Account'])]]
    ])

    const result = resolve(objects, metadata)

    expect(result.length).toBe(2)
    // Account first (Contact hard-depends on it)
    expect(result[0]!.objectName).toBe('Account')
    // Account should have circular reference flagged (soft dep on Contact which comes after)
    expect(result[0]!.hasCircularReference).toBe(true)
    expect(result[0]!.deferredFields).toContain('Primary_Contact__c')
  })

  // testNoDependencies
  it('handles objects with no dependencies', () => {
    const objects = new Set(['Account', 'Lead', 'Product2'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', []],
      ['Lead', []],
      ['Product2', []]
    ])

    const result = resolve(objects, metadata)
    expect(result.length).toBe(3)
    for (const info of result) {
      expect(info.hasCircularReference).toBe(false)
    }
  })

  // testSelfReference
  it('treats a self-reference as circular and defers the field', () => {
    const objects = new Set(['Account'])
    const metadata = new Map<string, FieldInfo[]>([['Account', [lookup('ParentId', ['Account'])]]])

    const result = resolve(objects, metadata)
    expect(result.length).toBe(1)
    expect(result[0]!.hasCircularReference).toBe(true)
    expect(result[0]!.deferredFields).toContain('ParentId')
  })

  // testExternalReferenceIgnored
  it('ignores references to objects outside the migration set (OwnerId → User)', () => {
    // Reference to an object NOT in the migration set should be ignored
    const objects = new Set(['Contact'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Contact', [masterDetail('OwnerId', ['User'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.length).toBe(1)
    expect(result[0]!.hasCircularReference).toBe(false)
    expect(result[0]!.hardDependencies).toHaveLength(0)
  })

  // testSoftDepOnlyGraphOrdersParentsFirst
  it('orders parents first when the only links are nullable lookups (soft deps)', () => {
    // A child whose ONLY link to its parent is a NULLABLE lookup (soft dep)
    // must still sort AFTER the parent. Object names are chosen so the correct
    // dependency order is the REVERSE of alphabetical order — proving the sort
    // is dependency-driven, not incidentally alphabetical:
    //   Z_Root__c (no deps)  <-  B_Mid__c (nullable->Z_Root__c)  <-  A_Leaf__c (nullable->B_Mid__c)
    const objects = new Set(['A_Leaf__c', 'B_Mid__c', 'Z_Root__c'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Z_Root__c', []],
      ['B_Mid__c', [lookup('Root__c', ['Z_Root__c'])]],
      ['A_Leaf__c', [lookup('Mid__c', ['B_Mid__c'])]]
    ])

    const result = resolve(objects, metadata)

    expect(result.length).toBe(3)
    const pos = positions(result)
    // Parents-first even though every link is a nullable lookup (the bug this fixes).
    expect(pos.get('Z_Root__c')!).toBeLessThan(pos.get('B_Mid__c')!)
    expect(pos.get('B_Mid__c')!).toBeLessThan(pos.get('A_Leaf__c')!)
    // No genuine cycle here, so nothing should be flagged circular / deferred.
    for (const info of result) {
      expect(info.hasCircularReference).toBe(false)
      expect(info.deferredFields).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Extra edge-case coverage (thin in the Apex suite)
// ---------------------------------------------------------------------------

describe('DependencyResolver (extra edge cases)', () => {
  it('breaks lexicographic ties deterministically for independent objects', () => {
    const objects = new Set(['Product2', 'Lead', 'Account'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', []],
      ['Lead', []],
      ['Product2', []]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['Account', 'Lead', 'Product2'])
    expect(result.map((r) => r.sortOrder)).toEqual([1, 2, 3])
  })

  it('breaks a mutual nullable (soft) cycle lexicographically and defers only the earlier side', () => {
    // A <-> B via nullable lookups on both sides — a genuine soft cycle.
    const objects = new Set(['A__c', 'B__c'])
    const metadata = new Map<string, FieldInfo[]>([
      ['A__c', [lookup('B_Ref__c', ['B__c'])]],
      ['B__c', [lookup('A_Ref__c', ['A__c'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['A__c', 'B__c'])
    // A__c is emitted before its soft target B__c → circular + deferred.
    expect(result[0]!.hasCircularReference).toBe(true)
    expect(result[0]!.deferredFields).toEqual(['B_Ref__c'])
    // B__c's soft dep (A__c) is already behind it → clean.
    expect(result[1]!.hasCircularReference).toBe(false)
    expect(result[1]!.deferredFields).toHaveLength(0)
  })

  it('defers EVERY field pointing at the same forward target (Quote → Contract shape)', () => {
    // Quote has multiple nullable Contract lookups; Contract hard-depends on
    // Quote, forcing Quote first — all Contract refs must be deferred.
    const objects = new Set(['Quote__c', 'Contract__c'])
    const metadata = new Map<string, FieldInfo[]>([
      [
        'Quote__c',
        [
          lookup('Master_Contract__c', ['Contract__c']),
          lookup('Amendment_of_Contract__c', ['Contract__c']),
          lookup('Renewal_of_Contract__c', ['Contract__c'])
        ]
      ],
      ['Contract__c', [masterDetail('Quote__c', ['Quote__c'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['Quote__c', 'Contract__c'])
    const quote = byName(result, 'Quote__c')
    expect(quote.hasCircularReference).toBe(true)
    expect(quote.deferredFields).toEqual([
      'Master_Contract__c',
      'Amendment_of_Contract__c',
      'Renewal_of_Contract__c'
    ])
    expect(byName(result, 'Contract__c').hasCircularReference).toBe(false)
  })

  it('treats a NON-nillable self-reference as soft/deferred (self-check precedes nillable check)', () => {
    // Apex quirk pinned: the refTo == objName branch runs BEFORE the
    // isNillable branch, so even a required self-ref is deferred, never hard.
    const objects = new Set(['Account'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', [masterDetail('Master__c', ['Account'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.length).toBe(1)
    expect(result[0]!.hardDependencies).toHaveLength(0)
    expect(result[0]!.softDependencies).toEqual(['Account'])
    expect(result[0]!.hasCircularReference).toBe(true)
    expect(result[0]!.deferredFields).toEqual(['Master__c'])
  })

  it('does NOT flag hard cycles as circular (pathological branch still terminates, lexicographic order)', () => {
    // Apex quirk pinned: circular detection only inspects softDeps, so a
    // (platform-impossible) hard A<->B cycle emits in lexicographic order
    // with no circular flag and no deferred fields.
    const objects = new Set(['B__c', 'A__c'])
    const metadata = new Map<string, FieldInfo[]>([
      ['A__c', [masterDetail('B_Ref__c', ['B__c'])]],
      ['B__c', [masterDetail('A_Ref__c', ['A__c'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['A__c', 'B__c'])
    for (const info of result) {
      expect(info.hasCircularReference).toBe(false)
      expect(info.deferredFields).toHaveLength(0)
    }
    expect(byName(result, 'A__c').hardDependencies).toEqual(['B__c'])
    expect(byName(result, 'B__c').hardDependencies).toEqual(['A__c'])
  })

  it('creates soft deps on every in-set target of a polymorphic field', () => {
    // Task.WhatId → [Account, Opportunity]; both in the set, no cycle.
    const objects = new Set(['Task', 'Account', 'Opportunity'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', []],
      ['Opportunity', []],
      ['Task', [lookup('WhatId', ['Account', 'Opportunity'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['Account', 'Opportunity', 'Task'])
    const task = byName(result, 'Task')
    expect(task.softDependencies).toEqual(['Account', 'Opportunity'])
    expect(task.hasCircularReference).toBe(false)
  })

  it('appends a polymorphic field once PER deferred target (duplicate entries, Apex addAll parity)', () => {
    // A's polymorphic nullable field points at B and C; B and C hard-depend
    // on A, so A goes first and BOTH targets are forward → the field is
    // deferred once per target, appearing twice. Pins Apex addAll behavior.
    const objects = new Set(['A__c', 'B__c', 'C__c'])
    const metadata = new Map<string, FieldInfo[]>([
      ['A__c', [lookup('Poly__c', ['B__c', 'C__c'])]],
      ['B__c', [masterDetail('A_Ref__c', ['A__c'])]],
      ['C__c', [masterDetail('A_Ref__c', ['A__c'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['A__c', 'B__c', 'C__c'])
    const a = byName(result, 'A__c')
    expect(a.hasCircularReference).toBe(true)
    expect(a.deferredFields).toEqual(['Poly__c', 'Poly__c'])
  })

  it('orders a junction object after both hard parents', () => {
    const objects = new Set(['Junction__c', 'ParentA__c', 'ParentB__c'])
    const metadata = new Map<string, FieldInfo[]>([
      ['ParentA__c', []],
      ['ParentB__c', []],
      [
        'Junction__c',
        [masterDetail('Parent_A__c', ['ParentA__c']), masterDetail('Parent_B__c', ['ParentB__c'])]
      ]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['ParentA__c', 'ParentB__c', 'Junction__c'])
    const junction = byName(result, 'Junction__c')
    expect(junction.hardDependencies).toEqual(['ParentA__c', 'ParentB__c'])
    expect(junction.hasCircularReference).toBe(false)
  })

  it('orders a mixed hard/soft sales graph parents-first with no false circulars', () => {
    const objects = new Set(['QuoteLine__c', 'Quote__c', 'Opportunity', 'Contact', 'Account'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', []],
      ['Contact', [lookup('AccountId', ['Account'])]],
      ['Opportunity', [lookup('AccountId', ['Account']), lookup('ContactId', ['Contact'])]],
      [
        'Quote__c',
        [masterDetail('OpportunityId', ['Opportunity']), lookup('AccountId', ['Account'])]
      ],
      ['QuoteLine__c', [masterDetail('QuoteId', ['Quote__c'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
      'Quote__c',
      'QuoteLine__c'
    ])
    expect(result.map((r) => r.sortOrder)).toEqual([1, 2, 3, 4, 5])
    for (const info of result) {
      expect(info.hasCircularReference).toBe(false)
      expect(info.deferredFields).toHaveLength(0)
    }
  })

  it('ignores non-createable reference fields', () => {
    const objects = new Set(['Account', 'Contact'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Account', []],
      [
        'Contact',
        [field('AccountId', { referenceTo: ['Account'], isNillable: false, isCreateable: false })]
      ]
    ])

    const result = resolve(objects, metadata)
    const contact = byName(result, 'Contact')
    expect(contact.hardDependencies).toHaveLength(0)
    expect(contact.softDependencies).toHaveLength(0)
  })

  it('ignores non-reference fields and reference fields with empty referenceTo', () => {
    const objects = new Set(['Alpha__c', 'Beta__c'])
    const metadata = new Map<string, FieldInfo[]>([
      [
        'Alpha__c',
        [
          field('Not_A_Ref__c', {
            isReference: false,
            referenceTo: ['Beta__c'],
            isNillable: false
          }),
          field('Empty_Ref__c', { isReference: true, referenceTo: [], isNillable: false })
        ]
      ],
      ['Beta__c', []]
    ])

    const result = resolve(objects, metadata)
    const alpha = byName(result, 'Alpha__c')
    expect(alpha.hardDependencies).toHaveLength(0)
    expect(alpha.softDependencies).toHaveLength(0)
    // With no edges, order falls back to lexicographic.
    expect(result.map((r) => r.objectName)).toEqual(['Alpha__c', 'Beta__c'])
  })

  it('treats an object missing from the metadata map as having no dependencies', () => {
    // Apex: fieldMetadataByObject.get(objName) == null → continue.
    const objects = new Set(['Account', 'Contact'])
    const metadata = new Map<string, FieldInfo[]>([
      ['Contact', [masterDetail('AccountId', ['Account'])]]
    ])

    const result = resolve(objects, metadata)
    expect(result.map((r) => r.objectName)).toEqual(['Account', 'Contact'])
    const account = byName(result, 'Account')
    expect(account.hardDependencies).toHaveLength(0)
    expect(account.softDependencies).toHaveLength(0)
    expect(account.hasCircularReference).toBe(false)
  })

  it('deduplicates a repeated field name per target but keeps distinct fields', () => {
    // Same field API name appended twice for the same target collapses to one
    // deferred entry (appendSoftField contains-check parity).
    const objects = new Set(['A__c', 'B__c'])
    const metadata = new Map<string, FieldInfo[]>([
      [
        'A__c',
        [
          lookup('B_Ref__c', ['B__c']),
          lookup('B_Ref__c', ['B__c']), // duplicate describe row
          lookup('Other_B_Ref__c', ['B__c'])
        ]
      ],
      ['B__c', [masterDetail('A_Ref__c', ['A__c'])]]
    ])

    const result = resolve(objects, metadata)
    const a = byName(result, 'A__c')
    expect(a.hasCircularReference).toBe(true)
    expect(a.deferredFields).toEqual(['B_Ref__c', 'Other_B_Ref__c'])
  })
})
