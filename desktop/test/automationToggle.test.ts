import { describe, it, expect } from 'vitest'
import {
  COMPOSITE_MAX,
  postToolingComposite,
  setValidationRulesActiveComposite,
  updateValidationRuleActive,
  setFlowsActiveComposite,
  deactivateFlow,
  reactivateFlow,
  setFlowActiveVersionFull,
  type AutomationToggleIo,
  type ToggleCalloutResult
} from '../src/main/engine/automationToggle'
import { makeAutomationToggleIo } from '../src/main/services/automationToggleIo'
import type { GuardedOrg } from '../src/main/services/salesforce'
import type { AutomationItem } from '../src/shared/types'

type Call = { path: string; method: string; body: string | null }

/** Scripted callout fake — records every call, routes to a handler. */
function makeIo(handler: (call: Call, index: number) => ToggleCalloutResult): {
  io: AutomationToggleIo
  calls: Call[]
  logs: string[]
} {
  const calls: Call[] = []
  const logs: string[] = []
  const io: AutomationToggleIo = {
    callout: async (path, method, body) => {
      const call = { path, method, body }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
    log: (level, message) => logs.push(`${level}: ${message}`)
  }
  return { io, calls, logs }
}

const ok = (body: unknown): ToggleCalloutResult => ({
  success: true,
  statusCode: 200,
  body: JSON.stringify(body)
})
const okRaw = (body: string): ToggleCalloutResult => ({ success: true, statusCode: 200, body })
const httpFail = (msg = 'boom'): ToggleCalloutResult => ({
  success: false,
  statusCode: 0,
  errorMessage: msg
})

/** One composite response: ordered subresponses with httpStatusCode + body. */
const composite = (subs: Array<{ status: number; body?: unknown }>): ToggleCalloutResult =>
  ok({ compositeResponse: subs.map((s) => ({ httpStatusCode: s.status, body: s.body ?? null })) })

const parseComposite = (body: string | null): { allOrNone: boolean; compositeRequest: Array<Record<string, unknown>> } =>
  JSON.parse(body ?? '{}')

const isCompositePost = (c: Call): boolean => c.path === '/services/data/v66.0/tooling/composite'
const compositeMethodOf = (c: Call): string =>
  String(parseComposite(c.body).compositeRequest[0]?.method)

const vr = (id: string): AutomationItem => ({
  id,
  name: `VR_${id}`,
  objectName: 'Account',
  automationType: 'ValidationRule',
  isActive: true,
  processType: null,
  isManagedPackage: false,
  restoreVersionNumber: null
})

const flow = (id: string, restoreVersionNumber: number | null = null): AutomationItem => ({
  id,
  name: `Flow_${id}`,
  objectName: 'Account',
  automationType: 'Flow',
  isActive: true,
  processType: 'RecordAfterSave',
  isManagedPackage: false,
  restoreVersionNumber
})

/** A GET-subresponse record body with a full VR Metadata block. */
const vrRecord = (active: boolean): Record<string, unknown> => ({
  Id: 'rec',
  Metadata: {
    validationName: 'VR',
    active,
    errorConditionFormula: '1=1',
    errorMessage: 'nope',
    description: null
  }
})

/** A GET-subresponse record body with a full FlowDefinition Metadata block. */
const flowDefRecord = (activeVersionNumber: number | null): Record<string, unknown> => ({
  Id: 'def',
  Metadata: { activeVersionNumber, masterLabel: 'F', description: null }
})

// ─────────────────────────────── postToolingComposite ───────────────────────

describe('postToolingComposite', () => {
  it('returns [] for empty subrequests without any callout', async () => {
    const { io, calls } = makeIo(() => httpFail())
    expect(await postToolingComposite(io, [])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('POSTs allOrNone=false to the tooling composite endpoint', async () => {
    const { io, calls } = makeIo(() => composite([{ status: 200 }]))
    await postToolingComposite(io, [{ method: 'GET', url: '/u', referenceId: 'g0' }])
    expect(calls[0]!.path).toBe('/services/data/v66.0/tooling/composite')
    expect(calls[0]!.method).toBe('POST')
    expect(parseComposite(calls[0]!.body)).toEqual({
      allOrNone: false,
      compositeRequest: [{ method: 'GET', url: '/u', referenceId: 'g0' }]
    })
  })

  it('returns null on overall HTTP failure', async () => {
    const { io } = makeIo(() => httpFail())
    expect(await postToolingComposite(io, [{ referenceId: 'g0' }])).toBeNull()
  })

  it('parses when success=false but statusCode=200 (Apex success||200 belt)', async () => {
    const { io } = makeIo(() => ({
      success: false,
      statusCode: 200,
      body: JSON.stringify({ compositeResponse: [{ httpStatusCode: 200 }] })
    }))
    expect(await postToolingComposite(io, [{ referenceId: 'g0' }])).toHaveLength(1)
  })

  it('returns null on malformed body / missing / non-array compositeResponse', async () => {
    const { io: bad } = makeIo(() => okRaw('not json'))
    expect(await postToolingComposite(bad, [{ referenceId: 'g0' }])).toBeNull()
    const { io: missing } = makeIo(() => ok({ other: 1 }))
    expect(await postToolingComposite(missing, [{ referenceId: 'g0' }])).toBeNull()
    const { io: notArray } = makeIo(() => ok({ compositeResponse: 'x' }))
    expect(await postToolingComposite(notArray, [{ referenceId: 'g0' }])).toBeNull()
  })
})

// ────────────────────────── Validation Rule composite ───────────────────────

describe('setValidationRulesActiveComposite', () => {
  it('returns [] for empty input without callouts', async () => {
    const { io, calls } = makeIo(() => httpFail())
    expect(await setValidationRulesActiveComposite(io, [], false)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('toggles 26 VRs in two 25-item chunks: GET composite → PATCH-full composite', async () => {
    const vrs = Array.from({ length: 26 }, (_, i) => vr(`03d${String(i).padStart(3, '0')}`))
    const { io, calls } = makeIo((c) => {
      const n = parseComposite(c.body).compositeRequest.length
      return compositeMethodOf(c) === 'GET'
        ? composite(Array.from({ length: n }, () => ({ status: 200, body: vrRecord(true) })))
        : composite(Array.from({ length: n }, () => ({ status: 204 })))
    })
    const done = await setValidationRulesActiveComposite(io, vrs, false)
    expect(done.map((d) => d.id)).toEqual(vrs.map((v) => v.id))
    // chunk1 GET, chunk1 PATCH, chunk2 GET, chunk2 PATCH
    expect(calls).toHaveLength(4)
    expect(calls.every(isCompositePost)).toBe(true)

    const firstGet = parseComposite(calls[0]!.body).compositeRequest
    expect(firstGet).toHaveLength(COMPOSITE_MAX)
    expect(firstGet[0]).toEqual({
      method: 'GET',
      url: '/services/data/v66.0/tooling/sobjects/ValidationRule/03d000',
      referenceId: 'g0'
    })
    expect(firstGet[24]!.referenceId).toBe('g24')

    const firstPatch = parseComposite(calls[1]!.body).compositeRequest
    expect(firstPatch[0]!.method).toBe('PATCH')
    expect(firstPatch[0]!.url).toBe('/services/data/v66.0/tooling/sobjects/ValidationRule/03d000')
    expect(firstPatch[0]!.referenceId).toBe('p0')
    // PATCH carries the ENTIRE Metadata object with active flipped, siblings preserved.
    expect(firstPatch[0]!.body).toEqual({
      Metadata: {
        validationName: 'VR',
        active: false,
        errorConditionFormula: '1=1',
        errorMessage: 'nope',
        description: null
      }
    })
    expect(parseComposite(calls[2]!.body).compositeRequest).toHaveLength(1)
  })

  it('already-in-state items skip the PATCH and are ordered before patched items', async () => {
    // b needs a flip, a is already inactive → localDone order = [a, b].
    const items = [vr('b'), vr('a')]
    const { io, calls } = makeIo((c) => {
      if (compositeMethodOf(c) === 'GET') {
        return composite([
          { status: 200, body: vrRecord(true) }, // b: active → needs disable
          { status: 200, body: vrRecord(false) } // a: already disabled
        ])
      }
      return composite([{ status: 204 }])
    })
    const done = await setValidationRulesActiveComposite(io, items, false)
    expect(done.map((d) => d.id)).toEqual(['a', 'b'])
    expect(parseComposite(calls[1]!.body).compositeRequest).toHaveLength(1)
  })

  it('referenceIds stay dense (g by chunk index, p by patch index) across in-state skips', async () => {
    // Middle item already in state → gets are g0,g1,g2 but patches are p0,p1
    // mapping to items 0 and 2 (AMS: referenceId = 'p' + patchItems.size()).
    const { io, calls } = makeIo((c) => {
      if (compositeMethodOf(c) === 'GET') {
        return composite([
          { status: 200, body: vrRecord(true) },
          { status: 200, body: vrRecord(false) }, // in state — skipped
          { status: 200, body: vrRecord(true) }
        ])
      }
      return composite([{ status: 204 }, { status: 204 }])
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b'), vr('c')], false)
    expect(done.map((d) => d.id)).toEqual(['b', 'a', 'c'])
    const gets = parseComposite(calls[0]!.body).compositeRequest
    expect(gets.map((g) => g.referenceId)).toEqual(['g0', 'g1', 'g2'])
    const patches = parseComposite(calls[1]!.body).compositeRequest
    expect(patches.map((p) => p.referenceId)).toEqual(['p0', 'p1'])
    expect(patches.map((p) => p.url)).toEqual([
      '/services/data/v66.0/tooling/sobjects/ValidationRule/a',
      '/services/data/v66.0/tooling/sobjects/ValidationRule/c'
    ])
  })

  it('all-in-state chunk issues no PATCH composite', async () => {
    const { io, calls } = makeIo(() =>
      composite([
        { status: 200, body: vrRecord(false) },
        { status: 200, body: vrRecord(false) }
      ])
    )
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b')], false)
    expect(done).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('GET-composite HTTP failure → whole chunk per-item fallback', async () => {
    const { io, calls } = makeIo((c) => {
      if (isCompositePost(c)) return httpFail('composite down')
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204, body: '' }
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b')], false)
    expect(done.map((d) => d.id)).toEqual(['a', 'b'])
    // 1 failed composite + per-item (GET+PATCH) × 2
    expect(calls).toHaveLength(5)
    expect(calls[1]!.path).toBe('/services/data/v66.0/tooling/sobjects/ValidationRule/a')
    expect(calls[2]!.path).toBe(
      '/services/data/v66.0/tooling/sobjects/ValidationRule/a?_HttpMethod=PATCH'
    )
    expect(calls[2]!.method).toBe('POST')
  })

  it('non-200 GET subresponse → per-item fallback for the WHOLE chunk', async () => {
    const { io, calls } = makeIo((c) => {
      if (isCompositePost(c)) {
        return composite([
          { status: 200, body: vrRecord(true) },
          { status: 404 }
        ])
      }
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204 }
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b')], false)
    expect(done).toHaveLength(2)
    expect(calls.filter((c) => !isCompositePost(c))).toHaveLength(4)
  })

  it('missing Metadata in a GET subresponse → per-item fallback', async () => {
    const { io } = makeIo((c) => {
      if (isCompositePost(c)) return composite([{ status: 200, body: { Id: 'x' } }])
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204 }
    })
    expect(await setValidationRulesActiveComposite(io, [vr('a')], false)).toHaveLength(1)
  })

  it('subresponse count mismatch → per-item fallback', async () => {
    const { io } = makeIo((c) => {
      if (isCompositePost(c)) return composite([{ status: 200, body: vrRecord(true) }])
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204 }
    })
    expect(await setValidationRulesActiveComposite(io, [vr('a'), vr('b')], false)).toHaveLength(2)
  })

  it('PATCH-composite overall failure → per-item fallback re-confirms in-state items too', async () => {
    let compositeCalls = 0
    const { io, calls } = makeIo((c) => {
      if (isCompositePost(c)) {
        compositeCalls++
        if (compositeMethodOf(c) === 'GET') {
          return composite([
            { status: 200, body: vrRecord(false) }, // already in state
            { status: 200, body: vrRecord(true) }
          ])
        }
        return httpFail('patch composite down')
      }
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204 }
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b')], false)
    expect(compositeCalls).toBe(2)
    // Whole chunk re-ran per-item, so 'a' was re-confirmed by its own GET.
    expect(done.map((d) => d.id)).toEqual(['a', 'b'])
    expect(calls.filter((c) => !isCompositePost(c) && c.method === 'GET')).toHaveLength(2)
  })

  it('non-2xx PATCH subresponse retries ONLY that item per-item (REVIEW-FIX #9)', async () => {
    const { io, calls } = makeIo((c) => {
      if (isCompositePost(c)) {
        if (compositeMethodOf(c) === 'GET') {
          return composite([
            { status: 200, body: vrRecord(true) },
            { status: 200, body: vrRecord(true) },
            { status: 200, body: vrRecord(true) }
          ])
        }
        return composite([{ status: 204 }, { status: 400 }, { status: 204 }])
      }
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204 }
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b'), vr('c')], false)
    expect(done.map((d) => d.id)).toEqual(['a', 'b', 'c'])
    const perItem = calls.filter((c) => !isCompositePost(c))
    expect(perItem.map((c) => c.path)).toEqual([
      '/services/data/v66.0/tooling/sobjects/ValidationRule/b',
      '/services/data/v66.0/tooling/sobjects/ValidationRule/b?_HttpMethod=PATCH'
    ])
  })

  it('per-item retry throw is caught, warned, and the item excluded', async () => {
    const { io, logs } = makeIo((c) => {
      if (isCompositePost(c)) {
        if (compositeMethodOf(c) === 'GET') {
          return composite([{ status: 200, body: vrRecord(true) }])
        }
        return composite([{ status: 400 }])
      }
      return okRaw('not json') // per-item GET → JSON.parse throws
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a')], false)
    expect(done).toEqual([])
    expect(logs.some((l) => l.includes('VR subrequest retry failed'))).toBe(true)
  })

  it('fallback per-item exception is caught per item; later items proceed', async () => {
    const { io, logs } = makeIo((c) => {
      if (isCompositePost(c)) return httpFail()
      if (c.path.includes('/ValidationRule/a')) return okRaw('not json')
      if (c.method === 'GET') return ok(vrRecord(true))
      return { success: true, statusCode: 204 }
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a'), vr('b')], false)
    expect(done.map((d) => d.id)).toEqual(['b'])
    expect(logs.some((l) => l.includes('VR composite fallback failed'))).toBe(true)
  })
})

describe('updateValidationRuleActive', () => {
  it('GET failure → false + warn', async () => {
    const { io, logs, calls } = makeIo(() => httpFail('nope'))
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(false)
    expect(calls).toHaveLength(1)
    expect(logs).toEqual(['warn: VR GET failed for 03dX: nope'])
  })

  it('missing Metadata → false + warn', async () => {
    const { io, logs } = makeIo(() => ok({ Id: 'x' }))
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(false)
    expect(logs).toEqual(['warn: VR 03dX has no Metadata block'])
  })

  it('short-circuits to true when already in state (no PATCH)', async () => {
    const { io, calls } = makeIo(() => ok(vrRecord(false)))
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('flips active and PATCHes the FULL Metadata via the POST override', async () => {
    const { io, calls } = makeIo((c) =>
      c.method === 'GET' ? ok(vrRecord(true)) : { success: true, statusCode: 200, body: '' }
    )
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(true)
    expect(calls[1]!.path).toBe(
      '/services/data/v66.0/tooling/sobjects/ValidationRule/03dX?_HttpMethod=PATCH'
    )
    expect(calls[1]!.method).toBe('POST')
    expect(JSON.parse(calls[1]!.body ?? '')).toEqual({
      Metadata: {
        validationName: 'VR',
        active: false,
        errorConditionFormula: '1=1',
        errorMessage: 'nope',
        description: null
      }
    })
  })

  it('accepts a bare 204 statusCode even with success=false (Apex 204||200||success)', async () => {
    const { io } = makeIo((c) =>
      c.method === 'GET' ? ok(vrRecord(true)) : { success: false, statusCode: 204 }
    )
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(true)
  })

  it('PATCH failure → false + warn', async () => {
    const { io, logs } = makeIo((c) => (c.method === 'GET' ? ok(vrRecord(true)) : httpFail('sad')))
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(false)
    expect(logs).toEqual(['warn: VR PATCH failed for 03dX: sad'])
  })

  it('treats a STRING "true"/"false" active like Apex Boolean.valueOf', async () => {
    const { io, calls } = makeIo(() =>
      ok({ Id: 'x', Metadata: { active: 'FALSE', errorConditionFormula: '1=1' } })
    )
    expect(await updateValidationRuleActive(io, '03dX', false)).toBe(true)
    expect(calls).toHaveLength(1) // short-circuited
  })

  it('THROWS on a non-boolean/non-string active (Apex Boolean.valueOf TypeException)', async () => {
    const { io } = makeIo(() => ok({ Id: 'x', Metadata: { active: 1 } }))
    await expect(updateValidationRuleActive(io, '03dX', false)).rejects.toThrow('Invalid boolean')
  })
})

describe('scalar-leaf throw parity (Boolean.valueOf / raw (Integer) cast)', () => {
  it('numeric active in a chunk GET body aborts the WHOLE set call (uncaught, AMS:602)', async () => {
    const { io } = makeIo((c) =>
      compositeMethodOf(c) === 'GET'
        ? composite([{ status: 200, body: { Id: 'x', Metadata: { active: 1 } } }])
        : composite([{ status: 204 }])
    )
    await expect(setValidationRulesActiveComposite(io, [vr('a')], false)).rejects.toThrow(
      'Invalid boolean'
    )
  })

  it('numeric active on the per-item FALLBACK path is caught and the item excluded (AMS:569)', async () => {
    const { io, logs } = makeIo((c) => {
      if (isCompositePost(c)) return httpFail() // force the per-item fallback
      return ok({ Id: 'x', Metadata: { active: 1 } })
    })
    const done = await setValidationRulesActiveComposite(io, [vr('a')], false)
    expect(done).toEqual([])
    expect(logs.some((l) => l.includes('VR composite fallback failed: Invalid boolean'))).toBe(true)
  })

  it('reactivateFlow THROWS on a string VersionNumber (Apex raw (Integer) cast, AMS:802)', async () => {
    const { io } = makeIo(() =>
      ok({ records: [{ Id: '301A', DefinitionId: '300A', VersionNumber: '4' }] })
    )
    await expect(reactivateFlow(io, '301A')).rejects.toThrow('Invalid integer')
  })
})

// ──────────────────────────────── Flow composite ────────────────────────────

/** Resolution-query response records. */
const resolution = (
  rows: Array<{ Id: string; DefinitionId?: string | null; VersionNumber?: number | null }>
): ToggleCalloutResult => ok({ records: rows })

const isToolingQuery = (c: Call): boolean =>
  c.path.startsWith('/services/data/v66.0/tooling/query/?q=')

describe('setFlowsActiveComposite', () => {
  it('returns [] for empty input without callouts', async () => {
    const { io, calls } = makeIo(() => httpFail())
    expect(await setFlowsActiveComposite(io, [], true)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('resolves 301→DefinitionId once, then disables via activeVersionNumber=0', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return resolution([
          { Id: '301A', DefinitionId: '300A', VersionNumber: 3 },
          { Id: '301B', DefinitionId: '300B', VersionNumber: 5 }
        ])
      }
      if (compositeMethodOf(c) === 'GET') {
        return composite([
          { status: 200, body: flowDefRecord(3) },
          { status: 200, body: flowDefRecord(5) }
        ])
      }
      return composite([{ status: 204 }, { status: 204 }])
    })
    const done = await setFlowsActiveComposite(io, [flow('301A'), flow('301B')], true)
    expect(done.map((d) => d.id)).toEqual(['301A', '301B'])

    // The resolution query: one call, quoted ids, spaces encoded '+' (urlEncode parity).
    expect(calls.filter(isToolingQuery)).toHaveLength(1)
    const q = decodeURIComponent(calls[0]!.path.split('?q=')[1]!.replace(/\+/g, '%20'))
    expect(q).toBe("SELECT Id, DefinitionId, VersionNumber FROM Flow WHERE Id IN ('301A','301B')")
    expect(calls[0]!.path).toContain('SELECT+Id%2C')

    const gets = parseComposite(calls[1]!.body).compositeRequest
    expect(gets[0]!.url).toBe('/services/data/v66.0/tooling/sobjects/FlowDefinition/300A')
    const patches = parseComposite(calls[2]!.body).compositeRequest
    expect(patches[0]!.url).toBe('/services/data/v66.0/tooling/sobjects/FlowDefinition/300A')
    expect((patches[0]!.body as Record<string, unknown>).Metadata).toEqual({
      activeVersionNumber: 0,
      masterLabel: 'F',
      description: null
    })
  })

  it('restore prefers the disable-time captured version over the current one', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 9 }])
      if (compositeMethodOf(c) === 'GET') return composite([{ status: 200, body: flowDefRecord(0) }])
      return composite([{ status: 204 }])
    })
    const done = await setFlowsActiveComposite(io, [flow('301A', 3)], false)
    expect(done).toHaveLength(1)
    const patch = parseComposite(calls[2]!.body).compositeRequest[0]!
    expect((patch.body as { Metadata: { activeVersionNumber: number } }).Metadata.activeVersionNumber).toBe(3)
  })

  it('restore falls back to the resolved current version when nothing was captured', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 7 }])
      if (compositeMethodOf(c) === 'GET') return composite([{ status: 200, body: flowDefRecord(0) }])
      return composite([{ status: 204 }])
    })
    const done = await setFlowsActiveComposite(io, [flow('301A', null)], false)
    expect(done).toHaveLength(1)
    const patch = parseComposite(calls[2]!.body).compositeRequest[0]!
    expect((patch.body as { Metadata: { activeVersionNumber: number } }).Metadata.activeVersionNumber).toBe(7)
  })

  it('restore with NO version anywhere → chunk falls back; self-resolving reactivateFlow recovers', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        // Batch resolution finds no VersionNumber; the per-item query does.
        return c.path.includes('IN+(')
          ? resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: null }])
          : resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 4 }])
      }
      if (isCompositePost(c) && compositeMethodOf(c) === 'GET') {
        return composite([{ status: 200, body: flowDefRecord(0) }])
      }
      if (c.method === 'GET') return ok(flowDefRecord(0))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A', null)], false)
    expect(done).toHaveLength(1)
    // batch resolution + chunk GET composite (target null → bail) + per-item query + GET + PATCH
    expect(calls.filter(isToolingQuery)).toHaveLength(2)
  })

  it('failed resolution query → [] (non-strict) → whole chunk self-resolves per-item (REVIEW-FIX #3)', async () => {
    const { io, calls, logs } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return c.path.includes('IN+(') ? httpFail('resolution down') : resolution([{ Id: '301A', DefinitionId: '300A' }])
      }
      if (c.method === 'GET') return ok(flowDefRecord(3))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A')], true)
    expect(done).toHaveLength(1)
    expect(logs.some((l) => l.includes('Tooling query failed: resolution down'))).toBe(true)
    // No composite was ever attempted — the unresolved chunk bailed straight away.
    expect(calls.filter(isCompositePost)).toHaveLength(0)
    // deactivateFlow self-resolved: its own query + GET + PATCH(0)
    const patch = calls.find((c) => c.path.includes('?_HttpMethod=PATCH'))!
    expect(JSON.parse(patch.body ?? '')).toEqual({
      Metadata: { activeVersionNumber: 0, masterLabel: 'F', description: null }
    })
  })

  it('already at target version → counted done without a PATCH', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 3 }])
      return composite([{ status: 200, body: flowDefRecord(0) }])
    })
    const done = await setFlowsActiveComposite(io, [flow('301A')], true)
    expect(done).toHaveLength(1)
    expect(calls).toHaveLength(2) // resolution + GET composite only
  })

  it('non-2xx PATCH subresponse retries only that item via the self-resolving path', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return c.path.includes('IN+(')
          ? resolution([
              { Id: '301A', DefinitionId: '300A', VersionNumber: 3 },
              { Id: '301B', DefinitionId: '300B', VersionNumber: 5 }
            ])
          : resolution([{ Id: '301B', DefinitionId: '300B' }])
      }
      if (isCompositePost(c) && compositeMethodOf(c) === 'GET') {
        return composite([
          { status: 200, body: flowDefRecord(3) },
          { status: 200, body: flowDefRecord(5) }
        ])
      }
      if (isCompositePost(c)) return composite([{ status: 204 }, { status: 500 }])
      if (c.method === 'GET') return ok(flowDefRecord(5))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A'), flow('301B')], true)
    expect(done.map((d) => d.id)).toEqual(['301A', '301B'])
    // Exactly one per-item self-resolution (for 301B).
    expect(calls.filter((c) => isToolingQuery(c) && !c.path.includes('IN+('))).toHaveLength(1)
  })

  it('GET-composite HTTP failure → whole flow chunk per-item fallback (disable → 0)', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return c.path.includes('IN+(')
          ? resolution([
              { Id: '301A', DefinitionId: '300A', VersionNumber: 3 },
              { Id: '301B', DefinitionId: '300B', VersionNumber: 5 }
            ])
          : resolution([{ Id: '301A', DefinitionId: '300A' }, { Id: '301B', DefinitionId: '300B' }].filter((r) => c.path.includes(r.Id)))
      }
      if (isCompositePost(c)) return httpFail('composite down')
      if (c.method === 'GET') return ok(flowDefRecord(3))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A'), flow('301B')], true)
    expect(done.map((d) => d.id)).toEqual(['301A', '301B'])
    // Both flows self-resolved per-item: one own query each…
    expect(calls.filter((c) => isToolingQuery(c) && !c.path.includes('IN+('))).toHaveLength(2)
    // …and both PATCHed to 0 via the per-item override endpoint.
    const patches = calls.filter((c) => c.path.includes('?_HttpMethod=PATCH'))
    expect(patches.map((c) => c.path)).toEqual([
      '/services/data/v66.0/tooling/sobjects/FlowDefinition/300A?_HttpMethod=PATCH',
      '/services/data/v66.0/tooling/sobjects/FlowDefinition/300B?_HttpMethod=PATCH'
    ])
    for (const p of patches) {
      expect((JSON.parse(p.body ?? '') as { Metadata: { activeVersionNumber: number } }).Metadata.activeVersionNumber).toBe(0)
    }
  })

  it('non-200 GET subresponse → whole flow chunk per-item fallback', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 3 }])
      }
      if (isCompositePost(c)) return composite([{ status: 404 }])
      if (c.method === 'GET') return ok(flowDefRecord(3))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A')], true)
    expect(done).toHaveLength(1)
    expect(calls.filter((c) => c.path.includes('?_HttpMethod=PATCH'))).toHaveLength(1)
  })

  it('missing Metadata / subresponse count mismatch → whole flow chunk per-item fallback', async () => {
    for (const bad of [
      composite([{ status: 200, body: { Id: 'no-metadata' } }]),
      composite([
        { status: 200, body: flowDefRecord(3) },
        { status: 200, body: flowDefRecord(3) }
      ])
    ]) {
      const { io } = makeIo((c) => {
        if (isToolingQuery(c)) return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 3 }])
        if (isCompositePost(c)) return bad
        if (c.method === 'GET') return ok(flowDefRecord(3))
        return { success: true, statusCode: 204 }
      })
      expect(await setFlowsActiveComposite(io, [flow('301A')], true)).toHaveLength(1)
    }
  })

  it('PATCH-composite overall failure → whole flow chunk per-item fallback', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 3 }])
      if (isCompositePost(c)) {
        return compositeMethodOf(c) === 'GET'
          ? composite([{ status: 200, body: flowDefRecord(3) }])
          : httpFail('patch composite down')
      }
      if (c.method === 'GET') return ok(flowDefRecord(3))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A')], true)
    expect(done).toHaveLength(1)
    expect(calls.filter(isCompositePost)).toHaveLength(2)
    expect(calls.filter((c) => c.path.includes('?_HttpMethod=PATCH'))).toHaveLength(1)
  })

  it('RESTORE polarity survives the per-item fallback: reactivateFlow, never deactivateFlow', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        // Batch resolution fails → whole chunk on the self-resolving path.
        return c.path.includes('IN+(')
          ? httpFail('resolution down')
          : resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 6 }])
      }
      if (c.method === 'GET') return ok(flowDefRecord(0))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A', 6)], false)
    expect(done).toHaveLength(1)
    // The per-item query is the reactivateFlow variant (DefinitionId + VersionNumber)…
    const perItemQuery = calls.find((c) => isToolingQuery(c) && !c.path.includes('IN+('))!
    expect(perItemQuery.path).toContain('SELECT+DefinitionId%2C+VersionNumber')
    // …and the PATCH restores the version — NOT 0.
    const patch = calls.find((c) => c.path.includes('?_HttpMethod=PATCH'))!
    expect(
      (JSON.parse(patch.body ?? '') as { Metadata: { activeVersionNumber: number } }).Metadata
        .activeVersionNumber
    ).toBe(6)
  })

  it('PARTIALLY resolved chunk bails whole to per-item — no composite for the resolved subset (REVIEW-FIX #3)', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return c.path.includes('IN+(')
          ? resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 3 }]) // 301B missing
          : resolution([
              { Id: '301A', DefinitionId: '300A', VersionNumber: 3 },
              { Id: '301B', DefinitionId: '300B', VersionNumber: 5 }
            ].filter((r) => c.path.includes(r.Id)))
      }
      if (isCompositePost(c)) throw new Error('composite must not run for a partially resolved chunk')
      if (c.method === 'GET') return ok(flowDefRecord(3))
      return { success: true, statusCode: 204 }
    })
    const done = await setFlowsActiveComposite(io, [flow('301A'), flow('301B')], true)
    expect(done.map((d) => d.id)).toEqual(['301A', '301B'])
    expect(calls.filter(isCompositePost)).toHaveLength(0)
    // BOTH items self-resolved per-item — including the one the batch query DID resolve.
    expect(calls.filter((c) => isToolingQuery(c) && !c.path.includes('IN+('))).toHaveLength(2)
  })

  it('chunks at 25 with a single resolution query', async () => {
    const flows = Array.from({ length: 26 }, (_, i) => flow(`301${String(i).padStart(3, '0')}`))
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) {
        return resolution(flows.map((f) => ({ Id: f.id, DefinitionId: `300${f.id}`, VersionNumber: 2 })))
      }
      const n = parseComposite(c.body).compositeRequest.length
      return compositeMethodOf(c) === 'GET'
        ? composite(Array.from({ length: n }, () => ({ status: 200, body: flowDefRecord(2) })))
        : composite(Array.from({ length: n }, () => ({ status: 204 })))
    })
    const done = await setFlowsActiveComposite(io, flows, true)
    expect(done).toHaveLength(26)
    expect(calls.filter(isToolingQuery)).toHaveLength(1)
    // resolution + (GET+PATCH) per chunk × 2
    expect(calls).toHaveLength(5)
    expect(parseComposite(calls[1]!.body).compositeRequest).toHaveLength(25)
  })
})

