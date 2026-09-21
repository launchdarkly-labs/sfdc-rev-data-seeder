import { describe, it, expect } from 'vitest'
import {
  to18,
  to15,
  reverse,
  generateExternalId,
  decodeExternalId,
  EXTERNAL_ID_FIELD,
  EXTERNAL_ID_LENGTH
} from '../src/main/engine/deploy/transform/sfid'

/**
 * Real 18-char Ids captured read-only from ldseed (jack@data-deploy.ld) on
 * 2026-07-25 — the "captured Id.valueOf fixture table" the E4X.1 AC requires.
 * The 15-char form is `id.substring(0,15)`; the full 18 is the oracle for the
 * checksum expansion. Case spread covers uppercase in chunk 0 (00D…, EOv…) and
 * chunk 2 (…twuU, …s4Yr, …hwTd) as well as all-lowercase chunks.
 */
const LDSEED_IDS_18 = [
  '005fn000003twuUAAQ',
  '005fn000003tx2XAAQ',
  '005fn000003tx2YAAQ',
  '005fn000003tx2aAAA',
  '00efn000002s4YrAAI',
  '00efn000002s4Z2AAI',
  '00efn000002s4Z0AAI',
  '00Dfn00000EOvEpEAL',
  'a1afn000003hwTdAAI',
  'a1afn000003hxKrAAI'
]

describe('sfid — constants', () => {
  it('pins the seeder ExtId field + length (ExternalIdService.FIELD_NAME/LENGTH)', () => {
    expect(EXTERNAL_ID_FIELD).toBe('Data_Deployment_External_Id__c')
    expect(EXTERNAL_ID_LENGTH).toBe(18)
  })
})

describe('sfid — to18 (15→18 checksum, Id.valueOf parity)', () => {
  it('expands every captured ldseed Id from its 15-char truncation', () => {
    for (const id18 of LDSEED_IDS_18) {
      expect(to18(id18.substring(0, 15))).toBe(id18)
    }
  })

  it('sets the suffix bit only for uppercase A-Z (LSB = first char of chunk)', () => {
    // chunk0 all-lower/digit → A; chunk1 all-zero → A; chunk2 has one uppercase
    // at index 4 ("…twuU") → bit4 = value 16 → alphabet[16] = 'Q'.
    expect(to18('005fn000003twuU')).toBe('005fn000003twuUAAQ')
    // "00Dfn" → D at index2 → bit2 = 4 → 'E'; chunk2 "EOvEp" → E,O,E at 0,1,3
    // → 1+2+8 = 11 → 'L'.
    expect(to18('00Dfn00000EOvEp')).toBe('00Dfn00000EOvEpEAL')
  })

  it('maps a fully-uppercase chunk to the max suffix char (value 31 → "5")', () => {
    // 15 uppercase letters → every chunk value 31 → alphabet[31] = '5'.
    expect(to18('ABCDEFGHIJKLMNO')).toBe('ABCDEFGHIJKLMNO555')
  })

  it('throws on a non-15-length input', () => {
    expect(() => to18('005fn000003twuUAAQ')).toThrow(/15-char/)
    expect(() => to18('short')).toThrow(/15-char/)
  })

  it('throws on an invalid Id character', () => {
    expect(() => to18('005fn000003twu-')).toThrow(/invalid/i)
  })
})

describe('sfid — to15', () => {
  it('truncates 18→15 and leaves 15 (or shorter) untouched', () => {
    expect(to15('005fn000003twuUAAQ')).toBe('005fn000003twuU')
    expect(to15('005fn000003twuU')).toBe('005fn000003twuU')
    expect(to15('short')).toBe('short')
  })

  it('round-trips with to18: to15(to18(id15)) === id15', () => {
    for (const id18 of LDSEED_IDS_18) {
      const id15 = id18.substring(0, 15)
      expect(to15(to18(id15))).toBe(id15)
    }
  })
})

describe('sfid — reverse (round-trip law)', () => {
  it('reverse(reverse(x)) === x', () => {
    for (const id18 of LDSEED_IDS_18) {
      expect(reverse(reverse(id18))).toBe(id18)
    }
    expect(reverse(reverse(''))).toBe('')
    expect(reverse('abc')).toBe('cba')
  })
})

describe('sfid — generateExternalId + decodeExternalId', () => {
  it('an 18-char Id is reversed verbatim and decodes back exactly', () => {
    for (const id18 of LDSEED_IDS_18) {
      const ext = generateExternalId(id18)
      expect(ext).toBe(reverse(id18))
      expect(decodeExternalId(ext)).toBe(id18)
    }
  })

  it('a 15-char Id is upcast to 18 THEN reversed (decodes to the 18-char form)', () => {
    const id15 = '005fn000003twuU'
    const ext = generateExternalId(id15)
    expect(ext).toBe(reverse('005fn000003twuUAAQ'))
    // Decodes to the 18-char form; to15 recovers the original 15.
    expect(decodeExternalId(ext)).toBe('005fn000003twuUAAQ')
    expect(to15(decodeExternalId(ext))).toBe(id15)
  })

  it('is idempotent as an upsert key: same source Id → same ExtId', () => {
    expect(generateExternalId('005fn000003twuUAAQ')).toBe(
      generateExternalId('005fn000003twuUAAQ')
    )
  })

  it('null/undefined source Id → injected random fallback (18 chars)', () => {
    const rng = () => 'deadbeefdeadbeef00'
    expect(generateExternalId(null, rng)).toBe('deadbeefdeadbeef00')
    expect(generateExternalId(undefined, rng)).toBe('deadbeefdeadbeef00')
  })

  it('the default random fallback yields 18 lowercase hex chars', () => {
    const ext = generateExternalId(null)
    expect(ext).toMatch(/^[0-9a-f]{18}$/)
  })
})
