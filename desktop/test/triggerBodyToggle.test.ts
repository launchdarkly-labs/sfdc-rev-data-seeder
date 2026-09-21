import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BEGIN_MARKER,
  END_MARKER,
  ESCAPED_CLOSE,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  TriggerBodyToggleError,
  commentOutBody,
  uncommentBody,
  isGuardTriggerName,
  fetchBodies,
  setTriggerBypassedDetailed,
  setTriggerBypassed,
  toggleTriggersDetailed,
  disableTriggers,
  restoreTriggers,
  restoreAllOrphanedTriggers,
  deployBodiesWithFallback,
  type TriggerToggleIo
} from '../src/main/engine/triggerBodyToggle'
import type { ToggleCalloutResult } from '../src/main/engine/automationToggle'
import { makeTriggerToggleIo } from '../src/main/services/automationToggleIo'
import type { GuardedOrg } from '../src/main/services/salesforce'

// ─────────────────────────────── golden transforms ──────────────────────────

// The canonical fixture from ApexTriggerBodyToggleCoverageTest (plainBodyJson /
// wrappedBodyJson) — the wrap output below is exactly what the Apex produces.
const PLAIN = 'trigger T on Account (before insert) { System.debug(1); }'
const WRAPPED =
  'trigger T on Account (before insert) {' + BEGIN_MARKER + ' System.debug(1); ' + END_MARKER + '}'

describe('commentOutBody / uncommentBody (golden)', () => {
  it('wraps the canonical body byte-exactly (Apex coverage-test fixture)', () => {
    expect(commentOutBody(PLAIN)).toBe(WRAPPED)
  })

  it('unwraps back to the original bytes', () => {
    expect(uncommentBody(WRAPPED)).toBe(PLAIN)
  })

  it('escapes EVERY nested */ (Apex String.replace is replace-ALL)', () => {
    const body =
      'trigger T on Account (before insert) {\n' +
      '  /* first comment */\n' +
      '  System.debug(1);\n' +
      '  /* second comment */\n' +
      '}'
    const wrapped = commentOutBody(body)
    // No raw '*/' may survive between the markers (it would close the wrapper early).
    const inner = wrapped.substring(
      wrapped.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length,
      wrapped.indexOf(END_MARKER)
    )
    expect(inner).not.toContain('*/')
    expect(inner.split(ESCAPED_CLOSE)).toHaveLength(3) // both */ escaped
    // Round-trip restores the original byte-perfectly.
    expect(uncommentBody(wrapped)).toBe(body)
  })

  it('is idempotent in both directions', () => {
    expect(commentOutBody(WRAPPED)).toBe(WRAPPED)
    expect(uncommentBody(PLAIN)).toBe(PLAIN)
  })

  it('throws on missing/reversed braces', () => {
    expect(() => commentOutBody('trigger T on Account before insert')).toThrow(
      'Could not locate trigger body braces'
    )
    expect(() => commentOutBody('} weird {')).toThrow(TriggerBodyToggleError)
  })

  it('refuses a body already containing the escape token', () => {
    const body = `trigger T on Account (before insert) {\n  String s = '${ESCAPED_CLOSE}';\n}`
    expect(() => commentOutBody(body)).toThrow('RDS escape token')
  })

  it('idempotency check fires BEFORE the escape-token refusal (order pin)', () => {
    // A wrapped body containing */ was escaped at wrap time, so it holds
    // ESCAPED_CLOSE — re-wrapping must return it unchanged, not throw.
    const wrapped = commentOutBody('trigger T on Account (before insert) { /* c */ }')
    expect(wrapped).toContain(ESCAPED_CLOSE)
    expect(commentOutBody(wrapped)).toBe(wrapped)
  })

  it('uncommentBody leaves out-of-order or missing markers unchanged', () => {
    const endFirst = `{${END_MARKER} x ${BEGIN_MARKER}}`
    expect(uncommentBody(endFirst)).toBe(endFirst)
    const onlyBegin = `{${BEGIN_MARKER} x}`
    expect(uncommentBody(onlyBegin)).toBe(onlyBegin)
  })

  it('idempotency/escape checks scan ONLY the brace substring (Apex scope pin)', () => {
    // A marker in a LEADING comment (before the first '{') is outside
    // bodyContent — Apex wraps anyway; so must we.
    const leadingMarker = `/* ${BEGIN_MARKER} note ${END_MARKER.slice(0, -2)} */ trigger T on A (x) { code(); }`
    const wrapped = commentOutBody(leadingMarker)
    expect(wrapped).not.toBe(leadingMarker)
    expect(wrapped).toContain(`{${BEGIN_MARKER} code(); ${END_MARKER}}`)
    // The escape token OUTSIDE the braces must not trigger the refusal.
    const leadingEscape = `// ${ESCAPED_CLOSE}\ntrigger T on A (x) { code(); }`
    expect(() => commentOutBody(leadingEscape)).not.toThrow()
  })

  it('round-trips EVERY repo trigger byte-perfectly (Apex corpus golden)', () => {
    // Vendored corpus (test/fixtures/apex-triggers/) — the 5 RDS_*_CpqGuard triggers
    // copied from the frozen Apex repo. Was `join(__dirname, '..', '..', 'force-app', ...)`
    // until the desktop app moved to its own repo (2026-09-07).
    const dir = join(__dirname, 'fixtures', 'apex-triggers')
    const files = readdirSync(dir).filter((f) => f.endsWith('.trigger'))
    expect(files.length).toBeGreaterThanOrEqual(5) // the 5 RDS_*_CpqGuard triggers
    for (const f of files) {
      const original = readFileSync(join(dir, f), 'utf8')
      const wrapped = commentOutBody(original)
      expect(wrapped).not.toBe(original)
      expect(uncommentBody(wrapped)).toBe(original) // byte-identity
      expect(commentOutBody(wrapped)).toBe(wrapped) // wrap idempotency
    }
  })
})

