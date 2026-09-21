import { describe, it, expect } from 'vitest'
import {
  makeAutomationHooks,
  restoreKey,
  itemFromLedgerRow,
  type AutomationHookDeps,
  type AutomationLedgerStore,
  type LedgerRow,
  type LedgerRowInput,
  type DriverToggleFns
} from '../src/main/engine/automation/hooks'
import type { AutomationItem } from '../src/shared/types'
import type { DeployIo } from '../src/main/engine/deploy/types'
import type { DeployPlan, FrozenObjectPlan } from '../src/main/engine/deploy/planFreeze'
import type { WorkflowRule } from '../src/main/engine/workflowRules'
import type { ActivationResult } from '../src/main/engine/cpqGuard'

// ── fixtures ─────────────────────────────────────────────────────────────────

const item = (
  automationType: AutomationItem['automationType'],
  id: string,
  name = `${automationType}_${id}`,
  extra: Partial<AutomationItem> = {}
): AutomationItem => ({
  id,
  name,
  objectName: 'Account',
  automationType,
  isActive: true,
  processType: null,
  isManagedPackage: false,
  restoreVersionNumber: null,
  ...extra
})

const planOf = (objs: Array<{ name: string; gated?: boolean }>): DeployPlan => ({
  objects: objs.map(
    (o, i) =>
      ({
        objectName: o.name,
        sortOrder: i,
        requiresTriggerBypass: o.gated ?? false
      }) as unknown as FrozenObjectPlan
  ),
  warnings: [],
  totalObjects: objs.length,
  totalRecords: 0
})

const wfr = (id: string, obj: string, name: string, active = true): WorkflowRule => ({
  id,
  name,
  tableEnumOrId: obj,
  active
})

/** In-memory AutomationLedgerStore + call trace. */
function makeLedger(seed: LedgerRow[] = []): {
  ledger: AutomationLedgerStore
  rows: Array<LedgerRow & { disabled: boolean; confirmed: boolean }>
  trace: string[]
  failWriteAhead?: () => void
} {
  const rows: Array<LedgerRow & { disabled: boolean; confirmed: boolean }> = seed.map((r) => ({
    ...r,
    disabled: false,
    confirmed: false
  }))
  const trace: string[] = []
  let nextId = seed.reduce((m, r) => Math.max(m, r.id), 0) + 1
  let writeAheadFails = false
  const ledger: AutomationLedgerStore = {
    ledgerWriteAhead(_dep, _uuid, inputs: LedgerRowInput[]) {
      trace.push('writeAhead')
      if (writeAheadFails) throw new Error('sqlite disk I/O error')
      const ids: number[] = []
      for (const input of inputs) {
        const id = nextId++
        rows.push({ id, ...input, disabledAt: null, disabled: false, confirmed: false })
        ids.push(id)
      }
      return ids
    },
    ledgerMarkDisabled(ids) {
      trace.push(`markDisabled:${ids.join(',')}`)
      for (const r of rows) if (ids.includes(r.id)) r.disabled = true
    },
    ledgerUnconfirmed() {
      trace.push('unconfirmed')
      return rows
        .filter((r) => !r.confirmed)
        .map(({ disabled: _d, confirmed: _c, ...rest }) => rest)
    },
    ledgerConfirmRestored(ids) {
      trace.push(`confirm:${ids.join(',')}`)
      for (const r of rows) if (ids.includes(r.id)) r.confirmed = true
    },
    deployedSourceIds(runId, objectApiName) {
      trace.push(`sources:${runId}:${objectApiName}`)
      // 18-char SOURCE ids — the driver derives the activation ExtIds from these.
      return ['800000000000001AAA', '800000000000002AAA']
    }
  }
  return {
    ledger,
    rows,
    trace,
    failWriteAhead: () => {
      writeAheadFails = true
    }
  }
}

interface Emitted {
  kind: string
  data: Record<string, unknown>
}

function makeIo(contractDeployed = 0): { io: DeployIo; events: Emitted[] } {
  const events: Emitted[] = []
  const io = {
    emit: (e: Emitted) => events.push(e),
    store: {
      objectCounters: () => [
        {
          runId: 1,
          objectApiName: 'Contract',
          // queried deliberately ≠ deployed: contractInScope must read
          // recordsDeployed (PDQ Records_Deployed__c > 0), never queried
          recordsQueried: contractDeployed + 1,
          recordsDeployed: contractDeployed,
          recordsFailed: 0,
          recordsFailedRoot: 0,
          recordsFailedCascade: 0,
          recordsSkipped: 0
        }
      ]
    }
  } as unknown as DeployIo
  return { io, events }
}

