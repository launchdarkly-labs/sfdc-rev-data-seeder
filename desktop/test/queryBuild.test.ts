import { describe, it, expect } from 'vitest'
import {
  buildSourceQueryV2,
  buildNormalSourceQuery,
  buildRetrySourceQuery
} from '../src/main/engine/deploy/transform/queryBuild'
import { escapeSingleQuotes } from '../src/main/engine/deploy/transform/apexSemantics'
import type { GoldenFieldInfo } from '../src/main/engine/deploy/golden/fixture'

/**
 * E4X.6 — source-query builder GF/byte-match suite (Apex buildSourceQueryV2
 * DDS L750-813 + the PBE ORDER BY / retry Id-IN call-site variants). The AC is
 * "rendered SOQL byte-matches the Apex output", so these assert exact strings.
 */

const f = (apiName: string, o: Partial<GoldenFieldInfo> = {}): GoldenFieldInfo => ({
  apiName,
  dataType: 'string',
  isCreateable: true,
  isNillable: true,
  isReference: false,
  referenceTo: [],
  relationshipName: null,
  isAutoNumber: false,
  isCalculated: false,
  isExternalId: false,
  isRestrictedPicklist: false,
  ...o
})

describe('escapeSingleQuotes', () => {
  it('prepends a backslash to every single quote (and nothing else)', () => {
    expect(escapeSingleQuotes("O'Brien")).toBe("O\\'Brien")
    expect(escapeSingleQuotes("a'b'c")).toBe("a\\'b\\'c")
    expect(escapeSingleQuotes('no quotes')).toBe('no quotes')
    expect(escapeSingleQuotes('back\\slash')).toBe('back\\slash') // backslashes untouched
  })
})

describe('buildSourceQueryV2 — SELECT + guards', () => {
  it('selects Id first, then createable fields in order', () => {
    expect(buildSourceQueryV2('Account', [f('Name'), f('Industry')], null)).toBe(
      'SELECT Id, Name, Industry FROM Account'
    )
  })

  it('drops non-createable / autoNumber / calculated / Id fields from the SELECT', () => {
    const fields = [
      f('Name'),
      f('NonCreate', { isCreateable: false }),
      f('AutoNum', { isAutoNumber: true }),
      f('Formula', { isCalculated: true }),
      f('Id')
    ]
    expect(buildSourceQueryV2('Account', fields, null)).toBe('SELECT Id, Name FROM Account')
  })

  it('escapes the object name (SOQL-injection guard)', () => {
    expect(buildSourceQueryV2("O'Brien__c", [], null)).toBe("SELECT Id FROM O\\'Brien__c")
  })
})

describe('buildSourceQueryV2 — Person-Account filter + WHERE injection', () => {
  it('appends the PA filter as its own WHERE when there is no user filter', () => {
    expect(buildSourceQueryV2('Contact', [f('LastName')], null, true)).toBe(
      'SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false'
    )
  })

  it('does NOT filter when the override is false', () => {
    expect(buildSourceQueryV2('Contact', [f('LastName')], null, false)).toBe(
      'SELECT Id, LastName FROM Contact'
    )
  })

  it('autodetects PA from the fields when the override is null', () => {
    const fields = [f('LastName'), f('IsPersonAccount', { isCreateable: false })]
    expect(buildSourceQueryV2('Contact', fields, null, null)).toBe(
      'SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false'
    )
  })

  it('injects the PA filter INTO an existing WHERE clause (AC: Contact-with-existing-WHERE)', () => {
    expect(buildSourceQueryV2('Contact', [f('LastName')], 'WHERE Email != null', true)).toBe(
      'SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false AND Email != null'
    )
  })

  it('prepends WHERE + PA to a bare condition filter (else branch)', () => {
    expect(buildSourceQueryV2('Contact', [f('LastName')], 'CreatedDate = TODAY', true)).toBe(
      'SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false AND CreatedDate = TODAY'
    )
  })

  it('appends a LIMIT/ORDER clause as-is, PA trailing (parity-faithful even if odd SOQL)', () => {
    // Apex appends LIMIT verbatim then tacks the un-consumed PA filter on as a
    // trailing WHERE — reproduced byte-for-byte (DDS L788-810).
    expect(buildSourceQueryV2('Contact', [f('LastName')], 'LIMIT 10', true)).toBe(
      'SELECT Id, LastName FROM Contact LIMIT 10 WHERE IsPersonAccount = false'
    )
  })

  it('trims the filter clause (Java-exact) before matching its prefix', () => {
    expect(buildSourceQueryV2('Account', [f('Name')], '   WHERE Amount > 0  ')).toBe(
      'SELECT Id, Name FROM Account WHERE Amount > 0'
    )
  })

  it('does not add a PA filter on a non-Contact object', () => {
    expect(buildSourceQueryV2('Account', [f('Name')], null, true)).toBe('SELECT Id, Name FROM Account')
  })
})

describe('buildNormalSourceQuery — PricebookEntry ORDER BY', () => {
  it('appends standard-first ORDER BY only for PricebookEntry', () => {
    expect(buildNormalSourceQuery('PricebookEntry', [f('UnitPrice', { dataType: 'currency' })], null)).toBe(
      'SELECT Id, UnitPrice FROM PricebookEntry ORDER BY Pricebook2.IsStandard DESC'
    )
    expect(buildNormalSourceQuery('Account', [f('Name')], null)).toBe('SELECT Id, Name FROM Account')
  })
})

describe('buildRetrySourceQuery — Id IN append', () => {
  it('adds a fresh WHERE Id IN when the base query has none', () => {
    expect(buildRetrySourceQuery('Account', [f('Name')], ['001A', '001B'])).toBe(
      "SELECT Id, Name FROM Account WHERE Id IN ('001A','001B')"
    )
  })

  it('ANDs the Id IN onto a base query that already has a (PA) WHERE', () => {
    expect(buildRetrySourceQuery('Contact', [f('LastName')], ['003A'], true)).toBe(
      "SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false AND Id IN ('003A')"
    )
  })

  it('escapes single quotes in the retry Ids', () => {
    expect(buildRetrySourceQuery('Account', [f('Name')], ["a'b"])).toBe(
      "SELECT Id, Name FROM Account WHERE Id IN ('a\\'b')"
    )
  })

  it('does NOT append the PBE ORDER BY on the retry path (retry uses the base query)', () => {
    // Apex appends ORDER BY only on the normal branch (DDQ L1740); the retry
    // branch (L1721-1730) never does.
    expect(buildRetrySourceQuery('PricebookEntry', [f('UnitPrice', { dataType: 'currency' })], ['a'])).toBe(
      "SELECT Id, UnitPrice FROM PricebookEntry WHERE Id IN ('a')"
    )
  })
})

describe('buildSourceQueryV2 — ORDER-prefixed filter (parity with LIMIT)', () => {
  it('appends an ORDER-prefixed filter as-is, PA trailing (same branch as LIMIT)', () => {
    expect(buildSourceQueryV2('Contact', [f('LastName')], 'ORDER BY CreatedDate', true)).toBe(
      'SELECT Id, LastName FROM Contact ORDER BY CreatedDate WHERE IsPersonAccount = false'
    )
  })
})
