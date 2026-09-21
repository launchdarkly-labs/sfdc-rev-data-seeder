import { describe, it, expect } from 'vitest'
import { targetHasExtIdOrgWide } from '../src/main/services/targetSchemaProbe'
import type { GuardedOrg } from '../src/main/services/salesforce'

type QueryCall = { soql: string; options: unknown }

function makeOrg(
  handler: (soql: string) => unknown[]
): { org: GuardedOrg; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  const org = {
    alias: 'sb1_714',
    role: 'target',
    orgId: '00DcW000005SHnpUAG',
    conn: {
      tooling: {
        query: async (soql: string, options: unknown) => {
          calls.push({ soql, options })
          return { records: handler(soql) }
        }
      }
    },
    assertWritable() {}
  } as unknown as GuardedOrg
  return { org, calls }
}

describe('targetHasExtIdOrgWide (SchemaService.batchCheckRdsField :530-607)', () => {
  it("queries CustomField by DeveloperName WITHOUT the __c suffix ('Data_Deployment_External_Id')", async () => {
    const { org, calls } = makeOrg(() => [])
    await targetHasExtIdOrgWide(org)
    expect(calls[0]!.soql).toBe(
      "SELECT TableEnumOrId FROM CustomField WHERE DeveloperName = 'Data_Deployment_External_Id'"
    )
    expect(calls[0]!.options).toEqual({ autoFetch: true, maxFetch: 50_000 })
  })

  it('standard objects (API name) pass through; entity-ID rows resolve via EntityDefinition with 18→15 truncation (:569-573 — managed objects silently dropped without it)', async () => {
    const { org, calls } = makeOrg((soql) => {
      if (soql.includes('CustomField')) {
        return [
          { TableEnumOrId: 'Account' }, // standard — API name
          { TableEnumOrId: '01I000000000001EAA' }, // custom — 18-char entity id
          { TableEnumOrId: '01I00000000000A' } // custom — already 15-char
        ]
      }
      return [
        { DurableId: '01I000000000001', QualifiedApiName: 'SBQQ__Quote__c' },
        { DurableId: '01I00000000000A', QualifiedApiName: 'My_Object__c' }
      ]
    })
    const result = await targetHasExtIdOrgWide(org)
    expect(result).toEqual(new Set(['Account', 'SBQQ__Quote__c', 'My_Object__c']))
    // the 18-char id was truncated to 15 in the IN list
    expect(calls[1]!.soql).toContain("'01I000000000001'")
    expect(calls[1]!.soql).not.toContain('01I000000000001EAA')
  })

  it("the entity-ID heuristic: '0'-prefixed WITHOUT '__' → resolve; a '0'-starting name WITH '__' stays direct (:557-561)", async () => {
    const { org, calls } = makeOrg((soql) =>
      soql.includes('CustomField') ? [{ TableEnumOrId: '0abc__Weird__c' }] : []
    )
    const result = await targetHasExtIdOrgWide(org)
    expect(result).toEqual(new Set(['0abc__Weird__c']))
    expect(calls).toHaveLength(1) // no EntityDefinition round-trip needed
  })

  it('no rows anywhere → empty set; no EntityDefinition query without unresolved ids', async () => {
    const { org, calls } = makeOrg(() => [])
    expect(await targetHasExtIdOrgWide(org)).toEqual(new Set())
    expect(calls).toHaveLength(1)
  })

  it('non-string / missing TableEnumOrId rows are skipped', async () => {
    const { org } = makeOrg((soql) =>
      soql.includes('CustomField')
        ? [{ TableEnumOrId: null }, {}, { TableEnumOrId: 'Contact' }]
        : []
    )
    expect(await targetHasExtIdOrgWide(org)).toEqual(new Set(['Contact']))
  })
})