const logMessages = (events: Emitted[]): string[] =>
  events.filter((e) => e.kind === 'log').map((e) => `${e.data.level}: ${e.data.message}`)

/** Scripted toggle layer: every fn succeeds unless overridden; calls traced. */
function makeFns(trace: string[], overrides: Partial<DriverToggleFns> = {}): DriverToggleFns {
  const cleanActivation: ActivationResult = {
    attempted: true,
    activated: 2,
    failed: 0,
    error: null
  }
  return {
    vrComposite: async (_io, items, active) => {
      trace.push(`vr:${active}:${items.map((i) => i.id).join(',')}`)
      return [...items]
    },
    flowComposite: async (_io, items, disable) => {
      trace.push(
        `flow:${disable}:${items.map((i) => `${i.id}@${i.restoreVersionNumber}`).join(',')}`
      )
      return [...items]
    },
    triggersDetailed: async (_io, ids, bypassed) => {
      trace.push(`trig:${bypassed}:${[...ids].join(',')}`)
      return {
        changedIds: new Set(ids),
        succeededIds: new Set(ids),
        alreadyInStateIds: new Set<string>(),
        failReasons: new Map<string, string>()
      }
    },
    disableDupRule: async (_io, fullName) => {
      trace.push(`dupOff:${fullName}`)
      return true
    },
    restoreDupRule: async (_io, fullName) => {
      trace.push(`dupOn:${fullName}`)
      return true
    },
    disableWfrs: async (_io, fullNames) => {
      trace.push(`wfrOff:${fullNames.join(',')}`)
      return fullNames.length
    },
    restoreWfr: async (_io, fullName) => {
      trace.push(`wfrOn:${fullName}`)
      return true
    },
    setCpqSetting: async (_io, disabled) => {
      trace.push(`cpqSetting:${disabled}`)
      return true
    },
    readCpqSetting: async () => {
      trace.push('cpqRead')
      return false // default: currently NOT disabled → enrolled
    },
    setRdsControl: async (_io, disabled) => {
      trace.push(`guard:${disabled}`)
      return true
    },
    finalizeCallouts: async (_io, opts) => {
      trace.push(
        `finalize:cancel=${opts.isCancel}:contract=${opts.contractInScope}:ids=${opts.runExtIds === undefined ? 'undefined' : [...opts.runExtIds].sort().join(',')}`
      )
      return {
        activation: opts.isCancel || !opts.contractInScope ? null : cleanActivation,
        guardDisarmed: true,
        guardError: null
      }
    },
    ...overrides
  }
}

const seams = {
  toggleIo: {} as AutomationHookDeps['toggleIo'],
  triggerIo: {} as AutomationHookDeps['triggerIo'],
  metadataIo: {} as AutomationHookDeps['metadataIo'],
  guardIo: {} as AutomationHookDeps['guardIo']
}

function makeDeps(
  overrides: Partial<AutomationHookDeps>,
  trace: string[],
  fnOverrides: Partial<DriverToggleFns> = {}
): AutomationHookDeps {
  return {
    deploymentId: 7,
    runUuid: 'run-1',
    plan: planOf([{ name: 'Account' }]),
    items: [],
    workflowRules: [],
    workflowRulesEnabled: true,
    ledger: makeLedger().ledger,
    ...seams,
    fns: makeFns(trace, fnOverrides),
    ...overrides
  }
}

// ── restoreKey / itemFromLedgerRow ───────────────────────────────────────────

describe('restoreKey (AMS:434-436)', () => {
  it('prefers the id, falls back to the name, tolerates nulls', () => {
    expect(restoreKey('Flow', '301x', 'MyFlow')).toBe('Flow|301x')
    expect(restoreKey('DuplicateRule', null, 'Account.R')).toBe('DuplicateRule|Account.R')
    expect(restoreKey('DuplicateRule', '  ', 'Account.R')).toBe('DuplicateRule|Account.R')
    expect(restoreKey(null, null, null)).toBe('|')
  })
})

describe('itemFromLedgerRow', () => {
  it('prefers the detail JSON snapshot; falls back to columns on bad JSON', () => {
    const full = item('Flow', '301x', 'F', { restoreVersionNumber: 4, objectName: 'Case' })
    const row: LedgerRow = {
      id: 1,
      itemType: 'Flow',
      itemId: '301x',
      itemName: 'F',
      restoreVersionNumber: 4,
      detail: JSON.stringify(full),
      disabledAt: null
    }
    expect(itemFromLedgerRow(row)).toEqual(full)
    expect(itemFromLedgerRow({ ...row, detail: '{broken' }).id).toBe('301x')
    expect(itemFromLedgerRow({ ...row, detail: null }).restoreVersionNumber).toBe(4)
  })
})

