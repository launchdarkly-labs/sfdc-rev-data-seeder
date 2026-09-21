import { describe, it, expect } from 'vitest'
import {
  discoverAutomation,
  queryValidationRules,
  queryFlows,
  discoverySummaryLines,
  queryTriggers,
  queryDuplicateRules,
  type AutomationDiscoveryIo
} from '../src/main/services/automationDiscovery'

type Rec = Record<string, unknown>

/** Fake io that captures every SOQL and serves canned per-query responses. */
function fakeIo(over: {
  tooling?: (soql: string) => Rec[] | Promise<Rec[]>
  query?: (soql: string) => Rec[] | Promise<Rec[]>
  gated?: string[]
}): AutomationDiscoveryIo & { toolingSoql: string[]; restSoql: string[] } {
  const toolingSoql: string[] = []
  const restSoql: string[] = []
  return {
    toolingSoql,
    restSoql,
    async toolingQuery(soql: string): Promise<Rec[]> {
      toolingSoql.push(soql)
      return over.tooling ? over.tooling(soql) : []
    },
    async query(soql: string): Promise<Rec[]> {
      restSoql.push(soql)
      return over.query ? over.query(soql) : []
    },
    requiresTriggerBypass: (obj: string) => (over.gated ?? []).includes(obj)
  }
}

const vrRec = (id: string, name: string, obj: string | null): Rec => ({
  Id: id,
  ValidationName: name,
  EntityDefinition: obj ? { QualifiedApiName: obj } : null
})

const flowViewRec = (
  api: string,
  obj: string | null,
  activeVersionId: string | null,
  version: number | null = 3
): Rec => ({
  ApiName: api,
  ActiveVersionId: activeVersionId,
  TriggerType: 'RecordAfterSave',
  TriggerObjectOrEvent: obj ? { QualifiedApiName: obj } : null,
  // FlowDefinitionView exposes the ACTIVE version's number as its own field —
  // there is no `ActiveVersion` relationship (S54 L2).
  VersionNumber: version
})

const triggerRec = (id: string, name: string, table: string): Rec => ({
  Id: id,
  Name: name,
  TableEnumOrId: table,
  NamespacePrefix: null
})

