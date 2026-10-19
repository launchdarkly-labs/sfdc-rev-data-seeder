/**
 * E4E.3 — root/cascade classification vs the Apex classifyFailures oracle
 * (DDQ L2202-2312). The fixture table pins both patterns, the dual-form id
 * matching, the byte-anchored line parsing (markers, split/trim/comma-strip),
 * the containsKey gate, and the bucket-count semantics (blank lines skipped).
 */
import { describe, expect, it } from 'vitest'
import {
  buildFailedByObject,
  classifyFailureLine,
  classifyFailures
} from '../src/main/engine/deploy/classify'
import { generateExternalId, reverse } from '../src/main/engine/deploy/transform/sfid'

const PARENT_18 = '001000000000042AAA' // failed Account source id
const CHILD_18 = '003000000000007AAA'
const childExt = generateExternalId(CHILD_18)
const parentExt = generateExternalId(PARENT_18)

/** The real composite error shape the transport renders (E4T.1 renderErrMsg). */
function fkLine(extId: string, parentExtId: string, entity: string): string {
  return (
    `${extId} → INVALID_FIELD: Foreign key external ID: ${parentExtId} not found ` +
    `for field Data_Deployment_External_Id__c in entity ${entity}; `
  )
}

function ctx(failed: Array<[string, string]> = [['Account', PARENT_18]]): Map<string, Set<string>> {
  return buildFailedByObject(
    ['Account', 'Contact', 'Opportunity'],
    failed.map(([objectApiName, sourceId]) => ({ objectApiName, sourceId }))
  )
}

describe('classifyFailureLine — pattern (a): FK to an in-deployment failed parent', () => {
  it('cascade: parent source id in the entity object failed set', () => {
    expect(classifyFailureLine(fkLine(childExt, parentExt, 'Account'), 'Contact', false, ctx())).toBe(
      'cascade'
    )
  })

  it('root: parent not in the failed set', () => {
    const otherParent = generateExternalId('001000000000099AAA')
    expect(
      classifyFailureLine(fkLine(childExt, otherParent, 'Account'), 'Contact', false, ctx())
    ).toBe('root')
  })

  it('root: entity is NOT a deployment object (containsKey gate)', () => {
    expect(
      classifyFailureLine(fkLine(childExt, parentExt, 'Custom_Thing__c'), 'Contact', false, ctx())
    ).toBe('root')
  })

  it('root: entity key is case-SENSITIVE (Apex Map)', () => {
    expect(classifyFailureLine(fkLine(childExt, parentExt, 'account'), 'Contact', false, ctx())).toBe(
      'root'
    )
  })

  it("root: 'in entity' appearing BEFORE the FK marker (entIdx > fkIdx required)", () => {
    const line = `in entity Account; Foreign key external ID: ${parentExt} not found`
    expect(classifyFailureLine(line, 'Contact', false, ctx())).toBe('root')
  })

  it('cascade: trailing comma after the ext id is stripped (Apex replace)', () => {
    const line =
      `${childExt} → INVALID_FIELD: Foreign key external ID: ${parentExt}, not found ` +
      `for field Data_Deployment_External_Id__c in entity Account; `
    expect(classifyFailureLine(line, 'Contact', false, ctx())).toBe('cascade')
  })

  it('cascade: 15-char reversed id matches the 18-char failed set (dual form)', () => {
    // The failed set was seeded with the 18-char id; the error line carries an
    // extId whose reverse is the 15-char form — builder stored both.
    const parent15 = PARENT_18.substring(0, 15)
    const ext15 = reverse(parent15)
    expect(classifyFailureLine(fkLine(childExt, ext15, 'Account'), 'Contact', false, ctx())).toBe(
      'cascade'
    )
  })

  it('root: entity object is in the deployment but its failed set is EMPTY', () => {
    expect(
      classifyFailureLine(fkLine(childExt, parentExt, 'Opportunity'), 'Contact', false, ctx())
    ).toBe('root')
  })
})

describe('classifyFailureLine — pattern (b): second-pass NOT_FOUND on own failed record', () => {
  const ownFailed = ctx([['Contact', CHILD_18]])
  const notFoundLine = `${childExt} → NOT_FOUND: The requested resource does not exist; `

  it('cascade: second-pass context + own source id already failed', () => {
    expect(classifyFailureLine(notFoundLine, 'Contact', true, ownFailed)).toBe('cascade')
  })

  it('root: NOT second-pass context', () => {
    expect(classifyFailureLine(notFoundLine, 'Contact', false, ownFailed)).toBe('root')
  })

  it('root: second pass but the record was never in the failed set', () => {
    expect(classifyFailureLine(notFoundLine, 'Contact', true, ctx([['Contact', '003000000000009AAA']]))).toBe(
      'root'
    )
  })

  it('root: NOT_FOUND without the arrow separator', () => {
    expect(classifyFailureLine('NOT_FOUND: gone', 'Contact', true, ownFailed)).toBe('root')
  })
})

describe('classifyFailures — bucket counting (the Apex return shape)', () => {
  it('sums buckets across lines; blank lines land in NEITHER bucket', () => {
    const lines = [
      fkLine(childExt, parentExt, 'Account'), // cascade
      `${childExt} → REQUIRED_FIELD_MISSING: missing [LastName]; `, // root
      '', // skipped (Apex continue)
      '   ', // blank → skipped
      fkLine(childExt, generateExternalId('001000000000098AAA'), 'Account') // root
    ]
    expect(classifyFailures(lines, 'Contact', false, ctx())).toEqual({ root: 2, cascade: 1 })
  })

  it('empty/null input → zero buckets (early return)', () => {
    expect(classifyFailures(null, 'Contact', false, ctx())).toEqual({ root: 0, cascade: 0 })
    expect(classifyFailures([], 'Contact', false, ctx())).toEqual({ root: 0, cascade: 0 })
  })
})

describe('buildFailedByObject', () => {
  it('keys EVERY deployment object (empty sets gate containsKey) + dual 15/18 forms', () => {
    const map = ctx()
    expect([...map.keys()].sort()).toEqual(['Account', 'Contact', 'Opportunity'])
    expect(map.get('Account')!.has(PARENT_18)).toBe(true)
    expect(map.get('Account')!.has(PARENT_18.substring(0, 15))).toBe(true)
    expect(map.get('Contact')!.size).toBe(0)
  })

  it('skips blank ids; keys unknown objects from failure rows', () => {
    const map = buildFailedByObject(
      ['Account'],
      [
        { objectApiName: 'Account', sourceId: '  ' },
        { objectApiName: 'Stray__c', sourceId: PARENT_18 }
      ]
    )
    expect(map.get('Account')!.size).toBe(0)
    expect(map.get('Stray__c')!.has(PARENT_18)).toBe(true)
  })
})
