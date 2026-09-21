import { describe, it, expect } from 'vitest'
import { applyPbeGate } from '../src/main/engine/deploy/transform/pbeGate'
import type { GoldenContext, GoldenOutcome } from '../src/main/engine/deploy/golden/fixture'

/**
 * E4X.4 — inactive-PBE gate unit suite (stage 3, DDS L1176-1205). Covers the
 * dual-form (15/18) set membership + substitute lookup, the exactly-18
 * normalization boundary, the no-substitute skip, and the non-OLI/absent guards.
 */

const PBE_18 = 'a0Bfn0000001abcAAM'
const PBE_15 = 'a0Bfn0000001abc' // == PBE_18.substring(0,15)
const SUB_18 = 'a0Bfn0000009zzzAAM'

type PbeCtx = Pick<
  GoldenContext,
  'objectName' | 'inactivePbeIds' | 'pbeSubstitutes' | 'knownPbeIds'
>

function outcome(payload: Record<string, unknown> | null): GoldenOutcome {
  return { payload, skipped: false, skipReason: null, droppedPicklistValues: {} }
}

function run(payload: Record<string, unknown> | null, ctx: Partial<PbeCtx>): GoldenOutcome {
  const o = outcome(payload)
  applyPbeGate(o, {
    objectName: ctx.objectName ?? 'OpportunityLineItem',
    inactivePbeIds: ctx.inactivePbeIds ?? [],
    pbeSubstitutes: ctx.pbeSubstitutes ?? {},
    knownPbeIds: ctx.knownPbeIds ?? []
  })
  return o
}

describe('applyPbeGate — guards', () => {
  it('no-ops on a non-OLI object', () => {
    const o = run({ PricebookEntryId: PBE_18 }, { objectName: 'Account', inactivePbeIds: [PBE_18] })
    expect(o.payload).toEqual({ PricebookEntryId: PBE_18 })
    expect(o.skipped).toBe(false)
  })

  it('no-ops when there are no inactive PBEs', () => {
    const o = run({ PricebookEntryId: PBE_18 }, { inactivePbeIds: [] })
    expect(o.payload).toEqual({ PricebookEntryId: PBE_18 })
  })

  it('no-ops when the payload has no PricebookEntryId', () => {
    const o = run({ Quantity: 1 }, { inactivePbeIds: [PBE_18] })
    expect(o.payload).toEqual({ Quantity: 1 })
  })

  it('leaves an ACTIVE PBE untouched', () => {
    const o = run({ PricebookEntryId: PBE_18 }, { inactivePbeIds: ['a0Bfn0000000otherAA'] })
    expect(o.payload).toEqual({ PricebookEntryId: PBE_18 })
  })

  it('matches the OLI object name case-INSENSITIVELY (Apex ==)', () => {
    const o = run(
      { PricebookEntryId: PBE_18 },
      { objectName: 'opportunitylineitem', inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_18]: SUB_18 } }
    )
    expect(o.payload).toEqual({ PricebookEntryId: SUB_18 })
  })
})

describe('applyPbeGate — substitution', () => {
  it('swaps an inactive PBE for its active substitute', () => {
    const o = run(
      { PricebookEntryId: PBE_18, Quantity: 2 },
      { inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_18]: SUB_18 } }
    )
    expect(o.payload).toEqual({ PricebookEntryId: SUB_18, Quantity: 2 })
    expect(o.skipped).toBe(false)
  })

  it('matches the inactive set via the 15-char form of an 18-char value', () => {
    const o = run(
      { PricebookEntryId: PBE_18 },
      { inactivePbeIds: [PBE_15], pbeSubstitutes: { [PBE_15]: SUB_18 } }
    )
    expect(o.payload).toEqual({ PricebookEntryId: SUB_18 })
  })

  it('falls back to the 15-char substitute key when the raw key misses', () => {
    const o = run(
      { PricebookEntryId: PBE_18 },
      { inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_15]: SUB_18 } }
    )
    expect(o.payload).toEqual({ PricebookEntryId: SUB_18 })
  })
})

