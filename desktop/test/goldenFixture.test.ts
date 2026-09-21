import { describe, it, expect } from 'vitest'
import {
  fixturePath,
  compareOutcome,
  serializeFixture,
  parseFixture,
  type GoldenOutcome,
  type GoldenFixture,
  type GoldenContext
} from '../src/main/engine/deploy/golden/fixture'

const CTX: GoldenContext = {
  objectName: 'Account',
  fields: [],
  deferredFields: [],
  mappings: {},
  nameMatchMaps: {},
  useBulkFormat: false,
  targetUserId: null,
  inactiveUserIds: [],
  targetFieldsByName: {},
  targetPicklistAllowedValues: {},
  inactivePbeIds: [],
  pbeSubstitutes: {}
}

function outcome(over: Partial<GoldenOutcome> = {}): GoldenOutcome {
  return { payload: {}, skipped: false, skipReason: null, droppedPicklistValues: {}, ...over }
}

describe('fixturePath', () => {
  it('builds <object>/<sourceId>.json', () => {
    expect(fixturePath('Account', '0011K00002GwMRVQA3')).toBe('Account/0011K00002GwMRVQA3.json')
  })

  it('sanitizes namespaced objects and any traversal characters', () => {
    expect(fixturePath('SBQQ__Quote__c', 'a1X')).toBe('SBQQ__Quote__c/a1X.json')
    expect(fixturePath('../../etc', 'a/b')).toBe('______etc/a_b.json')
  })

  it('throws on empty object or sourceId', () => {
    expect(() => fixturePath('', 'a')).toThrow()
    expect(() => fixturePath('Account', '')).toThrow()
  })
})

describe('compareOutcome', () => {
  it('returns no diffs for identical outcomes', () => {
    expect(compareOutcome(outcome(), outcome())).toEqual([])
  })

  it('flags a skipped mismatch', () => {
    const d = compareOutcome(outcome({ skipped: true, payload: null }), outcome())
    expect(d.some((x) => x.path === 'skipped')).toBe(true)
  })

  it('treats skipReason byte-exact (case-sensitive)', () => {
    const d = compareOutcome(
      outcome({ skipped: true, payload: null, skipReason: 'inactive_pbe_no_substitute' }),
      outcome({ skipped: true, payload: null, skipReason: 'Inactive_Pbe_No_Substitute' })
    )
    expect(d).toHaveLength(1)
    expect(d[0]!.path).toBe('skipReason')
  })

  it('detects added / removed / changed payload keys', () => {
    const base = outcome({ payload: { Name: 'A', Data_Deployment_External_Id__c: 'rev' } })
    const missing = compareOutcome(base, outcome({ payload: { Name: 'A' } }))
    expect(missing.map((x) => x.path)).toContain('payload.Data_Deployment_External_Id__c')

    const changed = compareOutcome(base, outcome({ payload: { Name: 'B', Data_Deployment_External_Id__c: 'rev' } }))
    expect(changed.map((x) => x.path)).toContain('payload.Name')
  })

  it('deep-equals nested ExtId relationship maps', () => {
    const nested = { AccountId: undefined, Account: { Data_Deployment_External_Id__c: 'xyz' } }
    const a = outcome({ payload: { Account: { Data_Deployment_External_Id__c: 'xyz' } } })
    const b = outcome({ payload: { Account: { Data_Deployment_External_Id__c: 'xyz' } } })
    expect(compareOutcome(a, b)).toEqual([])
    void nested
    const c = outcome({ payload: { Account: { Data_Deployment_External_Id__c: 'DIFFERENT' } } })
    expect(compareOutcome(a, c).map((x) => x.path)).toContain('payload.Account')
  })

  it('tolerates Set-order in droppedPicklistValues (same multiset, different order)', () => {
    const a = outcome({ droppedPicklistValues: { Status: ['Open', 'Closed'] } })
    const b = outcome({ droppedPicklistValues: { Status: ['Closed', 'Open'] } })
    expect(compareOutcome(a, b)).toEqual([])
  })

  it('flags a genuinely different picklist-drop multiset', () => {
    const a = outcome({ droppedPicklistValues: { Status: ['Open'] } })
    const b = outcome({ droppedPicklistValues: { Status: ['Open', 'Closed'] } })
    expect(compareOutcome(a, b).map((x) => x.path)).toContain('droppedPicklistValues.Status')
  })

  it('flags payload null-vs-present', () => {
    const d = compareOutcome(outcome({ payload: null }), outcome({ payload: {} }))
    expect(d.map((x) => x.path)).toContain('payload')
  })

  describe('clock-synthesized date/datetime tolerance', () => {
    const dateField = {
      apiName: 'Activation_Date__c',
      dataType: 'date',
      isCreateable: true,
      isNillable: false, // required-on-target ⇒ synthesized when source omits it
      isReference: false,
      referenceTo: [],
      relationshipName: null,
      isAutoNumber: false,
      isCalculated: false,
      isExternalId: false,
      isRestrictedPicklist: false
    }
    const ctxWithDate: GoldenContext = { ...CTX, targetFieldsByName: { Activation_Date__c: dateField } }
    const capturedDay = { payload: { Activation_Date__c: '2026-07-01' } }
    const replayDay = { payload: { Activation_Date__c: '2026-07-25' } }

    it('flags the differing synthesized date with a STRICT (no-opts) compare', () => {
      const d = compareOutcome(outcome(capturedDay), outcome(replayDay))
      expect(d.map((x) => x.path)).toContain('payload.Activation_Date__c')
    })

    it('tolerates the differing synthesized date when input + context are provided', () => {
      const d = compareOutcome(outcome(capturedDay), outcome(replayDay), {
        input: { Id: '001' }, // source did NOT supply Activation_Date__c ⇒ synthesized
        context: ctxWithDate
      })
      expect(d).toEqual([])
    })

    it('does NOT tolerate a date field the SOURCE actually provided (real value must match)', () => {
      const d = compareOutcome(outcome(capturedDay), outcome(replayDay), {
        input: { Id: '001', Activation_Date__c: '2026-07-01' }, // source-provided ⇒ strict
        context: ctxWithDate
      })
      expect(d.map((x) => x.path)).toContain('payload.Activation_Date__c')
    })

    it('still flags presence mismatch even for a tolerant field', () => {
      const d = compareOutcome(outcome(capturedDay), outcome({ payload: {} }), {
        input: { Id: '001' },
        context: ctxWithDate
      })
      expect(d.map((x) => x.path)).toContain('payload.Activation_Date__c')
    })

    it('does not tolerate a nillable date field (never synthesized)', () => {
      const nillable: GoldenContext = {
        ...CTX,
        targetFieldsByName: { Activation_Date__c: { ...dateField, isNillable: true } }
      }
      const d = compareOutcome(outcome(capturedDay), outcome(replayDay), {
        input: { Id: '001' },
        context: nillable
      })
      expect(d.map((x) => x.path)).toContain('payload.Activation_Date__c')
    })
  })
})

