import { describe, it, expect } from 'vitest'
import {
  CPQ_GUARD_TTL_HOURS,
  writeControl,
  setRdsDeploymentControl,
  resolveTargetOrganizationId,
  setCpqTriggerDisabled,
  readCpqTriggerDisabled,
  activateDraftContracts,
  runPostDeployFinalizeCallouts,
  type CpqGuardIo,
  type ActivationResult
} from '../src/main/engine/cpqGuard'
import type { ToggleCalloutResult } from '../src/main/engine/automationToggle'
import { makeCpqGuardIo } from '../src/main/services/automationToggleIo'
import type { GuardedOrg } from '../src/main/services/salesforce'

type Call = { path: string; method: string; body: string | null }

const NOW = new Date('2026-08-06T10:00:00.000Z')
const NOW_ISO = '2026-08-06T10:00:00.000Z'
const NOW_PLUS_8H_ISO = '2026-08-06T18:00:00.000Z'

const ok = (body: unknown): ToggleCalloutResult => ({
  success: true,
  statusCode: 200,
  body: JSON.stringify(body)
})
const noContent = (): ToggleCalloutResult => ({ success: true, statusCode: 204, body: '' })
const httpFail = (msg = 'boom', body = ''): ToggleCalloutResult => ({
  success: false,
  statusCode: 400,
  body,
  errorMessage: msg
})
const queryRecords = (records: unknown[]): ToggleCalloutResult => ok({ records })

const decodeQ = (path: string): string =>
  decodeURIComponent(path.split('?q=')[1]!.replace(/\+/g, '%20'))