// ── disableAutomation ────────────────────────────────────────────────────────

describe('disableAutomation', () => {
  it('WRITE-AHEAD strictly precedes every toggle; ledger failure aborts with ZERO toggles (D4 fail-loud)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const deps = makeDeps(
      { items: [item('ValidationRule', 'vr1')], ledger: ledgerBox.ledger },
      trace
    )
    // interleave the ledger trace with the toggle trace
    const origWriteAhead = ledgerBox.ledger.ledgerWriteAhead.bind(ledgerBox.ledger)
    ledgerBox.ledger.ledgerWriteAhead = (d, u, r) => {
      trace.push('writeAhead')
      return origWriteAhead(d, u, r)
    }
    const hooks = makeAutomationHooks(deps)
    await hooks.disableAutomation(1, makeIo().io)
    expect(trace.indexOf('writeAhead')).toBeGreaterThanOrEqual(0)
    expect(trace.indexOf('writeAhead')).toBeLessThan(trace.indexOf('vr:false:vr1'))

    const failing = makeLedger()
    failing.failWriteAhead!()
    const trace2: string[] = []
    const hooks2 = makeAutomationHooks(
      makeDeps({ items: [item('ValidationRule', 'vr1')], ledger: failing.ledger }, trace2)
    )
    await expect(hooks2.disableAutomation(1, makeIo().io)).rejects.toThrow('sqlite disk I/O error')
    expect(trace2.filter((t) => !t.startsWith('guard'))).toEqual([]) // no toggles ran
  })

  it('arms the CPQ guard ONLY when the plan has gated objects — and even with zero selected items (ADQ:57-60)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(
      makeDeps({ plan: planOf([{ name: 'SBQQ__Quote__c', gated: true }]), items: [] }, trace)
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(trace).toContain('guard:true')
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining(
        'Enabled CPQ trigger guard on target org — managed-package-gated objects in scope: SBQQ__Quote__c'
      )
    )

    const trace2: string[] = []
    const { io: io2, events: events2 } = makeIo()
    await makeAutomationHooks(makeDeps({ items: [] }, trace2)).disableAutomation(1, io2)
    expect(trace2).not.toContain('guard:true')
    expect(logMessages(events2)).toContainEqual(
      expect.stringContaining('CPQ trigger guard skipped — no managed-package-gated objects')
    )
  })

  it('a guard-arm failure logs a Warning and the disable CONTINUES (ADQ:79-82)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(
      makeDeps(
        {
          plan: planOf([{ name: 'Contract', gated: true }]),
          items: [item('ValidationRule', 'vr1')]
        },
        trace,
        {
          setRdsControl: async () => {
            throw new Error('guard exploded')
          }
        }
      )
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(logMessages(events)).toContainEqual(
      'Warning: Could not enable CPQ trigger guard: guard exploded'
    )
    expect(trace).toContain('vr:false:vr1') // toggles still ran
  })

  it('partitions by type and dispatches each mechanism (ATB:94-113)', async () => {
    const trace: string[] = []
    const items = [
      item('ValidationRule', 'vr1'),
      item('Flow', 'fl1', 'Flow_fl1', { restoreVersionNumber: 3 }),
      item('ApexTrigger', 'tr1'),
      item('DuplicateRule', 'dr1', 'Account.Dup'),
      item('CPQTriggerSetting', 'cpq1', 'SBQQ__TriggerDisabled__c')
    ]
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(makeDeps({ items, ledger: ledgerBox.ledger }, trace))
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(trace).toEqual(
      expect.arrayContaining([
        'vr:false:vr1',
        'flow:true:fl1@3',
        'trig:true:tr1',
        'dupOff:Account.Dup',
        'cpqSetting:true'
      ])
    )
    // all five recorded + marked disabled
    expect(ledgerBox.rows).toHaveLength(5)
    expect(ledgerBox.rows.every((r) => r.disabled)).toBe(true)
    expect(logMessages(events)).toContainEqual('Info: Disabled 5 automation items on target org')
  })

  it('WFR slice: relevance-scoped in the driver — out-of-plan and inactive rules never disable; fullName derived Object.Name', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps(
        {
          plan: planOf([{ name: 'Opportunity' }]),
          workflowRules: [
            wfr('w1', 'Opportunity', 'Notify Owner'),
            wfr('w2', 'Field_Trip__c', 'Irrelevant'),
            wfr('w3', 'Opportunity', 'Inactive Rule', false)
          ],
          ledger: ledgerBox.ledger
        },
        trace
      )
    )
    await hooks.disableAutomation(1, makeIo().io)
    expect(trace).toContain('wfrOff:Opportunity.Notify Owner')
    expect(trace.join('|')).not.toContain('Irrelevant')
    expect(trace.join('|')).not.toContain('Inactive')
    expect(ledgerBox.rows.map((r) => r.itemName)).toEqual(['Opportunity.Notify Owner'])
    expect(ledgerBox.rows[0]!.itemType).toBe('WorkflowRule')
  })

  it('trigger changedIds mark the ledger row disabled even when UNCONFIRMED (ATB:216-221 attempted-not-confirmed)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps(
        {
          items: [item('ApexTrigger', 'tr1'), item('ApexTrigger', 'tr2')],
          ledger: ledgerBox.ledger
        },
        trace,
        {
          triggersDetailed: async (_io, ids) => ({
            changedIds: new Set(ids), // both bodies were changed…
            succeededIds: new Set(['tr1']), // …but only tr1 confirmed
            alreadyInStateIds: new Set<string>(),
            failReasons: new Map([['tr2', 'MetadataContainer deploy did not confirm']])
          })
        }
      )
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(ledgerBox.rows.filter((r) => r.disabled)).toHaveLength(2) // over-record, never strand
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining('Disabled 1 automation items on target org (1 failed)')
    )
  })

  it('summary level escalates: all-failed → Error (ATB:315-318)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(
      makeDeps({ items: [item('DuplicateRule', 'dr1', 'Account.Dup')] }, trace, {
        disableDupRule: async () => false
      })
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining('Error: Disabled 0 automation items on target org (1 failed)')
    )
  })

  it('zero items + zero relevant WFRs → guard still evaluated, no ledger writes, "nothing selected" note', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(makeDeps({ items: [], ledger: ledgerBox.ledger }, trace))
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(ledgerBox.rows).toHaveLength(0)
    expect(logMessages(events)).toContainEqual('Info: No automation items selected for disable.')
  })
})

