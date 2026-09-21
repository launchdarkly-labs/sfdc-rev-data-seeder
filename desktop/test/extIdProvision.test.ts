import { describe, it, expect } from 'vitest'
import {
  provisionExtIdFields,
  chunk,
  METADATA_BATCH_SIZE,
  RDS_PERMISSION_SET
} from '../src/main/services/extIdProvision'
import { EXT_ID_FIELD } from '../src/main/engine/readiness'

/**
 * The bug this service exists to fix: a CustomField created through the
 * Metadata API carries no field-level security, so describeSObject omits it and
 * a create-then-poll loop can never converge. Verified live on ldseed (create →
 * NOT VISIBLE; add FLS → VISIBLE). These tests pin the ORDERING — fields, then
 * FLS, then poll — plus partial-failure isolation.
 */

// describeObject() maps from the jsforce describe shape, so the fake returns
// that shape (f.name / f.externalId), not the mapped FieldInfo.
const rawExtIdField = (): Record<string, unknown> => ({
  name: EXT_ID_FIELD,
  label: 'Data Deployment External Id',
  type: 'string',
  externalId: true,
  createable: true,
  updateable: true
})

interface Call {
  kind: string
  detail?: unknown
}

/**
 * Fake org. `visibleAfterFls` models the platform truth: a created field only
 * shows up in describe once the FLS grant has landed.
 */
function makeOrg(options: {
  present?: string[]
  createFails?: Record<string, string>
  permSetFails?: string
  permSetExists?: boolean
  grantFails?: Record<string, string>
  alreadyGranted?: string[]
  alreadyAssigned?: boolean
  visibleAfterFls?: boolean
  describeThrows?: Record<string, string>
} = {}) {
  const present = new Set(options.present ?? [])
  const createdFields = new Set<string>()
  const grantedObjects = new Set(options.alreadyGranted ?? [])
  let flsGranted = grantedObjects.size > 0
  const calls: Call[] = []
  const visibleAfterFls = options.visibleAfterFls ?? true

  const conn = {
    // Classification reads Tooling (FLS-independent), so the fake serves the
    // CustomField query from the same set the metadata create writes into.
    tooling: {
      async query(soql: string) {
        calls.push({ kind: 'tooling', detail: soql })
        if (soql.includes('FROM CustomField')) {
          const objects = [...present, ...createdFields]
          return { records: objects.map((o) => ({ TableEnumOrId: o })) }
        }
        return { records: [] }
      }
    },
    metadata: {
      async create(type: string, md: unknown) {
        const items = Array.isArray(md) ? md : [md]
        calls.push({ kind: 'create', detail: items.map((m) => (m as { fullName: string }).fullName) })
        return items.map((m) => {
          const fullName = (m as { fullName: string }).fullName
          const objectName = fullName.split('.')[0]!
          const failure = options.createFails?.[objectName]
          if (failure !== undefined) return { success: false, fullName, errors: failure }
          createdFields.add(objectName)
          return { success: true, fullName, errors: [] }
        })
      },
      async upsert(type: string, md: unknown) {
        calls.push({ kind: 'upsert', detail: md })
        if (options.permSetFails !== undefined) {
          return { success: false, fullName: RDS_PERMISSION_SET, errors: options.permSetFails }
        }
        flsGranted = true
        return { success: true, created: true, fullName: RDS_PERMISSION_SET, errors: [] }
      }
    },
    async identity() {
      return { user_id: '005xxx' }
    },
    async query(soql: string) {
      calls.push({ kind: 'query', detail: soql })
      if (soql.includes('FROM PermissionSet ')) {
        return { records: options.permSetExists ? [{ Id: '0PSxxx' }] : [] }
      }
      if (soql.includes('PermissionSetAssignment')) {
        return { records: options.alreadyAssigned ? [{ Id: '0Paxxx' }] : [] }
      }
      if (soql.includes('FROM FieldPermissions')) {
        // The platform rejects LIKE on Field ('invalid operator on id field'),
        // so the fake does too — that is what broke the first additive build.
        if (/Field\s+LIKE/i.test(soql)) throw new Error('invalid operator on id field')
        return {
          records: [
            // An unrelated grant on the same permission set must be ignored.
            { SobjectType: 'Account', Field: 'Account.Some_Other_Field__c' },
            ...[...grantedObjects].map((o) => ({
              SobjectType: o,
              Field: `${o}.${EXT_ID_FIELD}`
            }))
          ]
        }
      }
      return { records: [] }
    },
    sobject(name: string) {
      return {
        async create(rec: Record<string, unknown>) {
          calls.push({ kind: name, detail: rec })
          if (name === 'PermissionSet') {
            if (options.permSetFails !== undefined) {
              return { success: false, errors: options.permSetFails }
            }
            flsGranted = true
            return { success: true, id: '0PSxxx', errors: [] }
          }
          if (name === 'FieldPermissions') {
            const objectName = String(rec.SobjectType)
            const failure = options.grantFails?.[objectName]
            if (failure !== undefined) {
              // A duplicate error means the row IS there — model that, or the
              // test would assert on an impossible org state.
              if (/duplicate/i.test(failure)) grantedObjects.add(objectName)
              throw new Error(failure)
            }
            grantedObjects.add(objectName)
            flsGranted = true
            return { success: true, id: '01kxxx', errors: [] }
          }
          return { success: true, id: '0Paxxx', errors: [] }
        }
      }
    },
    // describeObject() reads through this; the fake mirrors the FLS rule.
    async describe(objectName: string) {
      const thrown = options.describeThrows?.[objectName]
      if (thrown !== undefined) throw new Error(thrown)
      // Platform truth: the field is only visible once THIS object's grant lands.
      const visible =
        (present.has(objectName) || createdFields.has(objectName)) &&
        grantedObjects.has(objectName) &&
        visibleAfterFls
      return { fields: visible ? [rawExtIdField()] : [] }
    }
  }

  return {
    org: {
      conn,
      orgId: '00Dfake0000000000',
      assertWritable: (): void => undefined
    } as never,
    calls,
    get flsGranted() {
      return flsGranted
    }
  }
}