/** Scripted guard-io fake: fixed clock, recorded calls, path-routed handler. */
function makeIo(
  handler: (call: Call, index: number) => ToggleCalloutResult,
  opts?: { cachedTargetOrgId?: string | null }
): { io: CpqGuardIo; calls: Call[]; logs: string[] } {
  const calls: Call[] = []
  const logs: string[] = []
  const io: CpqGuardIo = {
    callout: async (path, method, body) => {
      const call = { path, method, body }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    now: () => new Date(NOW.getTime()),
    cachedTargetOrgId: opts?.cachedTargetOrgId
  }
  return { io, calls, logs }
}

const isQuery = (c: Call): boolean => c.path.includes('/query/?q=')
const bodyOf = (c: Call): Record<string, unknown> => JSON.parse(c.body ?? '{}')

// ─────────────────────────────── writeControl ────────────────────────────────

describe('writeControl INVALID_FIELD retry (AMS:964-985)', () => {
  const payload = {
    Disable_CPQ_Triggers__c: true,
    Deployment_In_Progress__c: true,
    Expires_At__c: NOW_PLUS_8H_ISO
  }

  it('success on first try (204) → no retry', async () => {
    const { io, calls } = makeIo(() => noContent())
    const result = await writeControl(io, '/ep', 'PATCH', payload)
    expect(result.statusCode).toBe(204)
    expect(calls).toHaveLength(1)
  })

  it.each(['Expires_At__c', 'INVALID_FIELD', 'No such column'])(
    "failure body containing '%s' → retried ONCE without Expires_At__c, other fields intact",
    async (marker) => {
      const { io, calls } = makeIo((_c, i) =>
        i === 0 ? httpFail('bad field', `[{"message":"${marker}: nope"}]`) : noContent()
      )
      const result = await writeControl(io, '/ep', 'PATCH', payload)
      expect(calls).toHaveLength(2)
      expect(bodyOf(calls[1]!)).toEqual({
        Disable_CPQ_Triggers__c: true,
        Deployment_In_Progress__c: true
      })
      expect(result.statusCode).toBe(204)
    }
  )

  it('NO retry when the body is blank, lacks the markers, or the payload has no Expires_At__c', async () => {
    const blank = makeIo(() => httpFail('err', ''))
    expect((await writeControl(blank.io, '/ep', 'PATCH', payload)).success).toBe(false)
    expect(blank.calls).toHaveLength(1)

    const noMarker = makeIo(() => httpFail('err', '[{"message":"REQUIRED_FIELD_MISSING"}]'))
    expect((await writeControl(noMarker.io, '/ep', 'PATCH', payload)).success).toBe(false)
    expect(noMarker.calls).toHaveLength(1)

    const noTtl = makeIo(() => httpFail('err', '[{"message":"INVALID_FIELD"}]'))
    const p = { Disable_CPQ_Triggers__c: false, Deployment_In_Progress__c: false }
    expect((await writeControl(noTtl.io, '/ep', 'POST', p)).success).toBe(false)
    expect(noTtl.calls).toHaveLength(1)
  })

  it('retries only once — a failing retry is returned, not re-retried', async () => {
    const { io, calls } = makeIo(() => httpFail('still bad', '[{"message":"INVALID_FIELD"}]'))
    const result = await writeControl(io, '/ep', 'PATCH', payload)
    expect(result.success).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('does not mutate the caller payload when retrying', async () => {
    const { io } = makeIo((_c, i) =>
      i === 0 ? httpFail('bad', '[{"message":"INVALID_FIELD"}]') : noContent()
    )
    const mine = { ...payload }
    await writeControl(io, '/ep', 'PATCH', mine)
    expect(mine.Expires_At__c).toBe(NOW_PLUS_8H_ISO)
  })
})

// ─────────────────────────── setRdsDeploymentControl ─────────────────────────

describe('setRdsDeploymentControl (AMS:930-1005)', () => {
  it('ARM with existing record: PATCH by Id — both flags true, Expires_At__c = now+8h (TTL self-heal)', async () => {
    const { io, calls } = makeIo((c) =>
      isQuery(c) ? queryRecords([{ Id: 'a0X000000000001AAA' }]) : noContent()
    )
    expect(await setRdsDeploymentControl(io, true)).toBe(true)
    expect(CPQ_GUARD_TTL_HOURS).toBe(8)
    const patch = calls[1]!
    expect(patch.method).toBe('PATCH')
    expect(patch.path).toBe(
      '/services/data/v66.0/sobjects/RDS_Deployment_Control__c/a0X000000000001AAA'
    )
    expect(bodyOf(patch)).toEqual({
      Disable_CPQ_Triggers__c: true,
      Deployment_In_Progress__c: true,
      Expires_At__c: NOW_PLUS_8H_ISO
    })
  })

  it('DISARM: both flags false, Expires_At__c = NOW (already-expired = OFF)', async () => {
    const { io, calls } = makeIo((c) => (isQuery(c) ? queryRecords([{ Id: 'a0X1' }]) : noContent()))
    expect(await setRdsDeploymentControl(io, false)).toBe(true) // 204 → true
    expect(bodyOf(calls[1]!)).toEqual({
      Disable_CPQ_Triggers__c: false,
      Deployment_In_Progress__c: false,
      Expires_At__c: NOW_ISO
    })
  })

  it('queries the control record with the exact Apex SOQL', async () => {
    const { io, calls } = makeIo((c) => (isQuery(c) ? queryRecords([{ Id: 'a0X1' }]) : noContent()))
    await setRdsDeploymentControl(io, true)
    expect(decodeQ(calls[0]!.path)).toBe(
      'SELECT Id, Disable_CPQ_Triggers__c, Deployment_In_Progress__c FROM RDS_Deployment_Control__c LIMIT 1'
    )
  })

  it('no Org Default record → POST with the TARGET SetupOwnerId (the 159-SBQQ-errors bug)', async () => {
    const { io, calls } = makeIo(
      (c) => (isQuery(c) ? queryRecords([]) : { success: true, statusCode: 201, body: '{}' }),
      { cachedTargetOrgId: '00DcW000005SHnpUAG' }
    )
    expect(await setRdsDeploymentControl(io, true)).toBe(true)
    const post = calls[1]!
    expect(post.method).toBe('POST')
    expect(post.path).toBe('/services/data/v66.0/sobjects/RDS_Deployment_Control__c/')
    expect(bodyOf(post).SetupOwnerId).toBe('00DcW000005SHnpUAG')
  })

  it('cached org Id missing → resolves via live Organization query before POSTing', async () => {
    const { io, calls } = makeIo(
      (c) => {
        if (!isQuery(c)) return { success: true, statusCode: 201, body: '{}' }
        if (decodeQ(c.path).includes('RDS_Deployment_Control__c')) return queryRecords([])
        return queryRecords([{ Id: '00D999999999999AAA' }])
      },
      { cachedTargetOrgId: null }
    )
    expect(await setRdsDeploymentControl(io, true)).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST'])
    expect(bodyOf(calls[2]!).SetupOwnerId).toBe('00D999999999999AAA')
  })

  it('org Id unresolvable → warn + false, NO POST ever leaves (AMS:947-952)', async () => {
    const { io, calls, logs } = makeIo(
      (c) =>
        decodeQ(c.path).includes('RDS_Deployment_Control__c') ? queryRecords([]) : httpFail(),
      { cachedTargetOrgId: '   ' }
    )
    expect(await setRdsDeploymentControl(io, true)).toBe(false)
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(logs).toContainEqual(expect.stringContaining('could not resolve target Org Id'))
  })

  it('control query failure → false with no further callouts', async () => {
    const { io, calls } = makeIo(() => httpFail('no access'))
    expect(await setRdsDeploymentControl(io, true)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("POST failure → warn log with errorMessage AND body (Apex null-concat renders 'null')", async () => {
    const { io, logs } = makeIo(
      (c) =>
        isQuery(c) ? queryRecords([]) : { success: false, statusCode: 400, errorMessage: null },
      { cachedTargetOrgId: '00D1' }
    )
    expect(await setRdsDeploymentControl(io, true)).toBe(false)
    expect(logs).toContainEqual(
      expect.stringContaining('setRdsDeploymentControl POST failed: null | body: null')
    )
  })

  it('malformed query container THROWS (Apex cast parity — the driver catches)', async () => {
    const { io } = makeIo(() => ({ success: true, statusCode: 200, body: '"just a string"' }))
    await expect(setRdsDeploymentControl(io, true)).rejects.toThrow('not an object')
  })
})

// ────────────────────────── resolveTargetOrganizationId ──────────────────────

describe('resolveTargetOrganizationId (AMS:1013-1035)', () => {
  it('cached Id wins — zero callouts', async () => {
    const { io, calls } = makeIo(() => httpFail(), { cachedTargetOrgId: '00DcW000005SHnpUAG' })
    expect(await resolveTargetOrganizationId(io)).toBe('00DcW000005SHnpUAG')
    expect(calls).toEqual([])
  })

  it('live query fallback; failures/malformed/empty all degrade to null, never throw', async () => {
    const live = makeIo(() => queryRecords([{ Id: '00D42' }]))
    expect(await resolveTargetOrganizationId(live.io)).toBe('00D42')
    expect(decodeQ(live.calls[0]!.path)).toBe('SELECT Id FROM Organization LIMIT 1')

    expect(await resolveTargetOrganizationId(makeIo(() => httpFail()).io)).toBeNull()
    expect(
      await resolveTargetOrganizationId(
        makeIo(() => ({ success: true, statusCode: 200, body: 'not json' })).io
      )
    ).toBeNull()
    expect(await resolveTargetOrganizationId(makeIo(() => queryRecords([])).io)).toBeNull()
    expect(await resolveTargetOrganizationId(makeIo(() => queryRecords([{}])).io)).toBeNull()
  })
})

// ─────────────────────────── legacy SBQQ setting ─────────────────────────────

describe('setCpqTriggerDisabled — legacy SBQQ__TriggerDisabled__c (AMS:855-912)', () => {
  it('existing record → PATCH SBQQ__IsDisabled__c only (no SetupOwnerId, no TTL)', async () => {
    const { io, calls } = makeIo((c) => (isQuery(c) ? queryRecords([{ Id: 'a0Y1' }]) : noContent()))
    expect(await setCpqTriggerDisabled(io, true)).toBe(true)
    expect(decodeQ(calls[0]!.path)).toBe('SELECT Id FROM SBQQ__TriggerDisabled__c LIMIT 1')
    const patch = calls[1]!
    expect(patch.path).toBe('/services/data/v66.0/sobjects/SBQQ__TriggerDisabled__c/a0Y1')
    expect(bodyOf(patch)).toEqual({ SBQQ__IsDisabled__c: true })
  })

  it('no record → POST with target SetupOwnerId; un-disable on restore sends false', async () => {
    const { io, calls } = makeIo(
      (c) => (isQuery(c) ? queryRecords([]) : { success: true, statusCode: 201, body: '{}' }),
      { cachedTargetOrgId: '00D1' }
    )
    expect(await setCpqTriggerDisabled(io, false)).toBe(true)
    expect(bodyOf(calls[1]!)).toEqual({ SBQQ__IsDisabled__c: false, SetupOwnerId: '00D1' })
  })

  it('query failure → false, nothing written', async () => {
    const { io, calls } = makeIo(() => httpFail())
    expect(await setCpqTriggerDisabled(io, true)).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

// ─────────────────────────── contract activation ─────────────────────────────

describe('activateDraftContracts (PDQ:186-243)', () => {
  const contracts = (n: number): Array<{ Id: string; Status: string }> =>
    Array.from({ length: n }, (_, i) => ({
      Id: `800${String(i).padStart(4, '0')}`,
      Status: 'Draft'
    }))

  it("queries OUR Draft Contracts only (Status='Draft' AND ExtId != null)", async () => {
    const { io, calls } = makeIo(() => queryRecords([]))
    await activateDraftContracts(io)
    expect(decodeQ(calls[0]!.path)).toBe(
      "SELECT Id, Status FROM Contract WHERE Status = 'Draft' AND Data_Deployment_External_Id__c != null"
    )
  })

  it('query failure → attempted:false with a Query failed error', async () => {
    const { io } = makeIo(() => httpFail('no token'))
    expect(await activateDraftContracts(io)).toEqual({
      attempted: false,
      activated: 0,
      failed: 0,
      error: 'Query failed: no token'
    })
  })

  it('no Draft contracts → attempted:true, zero counts, no PATCH (PDQ:206-209)', async () => {
    const { io, calls } = makeIo(() => queryRecords([]))
    expect(await activateDraftContracts(io)).toEqual({
      attempted: true,
      activated: 0,
      failed: 0,
      error: null
    })
    expect(calls).toHaveLength(1)
  })

  it('450 contracts → composite PATCH chunks of 200/200/50, allOrNone:false, Activated payloads', async () => {
    const { io, calls } = makeIo((c, i) =>
      i === 0
        ? queryRecords(contracts(450))
        : ok(
            bodyOf(c).records ? (bodyOf(c).records as unknown[]).map(() => ({ success: true })) : []
          )
    )
    const r = await activateDraftContracts(io)
    const patches = calls.slice(1)
    expect(patches.map((c) => (bodyOf(c).records as unknown[]).length)).toEqual([200, 200, 50])
    expect(patches.every((c) => c.method === 'PATCH')).toBe(true)
    expect(patches.every((c) => c.path === '/services/data/v66.0/composite/sobjects/')).toBe(true)
    expect(patches.every((c) => bodyOf(c).allOrNone === false)).toBe(true)
    const first = (bodyOf(patches[0]!).records as Array<Record<string, unknown>>)[0]!
    expect(first).toEqual({ attributes: { type: 'Contract' }, Id: '8000000', Status: 'Activated' })
    expect(r).toEqual({ attempted: true, activated: 450, failed: 0, error: null })
  })

  it('per-record successes counted; failed batch callout adds the whole chunk and later chunks still run', async () => {
    const { io, calls } = makeIo((c, i) => {
      if (i === 0) return queryRecords(contracts(401))
      if (i === 1)
        return ok([...Array(150).fill({ success: true }), ...Array(50).fill({ success: false })])
      if (i === 2) return httpFail('mid-batch drop')
      return ok([{ success: true }])
    })
    const r = await activateDraftContracts(io)
    expect(calls).toHaveLength(4)
    expect(r).toEqual({ attempted: true, activated: 151, failed: 250, error: null })
  })

  it('a thrown parse error lands in result.error — the method NEVER throws (PDQ:239-241)', async () => {
    const { io } = makeIo((_c, i) =>
      i === 0
        ? queryRecords(contracts(1))
        : { success: true, statusCode: 200, body: '{"not":"a list"}' }
    )
    const r = await activateDraftContracts(io)
    expect(r.error).toContain('not a list')
  })
})

// ─────────────────────────── finalize composition ────────────────────────────

describe('runPostDeployFinalizeCallouts — Phase-A ordering (PDQ:22-27, :91-115)', () => {
  const route = (c: Call): ToggleCalloutResult => {
    const q = c.path.includes('?q=') ? decodeQ(c.path) : ''
    if (q.includes('Contract')) return queryRecords([{ Id: '8001', Status: 'Draft' }])
    if (q.includes('RDS_Deployment_Control__c')) return queryRecords([{ Id: 'a0X1' }])
    if (c.path.includes('composite/sobjects')) return ok([{ success: true }])
    return noContent()
  }

  it('normal finalize: Contract activation callouts STRICTLY BEFORE the guard disarm (ContractAfter still suppressed)', async () => {
    const { io, calls } = makeIo(route)
    const r = await runPostDeployFinalizeCallouts(io, { isCancel: false, contractInScope: true })
    const guardIndex = calls.findIndex((c) =>
      c.path.includes('?q=') ? decodeQ(c.path).includes('RDS_Deployment_Control__c') : false
    )
    const lastActivationIndex = calls.findLastIndex((c) => c.path.includes('composite/sobjects'))
    expect(lastActivationIndex).toBeGreaterThanOrEqual(0)
    expect(lastActivationIndex).toBeLessThan(guardIndex)
    expect(r.activation).toEqual({ attempted: true, activated: 1, failed: 0, error: null })
    expect(r.guardDisarmed).toBe(true)
    expect(r.guardError).toBeNull()
    // the disarm PATCH really disarms
    const disarm = calls[calls.length - 1]!
    expect(bodyOf(disarm).Disable_CPQ_Triggers__c).toBe(false)
  })

  it('cancel mode: activation SKIPPED (no partial-data finalize), guard STILL disarmed', async () => {
    const { io, calls } = makeIo(route)
    const r = await runPostDeployFinalizeCallouts(io, { isCancel: true, contractInScope: true })
    expect(r.activation).toBeNull()
    expect(calls.some((c) => c.path.includes('composite/sobjects'))).toBe(false)
    expect(r.guardDisarmed).toBe(true)
  })

  it('Contract not in scope: activation skipped, guard disarmed', async () => {
    const { io } = makeIo(route)
    const r = await runPostDeployFinalizeCallouts(io, { isCancel: false, contractInScope: false })
    expect(r.activation).toBeNull()
    expect(r.guardDisarmed).toBe(true)
  })

  it('a THROWN guard failure lands in guardError (≙ PDQ cpqFlipError catch :110-114); activation result survives', async () => {
    const { io } = makeIo((c) => {
      const q = c.path.includes('?q=') ? decodeQ(c.path) : ''
      if (q.includes('Contract')) return queryRecords([])
      if (q.includes('RDS_Deployment_Control__c'))
        return { success: true, statusCode: 200, body: '[1,2,3]' } // cast-throw
      return noContent()
    })
    const r = await runPostDeployFinalizeCallouts(io, { isCancel: false, contractInScope: true })
    expect(r.activation).toEqual({ attempted: true, activated: 0, failed: 0, error: null })
    expect(r.guardDisarmed).toBe(false)
    expect(r.guardError).toContain('not an object')
  })
})

// ─────────────────────────────── live adapter ────────────────────────────────

describe('makeCpqGuardIo adapter', () => {
  function makeOrg(request: (req: unknown) => Promise<unknown>): GuardedOrg {
    return {
      alias: 'sb1_714',
      role: 'target',
      orgId: '00DcW000005SHnpUAG',
      conn: { request },
      assertWritable() {}
    } as unknown as GuardedOrg
  }

  it('carries GuardedOrg.orgId as cachedTargetOrgId and supports an injected clock', async () => {
    const io = makeCpqGuardIo(
      makeOrg(async () => ({})),
      undefined,
      { now: () => NOW }
    )
    expect(io.cachedTargetOrgId).toBe('00DcW000005SHnpUAG')
    expect(io.now().toISOString()).toBe(NOW_ISO)
    expect(await resolveTargetOrganizationId(io)).toBe('00DcW000005SHnpUAG')
  })

  it('PATCH rides the guarded callout seam end-to-end (guard disarm through the adapter)', async () => {
    const seen: Array<{ method: string; url: string; body?: string }> = []
    const io = makeCpqGuardIo(
      makeOrg(async (req) => {
        const r = req as { method: string; url: string; body?: string }
        seen.push(r)
        if (r.url.includes('?q=')) return { records: [{ Id: 'a0X1' }] }
        return undefined // jsforce 204
      }),
      undefined,
      { now: () => NOW }
    )
    expect(await setRdsDeploymentControl(io, false)).toBe(true)
    expect(seen.map((r) => r.method)).toEqual(['GET', 'PATCH'])
    expect(JSON.parse(seen[1]!.body ?? '{}').Expires_At__c).toBe(NOW_ISO)
  })
})

// pin: ActivationResult is exported for the E4A.6 driver's Phase-B logging
const _typecheck: ActivationResult = { attempted: false, activated: 0, failed: 0, error: null }
void _typecheck

// ── §4.3(2) run-scoped activation — E4A.6 review pins, re-based on S46 E1 (ExtIds) ──

describe('activateDraftContracts runExtIds scoping (deployDesign §4.3(2), S46 E1)', () => {
  // 18-char source ids reversed = the ExtIds the transform wrote (generateExternalId).
  const EXT_A = 'AAA100000000000008'
  const EXT_B = 'AAA200000000000008'
  const EXT = 'Data_Deployment_External_Id__c'
  const draftRows = (): ToggleCalloutResult =>
    queryRecords([
      { Id: '800A', Status: 'Draft' },
      { Id: '800B', Status: 'Draft' }
    ])

  it('queries ONLY this run\u2019s ExtIds (Status=Draft AND ExtId IN (…)) and PATCHes every returned row', async () => {
    const { io, calls } = makeIo((c, i) =>
      i === 0 ? draftRows() : ok([{ success: true }, { success: true }])
    )
    const r = await activateDraftContracts(io, [EXT_A, EXT_B])
    const q = decodeQ(calls[0]!.path)
    expect(q).toBe(
      `SELECT Id, Status FROM Contract WHERE Status = 'Draft' AND ${EXT} IN ('${EXT_A}','${EXT_B}')`
    )
    expect(q).not.toContain('!= null') // never the org-wide Apex predicate when scoped
    const ids = (bodyOf(calls[1]!).records as Array<Record<string, unknown>>).map((x) => x.Id)
    expect(ids).toEqual(['800A', '800B'])
    expect(r).toEqual({ attempted: true, activated: 2, failed: 0, error: null })
  })

  it('an EMPTY run set activates nothing — attempted:true, ZERO callouts (never falls back to org-wide)', async () => {
    const { io, calls } = makeIo(() => draftRows())
    const r = await activateDraftContracts(io, [])
    expect(calls).toHaveLength(0)
    expect(r).toEqual({ attempted: true, activated: 0, failed: 0, error: null })
  })

  it('chunks the IN-list at 200 ExtIds per query, then PATCHes in 200s', async () => {
    const extIds = Array.from({ length: 250 }, (_, i) => `EXT${String(i).padStart(15, '0')}`)
    const { io, calls } = makeIo((c) => {
      if (isQuery(c)) {
        const n = (decodeQ(c.path).match(/'EXT/g) ?? []).length
        return queryRecords(
          Array.from({ length: n }, (_, i) => ({ Id: `800${i}`, Status: 'Draft' }))
        )
      }
      const batch = bodyOf(c).records as unknown[]
      return ok(batch.map(() => ({ success: true })))
    })
    const r = await activateDraftContracts(io, extIds)
    const queries = calls.filter(isQuery)
    expect(queries).toHaveLength(2)
    expect((decodeQ(queries[0]!.path).match(/'EXT/g) ?? []).length).toBe(200)
    expect((decodeQ(queries[1]!.path).match(/'EXT/g) ?? []).length).toBe(50)
    const patches = calls.filter((c) => c.path.includes('composite/sobjects'))
    expect(patches.map((p) => (bodyOf(p).records as unknown[]).length)).toEqual([200, 50])
    expect(r.activated).toBe(250)
  })

  it('a failed chunk query lands in error with NO PATCH issued (never throws; nothing half-activated)', async () => {
    const extIds = Array.from({ length: 201 }, (_, i) => `E${i}`)
    const { io, calls } = makeIo((c, i) => (i === 0 ? draftRows() : httpFail('QUERY_TIMEOUT')))
    const r = await activateDraftContracts(io, extIds)
    expect(r.attempted).toBe(false)
    expect(r.error).toMatch(/Query failed: QUERY_TIMEOUT/)
    expect(calls.filter((c) => c.path.includes('composite/sobjects'))).toHaveLength(0)
  })

  it('undefined keeps the verbatim org-wide Apex query (PDQ:196)', async () => {
    const { io, calls } = makeIo((c, i) =>
      i === 0 ? draftRows() : ok([{ success: true }, { success: true }])
    )
    const r = await activateDraftContracts(io)
    expect(decodeQ(calls[0]!.path)).toBe(
      `SELECT Id, Status FROM Contract WHERE Status = 'Draft' AND ${EXT} != null`
    )
    expect(r.activated).toBe(2)
  })

  it('runPostDeployFinalizeCallouts passes runExtIds through to the activation', async () => {
    const { io, calls } = makeIo((c) => {
      const q = c.path.includes('?q=') ? decodeQ(c.path) : ''
      if (q.includes('Contract')) return draftRows()
      if (q.includes('RDS_Deployment_Control__c')) return queryRecords([{ Id: 'a0X1' }])
      if (c.path.includes('composite/sobjects')) return ok([{ success: true }, { success: true }])
      return noContent()
    })
    await runPostDeployFinalizeCallouts(io, {
      isCancel: false,
      contractInScope: true,
      runExtIds: [EXT_B]
    })
    const contractQuery = calls.find((c) => isQuery(c) && decodeQ(c.path).includes('Contract'))!
    expect(decodeQ(contractQuery.path)).toContain(`IN ('${EXT_B}')`)
  })
})

describe('readCpqTriggerDisabled (FINDING #18 support)', () => {
  it('true only when the org-default record exists AND is disabled; absent record → false; failure THROWS', async () => {
    const t = makeIo(() => queryRecords([{ Id: 'a0Y1', SBQQ__IsDisabled__c: true }]))
    expect(await readCpqTriggerDisabled(t.io)).toBe(true)
    const f = makeIo(() => queryRecords([{ Id: 'a0Y1', SBQQ__IsDisabled__c: false }]))
    expect(await readCpqTriggerDisabled(f.io)).toBe(false)
    const none = makeIo(() => queryRecords([]))
    expect(await readCpqTriggerDisabled(none.io)).toBe(false)
    const err = makeIo(() => httpFail('no access'))
    await expect(readCpqTriggerDisabled(err.io)).rejects.toThrow(
      'SBQQ__TriggerDisabled__c read failed'
    )
  })
})

// ── E4A.5 review pins ────────────────────────────────────────────────────────

describe('E4A.5 review pins', () => {
  it('POST create-record payload carries BOTH flags + the TTL (the 159-SBQQ-errors payload, AMS:944-948)', async () => {
    const { io, calls } = makeIo(
      (c) => (isQuery(c) ? queryRecords([]) : { success: true, statusCode: 201, body: '{}' }),
      { cachedTargetOrgId: '00D1' }
    )
    await setRdsDeploymentControl(io, true)
    expect(bodyOf(calls[1]!)).toEqual({
      Disable_CPQ_Triggers__c: true,
      Deployment_In_Progress__c: true,
      Expires_At__c: NOW_PLUS_8H_ISO,
      SetupOwnerId: '00D1'
    })
  })

  it('INVALID_FIELD retry fires through setRdsDeploymentControl on BOTH the PATCH and POST branches (N2b wiring)', async () => {
    const patchSide = makeIo((c, i) => {
      if (isQuery(c)) return queryRecords([{ Id: 'a0X1' }])
      return i === 1 ? httpFail('bad', '[{"message":"No such column Expires_At__c"}]') : noContent()
    })
    expect(await setRdsDeploymentControl(patchSide.io, true)).toBe(true)
    expect(patchSide.calls).toHaveLength(3) // query + failed PATCH + retried PATCH
    expect(bodyOf(patchSide.calls[2]!)).not.toHaveProperty('Expires_At__c')

    const postSide = makeIo(
      (c, i) => {
        if (isQuery(c)) return queryRecords([])
        return i === 1
          ? httpFail('bad', '[{"errorCode":"INVALID_FIELD"}]')
          : { success: true, statusCode: 201, body: '{}' }
      },
      { cachedTargetOrgId: '00D1' }
    )
    expect(await setRdsDeploymentControl(postSide.io, true)).toBe(true)
    expect(postSide.calls).toHaveLength(3)
    expect(bodyOf(postSide.calls[2]!)).not.toHaveProperty('Expires_At__c')
    expect(bodyOf(postSide.calls[2]!).SetupOwnerId).toBe('00D1')
  })

  it('legacy setCpqTriggerDisabled: unresolvable org Id → warn + false, NO POST (AMS:893-898)', async () => {
    const { io, calls, logs } = makeIo(
      (c) => (decodeQ(c.path).includes('SBQQ__TriggerDisabled__c') ? queryRecords([]) : httpFail()),
      { cachedTargetOrgId: '  ' }
    )
    expect(await setCpqTriggerDisabled(io, true)).toBe(false)
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(logs).toContainEqual(expect.stringContaining('could not resolve target Org Id'))
  })

  it('a non-object records ELEMENT throws (Apex cast parity — no PATCH against recordId "")', async () => {
    const { io, calls } = makeIo(() => queryRecords([42]))
    await expect(setRdsDeploymentControl(io, true)).rejects.toThrow('Query record is not an object')
    expect(calls).toHaveLength(1)
  })
})

describe('makeCpqGuardIo failure shapes (OCS:898-908 parity — the E4A.5 HIGH)', () => {
  function makeOrgThrowing(err: unknown): GuardedOrg {
    const gateOps: string[] = []
    const org = {
      alias: 'sb1_714',
      role: 'target',
      orgId: '00DcW000005SHnpUAG',
      conn: {
        request: async () => {
          throw err
        }
      },
      assertWritable(operation: string) {
        gateOps.push(operation)
      }
    } as unknown as GuardedOrg
    ;(org as unknown as { gateOps: string[] }).gateOps = gateOps
    return org
  }

  it('an HTTP-response error (jsforce HttpApiError shape) resolves success:false WITH the reconstructed SF error body — the INVALID_FIELD retry reads it', async () => {
    const err = Object.assign(new Error("No such column 'Expires_At__c' on entity"), {
      errorCode: 'INVALID_FIELD',
      data: [{ message: "No such column 'Expires_At__c' on entity", errorCode: 'INVALID_FIELD' }]
    })
    const io = makeCpqGuardIo(makeOrgThrowing(err), undefined, { now: () => NOW })
    const res = await io.callout('/ep', 'PATCH', '{}')
    expect(res.success).toBe(false)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('INVALID_FIELD')
    expect(res.body).toContain('Expires_At__c')
  })

  it('a transport error (no errorCode) keeps the statusCode-0 no-body shape', async () => {
    const io = makeCpqGuardIo(makeOrgThrowing(new Error('fetch failed')), undefined, {
      now: () => NOW
    })
    const res = await io.callout('/ep', 'GET', null)
    expect(res).toEqual({ success: false, statusCode: 0, errorMessage: 'fetch failed' })
  })

  it('END-TO-END: the older-package INVALID_FIELD retry fires through the LIVE adapter (the 159-SBQQ-storm fallback)', async () => {
    let call = 0
    const org = {
      alias: 'sb1_714',
      role: 'target',
      orgId: '00DcW000005SHnpUAG',
      conn: {
        request: async (req: { method: string; url: string; body?: string }) => {
          call++
          if (req.url.includes('?q=')) return { records: [{ Id: 'a0X1' }] }
          if (JSON.parse(req.body ?? '{}').Expires_At__c !== undefined) {
            throw Object.assign(new Error("No such column 'Expires_At__c' on entity"), {
              errorCode: 'INVALID_FIELD',
              data: [{ message: "No such column 'Expires_At__c'", errorCode: 'INVALID_FIELD' }]
            })
          }
          return undefined // 204 — boolean-only retry accepted
        }
      },
      assertWritable() {}
    } as unknown as GuardedOrg
    const io = makeCpqGuardIo(org, undefined, { now: () => NOW })
    expect(await setRdsDeploymentControl(io, true)).toBe(true)
    expect(call).toBe(3) // query + rejected TTL write + accepted boolean-only retry
  })

  it('gates every callout: assertWritable runs BEFORE conn.request on each call', async () => {
    const order: string[] = []
    const org = {
      alias: 'sb1_714',
      role: 'target',
      orgId: '00D1',
      conn: {
        request: async () => {
          order.push('request')
          return { records: [] }
        }
      },
      assertWritable() {
        order.push('gate')
      }
    } as unknown as GuardedOrg
    const io = makeCpqGuardIo(org, undefined, { now: () => NOW })
    await io.callout('/a', 'GET', null)
    await io.callout('/b', 'POST', '{}')
    expect(order).toEqual(['gate', 'request', 'gate', 'request'])
  })
})
