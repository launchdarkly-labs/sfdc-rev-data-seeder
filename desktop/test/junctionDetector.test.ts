/**
 * Vitest port of the JunctionDetector behavior contract.
 *
 * NOTE on Apex test provenance: the Apex codebase has NO direct unit test for
 * JunctionDetector.detect/isKnownJunction — JunctionDeployCoverageTest drives
 * the downstream deploy path (executeJunctionDeploy) against hand-inserted
 * Deployment_Object__c rows. Every test below therefore pins the detector's
 * shipped semantics directly (per the "add edge-case tests where Apex coverage
 * was thin" rule), including the synthetic-FieldInfo contract that
 * DeploymentAnalysisQueueable.injectDetectedJunctions builds for junction rows.
 */
import { describe, it, expect } from 'vitest'
import {
  KNOWN_JUNCTIONS,
  detect,
  isKnownJunction,
  buildSyntheticParentFieldInfos
} from '../src/main/engine/junctionDetector'
import type { JunctionInfo } from '../src/main/engine/junctionDetector'

describe('KNOWN_JUNCTIONS registry (exactly as shipped)', () => {
  it('contains exactly one registered junction today: OpportunityContactRole', () => {
    expect(KNOWN_JUNCTIONS.size).toBe(1)
    expect(KNOWN_JUNCTIONS.has('OpportunityContactRole')).toBe(true)
  })

  it('OpportunityContactRole entry keeps parents and parentFields positionally aligned', () => {
    const ocr = KNOWN_JUNCTIONS.get('OpportunityContactRole')!
    expect(ocr.objectName).toBe('OpportunityContactRole')
    expect(ocr.parents).toEqual(['Opportunity', 'Contact'])
    expect(ocr.parentFields).toEqual(['OpportunityId', 'ContactId'])
  })
})

describe('detect — positive cases', () => {
  it('returns OpportunityContactRole when both parents are in scope', () => {
    const result = detect(new Set(['Opportunity', 'Contact']))
    expect(result).toHaveLength(1)
    expect(result[0]!.objectName).toBe('OpportunityContactRole')
    expect(result[0]!.parents).toEqual(['Opportunity', 'Contact'])
    expect(result[0]!.parentFields).toEqual(['OpportunityId', 'ContactId'])
  })

  it('still detects when scope contains extra unrelated objects', () => {
    const result = detect(new Set(['Account', 'Opportunity', 'Contact', 'SBQQ__Quote__c']))
    expect(result).toHaveLength(1)
    expect(result[0]!.objectName).toBe('OpportunityContactRole')
  })

  it('returns the SHARED registry instance, not a clone (Apex parity quirk)', () => {
    const result = detect(new Set(['Opportunity', 'Contact']))
    expect(result[0]).toBe(KNOWN_JUNCTIONS.get('OpportunityContactRole'))
  })
})

describe('detect — negative / parents-missing cases', () => {
  it('returns empty when only one parent (Opportunity) is in scope', () => {
    expect(detect(new Set(['Opportunity']))).toEqual([])
  })

  it('returns empty when only one parent (Contact) is in scope', () => {
    expect(detect(new Set(['Contact', 'Account']))).toEqual([])
  })

  it('returns empty when neither parent is in scope', () => {
    expect(detect(new Set(['Account', 'Case', 'Product2']))).toEqual([])
  })

  it('returns empty for an empty scope', () => {
    expect(detect(new Set())).toEqual([])
  })

  it('returns empty for null / undefined scope (Apex null-Set guard)', () => {
    expect(detect(null)).toEqual([])
    expect(detect(undefined)).toEqual([])
  })

  it('scope membership is case-SENSITIVE, matching Apex Set<String> semantics', () => {
    expect(detect(new Set(['opportunity', 'contact']))).toEqual([])
    expect(detect(new Set(['OPPORTUNITY', 'Contact']))).toEqual([])
  })

  it('junction API name in scope does NOT satisfy parent membership', () => {
    expect(detect(new Set(['OpportunityContactRole']))).toEqual([])
  })
})

describe('detect — junction already in scope (skip lives in the caller)', () => {
  it('still RETURNS the junction when it is itself in scope — Apex detect does not skip', () => {
    // Exactly as shipped: the "user picked it manually, leave it alone" skip is
    // implemented in DeploymentAnalysisQueueable.injectDetectedJunctions, not
    // in JunctionDetector.detect.
    const scope = new Set(['Opportunity', 'Contact', 'OpportunityContactRole'])
    const result = detect(scope)
    expect(result).toHaveLength(1)
    expect(result[0]!.objectName).toBe('OpportunityContactRole')
  })

  it('caller-side skip filter (injectDetectedJunctions pattern) removes in-scope junctions', () => {
    const scope = new Set(['Opportunity', 'Contact', 'OpportunityContactRole'])
    const toInject = detect(scope).filter((j) => !scope.has(j.objectName))
    expect(toInject).toEqual([])
  })

  it('caller-side skip filter keeps junctions the user did not pick', () => {
    const scope = new Set(['Opportunity', 'Contact'])
    const toInject = detect(scope).filter((j) => !scope.has(j.objectName))
    expect(toInject).toHaveLength(1)
    expect(toInject[0]!.objectName).toBe('OpportunityContactRole')
  })
})