describe('isGuardTriggerName', () => {
  it('matches RDS_*_CpqGuard case-sensitively, null-safe', () => {
    expect(isGuardTriggerName('RDS_Contract_CpqGuard')).toBe(true)
    expect(isGuardTriggerName('rds_Contract_CpqGuard')).toBe(false)
    expect(isGuardTriggerName('RDS_Contract_cpqguard')).toBe(false)
    expect(isGuardTriggerName('AccountTrigger')).toBe(false)
    expect(isGuardTriggerName(null)).toBe(false)
  })
})

// ─────────────────────────────── pipeline harness ───────────────────────────

type Call = { path: string; method: string; body: string | null }

function makeIo(handler: (call: Call, index: number) => ToggleCalloutResult): {
  io: TriggerToggleIo
  calls: Call[]
  logs: string[]
  sleeps: number[]
} {
  const calls: Call[] = []
  const logs: string[] = []
  const sleeps: number[] = []
  const io: TriggerToggleIo = {
    callout: async (path, method, body) => {
      const call = { path, method, body }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    now: () => new Date(1722500000000)
  }
  return { io, calls, logs, sleeps }
}

const ok = (body: unknown): ToggleCalloutResult => ({
  success: true,
  statusCode: 200,
  body: JSON.stringify(body)
})
const httpFail = (msg = 'boom'): ToggleCalloutResult => ({
  success: false,
  statusCode: 0,
  errorMessage: msg
})

const isTriggerQuery = (c: Call): boolean =>
  c.method === 'GET' && c.path.includes('FROM+ApexTrigger')
const isCarPoll = (c: Call): boolean =>
  c.method === 'GET' && c.path.includes('FROM+ContainerAsyncRequest')
const isContainerCreate = (c: Call): boolean =>
  c.method === 'POST' && c.path.endsWith('/tooling/sobjects/MetadataContainer/')
const isMemberAdd = (c: Call): boolean =>
  c.method === 'POST' && c.path.endsWith('/tooling/sobjects/ApexTriggerMember/')
const isCarCreate = (c: Call): boolean =>
  c.method === 'POST' && c.path.endsWith('/tooling/sobjects/ContainerAsyncRequest/')
const isDelete = (c: Call): boolean => c.method === 'DELETE'

const triggerRecords = (
  rows: Array<{ Id: string; Name?: string; Body: string | null }>
): ToggleCalloutResult => ok({ totalSize: rows.length, done: true, records: rows })

const carState = (state: string, extra: Record<string, unknown> = {}): ToggleCalloutResult =>
  ok({ records: [{ State: state, ErrorMsg: null, DeployDetails: null, ...extra }] })

const created = (id: string): ToggleCalloutResult => ok({ id, success: true })

/** Happy-path handler: plain body, everything succeeds, poll → Completed. */
function happyHandler(bodyById: Record<string, string | null>) {
  return (c: Call): ToggleCalloutResult => {
    if (isTriggerQuery(c)) {
      return triggerRecords(
        Object.entries(bodyById).map(([Id, Body]) => ({ Id, Body }))
      )
    }
    if (isCarPoll(c)) return carState('Completed')
    if (isContainerCreate(c)) return created('1dc000000000001')
    if (isMemberAdd(c)) return created('1dm000000000001')
    if (isCarCreate(c)) return created('1dr000000000001')
    if (isDelete(c)) return { success: true, statusCode: 200, body: '' }
    return ok({ records: [] })
  }
}

// ───────────────────────────── toggleTriggersDetailed ───────────────────────

describe('toggleTriggersDetailed', () => {
  it('happy path: fetch → wrap → container/member/CAR → poll Completed → cleanup', async () => {
    const { io, calls } = makeIo(happyHandler({ '01qA': PLAIN }))
    const r = await toggleTriggersDetailed(io, ['01qA'], true)
    expect([...r.changedIds]).toEqual(['01qA'])
    expect([...r.succeededIds]).toEqual(['01qA'])
    expect(r.alreadyInStateIds.size).toBe(0)
    expect(r.failReasons.size).toBe(0)

    // The exact callout sequence.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'GET', 'DELETE'])
    expect(calls[0]!.path).toContain("Id+IN+('01qA')")
    // Container name = 'RDS_Bypass_' + injected epoch millis.
    expect(JSON.parse(calls[1]!.body ?? '')).toEqual({ Name: 'RDS_Bypass_1722500000000' })
    // Member payload carries the container id + the WRAPPED body, key order fixed.
    expect(calls[2]!.body).toBe(
      JSON.stringify({
        MetadataContainerId: '1dc000000000001',
        ContentEntityId: '01qA',
        Body: WRAPPED
      })
    )
    expect(JSON.parse(calls[3]!.body ?? '')).toEqual({
      MetadataContainerId: '1dc000000000001',
      IsCheckOnly: false
    })
    expect(calls[4]!.path).toContain("FROM+ContainerAsyncRequest+WHERE+Id+%3D+'1dr000000000001'")
    expect(calls[5]!.path).toBe(
      '/services/data/v66.0/tooling/sobjects/MetadataContainer/1dc000000000001'
    )
  })

  it('already-wrapped body → alreadyInState, no deploy callouts', async () => {
    const { io, calls } = makeIo(happyHandler({ '01qA': WRAPPED }))
    const r = await toggleTriggersDetailed(io, ['01qA'], true)
    expect([...r.alreadyInStateIds]).toEqual(['01qA'])
    expect(r.changedIds.size).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('missing body → failReasons "trigger body not found"', async () => {
    const { io } = makeIo(happyHandler({}))
    const r = await toggleTriggersDetailed(io, ['01qA'], true)
    expect(r.failReasons.get('01qA')).toBe('trigger body not found')
    expect(r.changedIds.size).toBe(0)
  })

  it('fetch failure → every id gets "body fetch failed: …"', async () => {
    const { io } = makeIo(() => httpFail('down'))
    const r = await toggleTriggersDetailed(io, ['01qA', '01qB'], true)
    expect(r.failReasons.get('01qA')).toBe(
      'body fetch failed: Failed to fetch trigger bodies: down'
    )
    expect(r.failReasons.get('01qB')).toBe(
      'body fetch failed: Failed to fetch trigger bodies: down'
    )
  })

  it('restore polarity: wrapped body + bypassed=false unwraps and deploys the ORIGINAL', async () => {
    const { io, calls } = makeIo(happyHandler({ '01qA': WRAPPED }))
    const r = await toggleTriggersDetailed(io, ['01qA'], false)
    expect([...r.succeededIds]).toEqual(['01qA'])
    const member = calls.find(isMemberAdd)!
    expect((JSON.parse(member.body ?? '') as { Body: string }).Body).toBe(PLAIN)
  })
})

// ─────────────────────── deterministic confirm (no optimism) ─────────────────

describe('deployContainer confirm semantics', () => {
  it('Failed state + verify refetch showing the NEW body → confirmed via verify', async () => {
    const { io, logs } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        // First fetch returns the plain body; the verify refetch returns the
        // WRAPPED body (the deploy actually landed despite the Failed state).
        return triggerRecords([{ Id: '01qA', Body: WRAPPED }])
      }
      if (isCarPoll(c)) {
        return carState('Failed', {
          ErrorMsg: 'compile failure',
          DeployDetails: {
            componentFailures: [{ fullName: 'AccountTrig', problem: 'Unexpected token', lineNumber: 3 }]
          }
        })
      }
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(io, new Map([['01qA', WRAPPED]]))
    expect([...okSet]).toEqual(['01qA'])
    // extractFailureReason surfaced the compile problem (null-concat parity elsewhere).
    expect(logs.some((l) => l.includes('AccountTrig line 3: Unexpected token'))).toBe(true)
  })

  it('Failed state + verify showing the OLD body → NOT confirmed → per-item retry also fails → failReason', async () => {
    const { io } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isCarPoll(c)) return carState('Failed')
      return happyHandler({})(c)
    })
    const r = await toggleTriggersDetailed(io, ['01qA'], true)
    expect(r.succeededIds.size).toBe(0)
    expect([...r.changedIds]).toEqual(['01qA']) // attempted — still recorded for restore
    expect(r.failReasons.get('01qA')).toBe('MetadataContainer deploy did not confirm')
  })

  it('NO optimistic count: a never-terminal poll times out, sleeps deterministically, then verifies', async () => {
    let verifies = 0
    const { io, sleeps } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        verifies++
        // fetch #1 = the toggle read (plain); later fetches = verify refetch (still plain).
        return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      }
      if (isCarPoll(c)) return carState('InProgress') // never terminal
      return happyHandler({})(c)
    })
    const r = await toggleTriggersDetailed(io, ['01qA'], true)
    // Timeout → verify (old body) → single-item isolation retry → Timeout → verify again → not confirmed.
    expect(r.succeededIds.size).toBe(0)
    expect(r.failReasons.get('01qA')).toBe('MetadataContainer deploy did not confirm')
    // Two full poll budgets (batch container + isolation retry), real pacing each.
    expect(sleeps).toHaveLength(2 * MAX_POLL_ATTEMPTS)
    expect(sleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true)
    expect(verifies).toBe(3) // toggle read + 2 verify refetches
  })

  it('poll callout failure → Unknown immediately (no sleep) → verify decides', async () => {
    const { io, sleeps } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: WRAPPED }])
      if (isCarPoll(c)) return httpFail('poll down')
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(io, new Map([['01qA', WRAPPED]]))
    expect([...okSet]).toEqual(['01qA']) // verify saw the wrapped body
    expect(sleeps).toHaveLength(0)
  })

  it('Invalidated and Aborted are TERMINAL: no sleep, state warn logged, verify decides', async () => {
    for (const state of ['Invalidated', 'Aborted']) {
      const { io, sleeps, logs } = makeIo((c) => {
        if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
        if (isCarPoll(c)) return carState(state)
        return happyHandler({})(c)
      })
      const okSet = await deployBodiesWithFallback(io, new Map([['01qA', WRAPPED]]))
      expect(okSet.size).toBe(0)
      expect(sleeps).toHaveLength(0) // terminal on the FIRST poll — never spins to Timeout
      expect(logs.some((l) => l.includes(`state=${state}`))).toBe(true)
    }
  })

  it('state and body comparisons are case-INSENSITIVE (Apex String ==)', async () => {
    // Poll returns 'completed' lowercase → still the Completed branch (all count).
    const { io: lcIo, calls: lcCalls } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isCarPoll(c)) return carState('completed')
      return happyHandler({})(c)
    })
    const lcOk = await deployBodiesWithFallback(lcIo, new Map([['01qA', WRAPPED]]))
    expect([...lcOk]).toEqual(['01qA'])
    expect(lcCalls.filter(isTriggerQuery)).toHaveLength(0) // no verify refetch needed

    // Verify compare: refetched body differs ONLY in case → still confirmed.
    const { io: vIo } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: WRAPPED.toUpperCase() }])
      if (isCarPoll(c)) return carState('Failed')
      return happyHandler({})(c)
    })
    const vOk = await deployBodiesWithFallback(vIo, new Map([['01qA', WRAPPED]]))
    expect([...vOk]).toEqual(['01qA'])
  })

  it('a Completed multi-member container confirms EVERY member in one container', async () => {
    let containers = 0
    const { io, calls } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([])
      if (isContainerCreate(c)) {
        containers++
        return created('1dc000000000001')
      }
      if (isCarPoll(c)) return carState('Completed')
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(
      io,
      new Map([
        ['01qA', 'WA'],
        ['01qB', 'WB']
      ])
    )
    expect([...okSet].sort()).toEqual(['01qA', '01qB'])
    expect(containers).toBe(1) // no isolation retry may be needed to heal a partial confirm
    expect(calls.filter(isTriggerQuery)).toHaveLength(0)
  })

  it('empty poll records → Unknown → verify decides', async () => {
    const { io } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isCarPoll(c)) return ok({ records: [] })
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(io, new Map([['01qA', WRAPPED]]))
    expect(okSet.size).toBe(0)
  })
})

