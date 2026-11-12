/**
 * S75 — the SEQUENCE the 2026-11-10 seeds got wrong, end to end through the
 * first pass: a Subscription / Quote Line whose `SBQQ__ProductOption__c` and
 * `SBQQ__Dimension__c` are on Name Match must land with the TARGET config Ids
 * found by natural key, an unresolvable value must be left empty AND logged
 * with its reason (the transform drops it without a trace), and the config
 * objects must be read once per run, not once per object.
 */
import { describe, it, expect } from 'vitest'
import { runFirstPass } from '../src/main/engine/deploy/firstPass'
import { fld, frozenObject, harness, passCtx, planOf } from './helpers/deployFakes'

const PO = 'SBQQ__ProductOption__c'
const DIM = 'SBQQ__Dimension__c'
const ref = (apiName: string, to: string) =>
  fld(apiName, { dataType: 'reference', isReference: true, referenceTo: [to], relationshipName: apiName.replace(/__c$/, '__r') })

const describeFields = [fld('Name'), ref(PO, PO), ref(DIM, DIM)]
const mappings = {
  [PO]: { strategy: 'nameMatch', matchField: 'Name', customValue: null },
  [DIM]: { strategy: 'nameMatch', matchField: 'Name', customValue: null }
}

// Config rows. Product Ids are shared between the orgs; option / dimension Ids are not,
// and the auto-number option names point the WRONG way round on the target.
const sourceConfig: Record<string, Array<Record<string, unknown>>> = {
  [PO]: [
    { Id: 'sPO_SEATS', Name: 'PO-0001', SBQQ__ConfiguredSKU__c: 'P_BUNDLE', SBQQ__OptionalSKU__c: 'P_SEATS', SBQQ__Number__c: 10 },
    { Id: 'sPO_MAU', Name: 'PO-0002', SBQQ__ConfiguredSKU__c: 'P_BUNDLE', SBQQ__OptionalSKU__c: 'P_MAU', SBQQ__Number__c: 20 },
    { Id: 'sPO_OLD', Name: 'PO-0003', SBQQ__ConfiguredSKU__c: 'P_BUNDLE', SBQQ__OptionalSKU__c: 'P_RETIRED', SBQQ__Number__c: 30 }
  ],
  [DIM]: [{ Id: 'sDIM_Y1', Name: 'Year 1', SBQQ__Product__c: 'P_SEATS' }]
}
const targetConfig: Record<string, Array<Record<string, unknown>>> = {
  [PO]: [
    { Id: 'tPO_MAU', Name: 'PO-0001', SBQQ__ConfiguredSKU__c: 'P_BUNDLE', SBQQ__OptionalSKU__c: 'P_MAU', SBQQ__Number__c: 20 },
    { Id: 'tPO_SEATS', Name: 'PO-0002', SBQQ__ConfiguredSKU__c: 'P_BUNDLE', SBQQ__OptionalSKU__c: 'P_SEATS', SBQQ__Number__c: 10 },
    { Id: 'tPO_OTHER', Name: 'PO-0003', SBQQ__ConfiguredSKU__c: 'P_OTHER', SBQQ__OptionalSKU__c: 'P_RETIRED', SBQQ__Number__c: 5 }
  ],
  [DIM]: [
    { Id: 'tDIM_OTHER', Name: 'Year 1', SBQQ__Product__c: 'P_MAU' },
    { Id: 'tDIM_Y1', Name: 'Year 1', SBQQ__Product__c: 'P_SEATS' }
  ]
}
const configRows = (rows: Record<string, Array<Record<string, unknown>>>) => (soql: string) => {
  const m = / FROM (\w+)$/.exec(soql)
  return m ? rows[m[1]!] : undefined
}

const S1 = 'a0S000000000001AAA'
const S2 = 'a0S000000000002AAA'
const S3 = 'a0S000000000003AAA'

function seed(objectName: string) {
  const h = harness({
    sourceDescribe: describeFields,
    onQuerySource: configRows(sourceConfig),
    onQueryTarget: configRows(targetConfig),
    pages: [
      {
        records: [
          { Id: S1, Name: 'seats', [PO]: 'sPO_SEATS', [DIM]: 'sDIM_Y1' },
          { Id: S2, Name: 'mau', [PO]: 'sPO_MAU', [DIM]: null },
          { Id: S3, Name: 'retired option', [PO]: 'sPO_OLD', [DIM]: null }
        ],
        totalSize: 3
      }
    ]
  })
  const plan = planOf(frozenObject(objectName, ['Name', PO, DIM], { mappings }))
  return { h, plan }
}

describe.each(['SBQQ__Subscription__c', 'SBQQ__QuoteLine__c'])('first pass on %s — config lookups by natural key', (objectName) => {
  it('writes the target option / dimension Ids, not the name-matched ones', async () => {
    const { h, plan } = seed(objectName)
    await runFirstPass(plan, passCtx(h.io, objectName))

    const sent = h.upsertCalls[0]!.records
    expect(sent).toHaveLength(3)
    expect(sent[0]![PO]).toBe('tPO_SEATS') // a Name match would have sent tPO_MAU ("PO-0001")
    expect(sent[0]![DIM]).toBe('tDIM_Y1') // a Name match would have taken the last "Year 1"
    expect(sent[1]![PO]).toBe('tPO_MAU')
    expect(DIM in sent[1]!).toBe(false) // null on the source stays absent
  })

  it('leaves an unresolvable option empty and says why', async () => {
    const { h, plan } = seed(objectName)
    await runFirstPass(plan, passCtx(h.io, objectName))

    expect(PO in h.upsertCalls[0]!.records[2]!).toBe(false)
    const warn = h.logs.find((l) => l.level === 'Warning' && l.message.includes(`${objectName}.${PO}`))
    expect(warn?.message).toBe(
      `${objectName}.${PO}: 1 record(s) had a ${PO} that did not resolve by natural key on the target — field left empty`
    )
    expect(warn?.detail).toContain(`${S3}: no ${PO} on the target with the key of source PO-0003`)
    // The dimension resolved everywhere it was set — no line for it.
    expect(h.logs.some((l) => l.message.startsWith(`${objectName}.${DIM}:`))).toBe(false)
  })

  it('logs each config resolution once and reads each config object once per run', async () => {
    const { h, plan } = seed(objectName)
    await runFirstPass(plan, passCtx(h.io, objectName))
    await runFirstPass(plan, passCtx(h.io, objectName)) // a second object context on the same run

    const resolved = h.logs.filter((l) => l.message.startsWith('Natural key '))
    expect(resolved.map((l) => l.message).sort()).toEqual([
      `Natural key ${DIM}: 1 of 1 source row(s) matched on the target (2 row(s) there)`,
      `Natural key ${PO}: 2 of 3 source row(s) matched on the target (3 row(s) there)`
    ])
    expect(h.targetSoqls.filter((q) => q.endsWith(` FROM ${PO}`))).toHaveLength(1)
    expect(h.targetSoqls.filter((q) => q.endsWith(` FROM ${DIM}`))).toHaveLength(1)
  })
})
