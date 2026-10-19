import { describe, it, expect } from 'vitest'
import {
  validateSeedTemplate,
  validatePostRefreshTemplate,
  validateTemplate
} from '../../src/shared/templates/validate'
import {
  SAMPLE_POST_REFRESH_TEMPLATE,
  SAMPLE_SEED_TEMPLATE,
  cpqConfigurationPreset
} from '../../src/shared/templates/samples'
import {
  emptyPostRefreshTemplate,
  emptySeedTemplate,
  seedGroups,
  templateDetailLine,
  type SeedTemplate
} from '../../src/shared/templates/types'

const paths = (r: { errors: { path: string }[] }): string[] => r.errors.map((e) => e.path)

/** A minimal valid seed template (one tier) with overrides — independent of the sample's cross-refs. */
function seed(over: Partial<SeedTemplate> = {}): SeedTemplate {
  return { ...emptySeedTemplate(), tiers: [{ object: 'SBQQ__PriceRule__c' }], ...over }
}

describe('validateSeedTemplate', () => {
  it('accepts the shipped sample and the CPQ preset', () => {
    expect(validateSeedTemplate(SAMPLE_SEED_TEMPLATE)).toEqual({ ok: true, errors: [] })
    expect(validateSeedTemplate(cpqConfigurationPreset())).toEqual({ ok: true, errors: [] })
  })

  it('an empty template needs at least one tier', () => {
    const r = validateSeedTemplate(emptySeedTemplate())
    expect(r.ok).toBe(false)
    expect(paths(r)).toEqual(['tiers'])
  })

  it('refuses a non-object and a wrong schemaVersion', () => {
    expect(validateSeedTemplate(null).ok).toBe(false)
    expect(validateSeedTemplate([]).ok).toBe(false)
    const r = validateSeedTemplate({ ...SAMPLE_SEED_TEMPLATE, schemaVersion: 2 })
    expect(paths(r)).toContain('schemaVersion')
    expect(r.errors[0]!.message).toMatch(/understands up to schemaVersion 1/)
  })

  it('tiers must be unique and name valid API names', () => {
    const r = validateSeedTemplate(
      seed({ tiers: [{ object: 'Account' }, { object: 'Account' }, { object: '1bad' }] })
    )
    expect(paths(r)).toEqual(['tiers[1].object', 'tiers[2].object'])
  })

  it('batchSize is an integer 1–200', () => {
    const bad = [0, 201, 1.5, '50'] as unknown[]
    for (const b of bad) {
      const r = validateSeedTemplate(seed({ tiers: [{ object: 'Account', batchSize: b as number }] }))
      expect(paths(r), String(b)).toEqual(['tiers[0].batchSize'])
    }
    expect(validateSeedTemplate(seed({ tiers: [{ object: 'Account', batchSize: 1 }] })).ok).toBe(true)
    expect(validateSeedTemplate(seed({ tiers: [{ object: 'Account', batchSize: 200 }] })).ok).toBe(true)
  })

  it('where must not start with WHERE', () => {
    const r = validateSeedTemplate(seed({ tiers: [{ object: 'Account', where: 'WHERE Name != null' }] }))
    expect(paths(r)).toEqual(['tiers[0].where'])
    expect(validateSeedTemplate(seed({ tiers: [{ object: 'Account', where: 'Name != null' }] })).ok).toBe(true)
  })

  it('a handler needs its config; config without a handler is refused', () => {
    const r1 = validateSeedTemplate(
      seed({ tiers: [{ object: 'A__c', handler: 'attachmentsViaJunction' }] })
    )
    expect(paths(r1)).toEqual(['tiers[0].handlerConfig'])
    const r2 = validateSeedTemplate(
      seed({
        tiers: [{ object: 'A__c', handlerConfig: { fileIdField: 'F__c', parentField: 'P__c' } }]
      })
    )
    expect(paths(r2)).toEqual(['tiers[0].handlerConfig'])
    const r3 = validateSeedTemplate(
      seed({ tiers: [{ object: 'A__c', handler: 'bogus' as 'attachmentsViaJunction', handlerConfig: { fileIdField: 'F__c', parentField: 'P__c' } }] })
    )
    expect(paths(r3)).toEqual(['tiers[0].handler'])
  })

  it('prune parents and scope parents must be EARLIER tiers', () => {
    const r = validateSeedTemplate(
      seed({
        tiers: [
          { object: 'Child__c', pruneUnloadedUnder: { field: 'Parent__c', parent: 'Parent__c' } },
          { object: 'Parent__c' },
          { object: 'Other__c', parentScope: { anyOf: [{ field: 'X__c', object: 'Missing__c' }] } }
        ]
      })
    )
    expect(paths(r)).toEqual([
      'tiers[0].pruneUnloadedUnder.parent',
      'tiers[2].parentScope.anyOf[0].object'
    ])
    expect(r.errors[0]!.message).toMatch(/must come before/)
    expect(r.errors[1]!.message).toMatch(/not a tier/)
  })

  it('relink objects must be keep-Id objects', () => {
    const r = validateSeedTemplate(
      seed({ relinkCopiedObjects: [{ object: 'Opportunity', optionalFields: [] }] })
    )
    expect(paths(r)).toEqual(['relinkCopiedObjects[0].object'])
  })

  it('deferred fields, subsets and placeholders refer to tiers and sane values', () => {
    const r = validateSeedTemplate(
      seed({
        deferredFields: { NotATier__c: ['X__c'] },
        deferredPlaceholders: { 'bad name': 'x', Good__c: { nested: true } as unknown as string },
        subsets: [{ object: 'NotATier__c', ids: [] }, { object: 'SBQQ__PriceRule__c', ids: ['short'] }]
      })
    )
    expect(paths(r)).toEqual([
      'deferredFields.NotATier__c',
      'deferredPlaceholders.bad name',
      'deferredPlaceholders.Good__c',
      'subsets[0].object',
      'subsets[0].ids',
      'subsets[1].ids[0]'
    ])
  })

  it('expected failures need contains + why; object may be null', () => {
    const r = validateSeedTemplate(
      seed({ expectedFailures: [{ object: null, contains: '', why: 'x' }, { object: 'A', contains: 'y', why: '' }] })
    )
    expect(paths(r)).toEqual(['expectedFailures[0].contains', 'expectedFailures[1].why'])
  })

  it('copiedMatchTolerance bounds', () => {
    const r = validateSeedTemplate(seed({ copiedMatchTolerance: { absolute: -1, fraction: 2 } }))
    expect(paths(r)).toEqual(['copiedMatchTolerance.absolute', 'copiedMatchTolerance.fraction'])
  })

  it('source.expectedOrgId may be null or a 15/18-char Id', () => {
    expect(validateSeedTemplate(seed({ source: { expectedOrgId: null } })).ok).toBe(true)
    expect(validateSeedTemplate(seed({ source: { expectedOrgId: '00D000000000001' } })).ok).toBe(true)
    expect(paths(validateSeedTemplate(seed({ source: { expectedOrgId: 'nope' } })))).toEqual([
      'source.expectedOrgId'
    ])
  })
})

