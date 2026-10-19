import { describe, it, expect } from 'vitest'
import {
  METADATA_BATCH_MAX,
  countSaveSuccesses,
  listDuplicateRuleNames,
  deactivateDuplicateRules,
  reactivateDuplicateRules,
  disableDuplicateRule,
  restoreDuplicateRule,
  disableAllUnmanagedDuplicateRules,
  workflowRuleFullName,
  disableWorkflowRules,
  restoreWorkflowRules,
  restoreWorkflowRule,
  type MetadataToggleIo,
  type MetadataIoResult
} from '../src/main/engine/metadataToggle'
import { makeMetadataToggleIo } from '../src/main/services/metadataToggleIo'
import { ReadOnlyOrgError } from '../src/main/services/salesforce'
import type { GuardedOrg } from '../src/main/services/salesforce'

type Rec = Record<string, unknown>
type Call =
  | { op: 'list'; type: string }
  | { op: 'read'; type: string; fullNames: string[] }
  | { op: 'update'; type: string; records: Rec[] }

const okResult = (result: Rec[]): MetadataIoResult<Rec[]> => ({ success: true, result })
const failResult = (msg = 'SOAP boom'): MetadataIoResult<Rec[]> => ({
  success: false,
  errorMessage: msg
})

/** Scripted Metadata-API fake — records every call, routes to handlers. */
function makeIo(handlers: {
  list?: (type: string) => MetadataIoResult<Rec[]>
  read?: (type: string, fullNames: string[], readIndex: number) => MetadataIoResult<Rec[]>
  update?: (type: string, records: Rec[], updateIndex: number) => MetadataIoResult<Rec[]>
}): { io: MetadataToggleIo; calls: Call[]; logs: string[] } {
  const calls: Call[] = []
  const logs: string[] = []
  let reads = 0
  let updates = 0
  const io: MetadataToggleIo = {
    list: async (type) => {
      calls.push({ op: 'list', type })
      return handlers.list ? handlers.list(type) : okResult([])
    },
    read: async (type, fullNames) => {
      calls.push({ op: 'read', type, fullNames: [...fullNames] })
      return handlers.read ? handlers.read(type, [...fullNames], reads++) : okResult([])
    },
    update: async (type, records) => {
      calls.push({ op: 'update', type, records: records.map((r) => ({ ...r })) })
      return handlers.update ? handlers.update(type, [...records], updates++) : okResult([])
    },
    log: (level, message) => logs.push(`${level}: ${message}`)
  }
  return { io, calls, logs }
}

/** Read handler that echoes each requested fullName as a full rule record. */
const echoRead =
  (extra: (fullName: string) => Rec = () => ({})) =>
  (_type: string, fullNames: string[], _readIndex?: number): MetadataIoResult<Rec[]> =>
    okResult(
      fullNames.map((fn) => ({
        fullName: fn,
        isActive: true,
        actionOnInsert: 'Block',
        matchRule: { rule: `MR_${fn}` },
        ...extra(fn)
      }))
    )

/** Update handler that reports success for every record sent. */
const allSucceed = (_type: string, records: Rec[]): MetadataIoResult<Rec[]> =>
  okResult(records.map((r) => ({ fullName: r.fullName, success: true })))

