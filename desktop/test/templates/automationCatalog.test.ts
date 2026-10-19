import { describe, it, expect } from 'vitest'
import {
  APEX_TRIGGER_SOQL,
  FLOW_DEFINITION_VIEW_SOQL,
  FLOW_VERSION_VIEW_SOQL,
  buildAutomationCatalog,
  flowStateLabel,
  triggerStateLabel
} from '../../src/main/engine/templates/automationCatalog'
import { stubBody } from '../../src/main/engine/templates/triggerStub'
import { commentOutBody } from '../../src/main/engine/triggerBodyToggle'
import type { OrgReader } from '../../src/main/engine/templates/io'

function reader(opts: {
  query?: (soql: string) => Array<Record<string, unknown>>
  tooling?: (soql: string) => Array<Record<string, unknown>>
}): OrgReader {
  return {
    orgId: '00D1',
    label: 'org',
    describeGlobal: async () => [],
    describe: async () => null,
    query: async (soql) => opts.query?.(soql) ?? [],
    toolingQuery: async (soql) => opts.tooling?.(soql) ?? [],
    count: async () => 0,
    attachmentBody: async () => new Uint8Array(),
    organization: async () => ({ id: '00D1', name: 'org', isSandbox: true })
  }
}

const BODY = 'trigger T on Order (after insert) { run(); }'

describe('buildAutomationCatalog', () => {
  it('shapes flows (active version, latest version, managed) and triggers (status, body state, managed)', async () => {
    const org = reader({
      query: (soql) => {
        if (soql === FLOW_DEFINITION_VIEW_SOQL)
          return [
            {
              DurableId: 'd1',
              ApiName: 'Acme_Notify',
              Label: 'Notify',
              ProcessType: 'AutoLaunchedFlow',
              TriggerType: 'RecordAfterSave',
              TriggerObjectOrEvent: { QualifiedApiName: 'Opportunity' },
              IsActive: true,
              ActiveVersionId: '301a',
              VersionNumber: 3,
              NamespacePrefix: null,
              ManageableState: 'unmanaged'
            },
            {
              DurableId: 'd2',
              ApiName: 'Acme_Banner',
              Label: 'Banner',
              ProcessType: 'Flow',
              TriggerType: null,
              TriggerObjectOrEvent: null,
              IsActive: false,
              ActiveVersionId: null,
              VersionNumber: null,
              NamespacePrefix: null,
              ManageableState: 'unmanaged'
            },
            {
              DurableId: 'd3',
              ApiName: 'SBQQ__Managed',
              Label: 'M',
              ProcessType: 'Flow',
              TriggerType: null,
              TriggerObjectOrEvent: null,
              IsActive: true,
              ActiveVersionId: '301c',
              VersionNumber: 1,
              NamespacePrefix: 'SBQQ',
              ManageableState: 'installed'
            }
          ]
        if (soql === FLOW_VERSION_VIEW_SOQL)
          return [
            { FlowDefinitionViewId: 'd1', VersionNumber: 3 },
            { FlowDefinitionViewId: 'd1', VersionNumber: 4 },
            { FlowDefinitionViewId: 'd2', VersionNumber: 2 }
          ]
        return []
      },
      tooling: (soql) => {
        if (soql === APEX_TRIGGER_SOQL)
          return [
            { Id: '01q1', Name: 'T', TableEnumOrId: 'Order', Status: 'Active', NamespacePrefix: null, Body: BODY },
            { Id: '01q2', Name: 'Stub', TableEnumOrId: 'Order', Status: 'Active', NamespacePrefix: null, Body: stubBody(BODY, 't', 'd') },
            { Id: '01q3', Name: 'Wrapped', TableEnumOrId: 'Order', Status: 'Active', NamespacePrefix: null, Body: commentOutBody(BODY) },
            { Id: '01q4', Name: 'RDS_Order_CpqGuard', TableEnumOrId: 'Order', Status: 'Active', NamespacePrefix: null, Body: BODY },
            { Id: '01q5', Name: 'SBQQ__Managed', TableEnumOrId: 'SBQQ__Quote__c', Status: 'Active', NamespacePrefix: 'SBQQ', Body: null }
          ]
        return []
      }
    })
    const cat = await buildAutomationCatalog(org)
    expect(cat.errors).toEqual([])
    expect(cat.flows.map((f) => `${f.apiName}|${f.object}|${flowStateLabel(f)}|${f.managed}`)).toEqual([
      'Acme_Notify|Opportunity|active v3|false',
      'Acme_Banner|null|inactive (latest v2)|false',
      'SBQQ__Managed|null|active v1|true'
    ])
    expect(cat.flows[0]!.latestVersionNumber).toBe(4)
    expect(cat.triggers.map((t) => `${t.name}|${triggerStateLabel(t)}|${t.managed}`)).toEqual([
      'T|Active|false',
      'Stub|Active, commented out|false',
      'Wrapped|Active, wrapped by a deploy|false',
      'SBQQ__Managed|Active|true'
    ])
  })

  it('section failures are soft and named; a missing version view leaves latest unknown', async () => {
    const org = reader({
      query: (soql) => {
        if (soql === FLOW_DEFINITION_VIEW_SOQL)
          return [{ DurableId: 'd1', ApiName: 'F', Label: 'F', IsActive: true, VersionNumber: 1 }]
        throw new Error('no FlowVersionView')
      },
      tooling: () => {
        throw new Error('INVALID_TYPE')
      }
    })
    const cat = await buildAutomationCatalog(org)
    expect(cat.flows).toHaveLength(1)
    expect(cat.flows[0]!.latestVersionNumber).toBeNull()
    expect(cat.triggers).toEqual([])
    expect(cat.errors).toEqual(['Triggers could not be read: INVALID_TYPE'])
  })
})