describe('validatePostRefreshTemplate', () => {
  it('accepts the shipped sample and an empty template', () => {
    expect(validatePostRefreshTemplate(SAMPLE_POST_REFRESH_TEMPLATE)).toEqual({ ok: true, errors: [] })
    expect(validatePostRefreshTemplate(emptyPostRefreshTemplate())).toEqual({ ok: true, errors: [] })
  })

  it('one action per item, known actions only, no duplicate names', () => {
    const r = validatePostRefreshTemplate({
      ...SAMPLE_POST_REFRESH_TEMPLATE,
      automation: {
        flows: [
          { apiName: 'A', action: 'deactivate' },
          { apiName: 'A', action: 'activate' },
          { apiName: 'B', action: 'commentOut' }
        ],
        triggers: [
          { name: 'T', action: 'deactivate' },
          { name: 'T', action: 'uncomment' },
          { name: 'bad.name', action: 'activate' }
        ],
        settingPatches: []
      }
    })
    expect(paths(r)).toEqual([
      'automation.flows[1].apiName',
      'automation.flows[2].action',
      'automation.triggers[1].name',
      'automation.triggers[2].name'
    ])
  })

  it('flow API names may carry one namespace dot', () => {
    const ok = validatePostRefreshTemplate({
      ...SAMPLE_POST_REFRESH_TEMPLATE,
      automation: { flows: [{ apiName: 'ns.Flow_Name', action: 'deactivate' }], triggers: [], settingPatches: [] }
    })
    expect(ok.ok).toBe(true)
  })

  it('setting patches: label/object/field required; transform kind + value; where without WHERE', () => {
    const r = validatePostRefreshTemplate({
      ...SAMPLE_POST_REFRESH_TEMPLATE,
      automation: {
        flows: [],
        triggers: [],
        settingPatches: [
          { label: '', object: 'S__c', field: 'F__c', transform: { kind: 'prefix', value: '' } },
          { label: 'x', object: 'S__c', field: 'F__c', where: 'WHERE a = 1', transform: { kind: 'bogus', value: 1 } },
          { label: 'y', object: 'S__c', field: 'F__c', transform: { kind: 'set', value: { a: 1 } } }
        ]
      }
    })
    expect(paths(r)).toEqual([
      'automation.settingPatches[0].label',
      'automation.settingPatches[0].transform.value',
      'automation.settingPatches[1].where',
      'automation.settingPatches[1].transform.kind',
      'automation.settingPatches[2].transform.value'
    ])
  })

  it('seed template names are non-empty and unique; verify.safetyCheck must be true', () => {
    const r = validatePostRefreshTemplate({
      ...SAMPLE_POST_REFRESH_TEMPLATE,
      seedTemplates: [{ name: 'A' }, { name: 'A' }, { name: '' }],
      verify: { safetyCheck: false }
    })
    expect(paths(r)).toEqual(['seedTemplates[1].name', 'seedTemplates[2].name', 'verify.safetyCheck'])
  })
})