// ───────────────────────── isolation retry + failure paths ──────────────────

describe('deployBodiesWithFallback isolation retry', () => {
  it('retries EVERY unconfirmed member individually (no callout-budget guard)', async () => {
    let containers = 0
    const { io, calls } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        // Verify refetches: A landed, B and C did not (first container);
        // the per-item retries then poll to Completed so no more verifies.
        return triggerRecords([
          { Id: '01qA', Body: 'WA' },
          { Id: '01qB', Body: PLAIN },
          { Id: '01qC', Body: PLAIN }
        ])
      }
      if (isContainerCreate(c)) {
        containers++
        return created(`1dc00000000000${containers}`)
      }
      if (isCarPoll(c)) return containers === 1 ? carState('Failed') : carState('Completed')
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(
      io,
      new Map([
        ['01qA', 'WA'],
        ['01qB', 'WB'],
        ['01qC', 'WC']
      ])
    )
    expect([...okSet].sort()).toEqual(['01qA', '01qB', '01qC'])
    expect(containers).toBe(3) // batch + one isolation container per unconfirmed member
    const memberBodies = calls.filter(isMemberAdd).map((c) => (JSON.parse(c.body ?? '') as { ContentEntityId: string }).ContentEntityId)
    expect(memberBodies).toEqual(['01qA', '01qB', '01qC', '01qB', '01qC'])
  })

  it('container create failure → empty result, no members/CAR/DELETE', async () => {
    const { io, calls, logs } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isContainerCreate(c)) return httpFail('no container')
      return happyHandler({})(c)
    })
    const r = await toggleTriggersDetailed(io, ['01qA'], true)
    expect(r.succeededIds.size).toBe(0)
    // Two failed container creates (batch + isolation retry), nothing else after each.
    expect(calls.filter(isMemberAdd)).toHaveLength(0)
    expect(calls.filter(isCarCreate)).toHaveLength(0)
    expect(calls.filter(isDelete)).toHaveLength(0)
    expect(logs.some((l) => l.includes('MetadataContainer create failed'))).toBe(true)
  })

  it('a failed member add WARNs but the container still submits (Apex behavior)', async () => {
    const { io, calls, logs } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: WRAPPED }])
      if (isMemberAdd(c)) return httpFail('member rejected')
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(io, new Map([['01qA', WRAPPED]]))
    expect([...okSet]).toEqual(['01qA']) // poll Completed counts the container's keys
    expect(logs.some((l) => l.includes('ApexTriggerMember add failed for 01qA'))).toBe(true)
    expect(calls.filter(isCarCreate)).toHaveLength(1)
  })

  it('CAR create failure → bail, container still DELETEd (finally)', async () => {
    const { io, calls } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isCarCreate(c)) return httpFail('CAR rejected')
      return happyHandler({})(c)
    })
    const okSet = await deployBodiesWithFallback(io, new Map([['01qA', 'X {y}']]))
    expect(okSet.size).toBe(0)
    // Both containers (batch + isolation retry) were cleaned up.
    expect(calls.filter(isDelete)).toHaveLength(2)
  })

  it('a verify-refetch throw propagates AFTER the finally deletes the container', async () => {
    let fetches = 0
    const { io, calls } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        fetches++
        if (fetches === 1) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
        return httpFail('verify down') // fetchBodies throws inside deployContainer
      }
      if (isCarPoll(c)) return carState('Failed')
      return happyHandler({})(c)
    })
    await expect(toggleTriggersDetailed(io, ['01qA'], true)).rejects.toThrow(
      'Failed to fetch trigger bodies: verify down'
    )
    expect(calls.filter(isDelete)).toHaveLength(1)
  })
})