// ── finalize ─────────────────────────────────────────────────────────────────

describe('finalize (PDQ Phase A/B)', () => {
  it('normal completion with Contract deployed: activation runs run-scoped, then disarm; Phase-B lines emitted', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(makeDeps({}, trace))
    const { io, events } = makeIo(3)
    await hooks.finalize(1, io, 'completed')
    // S46 E1: the scope is the run's ExtIds = generateExternalId(sourceId)
    // (reverse of the 18-char id) — byte-for-byte what the transform wrote.
    expect(trace).toContain(
      'finalize:cancel=false:contract=true:ids=AAA100000000000008,AAA200000000000008'
    )
    const logs = logMessages(events)
    expect(logs).toContainEqual('Info: Contract activation: 2 activated, 0 failed')
    expect(logs).toContainEqual(
      'Info: Disabled CPQ trigger guard on target org (RDS_Deployment_Control__c)'
    )
  })

  it('cancelled: activation skipped, guard still disarmed (PDQ:100-103)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(makeDeps({}, trace))
    const { io, events } = makeIo(3)
    await hooks.finalize(1, io, 'cancelled')
    expect(trace).toContainEqual(expect.stringContaining('finalize:cancel=true'))
    expect(logMessages(events)).not.toContainEqual(expect.stringContaining('Contract activation:'))
  })

  it('no Contract rows deployed → contractInScope false (PDQ:75-87)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(makeDeps({}, trace))
    await hooks.finalize(1, makeIo(0).io, 'completed')
    expect(trace).toContainEqual(expect.stringContaining('contract=false'))
  })

  it('guard failure and activation failure surface as the exact PDQ warnings', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(
      makeDeps({}, trace, {
        finalizeCallouts: async () => ({
          activation: {
            attempted: false,
            activated: 0,
            failed: 0,
            error: 'Query failed: no token'
          },
          guardDisarmed: false,
          guardError: null
        })
      })
    )
    const { io, events } = makeIo(3)
    await hooks.finalize(1, io, 'completed')
    const logs = logMessages(events)
    expect(logs).toContainEqual('Warning: Contract activation failed: Query failed: no token')
    expect(logs).toContainEqual(
      'Warning: CPQ trigger guard NOT disabled at deploy end — flip RDS_Deployment_Control__c.Disable_CPQ_Triggers__c to false manually if needed.'
    )
  })
})

// ── restoreAutomation ────────────────────────────────────────────────────────

const row = (
  id: number,
  itemType: string,
  itemId: string | null,
  itemName: string,
  restoreVersionNumber: number | null = null,
  detail: string | null = null
): LedgerRow => ({ id, itemType, itemId, itemName, restoreVersionNumber, detail, disabledAt: null })

