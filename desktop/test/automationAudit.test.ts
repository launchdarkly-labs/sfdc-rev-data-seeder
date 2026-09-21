/**
 * S53 (item 1) — the automation-born-row audit, pure lane. The re-run duplicate class:
 * rows the TARGET's own automation created during a load carry no RDS key, so
 * a re-run neither updates nor removes them. The fingerprint is rows created
 * in the run window by the deploying user with a null key.
 */
import { describe, it, expect } from 'vitest'
import {
  AUDIT_SAMPLE_LIMIT,
  AUDIT_WINDOW_SKEW_MS,
  AUTOMATION_SPAWN_OBJECTS,
  describeFindings,
  isMissingObjectError,
  postRunAuditQueries,
  preRunAuditQueries,
  runAudit,
  soqlDateTime,
  type AuditQuery
} from '../src/main/engine/deploy/automationAudit'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'

const START = Date.UTC(2026, 8, 11, 0, 53, 38, 123) // 2026-09-11T00:53:38.123Z
const USER = '005TI00000AbCdEfGH'

describe('soqlDateTime', () => {
  it('renders a UTC literal without fractional seconds (SOQL rejects them)', () => {
    expect(soqlDateTime(START)).toBe('2026-09-11T00:53:38Z')
  })
})

describe('postRunAuditQueries — rows created in the run window by the deploying user, no key', () => {
  const objects = [
    { objectName: 'Account', isJunction: false },
    { objectName: 'OpportunityContactRole', isJunction: true },
    { objectName: 'OpportunityLineItem', isJunction: false }
  ]

  it('one query per non-junction plan object, key-filtered, windowed with the skew allowance', () => {
    const qs = postRunAuditQueries({
      objects,
      targetHasExtId: new Set(['Account', 'OpportunityLineItem']),
      runStartedAtMs: START,
      deployingUserId: USER
    })
    const acc = qs.find((q) => q.objectApiName === 'Account')!
    expect(acc.kind).toBe('automation_born')
    expect(acc.countSoql).toBe(
      `SELECT COUNT() FROM Account WHERE CreatedDate >= ${soqlDateTime(START - AUDIT_WINDOW_SKEW_MS)} ` +
        `AND CreatedById = '${USER}' AND ${EXTERNAL_ID_FIELD} = null`
    )
    expect(acc.sampleSoql).toContain(`ORDER BY CreatedDate DESC LIMIT ${AUDIT_SAMPLE_LIMIT}`)
    // Junctions are never audited — the engine itself inserts them unkeyed.
    expect(qs.some((q) => q.objectApiName === 'OpportunityContactRole')).toBe(false)
  })

  it('adds the known CPQ spawn objects NOT in the plan, without the key filter when they have no key', () => {
    const qs = postRunAuditQueries({
      objects,
      targetHasExtId: new Set(['Account', 'OpportunityLineItem', 'Contract']),
      runStartedAtMs: START,
      deployingUserId: USER
    })
    // OLI is in the plan → exactly one query for it (not duplicated by the spawn list).
    expect(qs.filter((q) => q.objectApiName === 'OpportunityLineItem')).toHaveLength(1)
    for (const spawn of AUTOMATION_SPAWN_OBJECTS) {
      expect(qs.some((q) => q.objectApiName === spawn)).toBe(true)
    }
    // Contract has the key org-wide → key-filtered; SBQQ__Subscription__c does not →
    // every row the user created in the window is foreign.
    expect(qs.find((q) => q.objectApiName === 'Contract')!.countSoql).toContain(
      `${EXTERNAL_ID_FIELD} = null`
    )
    expect(qs.find((q) => q.objectApiName === 'SBQQ__Subscription__c')!.countSoql).not.toContain(
      EXTERNAL_ID_FIELD
    )
  })

  it('bounds the window from above by the run’s finish time (+ skew) when known', () => {
    const FINISH = START + 15 * 60_000
    const bounded = postRunAuditQueries({
      objects: [{ objectName: 'Account', isJunction: false }],
      targetHasExtId: new Set(['Account']),
      runStartedAtMs: START,
      runFinishedAtMs: FINISH,
      deployingUserId: USER
    })
    expect(bounded[0]!.countSoql).toContain(
      `CreatedDate >= ${soqlDateTime(START - AUDIT_WINDOW_SKEW_MS)} AND CreatedDate <= ${soqlDateTime(FINISH + AUDIT_WINDOW_SKEW_MS)} AND`
    )
    // A Stalled run has no finish stamp → open-ended (the audit runs right after teardown).
    const open = postRunAuditQueries({
      objects: [{ objectName: 'Account', isJunction: false }],
      targetHasExtId: new Set(['Account']),
      runStartedAtMs: START,
      runFinishedAtMs: null,
      deployingUserId: USER
    })
    expect(open[0]!.countSoql).not.toContain('CreatedDate <=')
  })

  it('excludes the platform’s own OpportunityTeamMember “Opportunity Owner” rows (run 15 evidence)', () => {
    const qs = postRunAuditQueries({
      objects: [
        { objectName: 'OpportunityTeamMember', isJunction: false },
        { objectName: 'Account', isJunction: false }
      ],
      targetHasExtId: new Set(['OpportunityTeamMember', 'Account']),
      runStartedAtMs: START,
      deployingUserId: USER
    })
    expect(qs.find((q) => q.objectApiName === 'OpportunityTeamMember')!.countSoql).toContain(
      "AND TeamMemberRole != 'Opportunity Owner'"
    )
    expect(qs.find((q) => q.objectApiName === 'Account')!.countSoql).not.toContain('TeamMemberRole')
    const pre = preRunAuditQueries(
      [
        {
          objectName: 'OpportunityTeamMember',
          isJunction: false,
          scopeParentField: 'OpportunityId',
          scopeParentObject: 'Opportunity',
          scopeParentRelationship: 'Opportunity'
        }
      ],
      new Set(['OpportunityTeamMember', 'Opportunity'])
    )
    expect(pre[0]!.countSoql).toContain("AND TeamMemberRole != 'Opportunity Owner'")
  })

  it('escapes the user id', () => {
    const qs = postRunAuditQueries({
      objects: [{ objectName: 'Account', isJunction: false }],
      targetHasExtId: new Set(['Account']),
      runStartedAtMs: START,
      deployingUserId: "005'; DELETE"
    })
    expect(qs[0]!.countSoql).toContain("CreatedById = '005\\'; DELETE'")
  })
})