// ─────────────────────────── single-item + count APIs ───────────────────────

describe('setTriggerBypassedDetailed / setTriggerBypassed', () => {
  it('happy path: success, not alreadyInState', async () => {
    const { io } = makeIo(happyHandler({ '01qA': PLAIN }))
    const r = await setTriggerBypassedDetailed(io, '01qA', true)
    expect(r).toEqual({ success: true, alreadyInState: false, errorReason: null })
    expect(await setTriggerBypassed(makeIo(happyHandler({ '01qA': PLAIN })).io, '01qA', true)).toBe(true)
  })

  it('fetch failure → "Could not fetch trigger body: …"', async () => {
    const { io } = makeIo(() => httpFail('down'))
    const r = await setTriggerBypassedDetailed(io, '01qA', true)
    expect(r.success).toBe(false)
    expect(r.errorReason).toBe(
      'Could not fetch trigger body: Failed to fetch trigger bodies: down'
    )
  })

  it('body not found → sentinel message', async () => {
    const { io } = makeIo(happyHandler({}))
    const r = await setTriggerBypassedDetailed(io, '01qA', true)
    expect(r).toEqual({ success: false, alreadyInState: false, errorReason: 'Trigger body not found' })
  })

  it('already in state → success without deploy', async () => {
    const { io, calls } = makeIo(happyHandler({ '01qA': WRAPPED }))
    const r = await setTriggerBypassedDetailed(io, '01qA', true)
    expect(r).toEqual({ success: true, alreadyInState: true, errorReason: null })
    expect(calls).toHaveLength(1)
  })

  it('unconfirmed deploy → the Apex poll-budget message (verbatim)', async () => {
    const { io } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isCarPoll(c)) return carState('Aborted')
      return happyHandler({})(c)
    })
    const r = await setTriggerBypassedDetailed(io, '01qA', true)
    expect(r.success).toBe(false)
    expect(r.errorReason).toBe('MetadataContainer deploy did not complete in poll budget')
  })
})