// provisionExtIdFields always force-describes, so the cache is bypassed on read;
// the write-through still calls putCachedDescribe.
const store = {
  getCachedDescribe: () => null,
  putCachedDescribe: () => undefined
} as never

const noSleep = { sleep: async (): Promise<void> => undefined, maxAttempts: 3, pollIntervalMs: 0 }

describe('provisionExtIdFields — the FLS ordering fix', () => {
  it('creates fields, THEN grants FLS, THEN polls — and converges', async () => {
    const { org, calls } = makeOrg()
    const result = await provisionExtIdFields(org, store, ['Account', 'Contact'], noSleep)

    expect(result.created.sort()).toEqual(['Account', 'Contact'])
    expect(result.failures).toEqual([])
    expect(result.report.ready).toBe(true)

    // Ordering is the whole fix: the create must precede the grant.
    const kinds = calls.map((c) => c.kind)
    expect(kinds.indexOf('create')).toBeLessThan(kinds.indexOf('FieldPermissions'))
  })

  it('never converges without the grant — the exact S46 failure, now reported per object', async () => {
    const { org } = makeOrg({ permSetFails: 'INSUFFICIENT_ACCESS' })
    const result = await provisionExtIdFields(org, store, ['Account'], noSleep)

    expect(result.report.ready).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.error).toContain('field-level security grant failed')
  })

  it('grants FLS on pre-existing fields too — an older run may predate the fix', async () => {
    const { org, calls } = makeOrg({ present: ['Account'] })
    const result = await provisionExtIdFields(org, store, ['Account'], noSleep)

    expect(result.created).toEqual([])
    expect(result.alreadyPresent).toEqual(['Account'])
    expect(result.granted).toEqual(['Account'])
    // No create attempted — Tooling already reported the field.
    expect(calls.some((c) => c.kind === 'create')).toBe(false)
    const grant = calls.find((c) => c.kind === 'FieldPermissions')!.detail as Record<string, unknown>
    expect(grant).toEqual({
      ParentId: '0PSxxx',
      SobjectType: 'Account',
      Field: `Account.${EXT_ID_FIELD}`,
      PermissionsRead: true,
      PermissionsEdit: true
    })
  })

  it('grants field permissions ONLY — no objectPermissions (verified sufficient on ldseed)', async () => {
    const { org, calls } = makeOrg()
    await provisionExtIdFields(org, store, ['Account'], noSleep)
    const permSet = calls.find((c) => c.kind === 'PermissionSet')!.detail as Record<string, unknown>
    expect(permSet.Name).toBe(RDS_PERMISSION_SET)
    // Nothing in the whole call log carries object-level permissions.
    expect(JSON.stringify(calls)).not.toContain('ObjectPermissions')
    expect(JSON.stringify(calls)).not.toContain('objectPermissions')
  })

  // THE regression test for the first live run: Account/Contact already had the
  // field from a pre-fix run, so describe could not see it and the old
  // classifier tried to re-create it (DUPLICATE_DEVELOPER_NAME), then skipped
  // the grant because the object was in `failures`.
  it('grants — never re-creates — a field that exists but is invisible without FLS', async () => {
    const { org, calls } = makeOrg({ present: ['Account', 'Contact'] })
    const result = await provisionExtIdFields(org, store, ['Account', 'Contact'], noSleep)

    expect(calls.some((c) => c.kind === 'create')).toBe(false)
    expect(result.created).toEqual([])
    expect(result.granted).toEqual(['Account', 'Contact'])
    expect(result.failures).toEqual([])
    expect(result.report.ready).toBe(true)
  })

  // The permission set is inserted through the Data api precisely so a narrower
  // later deployment cannot strip a wider earlier one's grants.
  it('adds only the missing grants and leaves existing ones alone', async () => {
    const { org, calls } = makeOrg({
      present: ['Account', 'Contact'],
      permSetExists: true,
      alreadyGranted: ['Account']
    })
    const result = await provisionExtIdFields(org, store, ['Account', 'Contact'], noSleep)

    // Account was already granted; only Contact is inserted.
    const inserts = calls.filter((c) => c.kind === 'FieldPermissions')
    expect(inserts).toHaveLength(1)
    expect((inserts[0]!.detail as { SobjectType: string }).SobjectType).toBe('Contact')
    expect(result.granted).toEqual(['Account', 'Contact'])
    expect(result.permissionSetCreated).toBe(false)
  })

  it('treats a duplicate-grant race as already granted, not a failure', async () => {
    const { org } = makeOrg({
      present: ['Account'],
      grantFails: { Account: 'Duplicate row exists in FieldPermissions: [...]' },
      alreadyGranted: []
    })
    const result = await provisionExtIdFields(org, store, ['Account'], noSleep)
    expect(result.granted).toEqual(['Account'])
    expect(result.failures).toEqual([])
  })

  it('skips junctions entirely — they are exempt and cannot carry the field', async () => {
    const { org, calls } = makeOrg()
    const result = await provisionExtIdFields(
      org,
      store,
      ['Account', 'OpportunityContactRole'],
      noSleep
    )
    expect(result.skippedJunctions).toEqual(['OpportunityContactRole'])
    const created = calls.find((c) => c.kind === 'create')!.detail as string[]
    expect(created).toEqual([`Account.${EXT_ID_FIELD}`])
    expect(result.report.ready).toBe(true)
  })

  it('isolates a per-object create failure — one bad object does not sink the rest', async () => {
    const { org } = makeOrg({ createFails: { OpportunityTeamMember: 'INVALID_FIELD' } })
    const result = await provisionExtIdFields(
      org,
      store,
      ['Account', 'OpportunityTeamMember'],
      noSleep
    )
    expect(result.created).toEqual(['Account'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.objectName).toBe('OpportunityTeamMember')
    // The healthy object still got its grant.
    expect(result.granted).toEqual(['Account'])
  })

  it('reports every requested object even when one cannot be described', async () => {
    const { org } = makeOrg({
      createFails: { Ghost__c: 'INVALID_TYPE: no such object' },
      describeThrows: { Ghost__c: 'INVALID_TYPE: no such object' }
    })
    const result = await provisionExtIdFields(org, store, ['Account', 'Ghost__c'], noSleep)
    expect(result.report.objects.map((o) => o.objectName).sort()).toEqual(['Account', 'Ghost__c'])
    expect(result.failures.some((f) => f.objectName === 'Ghost__c')).toBe(true)
  })

  it('assigns the permission set once, and not again when already assigned', async () => {
    const fresh = makeOrg()
    const a = await provisionExtIdFields(fresh.org, store, ['Account'], noSleep)
    expect(a.assignmentCreated).toBe(true)
    expect(a.permissionSetCreated).toBe(true)
    expect(fresh.calls.some((c) => c.kind === 'PermissionSetAssignment')).toBe(true)

    const already = makeOrg({ alreadyAssigned: true, permSetExists: true })
    const b = await provisionExtIdFields(already.org, store, ['Account'], noSleep)
    expect(b.assignmentCreated).toBe(false)
    expect(b.permissionSetCreated).toBe(false)
    expect(already.calls.some((c) => c.kind === 'PermissionSetAssignment')).toBe(false)
  })

  it('reports a still-invisible field as a failure rather than hanging', async () => {
    const { org } = makeOrg({ visibleAfterFls: false })
    const result = await provisionExtIdFields(org, store, ['Account'], noSleep)
    expect(result.created).toEqual(['Account'])
    expect(result.failures[0]!.error).toContain('still not visible')
  })

  it('refuses to write when the org is not a target', async () => {
    const { org } = makeOrg()
    const readOnly = {
      ...(org as unknown as object),
      assertWritable: () => {
        throw new Error('source orgs are read-only')
      }
    } as never
    await expect(provisionExtIdFields(readOnly, store, ['Account'], noSleep)).rejects.toThrow(
      'read-only'
    )
  })

  it('batches CustomField creates at the Metadata CRUD ceiling of 10', async () => {
    const objects = Array.from({ length: 23 }, (_, i) => `Obj${i}__c`)
    const { org, calls } = makeOrg()
    await provisionExtIdFields(org, store, objects, noSleep)
    const creates = calls.filter((c) => c.kind === 'create')
    expect(creates).toHaveLength(3)
    expect((creates[0]!.detail as string[]).length).toBe(METADATA_BATCH_SIZE)
    expect((creates[2]!.detail as string[]).length).toBe(3)
  })
})