describe('validateTemplate / helpers', () => {
  it('dispatches by kind and refuses wizard kinds', () => {
    expect(validateTemplate('seed', SAMPLE_SEED_TEMPLATE).ok).toBe(true)
    expect(validateTemplate('postRefresh', SAMPLE_POST_REFRESH_TEMPLATE).ok).toBe(true)
    expect(validateTemplate('objects', {}).errors[0]!.message).toMatch(/not a runnable/)
  })

  it('seedGroups keeps first-appearance order with the default applied', () => {
    expect(seedGroups(SAMPLE_SEED_TEMPLATE)).toEqual(['default', 'forms'])
    expect(seedGroups({ tiers: [] })).toEqual([])
  })

  it('templateDetailLine summarises every kind', () => {
    expect(templateDetailLine('seed', SAMPLE_SEED_TEMPLATE)).toBe('36 objects in 2 groups')
    expect(templateDetailLine('seed', cpqConfigurationPreset())).toBe('32 objects')
    expect(templateDetailLine('postRefresh', SAMPLE_POST_REFRESH_TEMPLATE)).toBe(
      '3 flows, 2 triggers, 2 setting patches, 1 seed template'
    )
    expect(templateDetailLine('objects', { objects: ['A'] })).toBe('1 object (wizard)')
    expect(templateDetailLine('mappings', { A: {}, B: {} })).toBe('2 objects with mapping overrides (wizard)')
    expect(templateDetailLine('fields', {})).toBe('0 objects with field exclusions (wizard)')
  })
})