const names = (n: number, prefix = 'Account.Rule_'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`)

// ─────────────────────────────── countSaveSuccesses ──────────────────────────

describe('countSaveSuccesses (DRS:192-210 parity)', () => {
  it('counts boolean true and string "true"; nothing else, never throws', () => {
    expect(
      countSaveSuccesses([
        { success: true },
        { success: 'true' },
        { success: false },
        { success: 'false' },
        { success: 'TRUE' }, // Apex getText()=='true' is case-sensitive
        {},
        { success: 1 }
      ])
    ).toBe(2)
  })

  it('empty results → 0 (DRS:200 null-response parity)', () => {
    expect(countSaveSuccesses([])).toBe(0)
  })
})

// ─────────────────────────────── listDuplicateRuleNames ──────────────────────

describe('listDuplicateRuleNames (DRS:19-62)', () => {
  it('returns unmanaged fullNames only — namespaced rules skipped (DRS:54-58)', async () => {
    const { io } = makeIo({
      list: () =>
        okResult([
          { fullName: 'Account.Mine' },
          { fullName: 'Lead.Packaged', namespacePrefix: 'SBQQ' },
          { fullName: 'Contact.AlsoMine', namespacePrefix: '' },
          { fullName: 'Case.NilPrefix', namespacePrefix: null }
        ])
    })
    expect(await listDuplicateRuleNames(io)).toEqual([
      'Account.Mine',
      'Contact.AlsoMine',
      'Case.NilPrefix'
    ])
  })

  it('skips blank/missing fullNames (DRS:53)', async () => {
    const { io } = makeIo({
      list: () => okResult([{ fullName: '' }, { fullName: '   ' }, {}, { fullName: 'Lead.Real' }])
    })
    expect(await listDuplicateRuleNames(io)).toEqual(['Lead.Real'])
  })

  it('THROWS on list failure — the one throwing path (DRS:38-40)', async () => {
    const { io } = makeIo({ list: () => failResult('INVALID_SESSION_ID') })
    await expect(listDuplicateRuleNames(io)).rejects.toThrow(
      'listMetadata failed: INVALID_SESSION_ID'
    )
  })

  it("queries metadata type 'DuplicateRule' exactly (DRS:31)", async () => {
    const { io, calls } = makeIo({ list: () => okResult([{ fullName: 'Account.A' }]) })
    await listDuplicateRuleNames(io)
    expect(calls).toEqual([{ op: 'list', type: 'DuplicateRule' }])
  })

  it('empty org → []', async () => {
    const { io } = makeIo({})
    expect(await listDuplicateRuleNames(io)).toEqual([])
  })
})

// ─────────────────────────────── batching + typed flip ───────────────────────

describe('toggleMetadataActiveFlag batching (DRS:80-113)', () => {
  it('slices 23 names into read/update batches of 10/10/3', async () => {
    const all = names(23)
    const { io, calls } = makeIo({ read: echoRead(), update: allSucceed })
    const count = await deactivateDuplicateRules(io, all)

    const reads = calls.filter((c) => c.op === 'read') as Extract<Call, { op: 'read' }>[]
    const updates = calls.filter((c) => c.op === 'update') as Extract<Call, { op: 'update' }>[]
    expect(reads.map((c) => c.fullNames.length)).toEqual([10, 10, 3])
    expect(updates.map((c) => c.records.length)).toEqual([10, 10, 3])
    expect(reads[0]!.fullNames).toEqual(all.slice(0, METADATA_BATCH_MAX))
    expect(reads[2]!.fullNames).toEqual(all.slice(20))
    // read → update strictly interleaved per batch (read i precedes update i)
    expect(calls.map((c) => c.op)).toEqual(['read', 'update', 'read', 'update', 'read', 'update'])
    // the metadata type rides every read AND update (DRS:130, :166)
    expect(reads.every((c) => c.type === 'DuplicateRule')).toBe(true)
    expect(updates.every((c) => c.type === 'DuplicateRule')).toBe(true)
    expect(count).toBe(23)
  })

  it('deactivate sets isActive=false on EVERY record — including already-inactive (string-substitution parity: same final state, same count)', async () => {
    const { io, calls } = makeIo({
      read: (_t, fullNames) =>
        okResult([
          { fullName: fullNames[0], isActive: true },
          { fullName: fullNames[1], isActive: false } // already target state
        ]),
      update: allSucceed
    })
    const count = await deactivateDuplicateRules(io, ['Account.A', 'Account.B'])
    const update = calls.find((c) => c.op === 'update') as Extract<Call, { op: 'update' }>
    expect(update.records.map((r) => r.isActive)).toEqual([false, false])
    expect(count).toBe(2) // Apex counts the already-inactive rule's update success too
  })

  it('reactivate sets isActive=true and preserves every other field byte-for-byte (full-record round-trip — updateMetadata REPLACES)', async () => {
    const rule = {
      fullName: 'Account.Deep',
      isActive: false,
      actionOnInsert: 'Allow',
      duplicateRuleMatchRules: [{ matchingRule: 'Std', objectMapping: { inputObject: 'Account' } }],
      operationsOnInsert: ['Alert', 'Report']
    }
    const { io, calls } = makeIo({ read: () => okResult([{ ...rule }]), update: allSucceed })
    await reactivateDuplicateRules(io, ['Account.Deep'])
    const update = calls.find((c) => c.op === 'update') as Extract<Call, { op: 'update' }>
    expect(update.records[0]).toEqual({ ...rule, isActive: true })
    // the RESTORE direction rides type 'DuplicateRule' too — a wrong literal
    // here would strand rules disabled with every disable test still green
    expect(calls.map((c) => c.type)).toEqual(['DuplicateRule', 'DuplicateRule'])
  })

  it('does not mutate the records the read returned (pure flip on a copy)', async () => {
    const readRecord: Rec = { fullName: 'Account.A', isActive: true }
    const { io } = makeIo({ read: () => okResult([readRecord]), update: allSucceed })
    await deactivateDuplicateRules(io, ['Account.A'])
    expect(readRecord.isActive).toBe(true)
  })

  it('empty fullNames → zero calls, count 0', async () => {
    const { io, calls } = makeIo({})
    expect(await deactivateDuplicateRules(io, [])).toBe(0)
    expect(calls).toEqual([])
  })
})

// ─────────────────────────────── silent-zero contract ────────────────────────

describe('silent-zero hazard (DRS:95-98, 105-110 — count>0 is the outcome)', () => {
  it('a failed READ skips that batch (no update call), other batches still count — never throws', async () => {
    const { io, calls, logs } = makeIo({
      read: (_t, fullNames, readIndex) =>
        readIndex === 1 ? failResult('read timeout') : echoRead()('DuplicateRule', fullNames, 0),
      update: allSucceed
    })
    const count = await deactivateDuplicateRules(io, names(23))
    expect(count).toBe(13) // 10 + 0 + 3
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(2)
    expect(logs).toContainEqual(expect.stringContaining('error: readMetadata failed'))
  })

  it('a failed UPDATE contributes 0, is logged, and later batches proceed', async () => {
    const { io, logs } = makeIo({
      read: echoRead(),
      update: (_t, records, updateIndex) =>
        updateIndex === 0 ? failResult('update refused') : allSucceed(_t, records)
    })
    const count = await deactivateDuplicateRules(io, names(12))
    expect(count).toBe(2) // batch 1 (10) fails, batch 2 (2) succeeds
    expect(logs).toContainEqual(expect.stringContaining('error: updateMetadata failed'))
  })

  it('per-component failures inside a 200 update are not counted (mixed results)', async () => {
    const { io } = makeIo({
      read: echoRead(),
      update: (_t, records) =>
        okResult(records.map((r, i) => ({ fullName: r.fullName, success: i % 2 === 0 })))
    })
    expect(await deactivateDuplicateRules(io, names(4))).toBe(2)
  })

  it('nil read records (blank fullName) are filtered; an all-nil batch skips update entirely (DRS:102/173 null-envelope parity)', async () => {
    const { io, calls } = makeIo({
      read: (_t, fullNames, readIndex) =>
        readIndex === 0
          ? okResult(fullNames.map(() => ({ $: { 'xsi:nil': 'true' } })))
          : echoRead()('DuplicateRule', fullNames, 0),
      update: allSucceed
    })
    const count = await deactivateDuplicateRules(io, names(13))
    const updates = calls.filter((c) => c.op === 'update') as Extract<Call, { op: 'update' }>[]
    expect(updates).toHaveLength(1) // batch 1 (all nil) sent no update
    expect(updates[0]!.records).toHaveLength(3)
    expect(count).toBe(3)
  })

  it('a REJECTING io call propagates through the BATCH paths — CalloutException/gate throws abort remaining batches, never degrade to silent zero (DRS:214-222 raw Http().send)', async () => {
    const io: MetadataToggleIo = {
      list: async () => okResult([]),
      read: async () => {
        throw new Error("Write refused: org 'prod_720' has role 'source'")
      },
      update: async () => okResult([])
    }
    await expect(deactivateDuplicateRules(io, ['Account.A'])).rejects.toThrow('Write refused')
  })
})

// ─────────────────────────────── per-item count>0 helpers ────────────────────

describe('per-item helpers (AutomationToggleBatch:406-416/430-445 count>0 semantics)', () => {
  it('disableDuplicateRule → true only when the update confirmed success', async () => {
    const ok = makeIo({ read: echoRead(), update: allSucceed })
    expect(await disableDuplicateRule(ok.io, 'Account.A')).toBe(true)

    const silentZero = makeIo({ read: echoRead(), update: () => failResult() })
    expect(await disableDuplicateRule(silentZero.io, 'Account.A')).toBe(false)
  })

  it('restoreDuplicateRule → false on a swallowed failure response (the watchdog-unconfirmed path)', async () => {
    const { io } = makeIo({ read: () => failResult('token expired') })
    expect(await restoreDuplicateRule(io, 'Account.A')).toBe(false)
  })

  it('restoreDuplicateRule reactivates via the same machinery', async () => {
    const { io, calls } = makeIo({ read: echoRead(() => ({ isActive: false })), update: allSucceed })
    expect(await restoreDuplicateRule(io, 'Account.A')).toBe(true)
    const update = calls.find((c) => c.op === 'update') as Extract<Call, { op: 'update' }>
    expect(update.records[0]?.isActive).toBe(true)
  })

  it('per-item helpers CATCH a thrown transport failure → false + error log (AutomationToggleBatch catch(Exception) parity :412-415)', async () => {
    const logs: string[] = []
    const io: MetadataToggleIo = {
      list: async () => okResult([]),
      read: async () => {
        throw new Error('getaddrinfo ENOTFOUND example.my.salesforce.com')
      },
      update: async () => okResult([]),
      log: (level, message) => logs.push(`${level}: ${message}`)
    }
    expect(await disableDuplicateRule(io, 'Account.A')).toBe(false)
    expect(await restoreDuplicateRule(io, 'Account.A')).toBe(false)
    expect(await restoreWorkflowRule(io, 'Opportunity.R')).toBe(false)
    expect(logs).toContainEqual(expect.stringContaining('error: Dup-rule disable failed'))
    expect(logs).toContainEqual(expect.stringContaining('error: Dup-rule restore failed'))
    expect(logs).toContainEqual(expect.stringContaining('error: Workflow-rule restore failed'))
  })

  it('per-item helpers RETHROW write-gate violations — a role bug must not read as item failure (bound to the REAL ReadOnlyOrgError name)', async () => {
    // The engine matches by e.name (it can't import the class); using the real
    // class here pins the coupling — renaming it in salesforce.ts fails this.
    const gateError = new ReadOnlyOrgError('prod_720', 'source', 'Attempted: test.')
    const io: MetadataToggleIo = {
      list: async () => okResult([]),
      read: async () => {
        throw gateError
      },
      update: async () => okResult([])
    }
    await expect(disableDuplicateRule(io, 'Account.A')).rejects.toThrow('Write refused')
  })
})

// ─────────────────────────────── org-wide disable entry point ────────────────

describe('disableAllUnmanagedDuplicateRules (DataSeederController:2623-2695)', () => {
  it('empty org → count 0, NO toggle calls, writeAhead NOT called (:2626-2628)', async () => {
    const { io, calls } = makeIo({ list: () => okResult([]) })
    let writeAheadCalled = false
    const result = await disableAllUnmanagedDuplicateRules(io, () => {
      writeAheadCalled = true
    })
    expect(result).toEqual({ attempted: [], disabledCount: 0 })
    expect(writeAheadCalled).toBe(false)
    expect(calls.filter((c) => c.op !== 'list')).toEqual([])
  })

  it('writeAhead receives ALL listed fullNames BEFORE any toggle callout (D4 write-ahead reorder) — and a clean run logs NOTHING', async () => {
    const order: string[] = []
    const { io, calls, logs } = makeIo({
      list: () => okResult([{ fullName: 'Account.A' }, { fullName: 'Lead.B' }]),
      read: (t, fns) => {
        order.push('read')
        return echoRead()(t, fns, 0)
      },
      update: allSucceed
    })
    const result = await disableAllUnmanagedDuplicateRules(io, (fullNames) => {
      order.push(`writeAhead:${fullNames.join(',')}`)
    })
    expect(order[0]).toBe('writeAhead:Account.A,Lead.B')
    expect(result).toEqual({ attempted: ['Account.A', 'Lead.B'], disabledCount: 2 })
    expect(calls.some((c) => c.op === 'update')).toBe(true)
    // the shortfall error is the ONLY engine log — full success stays silent
    expect(logs).toEqual([])
  })

  it('an ASYNC writeAhead is awaited to resolution before the first callout (crash-safety would be defeated by a dropped await)', async () => {
    const order: string[] = []
    const { io } = makeIo({
      list: () => okResult([{ fullName: 'Account.A' }]),
      read: (t, fns) => {
        order.push('read')
        return echoRead()(t, fns, 0)
      },
      update: allSucceed
    })
    await disableAllUnmanagedDuplicateRules(io, async () => {
      // resolve on a later tick — statement order alone must not pass this
      await new Promise((r) => setTimeout(r, 0))
      order.push('writeAhead-resolved')
    })
    expect(order).toEqual(['writeAhead-resolved', 'read'])
  })

  it('FAIL-CLOSED: a rejecting writeAhead aborts the disable — propagates with ZERO toggle callouts (no rules deactivated without a durable restore record)', async () => {
    const { io, calls } = makeIo({
      list: () => okResult([{ fullName: 'Account.A' }, { fullName: 'Lead.B' }]),
      read: echoRead(),
      update: allSucceed
    })
    await expect(
      disableAllUnmanagedDuplicateRules(io, async () => {
        throw new Error('sqlite disk I/O error')
      })
    ).rejects.toThrow('sqlite disk I/O error')
    expect(calls.filter((c) => c.op !== 'list')).toEqual([])
  })

  it('disables ALL unmanaged rules org-wide (managed skipped at list time) and reports the silent-zero shortfall', async () => {
    const { io, logs } = makeIo({
      list: () =>
        okResult([
          { fullName: 'Account.A' },
          { fullName: 'Lead.Managed', namespacePrefix: 'SBQQ' },
          { fullName: 'Lead.B' }
        ]),
      read: echoRead(),
      update: (_t, records) =>
        okResult(records.map((r) => ({ fullName: r.fullName, success: r.fullName === 'Account.A' })))
    })
    const result = await disableAllUnmanagedDuplicateRules(io)
    expect(result.attempted).toEqual(['Account.A', 'Lead.B'])
    expect(result.disabledCount).toBe(1)
    expect(logs).toContainEqual(
      expect.stringContaining('error: Disabled only 1/2 duplicate rules')
    )
  })

  it('propagates the listMetadata throw (DRS:38-40 via :2625)', async () => {
    const { io } = makeIo({ list: () => failResult('no metadata access') })
    await expect(disableAllUnmanagedDuplicateRules(io)).rejects.toThrow('listMetadata failed')
  })
})

// ─────────────────────────────── workflow-rule slice ─────────────────────────

describe('workflow-rule disable slice (S32 decision — desktop-only extension)', () => {
  it('workflowRuleFullName joins TableEnumOrId and Name with a dot (spaces preserved)', () => {
    expect(workflowRuleFullName({ tableEnumOrId: 'Opportunity', name: 'Notify Owner' })).toBe(
      'Opportunity.Notify Owner'
    )
  })

  it("disableWorkflowRules flips the 'active' field false via type WorkflowRule", async () => {
    const { io, calls } = makeIo({
      read: (_t, fullNames) =>
        okResult(fullNames.map((fn) => ({ fullName: fn, active: true, triggerType: 'onCreateOnly' }))),
      update: allSucceed
    })
    const count = await disableWorkflowRules(io, ['Opportunity.Notify Owner'])
    expect(count).toBe(1)
    const read = calls.find((c) => c.op === 'read') as Extract<Call, { op: 'read' }>
    const update = calls.find((c) => c.op === 'update') as Extract<Call, { op: 'update' }>
    expect(read.type).toBe('WorkflowRule')
    expect(update.type).toBe('WorkflowRule')
    expect(update.records[0]).toEqual({
      fullName: 'Opportunity.Notify Owner',
      active: false,
      triggerType: 'onCreateOnly'
    })
  })

  it('restoreWorkflowRules / restoreWorkflowRule reactivate with the same batching + count>0 contract', async () => {
    const { io, calls } = makeIo({
      read: (_t, fullNames) => okResult(fullNames.map((fn) => ({ fullName: fn, active: false }))),
      update: allSucceed
    })
    expect(await restoreWorkflowRules(io, names(12, 'Opportunity.R'))).toBe(12)
    const updates = calls.filter((c) => c.op === 'update') as Extract<Call, { op: 'update' }>[]
    expect(updates.map((c) => c.records.length)).toEqual([10, 2])
    expect(updates.every((c) => c.records.every((r) => r.active === true))).toBe(true)
    // restore direction pins its metadata type too
    expect(calls.every((c) => c.type === 'WorkflowRule')).toBe(true)

    const silent = makeIo({ read: () => failResult() })
    expect(await restoreWorkflowRule(silent.io, 'Opportunity.R0')).toBe(false)

    const okIo = makeIo({
      read: (_t, fullNames) => okResult(fullNames.map((fn) => ({ fullName: fn, active: false }))),
      update: allSucceed
    })
    expect(await restoreWorkflowRule(okIo.io, 'Opportunity.R0')).toBe(true)
  })
})

// ─────────────────────────────── live adapter ────────────────────────────────

describe('makeMetadataToggleIo adapter', () => {
  function makeOrg(opts: {
    writable?: boolean
    list?: (queries: { type: string }, apiVersion?: string) => Promise<unknown>
    read?: (type: string, fullNames: string | string[]) => Promise<unknown>
    update?: (type: string, metadata: unknown) => Promise<unknown>
  }): { org: GuardedOrg; gateOps: string[] } {
    const gateOps: string[] = []
    const org = {
      alias: 'sb1_714',
      role: opts.writable === false ? 'source' : 'target',
      conn: {
        metadata: {
          list: opts.list ?? (async () => []),
          read: opts.read ?? (async () => []),
          update: opts.update ?? (async () => [])
        }
      },
      assertWritable(operation: string) {
        gateOps.push(operation)
        if (opts.writable === false) {
          // the REAL error class — its name is what the engine's per-item
          // rethrow keys on, so the fake must not diverge from it
          throw new ReadOnlyOrgError('sb1_714', 'source', `Attempted: ${operation}.`)
        }
      }
    } as unknown as GuardedOrg
    return { org, gateOps }
  }

  it('gates EVERY call (reads included) and the gate THROWS — never resolves success:false', async () => {
    const { org } = makeOrg({ writable: false })
    const io = makeMetadataToggleIo(org)
    await expect(io.list('DuplicateRule')).rejects.toThrow('Write refused')
    await expect(io.read('DuplicateRule', ['Account.A'])).rejects.toThrow('Write refused')
    await expect(io.update('DuplicateRule', [{ fullName: 'Account.A' }])).rejects.toThrow(
      'Write refused'
    )
  })

  it('a gate violation stays loud END-TO-END: real adapter → per-item helper REJECTS (never item-failure=false)', async () => {
    const { org } = makeOrg({ writable: false })
    const io = makeMetadataToggleIo(org)
    await expect(disableDuplicateRule(io, 'Account.A')).rejects.toThrow('Write refused')
  })

  it('names the operation in the gate assertion for each method', async () => {
    const { org, gateOps } = makeOrg({})
    const io = makeMetadataToggleIo(org)
    await io.list('DuplicateRule')
    await io.read('WorkflowRule', ['Opportunity.A', 'Opportunity.B'])
    await io.update('DuplicateRule', [{ fullName: 'Account.A' }])
    expect(gateOps).toEqual([
      'metadata toggle: listMetadata DuplicateRule',
      'metadata toggle: readMetadata WorkflowRule (2)',
      'metadata toggle: updateMetadata DuplicateRule (1)'
    ])
  })

  it('RECEIVED failure responses (SOAP faults — no syscall code) RESOLVE success:false — the silent-zero contract (DRS non-200 parity)', async () => {
    const { org } = makeOrg({
      read: async () => {
        throw new Error('sf:INVALID_SESSION_ID')
      }
    })
    const io = makeMetadataToggleIo(org)
    const res = await io.read('DuplicateRule', ['Account.A'])
    expect(res).toEqual({ success: false, errorMessage: 'sf:INVALID_SESSION_ID' })
  })

  it('NO-RESPONSE transport failures RETHROW — Apex CalloutException parity (raw Http().send, DRS:214-222)', async () => {
    const syscall = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED'
    })
    const { org } = makeOrg({
      read: async () => {
        throw syscall
      },
      update: async () => {
        // undici wraps the syscall error as TypeError('fetch failed') w/ cause
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
        })
      },
      list: async () => {
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
      }
    })
    const io = makeMetadataToggleIo(org)
    await expect(io.read('DuplicateRule', ['Account.A'])).rejects.toThrow('ECONNREFUSED')
    await expect(io.update('DuplicateRule', [{ fullName: 'Account.A' }])).rejects.toThrow(
      'fetch failed'
    )
    await expect(io.list('DuplicateRule')).rejects.toThrow('timed out')
  })

  it('passes the log channel through — engine silent-zero errors reach the provided logger', async () => {
    const logs: string[] = []
    const { org } = makeOrg({
      read: async () => {
        throw new Error('sf:INSUFFICIENT_ACCESS') // fault class → resolves false
      }
    })
    const io = makeMetadataToggleIo(org, (level, message) => logs.push(`${level}: ${message}`))
    expect(await deactivateDuplicateRules(io, ['Account.A'])).toBe(0)
    expect(logs).toContainEqual(expect.stringContaining('error: readMetadata failed'))
  })

  it('normalizes jsforce one-or-many: bare single records and null both become arrays', async () => {
    const { org } = makeOrg({
      list: async () => ({ fullName: 'Account.Only', namespacePrefix: null }),
      read: async () => null
    })
    const io = makeMetadataToggleIo(org)
    expect(await io.list('DuplicateRule')).toEqual({
      success: true,
      result: [{ fullName: 'Account.Only', namespacePrefix: null }]
    })
    expect(await io.read('DuplicateRule', ['Account.Gone'])).toEqual({ success: true, result: [] })
  })

  it('passes the pinned API version to listMetadata and array-normalizes update inputs', async () => {
    let listArgs: unknown[] = []
    let updateArg: unknown = null
    const { org } = makeOrg({
      list: async (queries, apiVersion) => {
        listArgs = [queries, apiVersion]
        return []
      },
      update: async (_type, metadata) => {
        updateArg = metadata
        return { fullName: 'Account.A', success: true }
      }
    })
    const io = makeMetadataToggleIo(org)
    await io.list('DuplicateRule')
    expect(listArgs).toEqual([{ type: 'DuplicateRule' }, '66.0'])
    const res = await io.update('DuplicateRule', [{ fullName: 'Account.A' }])
    expect(Array.isArray(updateArg)).toBe(true)
    expect(res).toEqual({ success: true, result: [{ fullName: 'Account.A', success: true }] })
  })

  it('round-trips end-to-end with the engine: disable one rule through the adapter', async () => {
    const store = new Map<string, Rec>([
      ['Account.A', { fullName: 'Account.A', isActive: true, actionOnInsert: 'Block' }]
    ])
    const { org } = makeOrg({
      read: async (_t, fullNames) => {
        const fns = Array.isArray(fullNames) ? fullNames : [fullNames]
        return fns.map((fn) => ({ ...(store.get(fn) ?? { $: { 'xsi:nil': 'true' } }) }))
      },
      update: async (_t, metadata) => {
        const records = (Array.isArray(metadata) ? metadata : [metadata]) as Rec[]
        return records.map((r) => {
          store.set(String(r.fullName), { ...r })
          return { fullName: r.fullName, success: true }
        })
      }
    })
    const io = makeMetadataToggleIo(org)
    expect(await disableDuplicateRule(io, 'Account.A')).toBe(true)
    expect(store.get('Account.A')).toEqual({
      fullName: 'Account.A',
      isActive: false,
      actionOnInsert: 'Block'
    })
    expect(await restoreDuplicateRule(io, 'Account.A')).toBe(true)
    expect(store.get('Account.A')!.isActive).toBe(true)
  })
})