describe('preRunAuditQueries — unkeyed rows already under RDS-keyed parents (scope relationship)', () => {
  it('one COUNT per scoped child along its scope relationship; root / junction / keyless skipped', () => {
    const qs = preRunAuditQueries(
      [
        {
          objectName: 'Account',
          isJunction: false,
          scopeParentField: null,
          scopeParentObject: null,
          scopeParentRelationship: null
        },
        {
          objectName: 'SBQQ__QuoteLine__c',
          isJunction: false,
          scopeParentField: 'SBQQ__Quote__c',
          scopeParentObject: 'SBQQ__Quote__c',
          scopeParentRelationship: 'SBQQ__Quote__r'
        },
        {
          objectName: 'OpportunityContactRole',
          isJunction: true,
          scopeParentField: 'OpportunityId',
          scopeParentObject: 'Opportunity',
          scopeParentRelationship: 'Opportunity'
        },
        {
          objectName: 'NoKey__c',
          isJunction: false,
          scopeParentField: 'Account__c',
          scopeParentObject: 'Account',
          scopeParentRelationship: 'Account__r'
        },
        {
          objectName: 'Task',
          isJunction: false,
          scopeParentField: 'WhatId',
          scopeParentObject: 'Account',
          scopeParentRelationship: null // polymorphic — cannot traverse
        }
      ],
      new Set(['Account', 'SBQQ__Quote__c', 'SBQQ__QuoteLine__c', 'Task'])
    )
    expect(qs).toHaveLength(1)
    expect(qs[0]).toMatchObject({
      kind: 'pre_run_unkeyed',
      objectApiName: 'SBQQ__QuoteLine__c',
      refObject: 'SBQQ__Quote__c',
      refField: 'SBQQ__Quote__c',
      sampleSoql: null
    })
    expect(qs[0]!.countSoql).toBe(
      `SELECT COUNT() FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__r.${EXTERNAL_ID_FIELD} != null ` +
        `AND ${EXTERNAL_ID_FIELD} = null`
    )
  })
})