describe('automationDiscovery (5B.8-b)', () => {
  it('VRs: org-wide fetch (pinned SOQL, no relationship FILTER) + client-side scope filter', async () => {
    const io = fakeIo({
      tooling: () => [
        vrRec('0VR1', 'Opp_Rule', 'Opportunity'),
        vrRec('0VR2', 'Acct_Rule', 'Account'),
        vrRec('0VR3', 'SBQQ__Managed_Rule', 'Opportunity'),
        vrRec('0VR4', 'Orphan_Rule', null) // null entity fails a non-empty scope
      ]
    })
    const items = await queryValidationRules(io, ['Opportunity'])
    // The relationship filter 500s on some orgs — it must NOT appear in the SOQL.
    expect(io.toolingSoql[0]).toBe(
      'SELECT Id, ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true'
    )
    expect(items.map((i) => i.name)).toEqual(['Opp_Rule', 'SBQQ__Managed_Rule'])
    expect(items[0]!.isManagedPackage).toBe(false)
    expect(items[1]!.isManagedPackage).toBe(true) // name contains '__'
  })

  it('flows: scoped FlowDefinitionView (pinned SOQL), 301 id, version captured, blank-id skipped', async () => {
    const io = fakeIo({
      query: () => [
        flowViewRec('Opp_After', 'Opportunity', '301A', 7),
        flowViewRec('Other_Obj', 'Case', '301B'),
        flowViewRec('No_Active', 'Opportunity', null) // no active version → nothing to disable
      ]
    })
    const { flows, flowScopeFallback, flowScopeFallbackReason } = await queryFlows(io, [
      'Opportunity'
    ])
    // Pinned: `VersionNumber` is a plain field on the view. `ActiveVersion.VersionNumber`
    // is NOT a relationship and made this query fail on every org (S54 L2, sb3 run 16:
    // "Didn't understand relationship 'ActiveVersion' in field path").
    expect(io.restSoql[0]).toBe(
      'SELECT ApiName, ActiveVersionId, TriggerType, TriggerObjectOrEvent.QualifiedApiName, ' +
        'VersionNumber FROM FlowDefinitionView ' +
        "WHERE IsActive = true AND TriggerType IN ('RecordBeforeSave','RecordAfterSave')"
    )
    expect(io.restSoql[0]).not.toContain('ActiveVersion.')
    expect(flowScopeFallback).toBe(false)
    expect(flowScopeFallbackReason).toBeNull()
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({
      id: '301A', // the ACTIVE-VERSION (301) id, not the definition id
      name: 'Opp_After',
      objectName: 'Opportunity',
      processType: 'RecordAfterSave',
      restoreVersionNumber: 7
    })
  })

  it('flows: scoped-query failure fails OPEN to the org-wide Tooling sweep, flagged', async () => {
    const io = fakeIo({
      query: () => {
        throw new Error('FlowDefinitionView unavailable')
      },
      tooling: (soql) =>
        soql.includes('FROM Flow')
          ? [{ Id: '301Z', Definition: { DeveloperName: 'Some_PB' }, ProcessType: 'Workflow' }]
          : []
    })
    const { flows, flowScopeFallback, flowScopeFallbackReason } = await queryFlows(io, [
      'Opportunity'
    ])
    expect(flowScopeFallback).toBe(true)
    // The fallback names its reason — a swallowed error hid L2 for 20 sessions.
    expect(flowScopeFallbackReason).toBe('FlowDefinitionView unavailable')
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({
      id: '301Z',
      name: 'Some_PB',
      objectName: '',
      processType: 'Workflow'
    })
    expect(io.toolingSoql.some((s) => s.includes("FROM Flow WHERE Status = 'Active'"))).toBe(true)
  })

  it('triggers: scoped IN clause (pinned, quoted+escaped) and RDS_*_CpqGuard hard-excluded', async () => {
    const io = fakeIo({
      tooling: () => [
        triggerRec('01q1', 'OppTrigger', 'Opportunity'),
        triggerRec('01q2', 'RDS_Opportunity_CpqGuard', 'Opportunity'), // never listed
        triggerRec('01q3', 'ContractTrigger', 'Contract')
      ]
    })
    const items = await queryTriggers(io, ['Opportunity', "Weird'Obj"])
    expect(io.toolingSoql[0]).toBe(
      "SELECT Id, Name, TableEnumOrId, NamespacePrefix FROM ApexTrigger WHERE Status = 'Active' " +
        "AND NamespacePrefix = null AND TableEnumOrId IN ('Opportunity','Weird\\'Obj') " +
        'ORDER BY TableEnumOrId'
    )
    expect(items.map((i) => i.name)).toEqual(['OppTrigger', 'ContractTrigger'])
  })

  it('duplicate rules: org-wide unmanaged only, fullName Object.DeveloperName', async () => {
    const io = fakeIo({
      query: () => [
        {
          Id: '0Bm1',
          DeveloperName: 'Std_Account_Rule',
          SobjectType: 'Account',
          NamespacePrefix: null
        },
        { Id: '0Bm2', DeveloperName: 'Pkg_Rule', SobjectType: 'Lead', NamespacePrefix: 'SBQQ' }
      ]
    })
    const items = await queryDuplicateRules(io)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      name: 'Account.Std_Account_Rule',
      objectName: 'Account',
      automationType: 'DuplicateRule'
    })
  })

  it('discoverAutomation: counts, playbook-gated objects sorted, dup-rule failure is soft', async () => {
    const io = fakeIo({
      tooling: (soql) => {
        if (soql.includes('FROM ValidationRule')) return [vrRec('0VR1', 'R1', 'SBQQ__Quote__c')]
        if (soql.includes('FROM ApexTrigger')) return [triggerRec('01q1', 'T1', 'Contract')]
        if (soql.includes('FROM EntityDefinition')) return [] // modern CPQ: no legacy setting
        return []
      },
      query: (soql) => {
        if (soql.includes('FROM DuplicateRule')) throw new Error('INVALID_TYPE: DuplicateRule')
        if (soql.includes('FlowDefinitionView')) return [flowViewRec('F1', 'Contract', '301A', 2)]
        return []
      },
      gated: ['SBQQ__Quote__c', 'Contract']
    })
    const snap = await discoverAutomation(io, ['SBQQ__Quote__c', 'Contract', 'Account'])
    expect(snap.validationRuleCount).toBe(1)
    expect(snap.flowCount).toBe(1)
    expect(snap.triggerCount).toBe(1)
    expect(snap.duplicateRuleCount).toBe(0)
    expect(snap.sectionErrors).toHaveLength(1)
    expect(snap.sectionErrors[0]).toMatch(/Duplicate rules could not be read/)
    expect(snap.cpqTriggerGatedObjects).toEqual(['Contract', 'SBQQ__Quote__c']) // sorted
    expect(snap.hasCpqTriggerSetting).toBe(false)
    expect(snap.items).toHaveLength(3)
  })

  it('discoverAutomation: legacy CPQ setting adds the synthetic toggle item (verbatim)', async () => {
    const io = fakeIo({
      tooling: (soql) =>
        soql.includes('FROM EntityDefinition')
          ? [{ QualifiedApiName: 'SBQQ__TriggerDisabled__c' }]
          : [],
      query: () => []
    })
    const snap = await discoverAutomation(io, ['Account'])
    expect(snap.hasCpqTriggerSetting).toBe(true)
    const cpq = snap.items.find((i) => i.automationType === 'CPQTriggerSetting')!
    expect(cpq).toMatchObject({
      id: 'CPQ_TRIGGER_SETTING',
      name: 'SBQQ Trigger Control',
      objectName: 'SBQQ__TriggerDisabled__c',
      isActive: true
    })
  })

  it('discoverAutomation: VR failure is STRICT (whole discovery fails, no silent empty)', async () => {
    const io = fakeIo({
      tooling: (soql) => {
        if (soql.includes('FROM ValidationRule')) throw new Error('tooling 500')
        return []
      }
    })
    await expect(discoverAutomation(io, ['Account'])).rejects.toThrow('tooling 500')
  })

  it('CPQ-setting probe failure fails toward false (the attestation-showing direction)', async () => {
    const io = fakeIo({
      tooling: (soql) => {
        if (soql.includes('FROM EntityDefinition')) throw new Error('probe failed')
        return []
      },
      query: () => []
    })
    const snap = await discoverAutomation(io, ['Account'])
    expect(snap.hasCpqTriggerSetting).toBe(false)
  })
})