describe('applyPbeGate — skip on no substitute', () => {
  it('skips the whole OLI (payload → null) with reason inactive_pbe_no_substitute', () => {
    const o = run({ PricebookEntryId: PBE_18 }, { inactivePbeIds: [PBE_18], pbeSubstitutes: {} })
    expect(o.skipped).toBe(true)
    expect(o.skipReason).toBe('inactive_pbe_no_substitute')
    expect(o.payload).toBeNull()
  })

  it('treats a blank substitute as no substitute → skip', () => {
    const o = run(
      { PricebookEntryId: PBE_18 },
      { inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_18]: '   ' } }
    )
    expect(o.skipped).toBe(true)
    expect(o.payload).toBeNull()
  })

  it('treats an explicit-null substitute as no substitute → skip', () => {
    const o = run(
      { PricebookEntryId: PBE_18 },
      { inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_18]: null } }
    )
    expect(o.skipped).toBe(true)
    expect(o.payload).toBeNull()
  })
})

describe('applyPbeGate — 15/18 normalization boundary', () => {
  it('does NOT normalize a 15-char payload value → a set holding only the 18-char misses', () => {
    // pbeId is 15 chars → pbe15 === pbeId (no substring). The set has only the
    // 18-char form, so neither pbeId nor pbe15 matches → left untouched.
    const o = run({ PricebookEntryId: PBE_15 }, { inactivePbeIds: [PBE_18], pbeSubstitutes: {} })
    expect(o.payload).toEqual({ PricebookEntryId: PBE_15 })
    expect(o.skipped).toBe(false)
  })

  it('matches a 15-char payload value against a 15-char set entry', () => {
    const o = run(
      { PricebookEntryId: PBE_15 },
      { inactivePbeIds: [PBE_15], pbeSubstitutes: { [PBE_15]: SUB_18 } }
    )
    expect(o.payload).toEqual({ PricebookEntryId: SUB_18 })
  })
})

describe('applyPbeGate — S49 (BUG-6): a PBE ABSENT from target is skipped, not failed', () => {
  // Live case: OLIs pointing at 01uTH000007mejtYAA ("Vega (Premium Agent)"),
  // ACTIVE on the source and absent from sb1_830, came back as
  // FIELD_INTEGRITY_EXCEPTION / NOT_FOUND on runs 2 and 3 instead of skipping.
  const MISSING_18 = 'a0Bfn0000004xyzAAM'

  it('skips with pbe_missing_on_target when the id is not on target', () => {
    const o = run({ PricebookEntryId: MISSING_18 }, { knownPbeIds: [PBE_18, PBE_15] })
    expect(o.skipped).toBe(true)
    expect(o.skipReason).toBe('pbe_missing_on_target')
    expect(o.payload).toBeNull()
  })

  it('passes an id that IS on target', () => {
    const o = run({ PricebookEntryId: PBE_18 }, { knownPbeIds: [PBE_18, PBE_15] })
    expect(o.skipped).toBe(false)
    expect(o.payload).toEqual({ PricebookEntryId: PBE_18 })
  })

  it('matches on the 15-char form too', () => {
    const o = run({ PricebookEntryId: PBE_18 }, { knownPbeIds: [PBE_15] })
    expect(o.skipped).toBe(false)
  })

  it('FAILS OPEN: an empty knownPbeIds disables the check (prefetch error)', () => {
    const o = run({ PricebookEntryId: MISSING_18 }, { knownPbeIds: [] })
    expect(o.skipped).toBe(false)
    expect(o.payload).toEqual({ PricebookEntryId: MISSING_18 })
  })

  it('inactive-with-substitute still wins over the missing check', () => {
    const o = run(
      { PricebookEntryId: PBE_18 },
      { inactivePbeIds: [PBE_18], pbeSubstitutes: { [PBE_18]: SUB_18 }, knownPbeIds: [PBE_18] }
    )
    expect(o.skipped).toBe(false)
    expect(o.payload).toEqual({ PricebookEntryId: SUB_18 })
  })
})