describe('restoreAutomation', () => {
  it('replays every unconfirmed row per type and stamps confirmation PER ITEM (§4.1)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger([
      row(1, 'ValidationRule', 'vr1', 'VR_vr1'),
      row(2, 'Flow', 'fl1', 'Flow_fl1', 5),
      row(3, 'ApexTrigger', 'tr1', 'Trg_tr1'),
      row(4, 'DuplicateRule', null, 'Account.Dup'),
      row(5, 'CPQTriggerSetting', 'cpq1', 'SBQQ__TriggerDisabled__c'),
      row(6, 'WorkflowRule', 'w1', 'Opportunity.Notify Owner')
    ])
    const hooks = makeAutomationHooks(makeDeps({ ledger: ledgerBox.ledger }, trace))
    const { io, events } = makeIo()
    await hooks.restoreAutomation(1, io, 'completed')
    expect(trace).toEqual(
      expect.arrayContaining([
        'vr:true:vr1',
        'flow:false:fl1@5', // disable-time version rides the restore
        'trig:false:tr1',
        'dupOn:Account.Dup',
        'cpqSetting:false',
        'wfrOn:Opportunity.Notify Owner'
      ])
    )
    expect(ledgerBox.rows.every((r) => r.confirmed)).toBe(true)
    expect(logMessages(events)).toContainEqual('Info: Restored 6 automation items on target org')
  })

  it('emits restore PROGRESS that announces each stage and reaches max (the tail was invisible)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger([
      row(1, 'ValidationRule', 'vr1', 'Account.VR1'),
      row(2, 'Flow', 'fl1', 'Flow_fl1'),
      row(3, 'ApexTrigger', 'tr1', 'Trg_tr1'),
      row(4, 'DuplicateRule', null, 'Account.Dup'),
      row(5, 'CPQTriggerSetting', 'cpq1', 'SBQQ__TriggerDisabled__c'),
      row(6, 'WorkflowRule', 'w1', 'Opportunity.Notify Owner')
    ])
    const hooks = makeAutomationHooks(makeDeps({ ledger: ledgerBox.ledger }, trace))
    const { io, events } = makeIo()
    await hooks.restoreAutomation(1, io, 'completed')
    const prog = events.filter((e) => e.kind === 'progress')
    expect(prog.length).toBeGreaterThan(0)
    expect(prog.every((p) => p.data.max === 6)).toBe(true)
    // Announced BEFORE the first composite runs — that await is where the run
    // sits longest, so a label that only appears afterwards shows nothing.
    expect(prog[0]!.data).toMatchObject({ value: 0, label: 'Validation rules (1)' })
    // The bar completes: restore is over when it says it is over.
    expect(prog.at(-1)!.data.value).toBe(6)
    // Monotonic — a bar that goes backwards is worse than no bar at all.
    const values = prog.map((p) => Number(p.data.value))
    expect(values).toEqual([...values].sort((a, b) => a - b))
    const labels = prog.map((p) => String(p.data.label))
    expect(labels).toContain('Flows (1)')
    expect(labels).toContain('Apex triggers (1)')
    expect(labels).toContain('Duplicate rule Account.Dup')
    expect(labels).toContain('CPQ trigger setting')
    expect(labels).toContain('Workflow rule Opportunity.Notify Owner')
  })

  it('progress still reaches max when items FAIL — a bar stalled at a failure reads as a hang', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger([
      row(1, 'DuplicateRule', null, 'Account.Good'),
      row(2, 'DuplicateRule', null, 'Account.Bad')
    ])
    const hooks = makeAutomationHooks(
      makeDeps({ ledger: ledgerBox.ledger }, trace, {
        restoreDupRule: async (_io, fullName) => fullName === 'Account.Good'
      })
    )
    const { io, events } = makeIo()
    await hooks.restoreAutomation(1, io, 'failed')
    const prog = events.filter((e) => e.kind === 'progress')
    expect(prog.at(-1)!.data).toMatchObject({ value: 2, max: 2 })
  })

  it('emits NO progress when there is nothing to restore (no phantom bar)', async () => {
    const emptyBox = makeLedger([])
    const { io, events } = makeIo()
    await makeAutomationHooks(makeDeps({ ledger: emptyBox.ledger }, [])).restoreAutomation(
      1,
      io,
      'completed'
    )
    expect(events.filter((e) => e.kind === 'progress')).toEqual([])
    expect(logMessages(events)).toContainEqual('Info: No automation to restore.')
  })

  it('a failed item stays UNCONFIRMED while others confirm; summary warns; NEVER throws (recovery-sweep work list)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger([
      row(1, 'DuplicateRule', null, 'Account.Good'),
      row(2, 'DuplicateRule', null, 'Account.Bad')
    ])
    const hooks = makeAutomationHooks(
      makeDeps({ ledger: ledgerBox.ledger }, trace, {
        restoreDupRule: async (_io, fullName) => fullName === 'Account.Good'
      })
    )
    const { io, events } = makeIo()
    await hooks.restoreAutomation(1, io, 'failed')
    expect(ledgerBox.rows.find((r) => r.itemName === 'Account.Good')!.confirmed).toBe(true)
    expect(ledgerBox.rows.find((r) => r.itemName === 'Account.Bad')!.confirmed).toBe(false)
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining(
        'Warning: Restored 1 automation items on target org (1 could not be re-enabled)'
      )
    )
  })

  it('dedupes by restoreKey — duplicate rows replay ONCE and BOTH confirm (AMS merge semantics)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger([
      row(1, 'ValidationRule', 'vr1', 'VR_vr1'),
      row(2, 'ValidationRule', 'vr1', 'VR_vr1')
    ])
    const hooks = makeAutomationHooks(makeDeps({ ledger: ledgerBox.ledger }, trace))
    await hooks.restoreAutomation(1, makeIo().io, 'completed')
    expect(trace.filter((t) => t.startsWith('vr:'))).toEqual(['vr:true:vr1'])
    expect(ledgerBox.rows.every((r) => r.confirmed)).toBe(true)
  })

  it('trigger alreadyInState counts as restored (body already clean)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger([row(1, 'ApexTrigger', 'tr1', 'Trg')])
    const hooks = makeAutomationHooks(
      makeDeps({ ledger: ledgerBox.ledger }, trace, {
        triggersDetailed: async (_io, ids) => ({
          changedIds: new Set<string>(),
          succeededIds: new Set<string>(),
          alreadyInStateIds: new Set(ids),
          failReasons: new Map<string, string>()
        })
      })
    )
    await hooks.restoreAutomation(1, makeIo().io, 'completed')
    expect(ledgerBox.rows[0]!.confirmed).toBe(true)
  })

  it('flow restore-version precedence: the ROW COLUMN beats a stale detail-JSON version; detail is the fallback when the column is null (N3 race fix)', async () => {
    const staleDetail = JSON.stringify(item('Flow', 'fl1', 'F', { restoreVersionNumber: 4 }))
    const columnWins = makeLedger([row(1, 'Flow', 'fl1', 'F', 9, staleDetail)])
    const trace1: string[] = []
    await makeAutomationHooks(makeDeps({ ledger: columnWins.ledger }, trace1)).restoreAutomation(
      1,
      makeIo().io,
      'completed'
    )
    expect(trace1).toContain('flow:false:fl1@9')

    const detailFallback = makeLedger([row(2, 'Flow', 'fl1', 'F', null, staleDetail)])
    const trace2: string[] = []
    await makeAutomationHooks(
      makeDeps({ ledger: detailFallback.ledger }, trace2)
    ).restoreAutomation(1, makeIo().io, 'completed')
    expect(trace2).toContain('flow:false:fl1@4')
  })

  it('empty ledger → "No automation to restore."; unreadable ledger THROWS (orchestrator parks Stalled)', async () => {
    const trace: string[] = []
    const emptyBox = makeLedger()
    const { io, events } = makeIo()
    await makeAutomationHooks(makeDeps({ ledger: emptyBox.ledger }, trace)).restoreAutomation(
      1,
      io,
      'completed'
    )
    expect(logMessages(events)).toContainEqual('Info: No automation to restore.')

    const broken = makeLedger()
    broken.ledger.ledgerUnconfirmed = () => {
      throw new Error('database is locked')
    }
    await expect(
      makeAutomationHooks(makeDeps({ ledger: broken.ledger }, trace)).restoreAutomation(
        1,
        makeIo().io,
        'completed'
      )
    ).rejects.toThrow('database is locked')
  })
})

