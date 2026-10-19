/**
 * Readiness (5B.4) — pure lane. The rules engine + the ExtId-field service
 * (metadata builder is pure; create/poll driven by injected fakes — no live org,
 * no sqlite). Per the standing rule, we assert the injected fake's behavior.
 */
import { describe, it, expect } from 'vitest'
import { assessObject, assessReadiness, rollup, EXT_ID_FIELD } from '../src/main/engine/readiness'
import { buildExtIdFieldMetadata, createExtIdField } from '../src/main/services/extIdField'
import type { FieldInfo } from '../src/shared/types'
import type { GuardedOrg } from '../src/main/services/salesforce'
import type { Store } from '../src/main/services/store'

const extIdField = (over: Partial<FieldInfo> = {}): FieldInfo => ({
  apiName: EXT_ID_FIELD,
  label: 'Data Deployment External Id',
  type: 'string',
  isReference: false,
  referenceTo: [],
  isCreateable: true,
  isUpdateable: true,
  isNillable: true,
  isExternalId: true,
  isAutoNumber: false,
  isCalculated: false,
  isRestrictedPicklist: false,
  picklistValues: [],
  length: 255,
  ...over
})

describe('assessObject / assessReadiness', () => {
  it('a non-junction WITH a flagged ExtId field is ready', () => {
    const r = assessObject({ objectName: 'Account', fields: [extIdField()], isJunction: false })
    expect(r).toMatchObject({ hasExtIdField: true, extIdIsExternalId: true, needsExtIdField: false })
  })

  it('a non-junction MISSING the field needs it', () => {
    const r = assessObject({ objectName: 'Account', fields: [], isJunction: false })
    expect(r).toMatchObject({ hasExtIdField: false, needsExtIdField: true })
  })

  it('a field present but NOT flagged externalId still needs a fix', () => {
    const r = assessObject({
      objectName: 'Account',
      fields: [extIdField({ isExternalId: false })],
      isJunction: false
    })
    expect(r).toMatchObject({ hasExtIdField: true, extIdIsExternalId: false, needsExtIdField: true })
  })

  it('a junction is exempt even with no ExtId field', () => {
    const r = assessObject({ objectName: 'OpportunityContactRole', fields: [], isJunction: true })
    expect(r.needsExtIdField).toBe(false)
  })

  it('rolls up counts + readiness across a mixed scope', () => {
    const report = assessReadiness([
      { objectName: 'Account', fields: [extIdField()], isJunction: false },
      { objectName: 'Contact', fields: [], isJunction: false },
      { objectName: 'OpportunityContactRole', fields: [], isJunction: true }
    ])
    expect(report).toMatchObject({
      objectCount: 3,
      junctionCount: 1,
      missingExtIdCount: 1,
      ready: false
    })
  })

  it('rollup includes describe-error entries without counting them as missing', () => {
    const report = rollup([
      { objectName: 'Account', isJunction: false, hasExtIdField: true, extIdIsExternalId: true, needsExtIdField: false },
      { objectName: 'SBQQ__Quote__c', isJunction: false, hasExtIdField: false, extIdIsExternalId: false, needsExtIdField: false, describeError: 'INVALID_TYPE' }
    ])
    expect(report.objectCount).toBe(2)
    expect(report.missingExtIdCount).toBe(0) // the un-describable one is not "missing"
    expect(report.ready).toBe(true)
    expect(report.objects[1]!.describeError).toBe('INVALID_TYPE')
  })
})

describe('buildExtIdFieldMetadata', () => {
  it('is a 255-char External Id text field named for the object', () => {
    expect(buildExtIdFieldMetadata('Account')).toEqual({
      fullName: `Account.${EXT_ID_FIELD}`,
      label: 'Data Deployment External Id',
      type: 'Text',
      length: 255,
      externalId: true,
      unique: false,
      required: false
    })
  })
})

// ── createExtIdField (injected fakes) ────────────────────────────────────

const noopStore = {
  getCachedDescribe: () => null,
  putCachedDescribe: () => {}
} as unknown as Store