describe('serializeFixture / parseFixture', () => {
  const fixture: GoldenFixture = {
    object: 'Account',
    sourceId: '0011K00002GwMRVQA3',
    captureId: 'cap-1',
    input: { Id: '0011K00002GwMRVQA3', Name: 'Acme' },
    context: {
      ...CTX,
      deferredFields: ['ParentId', 'AccountId'],
      inactiveUserIds: ['005B', '005A'],
      targetPicklistAllowedValues: { Status: ['Open', 'Closed'] }
    },
    outcome: outcome({ droppedPicklistValues: { Status: ['Open', 'Closed'] } })
  }

  it('is deterministic — same input, byte-identical output', () => {
    expect(serializeFixture(fixture)).toBe(serializeFixture(fixture))
  })

  it('sorts Set-sourced lists so Apex hash-order cannot flake the file', () => {
    const out = serializeFixture(fixture)
    const parsed = JSON.parse(out) as GoldenFixture
    expect(parsed.context.deferredFields).toEqual(['AccountId', 'ParentId'])
    expect(parsed.context.inactiveUserIds).toEqual(['005A', '005B'])
    expect(parsed.context.targetPicklistAllowedValues.Status).toEqual(['Closed', 'Open'])
    expect(parsed.outcome.droppedPicklistValues.Status).toEqual(['Closed', 'Open'])
  })

  it('re-capture order independence — differently-ordered Set fields serialize identically', () => {
    const reordered: GoldenFixture = {
      ...fixture,
      context: { ...fixture.context, deferredFields: ['AccountId', 'ParentId'], inactiveUserIds: ['005A', '005B'] }
    }
    expect(serializeFixture(reordered)).toBe(serializeFixture(fixture))
  })

  it('ends with a trailing newline', () => {
    expect(serializeFixture(fixture).endsWith('}\n')).toBe(true)
  })

  it('round-trips through parseFixture', () => {
    const parsed = parseFixture(serializeFixture(fixture))
    expect(parsed.object).toBe('Account')
    expect(parsed.sourceId).toBe('0011K00002GwMRVQA3')
    expect(parsed.outcome.skipped).toBe(false)
  })

  it('throws on a malformed fixture', () => {
    expect(() => parseFixture('{"object":"Account"}')).toThrow(/malformed/)
    expect(() => parseFixture('null')).toThrow()
  })
})