describe('isKnownJunction', () => {
  it('returns true for a registered junction', () => {
    expect(isKnownJunction('OpportunityContactRole')).toBe(true)
  })

  it('returns false for non-junction objects', () => {
    expect(isKnownJunction('Account')).toBe(false)
    expect(isKnownJunction('Opportunity')).toBe(false)
  })

  it('is case-sensitive, matching Apex Map key semantics', () => {
    expect(isKnownJunction('opportunitycontactrole')).toBe(false)
    expect(isKnownJunction('OPPORTUNITYCONTACTROLE')).toBe(false)
  })

  it('returns false for blank inputs (Apex String.isBlank parity)', () => {
    expect(isKnownJunction(null)).toBe(false)
    expect(isKnownJunction(undefined)).toBe(false)
    expect(isKnownJunction('')).toBe(false)
    expect(isKnownJunction('   ')).toBe(false)
    expect(isKnownJunction('\t\n')).toBe(false)
  })
})

describe('buildSyntheticParentFieldInfos — the shape the analysis caches for junction rows', () => {
  it('builds one hard-reference FieldInfo per parent FK, positionally paired', () => {
    const ocr = KNOWN_JUNCTIONS.get('OpportunityContactRole')!
    const synth = buildSyntheticParentFieldInfos(ocr)
    expect(synth).toHaveLength(2)

    const [oppFk, conFk] = synth
    expect(oppFk!.apiName).toBe('OpportunityId')
    expect(oppFk!.referenceTo).toEqual(['Opportunity'])
    expect(conFk!.apiName).toBe('ContactId')
    expect(conFk!.referenceTo).toEqual(['Contact'])
  })

  it('marks each synthetic FK exactly as the Apex analysis does (hard, createable reference)', () => {
    const ocr = KNOWN_JUNCTIONS.get('OpportunityContactRole')!
    for (const fi of buildSyntheticParentFieldInfos(ocr)) {
      // Values the Apex synth sets explicitly (injectDetectedJunctions):
      expect(fi.type).toBe('reference') // Apex dataType = 'reference'
      expect(fi.isReference).toBe(true)
      expect(fi.isCreateable).toBe(true)
      expect(fi.isNillable).toBe(false) // isNillable=false ⇒ hard dependency edge
      expect(fi.isExternalId).toBe(false)
      expect(fi.isAutoNumber).toBe(false)
      expect(fi.isCalculated).toBe(false)
      // TS-required fields the Apex synth left null/absent (documented deviation):
      expect(fi.label).toBe(fi.apiName)
      expect(fi.isUpdateable).toBe(false)
      expect(fi.isRestrictedPicklist).toBe(false)
      expect(fi.picklistValues).toEqual([])
      expect(fi.length).toBeNull()
    }
  })

  it('iteration is bounded by parentFields — extra parents are silently ignored (Apex loop parity)', () => {
    const lopsided: JunctionInfo = {
      objectName: 'Fake__c',
      parents: ['Account', 'Contact', 'User'],
      parentFields: ['AccountId', 'ContactId']
    }
    const synth = buildSyntheticParentFieldInfos(lopsided)
    expect(synth).toHaveLength(2)
    expect(synth.map((f) => f.apiName)).toEqual(['AccountId', 'ContactId'])
    expect(synth.map((f) => f.referenceTo)).toEqual([['Account'], ['Contact']])
  })

  it('throws when parentFields outnumber parents (Apex: List index out of bounds)', () => {
    const misaligned: JunctionInfo = {
      objectName: 'Fake__c',
      parents: ['Account'],
      parentFields: ['AccountId', 'ContactId']
    }
    expect(() => buildSyntheticParentFieldInfos(misaligned)).toThrow(/misaligned/)
  })

  it('detect output feeds straight into the synthetic builder (analysis pipeline contract)', () => {
    const detected = detect(new Set(['Opportunity', 'Contact']))
    expect(detected).toHaveLength(1)
    const synth = buildSyntheticParentFieldInfos(detected[0]!)
    expect(synth.map((f) => [f.apiName, f.referenceTo[0]])).toEqual([
      ['OpportunityId', 'Opportunity'],
      ['ContactId', 'Contact']
    ])
  })
})
