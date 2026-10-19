import { describe, it, expect } from 'vitest'
import {
  ciEquals,
  apexStringValueOf,
  splitRegex,
  leftTruncate,
  isBlank,
  apexTrim
} from '../src/main/engine/deploy/transform/apexSemantics'

const NBSP = String.fromCharCode(0xa0) // U+00A0 non-breaking space

describe('apexSemantics — ciEquals (trap 1: Apex String == is case-insensitive)', () => {
  it('folds case for strategy/object/status comparisons', () => {
    expect(ciEquals('externalId', 'EXTERNALID')).toBe(true)
    expect(ciEquals('DirectId', 'directId')).toBe(true)
    expect(ciEquals('skip', 'SKIP')).toBe(true)
    expect(ciEquals('Contact', 'contact')).toBe(true)
  })

  it('is false for genuinely different strings', () => {
    expect(ciEquals('externalId', 'directId')).toBe(false)
    expect(ciEquals('skip', 'skipp')).toBe(false)
  })

  it('matches Apex null semantics: null==null true, null=="x" false', () => {
    expect(ciEquals(null, null)).toBe(true)
    expect(ciEquals(undefined, undefined)).toBe(true)
    expect(ciEquals(null, undefined)).toBe(true)
    expect(ciEquals(null, 'x')).toBe(false)
    expect(ciEquals('x', null)).toBe(false)
  })
})

describe('apexSemantics — apexStringValueOf (trap 19: String.valueOf(Object))', () => {
  it('null/undefined → null (NOT the string "null")', () => {
    expect(apexStringValueOf(null)).toBeNull()
    expect(apexStringValueOf(undefined)).toBeNull()
  })

  it('Boolean → "true"/"false"', () => {
    expect(apexStringValueOf(true)).toBe('true')
    expect(apexStringValueOf(false)).toBe('false')
  })

  it('strings pass through', () => {
    expect(apexStringValueOf('005fn000003twuUAAQ')).toBe('005fn000003twuUAAQ')
    expect(apexStringValueOf('')).toBe('')
  })

  it('numbers stringify without exponent notation', () => {
    expect(apexStringValueOf(42)).toBe('42')
    expect(apexStringValueOf(0)).toBe('0')
    expect(apexStringValueOf(-7)).toBe('-7')
    expect(apexStringValueOf(3.14)).toBe('3.14')
    expect(apexStringValueOf(1e21)).toBe('1000000000000000000000')
    expect(apexStringValueOf(1.5e-7)).toBe('0.00000015')
  })
})

describe('apexSemantics — splitRegex (trap 10: Java String.split regex + trailing-empty rules)', () => {
  it('splits on a regex and drops trailing empty strings (limit 0)', () => {
    expect(splitRegex('a;b;c', ';')).toEqual(['a', 'b', 'c'])
    expect(splitRegex('a;b;', ';')).toEqual(['a', 'b'])
    expect(splitRegex('a,,', ',')).toEqual(['a'])
  })

  it('treats a string pattern as a regex (\\. → literal dot)', () => {
    expect(splitRegex('a.b.c', '\\.')).toEqual(['a', 'b', 'c'])
  })

  it('multi-picklist tokenization on ";"', () => {
    expect(splitRegex('Red;Green;Blue', ';')).toEqual(['Red', 'Green', 'Blue'])
  })

  it('no match → the whole input as a single element (even when empty)', () => {
    expect(splitRegex('abc', ';')).toEqual(['abc'])
    expect(splitRegex('', ';')).toEqual([''])
  })

  it('all-separator input → empty array (all trailing empties removed)', () => {
    expect(splitRegex(';', ';')).toEqual([])
    expect(splitRegex(';;;', ';')).toEqual([])
  })
})

describe('apexSemantics — leftTruncate (trap 13: Apex String.left)', () => {
  it('takes the first n chars, whole string if shorter', () => {
    expect(leftTruncate('abcdef', 3)).toBe('abc')
    expect(leftTruncate('ab', 5)).toBe('ab')
    expect(leftTruncate('abc', 3)).toBe('abc')
  })

  it('n <= 0 → empty string', () => {
    expect(leftTruncate('abc', 0)).toBe('')
    expect(leftTruncate('abc', -2)).toBe('')
    expect(leftTruncate('', 5)).toBe('')
  })
})

describe('apexSemantics — re-exported whitespace helpers (single source: scoping.ts)', () => {
  it('isBlank: null/undefined/empty/ASCII-whitespace-only → true', () => {
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank('\t\n')).toBe(true)
    expect(isBlank('x')).toBe(false)
  })

  it('isBlank: NBSP is NOT whitespace in Java → not blank (Session-30 trap)', () => {
    expect(isBlank(NBSP)).toBe(false)
    expect(isBlank(NBSP + NBSP)).toBe(false)
  })

  it('apexTrim: strips chars <= U+0020 only (NBSP survives)', () => {
    expect(apexTrim('  x  ')).toBe('x')
    expect(apexTrim('\t\nx\r')).toBe('x')
    expect(apexTrim(NBSP + 'x' + NBSP)).toBe(NBSP + 'x' + NBSP)
  })
})