// ── review-driven pins (E4A.6/5B.9 adversarial review) ──────────────────────

import { DEFAULT_FNS } from '../src/main/engine/automation/hooks'
import {
  setValidationRulesActiveComposite,
  setFlowsActiveComposite
} from '../src/main/engine/automationToggle'
import { toggleTriggersDetailed } from '../src/main/engine/triggerBodyToggle'
import {
  disableDuplicateRule,
  restoreDuplicateRule,
  disableWorkflowRules,
  restoreWorkflowRule
} from '../src/main/engine/metadataToggle'
import {
  setCpqTriggerDisabled,
  readCpqTriggerDisabled,
  setRdsDeploymentControl,
  runPostDeployFinalizeCallouts
} from '../src/main/engine/cpqGuard'

describe('DEFAULT_FNS identity pins (a typo’d default mapping must fail HERE, not live)', () => {
  it('every default maps to exactly its real engine function', () => {
    expect(DEFAULT_FNS.vrComposite).toBe(setValidationRulesActiveComposite)
    expect(DEFAULT_FNS.flowComposite).toBe(setFlowsActiveComposite)
    expect(DEFAULT_FNS.triggersDetailed).toBe(toggleTriggersDetailed)
    expect(DEFAULT_FNS.disableDupRule).toBe(disableDuplicateRule)
    expect(DEFAULT_FNS.restoreDupRule).toBe(restoreDuplicateRule)
    expect(DEFAULT_FNS.disableWfrs).toBe(disableWorkflowRules)
    expect(DEFAULT_FNS.restoreWfr).toBe(restoreWorkflowRule)
    expect(DEFAULT_FNS.setCpqSetting).toBe(setCpqTriggerDisabled)
    expect(DEFAULT_FNS.readCpqSetting).toBe(readCpqTriggerDisabled)
    expect(DEFAULT_FNS.setRdsControl).toBe(setRdsDeploymentControl)
    expect(DEFAULT_FNS.finalizeCallouts).toBe(runPostDeployFinalizeCallouts)
  })
})