describe('queryWorkflowRules (S32 extension, E4A.1 slice)', () => {
  it('maps Tooling WorkflowRule Metadata.active and fails OPEN TO EMPTY', async () => {
    const { queryWorkflowRules } = await import('../src/main/services/automationDiscovery')
    const toolingSoql: string[] = []
    const io = {
      toolingQuery: (soql: string) => {
        toolingSoql.push(soql)
        return Promise.resolve([
          { Id: '01Q1', Name: 'WR1', TableEnumOrId: 'Account', Metadata: { active: true } },
          { Id: '01Q2', Name: 'WR2', TableEnumOrId: 'Account', Metadata: { active: false } },
          { Id: '01Q3', Name: 'WR3', TableEnumOrId: 'Case', Metadata: null }
        ])
      },
      query: () => Promise.resolve([]),
      requiresTriggerBypass: () => false
    }
    const rules = await queryWorkflowRules(io)
    expect(toolingSoql).toEqual(['SELECT Id, Name, TableEnumOrId, Metadata FROM WorkflowRule'])
    expect(rules).toEqual([
      { id: '01Q1', name: 'WR1', tableEnumOrId: 'Account', active: true },
      { id: '01Q2', name: 'WR2', tableEnumOrId: 'Account', active: false },
      { id: '01Q3', name: 'WR3', tableEnumOrId: 'Case', active: false }
    ])

    const down = {
      toolingQuery: () => Promise.reject(new Error('WorkflowRule type unsupported')),
      query: () => Promise.resolve([]),
      requiresTriggerBypass: () => false
    }
    expect(await queryWorkflowRules(down)).toEqual([])
  })
})

// ── S54 F2: discovery → job-log lines (the L2 lesson: the log must say which flow set is in play) ──
describe('discoverySummaryLines (S54 F2)', () => {
  const base = {
    items: [],
    validationRuleCount: 93,
    flowCount: 73,
    triggerCount: 17,
    duplicateRuleCount: 0,
    hasCpqTriggerSetting: false,
    cpqTriggerGatedObjects: [],
    flowScopeFallback: false,
    flowScopeFallbackReason: null,
    sectionErrors: []
  }
  it('one info line naming the counts and the SCOPED flow set when the query worked', () => {
    const lines = discoverySummaryLines(base)
    expect(lines).toEqual([
      {
        level: 'info',
        message:
          'Automation discovered on the target: 73 flows (record-triggered flows on the plan objects only), ' +
          '93 validation rules, 17 triggers, 0 duplicate rules.'
      }
    ])
  })
  it('the fallback adds a WARN that names the org-wide sweep and quotes the target error', () => {
    const lines = discoverySummaryLines({
      ...base,
      flowCount: 223,
      flowScopeFallback: true,
      flowScopeFallbackReason: "Didn't understand relationship 'ActiveVersion' in field path",
      sectionErrors: ['Duplicate rules could not be read: INVALID_TYPE']
    })
    expect(lines[0]!.message).toContain('223 flows (ORG-WIDE sweep — every active flow)')
    expect(lines[1]).toEqual({
      level: 'warn',
      message:
        'Scoped flow query failed on the target — the ORG-WIDE flow sweep (223 flows) will be disabled and ' +
        "restored instead. Target said: Didn't understand relationship 'ActiveVersion' in field path"
    })
    expect(lines[2]).toEqual({
      level: 'warn',
      message: 'Automation discovery: Duplicate rules could not be read: INVALID_TYPE'
    })
  })
  it('singulars read correctly', () => {
    const [l] = discoverySummaryLines({
      ...base,
      flowCount: 1,
      validationRuleCount: 1,
      triggerCount: 1,
      duplicateRuleCount: 1
    })
    expect(l!.message).toBe(
      'Automation discovered on the target: 1 flow (record-triggered flows on the plan objects only), 1 validation rule, 1 trigger, 1 duplicate rule.'
    )
  })
})
