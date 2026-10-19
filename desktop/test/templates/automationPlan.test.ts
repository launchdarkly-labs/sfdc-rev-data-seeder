import { describe, it, expect } from 'vitest'
import {
  planAutomation,
  planFlow,
  planItemToReport,
  planTrigger
} from '../../src/main/engine/templates/automationPlan'
import type { CatalogFlow, CatalogTrigger } from '../../src/shared/templates/types'

function flow(over: Partial<CatalogFlow>): CatalogFlow {
  return {
    apiName: 'F',
    label: 'F',
    processType: 'AutoLaunchedFlow',
    triggerType: 'RecordAfterSave',
    object: 'Opportunity',
    isActive: true,
    activeVersionNumber: 3,
    latestVersionNumber: 3,
    managed: false,
    namespace: null,
    ...over
  }
}
function trig(over: Partial<CatalogTrigger>): CatalogTrigger {
  return { id: '01q1', name: 'T', object: 'Order', status: 'Active', bodyState: 'live', managed: false, namespace: null, ...over }
}

describe('planFlow — wanted × found', () => {
  it('deactivate: active → change, inactive → alreadyThere', () => {
    expect(planFlow('F', 'deactivate', flow({})).decision).toBe('change')
    expect(planFlow('F', 'deactivate', flow({ isActive: false, activeVersionNumber: null })).decision).toBe('alreadyThere')
  })
  it('activate: inactive → change (latest), active at latest → alreadyThere, active below latest → change', () => {
    expect(planFlow('F', 'activate', flow({ isActive: false, activeVersionNumber: null, latestVersionNumber: 4 })).decision).toBe('change')
    expect(planFlow('F', 'activate', flow({})).decision).toBe('alreadyThere')
    const up = planFlow('F', 'activate', flow({ activeVersionNumber: 2, latestVersionNumber: 4 }))
    expect(up.decision).toBe('change')
    expect(up.detail).toBe('active v2 → latest v4')
    // Unknown latest + active → already there (no evidence of a newer version).
    expect(planFlow('F', 'activate', flow({ latestVersionNumber: null })).decision).toBe('alreadyThere')
  })
  it('not found and managed are never changes', () => {
    expect(planFlow('F', 'deactivate', undefined).decision).toBe('notFound')
    expect(planFlow('F', 'deactivate', flow({ managed: true, namespace: 'ns' })).decision).toBe('managed')
  })
})

describe('planTrigger — wanted × found', () => {
  it('deactivate / activate read Status', () => {
    expect(planTrigger('T', 'deactivate', trig({})).decision).toBe('change')
    expect(planTrigger('T', 'deactivate', trig({ status: 'Inactive' })).decision).toBe('alreadyThere')
    expect(planTrigger('T', 'activate', trig({ status: 'Inactive' })).decision).toBe('change')
    expect(planTrigger('T', 'activate', trig({})).decision).toBe('alreadyThere')
  })
  it('commentOut / uncomment read the body state; a DEPLOY wrap is unsupported', () => {
    expect(planTrigger('T', 'commentOut', trig({})).decision).toBe('change')
    expect(planTrigger('T', 'commentOut', trig({ bodyState: 'templateStub' })).decision).toBe('alreadyThere')
    expect(planTrigger('T', 'commentOut', trig({ bodyState: 'deployWrapped' })).decision).toBe('unsupported')
    expect(planTrigger('T', 'uncomment', trig({ bodyState: 'templateStub' })).decision).toBe('change')
    expect(planTrigger('T', 'uncomment', trig({})).decision).toBe('alreadyThere')
    expect(planTrigger('T', 'uncomment', trig({ bodyState: 'deployWrapped' })).decision).toBe('unsupported')
  })
  it('not found and managed', () => {
    expect(planTrigger('T', 'deactivate', undefined).decision).toBe('notFound')
    expect(planTrigger('T', 'deactivate', trig({ managed: true, namespace: 'SBQQ' })).decision).toBe('managed')
  })
})

describe('planAutomation + report rows', () => {
  it('counts changes and renders dry-run rows as planned', () => {
    const plan = planAutomation(
      {
        automation: {
          flows: [
            { apiName: 'A', action: 'deactivate' },
            { apiName: 'B', action: 'activate' },
            { apiName: 'Missing', action: 'deactivate' }
          ],
          triggers: [
            { name: 'T', action: 'deactivate' },
            { name: 'U', action: 'commentOut' }
          ],
          settingPatches: []
        }
      },
      {
        flows: [flow({ apiName: 'A' }), flow({ apiName: 'B', isActive: false, activeVersionNumber: null, latestVersionNumber: 2 })],
        triggers: [trig({ name: 'T' }), trig({ name: 'U', bodyState: 'templateStub' })]
      }
    )
    expect(plan.changes).toBe(3)
    const rows = plan.items.map((i) => planItemToReport(i, true))
    expect(rows.map((r) => `${r.itemType}:${r.name}:${r.found}:${r.result}`)).toEqual([
      'Flow:A:active v3:planned',
      'Flow:B:inactive (latest v2):planned',
      'Flow:Missing:not found:notFound',
      'ApexTrigger:T:Active:planned',
      'ApexTrigger:U:Active, commented out:alreadyThere'
    ])
    expect(planItemToReport(plan.items[0]!, false).result).toBe('changed')
  })
})
