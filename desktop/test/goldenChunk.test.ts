import { describe, it, expect } from 'vitest'
import {
  chunkString,
  reassembleChunks,
  buildChunkTag,
  parseChunkTag,
  DEFAULT_CHUNK_CHARS,
  GOLDEN_TAG,
  type CaptureRow
} from '../src/main/engine/deploy/golden/chunk'

const UUID = 'cap-1234'

/** Build the log-rows a capture would produce for one string. */
function rowsFor(s: string, cap: number, captureId = UUID): CaptureRow[] {
  const chunks = chunkString(s, cap)
  return chunks.map((body, i) => ({
    message: buildChunkTag(captureId, i, chunks.length),
    errorDetails: body === '' ? null : body // SF stores '' as null
  }))
}

describe('chunkString', () => {
  it('returns a single empty chunk for the empty string (total >= 1 invariant)', () => {
    expect(chunkString('', 10)).toEqual([''])
  })

  it('returns one chunk when shorter than the cap', () => {
    expect(chunkString('abc', 10)).toEqual(['abc'])
  })

  it('splits exactly on a cap multiple with no empty tail', () => {
    expect(chunkString('abcdef', 3)).toEqual(['abc', 'def'])
  })

  it('splits with a short final chunk', () => {
    expect(chunkString('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
  })

  it('is lossless — join reproduces the input', () => {
    const s = 'x'.repeat(1000) + 'ünîçödé' + 'y'.repeat(1000)
    expect(chunkString(s, 137).join('')).toBe(s)
  })

  it('rejects a non-positive or non-integer cap', () => {
    expect(() => chunkString('a', 0)).toThrow()
    expect(() => chunkString('a', -5)).toThrow()
    expect(() => chunkString('a', 1.5)).toThrow()
  })

  it('defaults to a cap under the 131,072 Error_Details__c limit', () => {
    expect(DEFAULT_CHUNK_CHARS).toBeLessThan(131072)
  })
})

describe('buildChunkTag / parseChunkTag', () => {
  it('round-trips', () => {
    expect(parseChunkTag(buildChunkTag('abc', 2, 5))).toEqual({ captureId: 'abc', seq: 2, total: 5 })
  })

  it('rejects a captureId containing the delimiter', () => {
    expect(() => buildChunkTag('a|b', 0, 1)).toThrow()
  })

  it('returns null for null / foreign / malformed messages', () => {
    expect(parseChunkTag(null)).toBeNull()
    expect(parseChunkTag('some unrelated log line')).toBeNull()
    expect(parseChunkTag(`${GOLDEN_TAG}|abc|2`)).toBeNull() // too few fields
    expect(parseChunkTag(`OTHER|abc|0|1`)).toBeNull()
    expect(parseChunkTag(`${GOLDEN_TAG}|abc|x|1`)).toBeNull() // non-numeric seq
  })

  it('rejects out-of-range seq/total', () => {
    expect(parseChunkTag(`${GOLDEN_TAG}|abc|3|3`)).toBeNull() // seq == total
    expect(parseChunkTag(`${GOLDEN_TAG}|abc|-1|3`)).toBeNull()
    expect(parseChunkTag(`${GOLDEN_TAG}|abc|0|0`)).toBeNull()
  })
})

describe('reassembleChunks', () => {
  it('round-trips a single-chunk capture', () => {
    const s = '{"a":1}'
    expect(reassembleChunks(rowsFor(s, 1000), UUID)).toBe(s)
  })

  it('round-trips a multi-chunk capture regardless of row order', () => {
    const s = JSON.stringify({ big: 'z'.repeat(5000) })
    const rows = rowsFor(s, 137)
    expect(rows.length).toBeGreaterThan(1)
    // shuffle
    const shuffled = [...rows].reverse()
    expect(reassembleChunks(shuffled, UUID)).toBe(s)
  })

  it('coalesces a null errorDetails (SF empty LongTextArea) to empty string', () => {
    expect(reassembleChunks(rowsFor('', 10), UUID)).toBe('')
  })

  it('ignores rows from other captures and non-golden log rows', () => {
    const mine = rowsFor('MINE', 2)
    const noise: CaptureRow[] = [
      { message: buildChunkTag('other-cap', 0, 1), errorDetails: 'THEIRS' },
      { message: 'ordinary deployment log', errorDetails: 'stuff' },
      { message: null, errorDetails: 'orphan' }
    ]
    expect(reassembleChunks([...noise, ...mine], UUID)).toBe('MINE')
  })

  it('throws when a chunk is missing (fail-loud, no partial read)', () => {
    const rows = rowsFor('abcdefghij', 3) // 4 chunks
    const dropped = rows.filter((_, i) => i !== 2)
    expect(() => reassembleChunks(dropped, UUID)).toThrow(/missing seq: 2/)
  })

  it('throws on a duplicate chunk seq', () => {
    const rows = rowsFor('abcdef', 3) // seq 0,1
    rows.push({ message: buildChunkTag(UUID, 0, 2), errorDetails: 'dup' })
    expect(() => reassembleChunks(rows, UUID)).toThrow(/duplicate chunk seq 0/)
  })

  it('throws on a chunk-total disagreement (mixed corrupt rows)', () => {
    const rows: CaptureRow[] = [
      { message: buildChunkTag(UUID, 0, 2), errorDetails: 'a' },
      { message: buildChunkTag(UUID, 1, 3), errorDetails: 'b' }
    ]
    expect(() => reassembleChunks(rows, UUID)).toThrow(/total disagreement/)
  })

  it('throws when no chunks match the capture id', () => {
    expect(() => reassembleChunks(rowsFor('x', 10, 'other'), UUID)).toThrow(/no chunks found/)
  })
})