/** Fake org whose describe returns a scripted sequence of field lists. */
function fakeOrg(opts: {
  createResult?: { success: boolean; errors?: unknown }
  describeSequence: FieldInfo[][]
  writable?: boolean
}): { org: GuardedOrg; createCalls: unknown[]; describeCount: () => number } {
  let d = 0
  const createCalls: unknown[] = []
  const org = {
    alias: 'tgt',
    role: 'target',
    orgId: '00Dtgt',
    assertWritable: (op: string) => {
      if (opts.writable === false) throw new Error(`read-only: ${op}`)
    },
    conn: {
      metadata: {
        create: async (_type: string, md: unknown) => {
          createCalls.push(md)
          return opts.createResult ?? { success: true }
        }
      },
      // describeObject(force:true) calls conn.describe and maps to FieldInfo;
      // our FieldInfo already matches the mapped shape closely enough for the
      // fields the assessor reads (apiName/isExternalId), so echo them as raw.
      describe: async () => {
        const fields = opts.describeSequence[Math.min(d, opts.describeSequence.length - 1)]!
        d++
        return { fields: fields.map((f) => ({ name: f.apiName, externalId: f.isExternalId })) }
      }
    }
  } as unknown as GuardedOrg
  return { org, createCalls, describeCount: () => d }
}

const fastSleep = (): Promise<void> => Promise.resolve()

describe('createExtIdField', () => {
  it('creates the field and returns ready when it appears on the first describe', async () => {
    const { org, createCalls } = fakeOrg({ describeSequence: [[extIdField()]] })
    const r = await createExtIdField(org, noopStore, 'Account', { sleep: fastSleep })
    expect(r.needsExtIdField).toBe(false)
    expect(createCalls).toHaveLength(1)
  })

  it('polls until the field surfaces (missing, then present)', async () => {
    const { org, describeCount } = fakeOrg({
      describeSequence: [[], [extIdField()]] // 1st describe empty, 2nd has it
    })
    const r = await createExtIdField(org, noopStore, 'Account', { sleep: fastSleep, maxAttempts: 3 })
    expect(r.needsExtIdField).toBe(false)
    expect(describeCount()).toBe(2)
  })

  it('throws when metadata create fails (and never describes/polls)', async () => {
    const { org, describeCount } = fakeOrg({
      createResult: { success: false, errors: [{ message: 'DUPLICATE' }] },
      describeSequence: [[extIdField()]]
    })
    await expect(createExtIdField(org, noopStore, 'Account', { sleep: fastSleep })).rejects.toThrow(
      /Could not create/
    )
    expect(describeCount()).toBe(0)
  })

  it('throws if the field never becomes visible within maxAttempts', async () => {
    const { org } = fakeOrg({ describeSequence: [[]] }) // always empty
    await expect(
      createExtIdField(org, noopStore, 'Account', { sleep: fastSleep, maxAttempts: 2 })
    ).rejects.toThrow(/did not become visible/)
  })

  it('refuses on a non-writable (source/prod) org before any create', async () => {
    const { org, createCalls } = fakeOrg({ describeSequence: [[extIdField()]], writable: false })
    await expect(createExtIdField(org, noopStore, 'Account', { sleep: fastSleep })).rejects.toThrow(
      /read-only/
    )
    expect(createCalls).toHaveLength(0)
  })
})

// ── S57 (B4): entities that can never carry the key ───────────────────────────
// Dep 36 (sb1-915-git): CampaignMemberStatus stayed red after Provision because the
// platform allows no custom fields on it; nothing said so.
describe('S57 B4 — cannotHostCustomField', () => {
  it('a registry object with no field is flagged (still needs the field → still blocks)', () => {
    const r = assessObject({ objectName: 'CampaignMemberStatus', fields: [], isJunction: false })
    expect(r).toMatchObject({ needsExtIdField: true, cannotHostCustomField: true })
  })
  it('an ordinary object is not flagged; an explicit flag (from a Provision refusal) is honoured', () => {
    expect(assessObject({ objectName: 'Account', fields: [], isJunction: false }).cannotHostCustomField).toBeUndefined()
    const r = assessObject({ objectName: 'Widget__c', fields: [], isJunction: false, cannotHostCustomField: true })
    expect(r.cannotHostCustomField).toBe(true)
  })
  it('a junction is never flagged (it needs no key)', () => {
    const r = assessObject({ objectName: 'OpportunityContactRole', fields: [], isJunction: true, cannotHostCustomField: true })
    expect(r.cannotHostCustomField).toBeUndefined()
  })
})