describe('runAudit — fail-open per object, samples only for hits', () => {
  const q = (objectApiName: string, sample = true): AuditQuery => ({
    kind: 'automation_born',
    objectApiName,
    refObject: null,
    refField: null,
    countSoql: `COUNT ${objectApiName}`,
    sampleSoql: sample ? `SAMPLE ${objectApiName}` : null
  })

  it('reports non-zero counts with sample ids, skips zero counts', async () => {
    const sampleCalls: string[] = []
    const r = await runAudit([q('OpportunityLineItem'), q('Account')], {
      count: async (soql) => (soql.includes('OpportunityLineItem') ? 137 : 0),
      sampleIds: async (soql) => {
        sampleCalls.push(soql)
        return ['00k1', '00k2']
      }
    })
    expect(r.findings).toEqual([
      {
        kind: 'automation_born',
        objectApiName: 'OpportunityLineItem',
        refObject: null,
        refField: null,
        count: 137,
        sampleIds: ['00k1', '00k2']
      }
    ])
    expect(sampleCalls).toEqual(['SAMPLE OpportunityLineItem']) // no sample for the zero
    expect(r.errors).toEqual([])
  })

  it('a missing sObject (spawn object absent on target) is skipped silently; other errors are reported', async () => {
    const r = await runAudit([q('SBQQ__Subscription__c'), q('Asset'), q('Account')], {
      count: async (soql) => {
        if (soql.includes('SBQQ__'))
          throw new Error("INVALID_TYPE: sObject type 'SBQQ__Subscription__c' is not supported.")
        if (soql.includes('Asset'))
          throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.')
        return 0
      },
      sampleIds: async () => []
    })
    expect(r.skippedMissingObjects).toEqual(['SBQQ__Subscription__c'])
    expect(r.errors).toEqual([
      { objectApiName: 'Asset', error: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.' }
    ])
    expect(r.findings).toEqual([])
  })

  it('a failed sample keeps the count finding', async () => {
    const r = await runAudit([q('Account')], {
      count: async () => 3,
      sampleIds: async () => {
        throw new Error('boom')
      }
    })
    expect(r.findings[0]).toMatchObject({ count: 3, sampleIds: [] })
  })

  it('isMissingObjectError recognises the platform wordings', () => {
    expect(isMissingObjectError("sObject type 'Asset' is not supported")).toBe(true)
    expect(isMissingObjectError('INVALID_TYPE: …')).toBe(true)
    expect(isMissingObjectError("Didn't understand relationship 'SBQQ__Quote__r'")).toBe(true)
    expect(isMissingObjectError('REQUEST_LIMIT_EXCEEDED')).toBe(false)
  })
})

describe('describeFindings', () => {
  it('names objects with counts; pre-run findings name the parent relationship', () => {
    expect(
      describeFindings([
        {
          kind: 'automation_born',
          objectApiName: 'OpportunityLineItem',
          refObject: null,
          refField: null,
          count: 59,
          sampleIds: []
        },
        {
          kind: 'pre_run_unkeyed',
          objectApiName: 'SBQQ__QuoteLine__c',
          refObject: 'SBQQ__Quote__c',
          refField: 'SBQQ__Quote__c',
          count: 137,
          sampleIds: []
        }
      ])
    ).toBe(
      'OpportunityLineItem (59), SBQQ__QuoteLine__c (137 under keyed SBQQ__Quote__c via SBQQ__Quote__c)'
    )
  })
})