// ───────────────────────────── per-item flow toggles ────────────────────────

describe('deactivateFlow / reactivateFlow / setFlowActiveVersionFull', () => {
  it('deactivateFlow: empty query → false, nothing else called', async () => {
    const { io, calls } = makeIo(() => ok({ records: [] }))
    expect(await deactivateFlow(io, '301A')).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toContain("Id+%3D+'301A'")
  })

  it('deactivateFlow: missing DefinitionId → false', async () => {
    const { io } = makeIo(() => ok({ records: [{ Id: '301A' }] }))
    expect(await deactivateFlow(io, '301A')).toBe(false)
  })

  it('reactivateFlow: null VersionNumber → false', async () => {
    const { io } = makeIo(() => ok({ records: [{ Id: '301A', DefinitionId: '300A' }] }))
    expect(await reactivateFlow(io, '301A')).toBe(false)
  })

  it('reactivateFlow restores the 301 record’s own version', async () => {
    const { io, calls } = makeIo((c) => {
      if (isToolingQuery(c)) return resolution([{ Id: '301A', DefinitionId: '300A', VersionNumber: 6 }])
      if (c.method === 'GET') return ok(flowDefRecord(0))
      return { success: true, statusCode: 204 }
    })
    expect(await reactivateFlow(io, '301A')).toBe(true)
    const patch = calls.find((c) => c.path.includes('?_HttpMethod=PATCH'))!
    expect(patch.path).toBe(
      '/services/data/v66.0/tooling/sobjects/FlowDefinition/300A?_HttpMethod=PATCH'
    )
    expect(
      (JSON.parse(patch.body ?? '') as { Metadata: { activeVersionNumber: number } }).Metadata
        .activeVersionNumber
    ).toBe(6)
  })

  it('setFlowActiveVersionFull: GET failure → false + warn', async () => {
    const { io, logs } = makeIo(() => httpFail('gone'))
    expect(await setFlowActiveVersionFull(io, '300A', 0)).toBe(false)
    expect(logs).toEqual(['warn: FlowDef GET failed for 300A: gone'])
  })

  it('setFlowActiveVersionFull: no Metadata → false + warn', async () => {
    const { io, logs } = makeIo(() => ok({ Id: 'x' }))
    expect(await setFlowActiveVersionFull(io, '300A', 0)).toBe(false)
    expect(logs).toEqual(['warn: FlowDef 300A has no Metadata block'])
  })

  it('setFlowActiveVersionFull: short-circuits at target version', async () => {
    const { io, calls } = makeIo(() => ok(flowDefRecord(4)))
    expect(await setFlowActiveVersionFull(io, '300A', 4)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('setFlowActiveVersionFull: PATCH failure → false + warn', async () => {
    const { io, logs } = makeIo((c) => (c.method === 'GET' ? ok(flowDefRecord(0)) : httpFail('sad')))
    expect(await setFlowActiveVersionFull(io, '300A', 4)).toBe(false)
    expect(logs).toEqual(['warn: FlowDef PATCH failed for 300A: sad'])
  })
})

// ────────────────────────────── live IO adapter ─────────────────────────────

interface FakeConnCall {
  method?: string
  url?: string
  body?: string
  headers?: Record<string, string>
}

function fakeOrg(over: {
  request?: (req: FakeConnCall) => Promise<unknown>
  assertWritable?: (op: string) => void
}): { org: GuardedOrg; requests: FakeConnCall[]; ops: string[] } {
  const requests: FakeConnCall[] = []
  const ops: string[] = []
  const org = {
    alias: 't',
    role: 'target',
    conn: {
      request: async (req: FakeConnCall) => {
        requests.push(req)
        return over.request ? over.request(req) : {}
      }
    },
    assertWritable: (op: string) => {
      ops.push(op)
      over.assertWritable?.(op)
    }
  } as unknown as GuardedOrg
  return { org, requests, ops }
}

describe('makeAutomationToggleIo', () => {
  it('gates EVERY callout (reads included) through assertWritable, before the request', async () => {
    const { org, requests, ops } = fakeOrg({})
    const io = makeAutomationToggleIo(org)
    await io.callout('/services/data/v66.0/tooling/sobjects/ValidationRule/x', 'GET', null)
    expect(ops).toEqual([
      'automation toggle: GET /services/data/v66.0/tooling/sobjects/ValidationRule/x'
    ])
    expect(requests).toHaveLength(1)
  })

  it('propagates an assertWritable throw (role violation is loud, not a fallback)', async () => {
    const { org, requests } = fakeOrg({
      assertWritable: () => {
        throw new Error('Write refused')
      }
    })
    const io = makeAutomationToggleIo(org)
    await expect(io.callout('/x', 'POST', '{}')).rejects.toThrow('Write refused')
    expect(requests).toHaveLength(0)
  })

  it('resolves success:false (never rejects) on an HTTP/network error', async () => {
    const { org } = fakeOrg({
      request: async () => {
        throw new Error('ECONNRESET')
      }
    })
    const io = makeAutomationToggleIo(org)
    const res = await io.callout('/x', 'GET', null)
    expect(res).toEqual({ success: false, statusCode: 0, errorMessage: 'ECONNRESET' })
  })

  it('serializes the response body; 204/undefined becomes an empty body', async () => {
    const { org } = fakeOrg({ request: async () => undefined })
    const io = makeAutomationToggleIo(org)
    const res = await io.callout('/x', 'POST', '{}')
    expect(res).toEqual({ success: true, statusCode: 200, body: '' })
  })

  it('round-trips a real JSON response body faithfully', async () => {
    const payload = {
      records: [{ Id: '301A', DefinitionId: '300A', VersionNumber: 4 }],
      done: true
    }
    const { org } = fakeOrg({ request: async () => payload })
    const io = makeAutomationToggleIo(org)
    const res = await io.callout('/x', 'GET', null)
    expect(res.success).toBe(true)
    expect(JSON.parse(res.body ?? '')).toEqual(payload)
  })

  it('sets Content-Type only when a body is sent', async () => {
    const { org, requests } = fakeOrg({ request: async () => ({ ok: 1 }) })
    const io = makeAutomationToggleIo(org)
    await io.callout('/x', 'GET', null)
    await io.callout('/y', 'POST', '{"a":1}')
    expect(requests[0]!.headers).toBeUndefined()
    expect(requests[0]!.body).toBeUndefined()
    expect(requests[1]!.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(requests[1]!.body).toBe('{"a":1}')
  })
})