describe('FINDING #18 — legacy CPQ setting restore-to-original (minimal-safe enrollment)', () => {
  const cpqItem = item('CPQTriggerSetting', 'CPQ_TRIGGER_SETTING', 'SBQQ__TriggerDisabled__c')

  it('already-true setting is NOT enrolled: no ledger row, no toggle, Info note — restore can never flip it', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps({ items: [cpqItem], ledger: ledgerBox.ledger }, trace, {
        readCpqSetting: async () => true
      })
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(ledgerBox.rows).toHaveLength(0)
    expect(trace).not.toContain('cpqSetting:true')
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining('already true on the target — left untouched (restore-to-original)')
    )
  })

  it('currently-false setting IS enrolled and disabled (restore un-disable is then correct)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps({ items: [cpqItem], ledger: ledgerBox.ledger }, trace, {
        readCpqSetting: async () => false
      })
    )
    await hooks.disableAutomation(1, makeIo().io)
    expect(trace).toContain('cpqSetting:true')
    expect(ledgerBox.rows.map((r) => r.itemType)).toEqual(['CPQTriggerSetting'])
  })

  it('unreadable setting is SKIPPED with a Warning — never guess', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps({ items: [cpqItem], ledger: ledgerBox.ledger }, trace, {
        readCpqSetting: async () => {
          throw new Error('no access')
        }
      })
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(ledgerBox.rows).toHaveLength(0)
    expect(trace).not.toContain('cpqSetting:true')
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining('Warning: Could not read SBQQ__TriggerDisabled__c')
    )
  })
})

describe('WFR per-run toggle (S32: default ON, master-gated by the caller)', () => {
  it('workflowRulesEnabled=false skips the whole slice — no query results used, no ledger rows, no toggles', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps(
        {
          plan: planOf([{ name: 'Opportunity' }]),
          workflowRules: [wfr('w1', 'Opportunity', 'Notify Owner')],
          workflowRulesEnabled: false,
          ledger: ledgerBox.ledger
        },
        trace
      )
    )
    await hooks.disableAutomation(1, makeIo().io)
    expect(trace.join('|')).not.toContain('wfrOff')
    expect(ledgerBox.rows).toHaveLength(0)
  })
})