describe('disableTriggers / restoreTriggers counts', () => {
  it('all already wrapped → 0 without a deploy', async () => {
    const { io, calls } = makeIo(happyHandler({ '01qA': WRAPPED }))
    expect(await disableTriggers(io, ['01qA'])).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('unknown id skipped → 0', async () => {
    const { io } = makeIo(happyHandler({}))
    expect(await disableTriggers(io, ['01q99'])).toBe(0)
  })

  it('empty input → 0 with no callouts', async () => {
    const { io, calls } = makeIo(() => httpFail())
    expect(await disableTriggers(io, [])).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('fetch failure THROWS (strict path)', async () => {
    const { io } = makeIo(() => httpFail('down'))
    await expect(disableTriggers(io, ['01qA'])).rejects.toThrow(TriggerBodyToggleError)
  })

  it('restoreTriggers unwraps a wrapped body and counts it', async () => {
    const { io, calls } = makeIo(happyHandler({ '01qA': WRAPPED }))
    expect(await restoreTriggers(io, ['01qA'])).toBe(1)
    const member = calls.find(isMemberAdd)!
    expect((JSON.parse(member.body ?? '') as { Body: string }).Body).toBe(PLAIN)
  })

  it('counts are CONFIRMED, not attempted: an unconfirmed deploy yields 0', async () => {
    // Poll → Failed, verify refetch shows the OLD body (deploy never landed).
    const { io } = makeIo((c) => {
      if (isTriggerQuery(c)) return triggerRecords([{ Id: '01qA', Body: PLAIN }])
      if (isCarPoll(c)) return carState('Failed')
      return happyHandler({})(c)
    })
    expect(await disableTriggers(io, ['01qA'])).toBe(0)
  })
})

// ─────────────────────────── orphan scan / restore ──────────────────────────

describe('restoreAllOrphanedTriggers', () => {
  const scanRows = [
    { Id: '01q001', Name: 'AccountTrigger', Body: WRAPPED },
    { Id: '01q002', Name: 'RDS_Contract_CpqGuard', Body: WRAPPED },
    { Id: '01q003', Name: 'PlainTrigger', Body: PLAIN }
  ]

  it('restores the non-guard orphan, skips the guard, ignores plain (Apex-test parity)', async () => {
    const { io, calls } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        // Scan query first; the deploy path never refetches (poll → Completed).
        return c.path.includes('NamespacePrefix+%3D+null')
          ? triggerRecords(scanRows)
          : triggerRecords([])
      }
      return happyHandler({})(c)
    })
    const r = await restoreAllOrphanedTriggers(io)
    expect(r.scanned).toBe(3)
    expect(r.orphaned).toBe(2)
    expect(r.skippedGuards).toEqual(['RDS_Contract_CpqGuard'])
    expect(r.restoredNames).toEqual(['AccountTrigger'])
    expect(r.restored).toBe(1)
    expect(r.error).toBeNull()
    // The exact scan query.
    const scan = calls[0]!
    expect(scan.path).toContain('SELECT+Id%2C+Name%2C+Body+FROM+ApexTrigger+WHERE+NamespacePrefix+%3D+null')
    // The deployed body is the clean original.
    const member = calls.find(isMemberAdd)!
    expect(JSON.parse(member.body ?? '')).toMatchObject({ ContentEntityId: '01q001', Body: PLAIN })
  })

  it('scan query failure → error, nothing restored', async () => {
    const { io } = makeIo(() => httpFail('scan down'))
    const r = await restoreAllOrphanedTriggers(io)
    expect(r.error).toBe('Orphan scan query failed: scan down')
    expect(r.restored).toBe(0)
  })

  it('a mid-deploy throw is caught into error (Apex catch-all)', async () => {
    const { io } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        return c.path.includes('NamespacePrefix')
          ? triggerRecords(scanRows)
          : httpFail('verify down')
      }
      if (isCarPoll(c)) return carState('Failed') // forces the verify refetch → throw
      return happyHandler({})(c)
    })
    const r = await restoreAllOrphanedTriggers(io)
    expect(r.error).toBe('Orphan restore error: Failed to fetch trigger bodies: verify down')
  })

  it('restored counts only CONFIRMED deploys; restoredNames still lists the attempt (Apex order)', async () => {
    const { io } = makeIo((c) => {
      if (isTriggerQuery(c)) {
        // Scan finds the wrapped orphan; the verify refetch shows it STILL wrapped.
        return triggerRecords([{ Id: '01q001', Name: 'AccountTrigger', Body: WRAPPED }])
      }
      if (isCarPoll(c)) return carState('Failed')
      return happyHandler({})(c)
    })
    const r = await restoreAllOrphanedTriggers(io)
    expect(r.restoredNames).toEqual(['AccountTrigger']) // recorded BEFORE the deploy (ATBTS:116)
    expect(r.restored).toBe(0) // but never counted — deploy did not confirm
    expect(r.error).toBeNull()
  })

  it('missing records key → clean empty result (Apex returns silently)', async () => {
    const { io } = makeIo(() => ok({ done: true }))
    const r = await restoreAllOrphanedTriggers(io)
    expect(r).toEqual({
      scanned: 0,
      orphaned: 0,
      restored: 0,
      restoredNames: [],
      skippedGuards: [],
      error: null
    })
  })
})

