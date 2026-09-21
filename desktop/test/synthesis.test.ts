import { describe, it, expect } from 'vitest'
import {
  synthesizeRequiredFields,
  defaultSynthClock,
  type SynthClock
} from '../src/main/engine/deploy/transform/synthesis'
import type { GoldenFieldInfo } from '../src/main/engine/deploy/golden/fixture'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'

/**
 * E4X.4 — required-field synthesis unit suite (Apex transformRecordV2 tail,
 * DDS L1044-1088). Covers every sentinel type + every skip condition. The
 * clock is injected fixed so date/datetime sentinels assert an exact format.
 */

// S49 (BUG-5): the sentinel now uses the Id's TAIL, lowercased — the head is
// the key-prefix/pod and is identical for every record of an object in an org,
// which made every synthesized UNIQUE field collide (only the first record of
// LaunchDarkly_Account__c could ever deploy).
const SOURCE_ID = 'ABCDEFGHijklmno' // full, lowercased → 'abcdefghijklmno'
const FIXED_CLOCK: SynthClock = {
  today: () => '2026-07-27',
  nowGmt: () => '2026-07-27T13:45:59.123Z'
}

/** A required (non-nillable), createable, synthesizable target field by default. */
function tf(partial: Partial<GoldenFieldInfo> & { apiName: string }): GoldenFieldInfo {
  return {
    dataType: 'string',
    isCreateable: true,
    isNillable: false,
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

function synth(
  fields: GoldenFieldInfo[],
  opts: { target?: Record<string, unknown>; sourceId?: string | null; deferredFields?: string[] } = {}
): Record<string, unknown> {
  const target = opts.target ?? {}
  const tfbn: Record<string, GoldenFieldInfo> = {}
  for (const f of fields) tfbn[f.apiName] = f
  synthesizeRequiredFields(
    target,
    { targetFieldsByName: tfbn, deferredFields: opts.deferredFields ?? [] },
    opts.sourceId === undefined ? SOURCE_ID : opts.sourceId,
    FIXED_CLOCK
  )
  return target
}

describe('synthesizeRequiredFields — sentinel table', () => {
  it('string / textarea → rds-<source Id, lowercased> (full id: unique per record)', () => {
    expect(synth([tf({ apiName: 'S', dataType: 'string' })]).S).toBe('rds-abcdefghijklmno')
    expect(synth([tf({ apiName: 'T', dataType: 'textarea' })]).T).toBe('rds-abcdefghijklmno')
  })

  it('two records of the same object get DIFFERENT sentinels (the BUG-5 regression)', () => {
    // Real ids from the failure: both share the 8-char head 'a5r1k000'.
    const a = synth([tf({ apiName: 'S', dataType: 'string' })], {
      sourceId: 'a5r1K000000iiNxQAI'
    }).S
    const b = synth([tf({ apiName: 'S', dataType: 'string' })], {
      sourceId: 'a5r1K000000ioPjQAI'
    }).S
    expect(a).not.toBe(b)
  })

  it('respects the target field length, trimming from the LEFT to keep the tail', () => {
    // budget = 12 - len('rds-') = 8 → last 8 chars, total exactly 12
    expect(synth([tf({ apiName: 'S', dataType: 'string', length: 12 })]).S).toBe('rds-hijklmno')
  })

  it('email → rds-<source Id>@example.invalid', () => {
    expect(synth([tf({ apiName: 'E', dataType: 'email' })]).E).toBe(
      'rds-abcdefghijklmno@example.invalid'
    )
  })

  it('url / phone → fixed sentinels', () => {
    expect(synth([tf({ apiName: 'U', dataType: 'url' })]).U).toBe('https://example.invalid/rds')
    expect(synth([tf({ apiName: 'P', dataType: 'phone' })]).P).toBe('5555550100')
  })

  it('int / double / currency / percent → 0 (numeric, not the string "0")', () => {
    for (const dt of ['int', 'double', 'currency', 'percent']) {
      const out = synth([tf({ apiName: 'N', dataType: dt })])
      expect(out.N).toBe(0)
      expect(out.N).not.toBe('0')
    }
  })

  it('boolean → false', () => {
    expect(synth([tf({ apiName: 'B', dataType: 'boolean' })]).B).toBe(false)
  })

  it('date / datetime → the injected clock values (exact format)', () => {
    expect(synth([tf({ apiName: 'D', dataType: 'date' })]).D).toBe('2026-07-27')
    expect(synth([tf({ apiName: 'DT', dataType: 'datetime' })]).DT).toBe('2026-07-27T13:45:59.123Z')
  })

  it('falls back to "x" in the sentinel when there is no source Id', () => {
    expect(synth([tf({ apiName: 'S', dataType: 'string' })], { sourceId: null }).S).toBe('rds-x')
    expect(synth([tf({ apiName: 'E', dataType: 'email' })], { sourceId: null }).E).toBe(
      'rds-x@example.invalid'
    )
  })
})

describe('synthesizeRequiredFields — skip conditions', () => {
  it('skips nillable / non-createable / autoNumber / calculated fields', () => {
    expect(synth([tf({ apiName: 'N1', isNillable: true })])).not.toHaveProperty('N1')
    expect(synth([tf({ apiName: 'N2', isCreateable: false })])).not.toHaveProperty('N2')
    expect(synth([tf({ apiName: 'N3', isAutoNumber: true })])).not.toHaveProperty('N3')
    expect(synth([tf({ apiName: 'N4', isCalculated: true })])).not.toHaveProperty('N4')
  })

  it('skips SYSTEM_MANAGED_FIELDS, the ExtId field, and references', () => {
    expect(synth([tf({ apiName: 'CreatedById' })])).not.toHaveProperty('CreatedById')
    expect(synth([tf({ apiName: EXTERNAL_ID_FIELD })])).not.toHaveProperty(EXTERNAL_ID_FIELD)
    expect(
      synth([tf({ apiName: 'AccountId', isReference: true, referenceTo: ['Account'] })])
    ).not.toHaveProperty('AccountId')
  })

  it('matches the ExtId field name case-insensitively (Apex ==)', () => {
    expect(
      synth([tf({ apiName: EXTERNAL_ID_FIELD.toLowerCase() })])
    ).not.toHaveProperty(EXTERNAL_ID_FIELD.toLowerCase())
  })

  it('skips a deferred field (first-pass exclusion)', () => {
    expect(
      synth([tf({ apiName: 'Def__c' })], { deferredFields: ['Def__c'] })
    ).not.toHaveProperty('Def__c')
  })

  it('does not overwrite a field already present in the payload', () => {
    const out = synth([tf({ apiName: 'S' })], { target: { S: 'existing' } })
    expect(out.S).toBe('existing')
  })

  it('skips when the field’s relationship shape is already in the payload', () => {
    const out = synth([tf({ apiName: 'AccountId', relationshipName: 'Account', dataType: 'string' })], {
      target: { Account: { [EXTERNAL_ID_FIELD]: 'x' } }
    })
    expect(out).not.toHaveProperty('AccountId')
  })

  it('skips a non-synthesizable data type (e.g. picklist / base64)', () => {
    expect(synth([tf({ apiName: 'PL', dataType: 'picklist' })])).not.toHaveProperty('PL')
    expect(synth([tf({ apiName: 'B64', dataType: 'base64' })])).not.toHaveProperty('B64')
    expect(synth([tf({ apiName: 'Null', dataType: null })])).not.toHaveProperty('Null')
  })

  it('is a no-op when targetFieldsByName is empty (synthesis disabled)', () => {
    const target = { Name: 'Acme' }
    synthesizeRequiredFields(target, { targetFieldsByName: {}, deferredFields: [] }, SOURCE_ID, FIXED_CLOCK)
    expect(target).toEqual({ Name: 'Acme' })
  })
})

describe('synthesizeRequiredFields — defaultSynthClock format', () => {
  it('emits a yyyy-MM-dd date and a yyyy-MM-ddTHH:mm:ss.SSSZ datetime', () => {
    expect(defaultSynthClock.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(defaultSynthClock.nowGmt()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
