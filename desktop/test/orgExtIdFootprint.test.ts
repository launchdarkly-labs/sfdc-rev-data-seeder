/**
 * S70 (UAT U-4): the per-org External-Id footprint — pure lane. The Tooling
 * probe itself is covered by targetSchemaProbe's tests; here: the SOQL guard,
 * the sort + junction annotation, and the COUNT() read.
 */
import { describe, it, expect } from 'vitest'
import {
  buildExtIdCountSoql,
  isSafeObjectName,
  orgExtIdFootprint,
  orgExtIdPopulatedCount
} from '../src/main/services/orgExtIdFootprint'
import { EXT_ID_FIELD } from '../src/main/engine/readiness'
import { isKnownJunction } from '../src/main/engine/junctionDetector'
import type { GuardedOrg } from '../src/main/services/salesforce'

function fakeOrg(tableIds: string[], totalSize = 0): GuardedOrg {
  return {
    conn: {
      tooling: { query: async () => ({ records: tableIds.map((TableEnumOrId) => ({ TableEnumOrId })) }) },
      query: async () => ({ totalSize })
    }
  } as unknown as GuardedOrg
}

describe('isSafeObjectName / buildExtIdCountSoql', () => {
  it('accepts standard, custom, namespaced and metadata-type API names', () => {
    for (const n of ['Account', 'SBQQ__Quote__c', 'ns__Thing__mdt', 'OpportunityContactRole']) {
      expect(isSafeObjectName(n), n).toBe(true)
    }
  })
  it('rejects anything that is not an API name (it reaches a SOQL string)', () => {
    for (const n of ['', '1abc', 'Account; DROP', 'A.B', "Account'", 'Account WHERE', 'a'.repeat(101)]) {
      expect(isSafeObjectName(n), JSON.stringify(n)).toBe(false)
      expect(() => buildExtIdCountSoql(n)).toThrow(/Not a Salesforce object API name/)
    }
  })
  it('builds the COUNT() over the configured field', () => {
    expect(buildExtIdCountSoql('Contact')).toBe(`SELECT COUNT() FROM Contact WHERE ${EXT_ID_FIELD} != null`)
  })
})

describe('orgExtIdFootprint', () => {
  it('returns the probe result sorted by name with the junction flag and the field name', async () => {
    const fp = await orgExtIdFootprint(fakeOrg(['Contact', 'Account', 'OpportunityContactRole']))
    expect(fp.fieldName).toBe(EXT_ID_FIELD)
    expect(fp.objects.map((o) => o.objectName)).toEqual(['Account', 'Contact', 'OpportunityContactRole'])
    for (const o of fp.objects) expect(o.isJunction).toBe(isKnownJunction(o.objectName))
    expect(fp.checkedAt).toBeGreaterThan(0)
  })
  it('an org with no field anywhere yields an empty list, not an error', async () => {
    expect((await orgExtIdFootprint(fakeOrg([]))).objects).toEqual([])
  })
})

describe('orgExtIdPopulatedCount', () => {
  it('reads totalSize from the COUNT() query', async () => {
    expect(await orgExtIdPopulatedCount(fakeOrg([], 42), 'Account')).toBe(42)
  })
  it('refuses an unsafe object name before any query', async () => {
    await expect(orgExtIdPopulatedCount(fakeOrg([], 42), 'Account; DROP')).rejects.toThrow(/API name/)
  })
})