// ─────────────────────────────── fetchBodies ────────────────────────────────

describe('fetchBodies', () => {
  it('builds the quoted IN query and maps Id→Body (null Body preserved)', async () => {
    const { io, calls } = makeIo(() =>
      triggerRecords([
        { Id: '01qA', Body: 'x' },
        { Id: '01qB', Body: null }
      ])
    )
    const m = await fetchBodies(io, ['01qA', '01qB'])
    expect(calls[0]!.path).toContain("Id+IN+('01qA'%2C'01qB')")
    expect(m.get('01qA')).toBe('x')
    expect(m.get('01qB')).toBeNull()
  })

  it('throws with the Apex message on query failure', async () => {
    const { io } = makeIo(() => httpFail('nope'))
    await expect(fetchBodies(io, ['01qA'])).rejects.toThrow('Failed to fetch trigger bodies: nope')
  })
})

// ─────────────────────────────── live adapter ───────────────────────────────

describe('makeTriggerToggleIo', () => {
  function fakeOrg(): { org: GuardedOrg; requests: Array<Record<string, unknown>> } {
    const requests: Array<Record<string, unknown>> = []
    const org = {
      alias: 't',
      role: 'target',
      conn: {
        request: async (req: Record<string, unknown>) => {
          requests.push(req)
          return {}
        }
      },
      assertWritable: () => {}
    } as unknown as GuardedOrg
    return { org, requests }
  }

  it('passes DELETE through the guarded callout', async () => {
    const { org, requests } = fakeOrg()
    const io = makeTriggerToggleIo(org)
    const res = await io.callout('/services/data/v66.0/tooling/sobjects/MetadataContainer/x', 'DELETE', null)
    expect(res.success).toBe(true)
    expect(requests[0]!.method).toBe('DELETE')
  })

  it('uses injected sleep/now fakes; provides real defaults otherwise', async () => {
    const { org } = fakeOrg()
    const slept: number[] = []
    const io = makeTriggerToggleIo(org, undefined, {
      sleep: async (ms) => {
        slept.push(ms)
      },
      now: () => new Date(42)
    })
    await io.sleep(7)
    expect(slept).toEqual([7])
    expect(io.now().getTime()).toBe(42)
    const real = makeTriggerToggleIo(org)
    expect(typeof real.now().getTime()).toBe('number')
    await real.sleep(1) // resolves without hanging
  })
})