describe('disable-side failure arms (ATB parity)', () => {
  it('progressive composite fold: VR succeeds then flow THROWS → VRs still count succeeded + marked; flows fail; ONE error detail (ATB:179-192)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps(
        {
          items: [item('ValidationRule', 'vr1'), item('Flow', 'fl1')],
          ledger: ledgerBox.ledger
        },
        trace,
        {
          flowComposite: async () => {
            throw new Error('composite exploded')
          }
        }
      )
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    const summary = logMessages(events).find((m) => m.includes('Disabled '))
    expect(summary).toContain('Disabled 1 automation items on target org (1 failed)')
    expect(summary).toContain('Composite flow/VR toggle error — composite exploded')
    const vrRow = ledgerBox.rows.find((r) => r.itemType === 'ValidationRule')!
    expect(vrRow.disabled).toBe(true) // the succeeded VR is recorded for restore
    expect(ledgerBox.rows.find((r) => r.itemType === 'Flow')!.disabled).toBe(false)
  })

  it('VR composite throw fails BOTH partitions (nothing accumulated yet)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(
      makeDeps({ items: [item('ValidationRule', 'vr1'), item('Flow', 'fl1')] }, trace, {
        vrComposite: async () => {
          throw new Error('down')
        },
        flowComposite: async () => {
          throw new Error('unreachable — single try aborts at the VR call')
        }
      })
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining('Error: Disabled 0 automation items on target org (2 failed)')
    )
  })

  it('trigger-batch THROW appends the detail WITHOUT failedCount (ATB:212-214 parity — summary stays Info)', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(
      makeDeps({ items: [item('ApexTrigger', 'tr1')] }, trace, {
        triggersDetailed: async () => {
          throw new Error('container died')
        }
      })
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    const summary = logMessages(events).find((m) => m.includes('Disabled '))!
    expect(summary).toContain('Info: Disabled 0 automation items on target org')
    expect(summary).not.toContain('failed)') // failedCount untouched — Apex parity
    expect(summary).toContain('ApexTrigger batch toggle error — container died')
  })

  it('disable-side alreadyInState triggers: counted neither way and NOT recorded for restore (ATB:219 pre-wrapped not tracked)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(
      makeDeps({ items: [item('ApexTrigger', 'tr1')], ledger: ledgerBox.ledger }, trace, {
        triggersDetailed: async (_io, ids) => ({
          changedIds: new Set<string>(),
          succeededIds: new Set(ids),
          alreadyInStateIds: new Set(ids),
          failReasons: new Map<string, string>()
        })
      })
    )
    const { io, events } = makeIo()
    await hooks.disableAutomation(1, io)
    expect(ledgerBox.rows[0]!.disabled).toBe(false)
    expect(logMessages(events)).toContainEqual(
      expect.stringContaining('Info: Disabled 0 automation items on target org')
    )
  })

  it('WFR shortfall: succeeded += count, remainder failed, ALL marked for restore, shortfall detail; WFR throw fails all + marks all', async () => {
    const rules = [wfr('w1', 'Opportunity', 'A'), wfr('w2', 'Opportunity', 'B')]
    const shortTrace: string[] = []
    const shortBox = makeLedger()
    const { io, events } = makeIo()
    await makeAutomationHooks(
      makeDeps(
        { plan: planOf([{ name: 'Opportunity' }]), workflowRules: rules, ledger: shortBox.ledger },
        shortTrace,
        { disableWfrs: async () => 1 }
      )
    ).disableAutomation(1, io)
    const summary = logMessages(events).find((m) => m.includes('Disabled '))!
    expect(summary).toContain('Disabled 1 automation items on target org (1 failed)')
    expect(summary).toContain('WorkflowRule disable shortfall — 1/2 confirmed')
    expect(shortBox.rows.every((r) => r.disabled)).toBe(true)

    const throwBox = makeLedger()
    const { io: io2, events: events2 } = makeIo()
    await makeAutomationHooks(
      makeDeps(
        { plan: planOf([{ name: 'Opportunity' }]), workflowRules: rules, ledger: throwBox.ledger },
        [],
        {
          disableWfrs: async () => {
            throw new Error('soap down')
          }
        }
      )
    ).disableAutomation(1, io2)
    expect(logMessages(events2)).toContainEqual(
      expect.stringContaining('Error: Disabled 0 automation items on target org (2 failed)')
    )
    expect(throwBox.rows.every((r) => r.disabled)).toBe(true)
  })
})

describe('finalize seam arguments (review pins)', () => {
  it('deployedSourceIds is called with (runId, "Contract") exactly, and NOT at all when Contract deployed nothing (S46 E1)', async () => {
    const trace: string[] = []
    const ledgerBox = makeLedger()
    const hooks = makeAutomationHooks(makeDeps({ ledger: ledgerBox.ledger }, trace))
    await hooks.finalize(42, makeIo(3).io, 'completed')
    expect(ledgerBox.trace).toContain('sources:42:Contract')

    const idle = makeLedger()
    await makeAutomationHooks(makeDeps({ ledger: idle.ledger }, [])).finalize(
      43,
      makeIo(0).io,
      'completed'
    )
    expect(idle.trace.some((t) => t.startsWith('sources:'))).toBe(false)
  })

  it('contractInScope reads recordsDEPLOYED — queried-but-zero-deployed skips activation', async () => {
    const trace: string[] = []
    const hooks = makeAutomationHooks(makeDeps({}, trace))
    await hooks.finalize(1, makeIo(0).io, 'completed') // queried=1, deployed=0
    expect(trace).toContainEqual(expect.stringContaining('contract=false'))
    // S46 E1 pin: the scope is ALWAYS an explicit list — undefined would fall
    // back to the org-wide Apex query (activate Draft Contracts we never wrote).
    expect(trace).not.toContainEqual(expect.stringContaining('ids=undefined'))
    expect(trace).toContainEqual(expect.stringContaining('contract=false:ids='))
  })
})
