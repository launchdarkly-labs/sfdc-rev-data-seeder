/**
 * TemplateSummary.cpqGatedObjects — resolved in MAIN with the runner's policy
 * (S61 fix: a post-refresh template's run form never showed the CPQ attestation
 * because the renderer only looked at a seed template's own tiers).
 */
import { describe, it, expect } from 'vitest'
import { cpqGatedObjects } from '../../src/main/services/templateStore'
import { SAMPLE_SEED_TEMPLATE } from '../../src/shared/templates/samples'

describe('cpqGatedObjects', () => {
  it('returns the CPQ-gated seeded objects, sorted and de-duplicated, and nothing else', () => {
    const gated = cpqGatedObjects(SAMPLE_SEED_TEMPLATE.tiers)
    expect(gated).toContain('SBQQ__BlockPrice__c')
    expect(gated).toContain('SBQQ__PriceRule__c')
    expect(gated).not.toContain('Acme_Form__c')
    expect(gated).not.toContain('ConsumptionSchedule')
    expect(gated).toEqual([...new Set(gated)].sort())
  })
  it('is empty for a seed with no gated objects', () => {
    expect(cpqGatedObjects([{ object: 'Account' }, { object: 'Acme_Form__c' }])).toEqual([])
  })
})
