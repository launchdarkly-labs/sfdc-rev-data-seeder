/**
 * Tests for objectPolicy (port of ObjectPolicyServiceTest.cls — N6 Object
 * Gating Playbook resolver).
 *
 * Resolution is exercised deterministically by injecting playbook JSON through
 * setPlaybookJsonOverride (the port of the @TestVisible playbookJsonOverride
 * hook) — except "shipped playbook" tests, which drop the override to prove
 * the embedded-playbook load path works (the port of testDeployedResourceLoads,
 * whose StaticResource SOQL path became the embedded SHIPPED_PLAYBOOK).
 *
 * The first describe block ports each Apex test method 1:1 (same fixtures,
 * same assertions); the second adds edge cases the Apex suite left thin.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  resolve,
  decideStrategy,
  recommendedBatchSize,
  namespaceOf,
  setPlaybookJsonOverride,
  clearCache,
  SHIPPED_PLAYBOOK,
  STRATEGY_REST,
  STRATEGY_BULK,
  STRATEGY_AUTO,
  type ResolvedPolicy
} from '../src/main/engine/objectPolicy'

const MINIMAL_PLAYBOOK =
  '{' +
  '  "version": 1,' +
  '  "defaultPolicy": {"tier":"free","apiStrategy":"auto","restPageSize":2000,' +
  '     "restMaxRecords":10000,"bulkBatchSize":10000,"requiresTriggerBypass":false,' +
  '     "requiresAutomationDisable":true},' +
  '  "namespaceRules":[' +
  '     {"namespace":"SBQQ","tier":"gated","apiStrategy":"REST","restPageSize":200,' +
  '      "requiresTriggerBypass":true}],' +
  '  "objects":{' +
  '     "Contract":{"tier":"gated","apiStrategy":"REST","restPageSize":200,' +
  '        "requiresTriggerBypass":true},' +
  '     "OpportunityContactRole":{"tier":"junction","apiStrategy":"REST","restPageSize":200,' +
  '        "requiresTriggerBypass":true}}' +
  '}'

function inject(json: string | null): void {
  setPlaybookJsonOverride(json)
  clearCache()
}

afterEach(() => {
  // reset module state so no override/cache leaks into other suites
  inject(null)
})

describe('ObjectPolicyServiceTest ports', () => {
  it('testFreeObjectAuto — plain custom object is free/auto and size-routed', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve('Widget__c')
    expect(pol.tier, 'plain custom object → free tier').toBe('free')
    expect(pol.apiStrategy, 'free → auto').toBe(STRATEGY_AUTO)
    expect(pol.requiresTriggerBypass, 'free objects need no trigger bypass').toBe(false)
    expect(pol.matchReason, 'unmatched object falls to default').toBe('default')

    // small volume → REST; over the per-object ceiling → Bulk; wide plan → Bulk
    expect(decideStrategy(pol, 100, 3, 10000, 50), 'small free → REST').toBe('REST')
    expect(decideStrategy(pol, 50000, 3, 10000, 50), 'large free → Bulk').toBe('Bulk')
    expect(decideStrategy(pol, 100, 80, 10000, 50), 'wide plan flips free → Bulk').toBe('Bulk')
  })

  it('testSbqqNamespaceForcedRest — SBQQ namespace is gated and never falls to Bulk', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve('SBQQ__Subscription__c')
    expect(pol.tier, 'SBQQ namespace → gated').toBe('gated')
    expect(pol.apiStrategy, 'gated → REST').toBe('REST')
    expect(pol.restPageSize, 'gated → small page').toBe(200)
    expect(pol.requiresTriggerBypass, 'gated CPQ → trigger bypass').toBe(true)
    expect(pol.matchReason, 'matched via namespace rule').toBe('namespace:SBQQ')

    // The N5 backtrack fix: a huge, wide-plan gated object still routes REST.
    expect(
      decideStrategy(pol, 999999, 80, 10000, 50),
      'gated object must never fall to Bulk regardless of count/plan width'
    ).toBe('REST')
  })

  it('testExplicitContract — explicit object entry wins', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve('Contract')
    expect(pol.tier, 'Contract explicit → gated').toBe('gated')
    expect(pol.apiStrategy).toBe('REST')
    expect(pol.requiresTriggerBypass).toBe(true)
    expect(pol.matchReason, 'matched via explicit object entry').toBe('object')
  })

  it('testJunctionOcr — OpportunityContactRole is junction tier', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve('OpportunityContactRole')
    expect(pol.tier, 'OCR → junction tier').toBe('junction')
    expect(pol.apiStrategy).toBe('REST')
    expect(pol.requiresTriggerBypass).toBe(true)
  })

  it('testGatedDetected — runtime-detected automation goes conservative', () => {
    inject(MINIMAL_PLAYBOOK)
    const detected = new Set<string>(['Widget__c'])
    const pol = resolve('Widget__c', detected)
    expect(pol.tier, 'detected automation → conservative gated-detected').toBe('gated-detected')
    expect(pol.apiStrategy, 'gated-detected → REST').toBe(STRATEGY_REST)
    expect(pol.restPageSize).toBe(200)
    expect(pol.requiresAutomationDisable, 'must disable detected automation').toBe(true)
    expect(
      pol.requiresTriggerBypass,
      'no forced managed bypass unless a managed namespace matched'
    ).toBe(false)
    expect(pol.matchReason).toBe('detected')
  })

  it('testPlainCustomObjectNotNamespaced — namespaceOf parses only <ns>__<Object>__c', () => {
    inject(MINIMAL_PLAYBOOK)
    // Automation_Ledger__c has a single "__" (before c) → not a namespace.
    expect(namespaceOf('Automation_Ledger__c'), 'plain custom object is not namespaced').toBeNull()
    expect(namespaceOf('SBQQ__QuoteLine__c'), 'managed object namespace parsed from API name').toBe(
      'SBQQ'
    )
    expect(namespaceOf('Account'), 'standard object has no namespace').toBeNull()

    const pol = resolve('Automation_Ledger__c')
    expect(pol.tier, 'plain custom object → free').toBe('free')
  })

  it('testRecommendedBatchSize — REST capped at 200, Bulk uses policy size', () => {
    inject(MINIMAL_PLAYBOOK)
    const gated = resolve('SBQQ__QuoteLine__c')
    expect(
      recommendedBatchSize(gated, 'REST'),
      'REST write batch capped at the 200 composite ceiling'
    ).toBe(200)

    const free = resolve('Widget__c')
    expect(
      recommendedBatchSize(free, 'Bulk'),
      'Bulk write batch uses the policy bulkBatchSize'
    ).toBe(10000)
  })

  it('testDecideStrategyZeroOrNull — zero/null counts always route REST', () => {
    inject(MINIMAL_PLAYBOOK)
    const free = resolve('Widget__c')
    expect(
      decideStrategy(free, 0, 3, 10000, 50),
      'zero records → REST (nothing to bulk-load)'
    ).toBe('REST')
    expect(decideStrategy(free, null, 3, 10000, 50), 'null count → REST').toBe('REST')
  })

  it('testFailOpenBuiltInPlaybook — malformed JSON still gates the CPQ graph', () => {
    // Malformed JSON → parse fails → built-in fallback still gates the CPQ graph.
    inject('{ this is not valid json ]')
    const sbqq = resolve('SBQQ__Quote__c')
    expect(sbqq.tier, 'fail-open still gates SBQQ namespace').toBe('gated')
    expect(sbqq.apiStrategy).toBe('REST')
    expect(sbqq.requiresTriggerBypass).toBe(true)

    const contract = resolve('Contract')
    expect(contract.tier, 'fail-open still gates Contract').toBe('gated')

    const free = resolve('Widget__c')
    expect(free.tier, 'fail-open leaves unknown objects free').toBe('free')
  })

  it('testDeployedResourceLoads — dropping the override loads the shipped playbook', () => {
    // Apex exercises the StaticResource SOQL path here; the desktop port ships
    // the resource embedded, so this exercises the SHIPPED_PLAYBOOK load path.
    inject(null)
    const pol = resolve('Contract')
    expect(pol.tier, 'Contract is gated whether from resource or fallback').toBe('gated')
    expect(pol.apiStrategy).toBe('REST')
  })
})

describe('extra edge cases (thin in Apex coverage)', () => {
  /** Hand-built policy for exercising the null-fallback branches directly. */
  function bare(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
    return {
      objectName: 'Widget__c',
      tier: null,
      apiStrategy: null,
      restPageSize: null,
      restMaxRecords: null,
      bulkBatchSize: null,
      requiresTriggerBypass: null,
      requiresAutomationDisable: null,
      matchReason: 'default',
      ...overrides
    }
  }

  it('shipped playbook — semi-tier standard objects resolve from explicit entries', () => {
    inject(null)
    const account = resolve('Account')
    expect(account.tier).toBe('semi')
    expect(account.apiStrategy).toBe('auto')
    expect(account.matchReason).toBe('object')
    expect(account.requiresTriggerBypass).toBe(false)
    expect(account.requiresAutomationDisable).toBe(true)
    expect(account.restPageSize).toBe(2000)

    // Opportunity is semi BUT carries the Contracted trip-wire → trigger bypass
    const opp = resolve('Opportunity')
    expect(opp.tier).toBe('semi')
    expect(opp.requiresTriggerBypass).toBe(true)

    // Billing + Service Cloud CPQ namespaces are gated like SBQQ
    expect(resolve('blng__Invoice__c').tier).toBe('gated')
    expect(resolve('SBQQSC__Something__c').tier).toBe('gated')

    // shipped resource carries version 1 (0 is reserved for the built-in fallback)
    expect(SHIPPED_PLAYBOOK.version).toBe(1)
  })

  it('shipped playbook — junction OCR and free unknowns', () => {
    inject(null)
    const ocr = resolve('OpportunityContactRole')
    expect(ocr.tier).toBe('junction')
    expect(ocr.requiresTriggerBypass).toBe(true)
    expect(resolve('Widget__c').tier).toBe('free')
  })

  it('explicit object entry wins over namespace rule and detected set', () => {
    const pb = JSON.parse(MINIMAL_PLAYBOOK) as Record<string, unknown>
    ;(pb['objects'] as Record<string, unknown>)['SBQQ__Quote__c'] = {
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 50,
      requiresTriggerBypass: true
    }
    inject(JSON.stringify(pb))

    const viaObject = resolve('SBQQ__Quote__c', new Set(['SBQQ__Quote__c']))
    expect(viaObject.matchReason, 'object entry beats namespace + detected').toBe('object')
    expect(viaObject.restPageSize).toBe(50)

    const viaDetected = resolve('Contract', new Set(['Contract']))
    expect(viaDetected.matchReason, 'object entry beats detected').toBe('object')
    expect(viaDetected.tier).toBe('gated')
  })

  it('namespace rule wins over detected set', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve('SBQQ__Subscription__c', new Set(['SBQQ__Subscription__c']))
    expect(pol.matchReason).toBe('namespace:SBQQ')
    expect(pol.tier).toBe('gated')
  })

  it('namespace matching is case-insensitive', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve('sbqq__Quote__c')
    expect(pol.tier).toBe('gated')
    // matchReason echoes the RULE namespace (Apex appends nr.namespace, not the parsed one)
    expect(pol.matchReason).toBe('namespace:SBQQ')
  })

  it('namespaceOf edge cases — leading __, multi-segment, blank', () => {
    expect(namespaceOf('__Foo__c'), 'leading __ (idx 0) is not a namespace').toBeNull()
    expect(namespaceOf('A__B__C__c'), 'first __ wins on multi-segment names').toBe('A')
    expect(namespaceOf(''), 'empty string').toBeNull()
    expect(namespaceOf('   '), 'whitespace-only string').toBeNull()
    expect(namespaceOf(null), 'null').toBeNull()
    expect(namespaceOf('SBQQ__'), 'trailing __ leaves nothing after → no namespace').toBeNull()
  })

  it('object lookup matches own keys only (Apex Map.get parity, no prototype chain)', () => {
    inject(MINIMAL_PLAYBOOK)
    // Object.prototype members must not resolve as playbook entries.
    for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const pol = resolve(name)
      expect(pol.matchReason, `${name} is not a playbook entry`).toBe('default')
      expect(pol.tier).toBe('free')
    }
  })

  it('null objectName resolves to the free default', () => {
    inject(MINIMAL_PLAYBOOK)
    const pol = resolve(null)
    expect(pol.tier).toBe('free')
    expect(pol.matchReason).toBe('default')
    expect(pol.objectName).toBeNull()
  })

  it('fillDefaults clamps restPageSize into the platform window [1, 2000]', () => {
    const pb = JSON.parse(MINIMAL_PLAYBOOK) as Record<string, unknown>
    ;(pb['objects'] as Record<string, unknown>)['Huge__c'] = { tier: 'free', restPageSize: 5000 }
    ;(pb['objects'] as Record<string, unknown>)['Zero__c'] = { tier: 'free', restPageSize: 0 }
    ;(pb['objects'] as Record<string, unknown>)['Neg__c'] = { tier: 'free', restPageSize: -5 }
    inject(JSON.stringify(pb))

    expect(resolve('Huge__c').restPageSize, '> 2000 clamps to 2000').toBe(2000)
    expect(resolve('Zero__c').restPageSize, '0 clamps up to the 200 composite cap').toBe(200)
    expect(resolve('Neg__c').restPageSize, 'negative clamps up to the 200 composite cap').toBe(200)
  })

  it('blank strings in defaultPolicy coalesce to free/auto', () => {
    inject(
      '{"version":1,"defaultPolicy":{"tier":"   ","apiStrategy":"",' +
        '"restPageSize":2000,"restMaxRecords":10000,"bulkBatchSize":10000}}'
    )
    const pol = resolve('Widget__c')
    expect(pol.tier, 'blank default tier → free').toBe('free')
    expect(pol.apiStrategy, 'blank default apiStrategy → auto').toBe(STRATEGY_AUTO)
    // unspecified default flags: bypass → false, automation-disable → true
    expect(pol.requiresTriggerBypass).toBe(false)
    expect(pol.requiresAutomationDisable).toBe(true)
  })

  it('parseable JSON without defaultPolicy fails open to the built-in playbook', () => {
    inject('{"version": 5}')
    expect(resolve('SBQQ__Quote__c').tier, 'built-in still gates SBQQ').toBe('gated')
    expect(resolve('OrderItem').tier, 'built-in gates OrderItem').toBe('gated')
    expect(resolve('OpportunityContactRole').tier, 'built-in OCR is junction').toBe('junction')

    inject('null')
    expect(resolve('Contract').tier, 'JSON null document fails open too').toBe('gated')

    inject('   ')
    expect(resolve('Contract').tier, 'blank override fails open too').toBe('gated')
  })

  it('decideStrategy — explicit Bulk policy routes Bulk, but zero records still REST', () => {
    const bulkPol = bare({ apiStrategy: STRATEGY_BULK })
    expect(
      decideStrategy(bulkPol, 5, 1, 10000, 50),
      'Bulk policy → Bulk for any nonzero count'
    ).toBe('Bulk')
    expect(
      decideStrategy(bulkPol, 0, 1, 10000, 50),
      'zero records overrides even a Bulk policy'
    ).toBe('REST')
    // case-insensitive strategy match (Apex equalsIgnoreCase)
    expect(decideStrategy(bare({ apiStrategy: 'bulk' }), 5, 1, 10000, 50)).toBe('Bulk')
    expect(decideStrategy(bare({ apiStrategy: 'rest' }), 999999, 80, 10, 5)).toBe('REST')
  })

  it('decideStrategy — auto falls back to recordThreshold only when policy restMaxRecords is null', () => {
    // policy restMaxRecords (10000) wins over a tighter recordThreshold (50)
    inject(MINIMAL_PLAYBOOK)
    const free = resolve('Widget__c')
    expect(
      decideStrategy(free, 100, 3, 50, 50),
      'policy restMaxRecords beats recordThreshold'
    ).toBe('REST')

    // hand-built policy without restMaxRecords uses the recordThreshold
    const noMax = bare({ apiStrategy: STRATEGY_AUTO })
    expect(decideStrategy(noMax, 100, 3, 50, 50), 'falls back to recordThreshold').toBe('Bulk')
    expect(
      decideStrategy(noMax, 100, 3, null, null),
      'null thresholds → unconstrained → REST'
    ).toBe('REST')
    expect(
      decideStrategy(noMax, 100, null, null, 50),
      'null totalObjectCount fits any objectThreshold'
    ).toBe('REST')
    // null apiStrategy behaves like auto
    expect(decideStrategy(bare(), 100, 3, 50, 50)).toBe('Bulk')
  })

  it('recommendedBatchSize — null fields fall back, REST always capped at 200', () => {
    expect(recommendedBatchSize(bare(), 'Bulk'), 'null bulkBatchSize → 10000').toBe(10000)
    expect(
      recommendedBatchSize(bare({ bulkBatchSize: 250 }), 'BULK'),
      'case-insensitive Bulk'
    ).toBe(250)
    expect(recommendedBatchSize(bare(), 'REST'), 'null restPageSize → 200 composite cap').toBe(200)
    expect(
      recommendedBatchSize(bare({ restPageSize: 2000 }), 'REST'),
      'page 2000 capped to 200'
    ).toBe(200)
    expect(recommendedBatchSize(bare({ restPageSize: 50 }), 'REST'), 'small page kept').toBe(50)
    expect(
      recommendedBatchSize(bare({ restPageSize: 50 }), null),
      'null strategy takes the REST path'
    ).toBe(50)
  })

  it('playbook cache persists until clearCache (Apex static cache parity)', () => {
    inject(MINIMAL_PLAYBOOK)
    expect(resolve('Contract').tier).toBe('gated')

    // change the override WITHOUT clearing → still served from cache
    setPlaybookJsonOverride('{"version":1,"defaultPolicy":{"tier":"free","apiStrategy":"auto"}}')
    expect(resolve('Contract').tier, 'cached playbook still in force').toBe('gated')

    clearCache()
    expect(
      resolve('Contract').matchReason,
      'new playbook (no Contract entry) after clearCache'
    ).toBe('default')
    expect(resolve('Contract').tier).toBe('free')
  })
})