describe('existingGrants query shape', () => {
  it('never filters FieldPermissions.Field with LIKE, and ignores unrelated grants', async () => {
    // The fake throws on a LIKE filter, so a regression would surface as a
    // grant failure rather than a silent empty read.
    const { org, calls } = makeOrg({ present: ['Account'], permSetExists: true })
    const result = await provisionExtIdFields(org, store, ['Account'], noSleep)

    const fpQuery = calls.find(
      (c) => c.kind === 'query' && String(c.detail).includes('FROM FieldPermissions')
    )
    expect(String(fpQuery!.detail)).not.toMatch(/LIKE/i)
    expect(result.failures).toEqual([])
    // Account's only pre-existing grant was an unrelated field, so the ExtId
    // grant still had to be inserted.
    expect(calls.filter((c) => c.kind === 'FieldPermissions')).toHaveLength(1)
    expect(result.granted).toEqual(['Account'])
  })
})

describe('chunk', () => {
  it('splits without dropping or duplicating', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 10)).toEqual([])
    expect(chunk([1], 10)).toEqual([[1]])
  })
})

// ── S57 (B4): objects the platform will not let us key ────────────────────────
describe('provisionExtIdFields — S57 B4 unprovisionable entities', () => {
  it('skips a registry object (no create attempted), reports it, and flags its row', async () => {
    const { org, calls } = makeOrg()
    const result = await provisionExtIdFields(org, store, ['Account', 'CampaignMemberStatus'], noSleep)
    expect(result.created).toEqual(['Account'])
    expect(result.unprovisionable).toEqual(['CampaignMemberStatus'])
    expect(result.failures).toEqual([
      {
        objectName: 'CampaignMemberStatus',
        error: expect.stringMatching(/can't carry a custom field, so this tool has no way to key it — deselect it/)
      }
    ])
    const created = calls.filter((c) => c.kind === 'create').flatMap((c) => c.detail as string[])
    expect(created.some((n) => n.startsWith('CampaignMemberStatus.'))).toBe(false)
    const row = result.report.objects.find((o) => o.objectName === 'CampaignMemberStatus')!
    expect(row.cannotHostCustomField).toBe(true)
    expect(row.needsExtIdField).toBe(true)
    expect(result.report.ready).toBe(false)
  })

  it('classifies the platform\'s own refusal text for an object the registry does not know', async () => {
    const { org } = makeOrg({
      createFails: { Widget__c: 'Custom fields are not allowed on this entity' }
    })
    const result = await provisionExtIdFields(org, store, ['Widget__c', 'Account'], noSleep)
    expect(result.unprovisionable).toEqual(['Widget__c'])
    expect(result.failures[0]!.error).toMatch(/Widget__c can't carry a custom field/)
    expect(result.failures[0]!.error).toMatch(/Custom fields are not allowed on this entity/)
    expect(result.report.objects.find((o) => o.objectName === 'Widget__c')!.cannotHostCustomField).toBe(true)
    expect(result.created).toEqual(['Account'])
  })

  it('a transient create failure stays a plain failure, not unprovisionable', async () => {
    const { org } = makeOrg({ createFails: { Account: 'UNKNOWN_EXCEPTION: try again' } })
    const result = await provisionExtIdFields(org, store, ['Account'], noSleep)
    expect(result.unprovisionable).toEqual([])
    expect(result.failures[0]!.error).toMatch(/could not create/)
  })
})
