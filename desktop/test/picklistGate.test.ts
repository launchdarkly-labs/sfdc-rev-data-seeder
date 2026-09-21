import { describe, it, expect } from 'vitest'
import { applyPicklistGate } from '../src/main/engine/deploy/transform/picklistGate'

/**
 * E4X.4 — restricted-picklist gate unit suite (stage 2, DDS L1138-1174). Covers
 * single vs multi-select, Java-regex split of trailing empties (trap 10),
 * Java-exact token trim, case-sensitive membership, sample aggregation + dedupe.
 */

function gate(
  payload: Record<string, unknown>,
  allowed: Record<string, string[]>
): { payload: Record<string, unknown>; dropped: Record<string, string[]> } {
  const dropped: Record<string, string[]> = {}
  applyPicklistGate(payload, { targetPicklistAllowedValues: allowed }, dropped)
  return { payload, dropped }
}

describe('applyPicklistGate — single-select', () => {
  it('keeps an allowed value', () => {
    const { payload, dropped } = gate({ Stage: 'Won' }, { Stage: ['Won', 'Lost'] })
    expect(payload.Stage).toBe('Won')
    expect(dropped).toEqual({})
  })

  it('drops a disallowed value and records the sample', () => {
    const { payload, dropped } = gate({ Stage: 'Bogus' }, { Stage: ['Won', 'Lost'] })
    expect(payload).not.toHaveProperty('Stage')
    expect(dropped).toEqual({ Stage: ['Bogus'] })
  })

  it('membership is case-SENSITIVE (Apex Set.contains)', () => {
    const { payload, dropped } = gate({ Stage: 'won' }, { Stage: ['Won'] })
    expect(payload).not.toHaveProperty('Stage')
    expect(dropped.Stage).toEqual(['won'])
  })
})

describe('applyPicklistGate — multi-select', () => {
  it('keeps a value when every token is allowed', () => {
    const { payload } = gate({ Tags: 'A;B' }, { Tags: ['A', 'B', 'C'] })
    expect(payload.Tags).toBe('A;B')
  })

  // S49 divergence from the Apex port: only the offending TOKENS go, not the
  // whole field. The Apex behaviour threw away 'A' to protect against 'Z';
  // standing rule 9 made the frozen Apex advisory, and stage 2b had to make the
  // same call for record-type-scoped values.
  it('drops only the disallowed TOKENS and keeps the rest (S49)', () => {
    const { payload, dropped } = gate({ Tags: 'A;Z' }, { Tags: ['A', 'B'] })
    expect(payload.Tags).toBe('A')
    expect(dropped.Tags).toEqual(['Z'])
  })

  it('deletes the field only when EVERY token is disallowed', () => {
    const { payload, dropped } = gate({ Tags: 'Y;Z' }, { Tags: ['A', 'B'] })
    expect(payload).not.toHaveProperty('Tags')
    expect(dropped.Tags).toEqual(['Y', 'Z'])
  })

  it('Java-trims each token before the membership check', () => {
    const { payload } = gate({ Tags: ' A ; B ' }, { Tags: ['A', 'B'] })
    expect(payload.Tags).toBe(' A ; B ')
  })

  it('drops the trailing empty token (Java regex split, trap 10) — "A;" stays', () => {
    // Raw JS "A;".split(";") = ["A",""] → "" would fail membership and drop the
    // field; splitRegex drops the trailing empty so only "A" is checked.
    const { payload, dropped } = gate({ Tags: 'A;' }, { Tags: ['A'] })
    expect(payload.Tags).toBe('A;')
    expect(dropped).toEqual({})
  })

  it('drops the INTERIOR empty token and keeps the real ones — "A;;B" → "A;B"', () => {
    // 'A;;B' → splitRegex → ['A','','B'] (Java split drops only TRAILING
    // empties, trap 10). The interior '' is not an allowed value, so under the
    // S49 per-token rule it alone is dropped; the platform would have rejected
    // it anyway, and A;B is what the user meant.
    const { payload, dropped } = gate({ Tags: 'A;;B' }, { Tags: ['A', 'B'] })
    expect(payload.Tags).toBe('A;B')
    expect(dropped.Tags).toEqual([''])
  })
})

describe('applyPicklistGate — guards + aggregation', () => {
  it('ignores non-picklist keys (no allowed entry)', () => {
    const { payload } = gate({ Name: 'Acme', Amount: 100 }, { Stage: ['Won'] })
    expect(payload).toEqual({ Name: 'Acme', Amount: 100 })
  })

  it('ignores a null payload value', () => {
    const { payload } = gate({ Stage: null }, { Stage: ['Won'] })
    expect(payload).toHaveProperty('Stage', null)
  })

  it('is a no-op when there is no target picklist map', () => {
    const payload = { Stage: 'anything' }
    const dropped: Record<string, string[]> = {}
    applyPicklistGate(payload, { targetPicklistAllowedValues: {} }, dropped)
    expect(payload).toEqual({ Stage: 'anything' })
    expect(dropped).toEqual({})
  })

  it('dedupes the same dropped sample across calls sharing an accumulator', () => {
    const dropped: Record<string, string[]> = {}
    applyPicklistGate({ Stage: 'Bogus' }, { targetPicklistAllowedValues: { Stage: ['Won'] } }, dropped)
    applyPicklistGate({ Stage: 'Bogus' }, { targetPicklistAllowedValues: { Stage: ['Won'] } }, dropped)
    expect(dropped.Stage).toEqual(['Bogus'])
  })
})
