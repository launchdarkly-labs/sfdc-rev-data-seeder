import { describe, it, expect } from 'vitest'
import { KeptIds, scopeRows } from '../../src/main/engine/templates/seed/parentScope'
import { DRY_PREFIX, SeedIdMap, staleObjects } from '../../src/main/engine/templates/seed/idMap'
import { resolveRun, tiersForGroups } from '../../src/main/engine/templates/resolve'
import { SAMPLE_POST_REFRESH_TEMPLATE, SAMPLE_SEED_TEMPLATE } from '../../src/shared/templates/samples'
import { Tally, batchSizeSuggestions, decideNextAction, decideState, groupProblems, isRetryable } from '../../src/main/engine/templates/tally'

describe('parentScope', () => {
  it('subsets keep the listed roots (15/18-char tolerant) and report missing ids', () => {
    const kept = new KeptIds()
    const r = scopeRows(
      { subsets: [{ object: 'Form__c', ids: ['aB3000000000001AAA', 'aB3000000000009AAA'] }] },
      { object: 'Form__c' },
      [{ Id: 'aB3000000000001AAA' }, { Id: 'aB3000000000002AAA' }],
      kept
    )
    expect(r.rows.map((x) => x.Id)).toEqual(['aB3000000000001AAA'])
    expect(r.droppedBySubset).toBe(1)
    expect(r.missingSubsetIds).toEqual(['aB3000000000009AAA'])
    expect(kept.has('Form__c', 'aB3000000000001AAA')).toBe(true)
  })

  it('parentScope keeps rows whose ANY listed lookup points at a kept parent', () => {
    const kept = new KeptIds()
    kept.add('Form__c', ['f1'])
    kept.add('Step__c', ['s1'])
    const r = scopeRows(
      { subsets: [] },
      {
        object: 'Rule__c',
        parentScope: { anyOf: [{ field: 'Form__c', object: 'Form__c' }, { field: 'Step__c', object: 'Step__c' }] }
      },
      [
        { Id: 'r1', Form__c: 'f1', Step__c: null },
        { Id: 'r2', Form__c: null, Step__c: 's1' },
        { Id: 'r3', Form__c: 'f9', Step__c: 's9' }
      ],
      kept
    )
    expect(r.rows.map((x) => x.Id)).toEqual(['r1', 'r2'])
    expect(r.droppedByParent).toBe(1)
  })
})

describe('SeedIdMap', () => {
  it('tracks per object, excludes dry markers and resumed rows from persistable()', () => {
    const m = new SeedIdMap([{ objectApiName: 'A', sourceId: 'a0', targetId: 't0' }])
    m.set('A', 'a1', 't1')
    m.set('A', 'a2', `${DRY_PREFIX}a2`)
    m.set('B', 'b1', 'u1')
    expect(m.resumed.has('a0')).toBe(true)
    expect(m.loadedCount('A')).toBe(3)
    expect(m.targetIds('A')).toEqual(['t0', 't1'])
    expect(m.persistable('A')).toEqual([{ objectApiName: 'A', sourceId: 'a1', targetId: 't1' }])
    expect(m.get('b1')).toBe('u1')
    expect(staleObjects([{ object: 'A', target: 3, mapped: 3 }, { object: 'B', target: 2, mapped: 1 }])).toEqual(['B: target 2, id map 1'])
  })
})

describe('resolveRun', () => {
  const seeds = new Map<string, unknown>([['Acme CPQ configuration', SAMPLE_SEED_TEMPLATE]])
  it('a seed template runs itself; groups filter tiers', () => {
    const r = resolveRun({
      kind: 'seed',
      name: 'Acme CPQ configuration',
      payload: SAMPLE_SEED_TEMPLATE,
      steps: { automation: false, seeds: [{ name: 'Acme CPQ configuration', groups: ['forms'] }], optInPatches: [] },
      seedTemplatesByName: seeds
    })
    expect(r.blockers).toEqual([])
    expect(r.seeds[0]!.tiers.map((t) => t.object)).toEqual(['Acme_Form__c', 'Acme_Form_Step__c', 'Acme_Form_Field__c', 'Acme_Form_Rule__c'])
    expect(tiersForGroups(SAMPLE_SEED_TEMPLATE, [])).toHaveLength(36)
  })
  it('a post-refresh template resolves the seeds it names, applies opt-in patches, and embeds the snapshot', () => {
    const r = resolveRun({
      kind: 'postRefresh',
      name: 'Acme dev sandbox',
      payload: SAMPLE_POST_REFRESH_TEMPLATE,
      steps: { automation: true, seeds: [{ name: 'Acme CPQ configuration', groups: [] }], optInPatches: [] },
      seedTemplatesByName: seeds
    })
    expect(r.blockers).toEqual([])
    expect(r.automation).toBe(true)
    expect(r.settingPatches.map((p) => p.label)).toEqual(['Disable the chat integration workspace']) // opt-in one not ticked
    expect(r.seeds[0]!.groups).toEqual(['default', 'forms']) // from the template's ref
    expect((r.snapshot as { embeddedSeedTemplates: unknown[] }).embeddedSeedTemplates).toHaveLength(1)
    const withOptIn = resolveRun({
      kind: 'postRefresh',
      name: 'Acme dev sandbox',
      payload: SAMPLE_POST_REFRESH_TEMPLATE,
      steps: { automation: true, seeds: [], optInPatches: ['Clear chat user ids so flows cannot message real people'] },
      seedTemplatesByName: seeds
    })
    expect(withOptIn.settingPatches).toHaveLength(2)
    expect(withOptIn.seeds).toEqual([]) // not selected
  })
  it('a missing or invalid seed template is a blocker', () => {
    const r = resolveRun({
      kind: 'postRefresh',
      name: 'P',
      payload: SAMPLE_POST_REFRESH_TEMPLATE,
      steps: { automation: true, seeds: [{ name: 'Acme CPQ configuration', groups: [] }], optInPatches: [] },
      seedTemplatesByName: new Map([['Acme CPQ configuration', { schemaVersion: 1 }]])
    })
    expect(r.blockers[0]).toMatch(/not valid/)
    const r2 = resolveRun({ ...{ kind: 'postRefresh' as const, name: 'P', payload: SAMPLE_POST_REFRESH_TEMPLATE }, steps: { automation: true, seeds: [{ name: 'Acme CPQ configuration', groups: [] }], optInPatches: [] }, seedTemplatesByName: new Map() })
    expect(r2.blockers[0]).toMatch(/does not exist/)
  })
})

describe('Tally + summary', () => {
  it('matches expected failures by object + substring, groups, and suggests batch sizes', () => {
    const t = new Tally()
    t.configure([{ object: 'Product2', contains: 'Phase Category', why: 'known VR' }, { object: null, contains: 'orphan', why: 'orphan rows' }])
    t.add('seed', 'Product2', 'p1', 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phase Category is required')
    t.add('seed', 'Other__c', 'o1', 'orphan junction row')
    t.add('seed', 'Other__c', 'o2', 'boom')
    t.add('seed', 'Other__c', 'o3', 'boom again')
    expect(t.expected()).toHaveLength(2)
    expect(t.unexpected()).toHaveLength(2)
    expect(groupProblems(t.unexpected())).toEqual([{ step: 'seed', object: 'Other__c', count: 2, example: 'boom', why: null }])
    // S61 U-8: unexpected problems after a run that ran to the end → partial; a run that did not finish → failed.
    expect(decideState({ blocked: false, cancelled: false, unexpected: 2, completed: true })).toBe('partial')
    expect(decideState({ blocked: false, cancelled: false, unexpected: 2, completed: false })).toBe('failed')
    expect(decideState({ blocked: true, cancelled: false, unexpected: 0, completed: false })).toBe('blocked')
    expect(decideState({ blocked: false, cancelled: true, unexpected: 0, completed: false })).toBe('cancelled')
    expect(decideState({ blocked: false, cancelled: false, unexpected: 0, completed: true })).toBe('clean')
    expect(decideNextAction({ state: 'partial', unexpected: t.unexpected(), mode: 'apply', unrestoredTemporary: 0 })).toBe('resume')
    // S61 U-7: a Resume is only suggested when some seed-side problem could come out differently.
    const nonRetryable = [
      { step: 'seed' as const, object: 'sbaa__Approver__c', recordId: 'a1', message: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id: 005x', expected: false, why: null },
      { step: 'relink' as const, object: 'Product2', recordId: 'p1', message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phase Category is required', expected: false, why: null },
      { step: 'seed' as const, object: 'X__c', recordId: 'x1', message: 'skipped: attachment missing in source (orphan row)', expected: false, why: null }
    ]
    expect(nonRetryable.map(isRetryable)).toEqual([false, false, false])
    expect(isRetryable({ message: 'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record' })).toBe(true)
    expect(decideNextAction({ state: 'partial', unexpected: nonRetryable, mode: 'apply', unrestoredTemporary: 0 })).toBe('fixAndRerun')
    expect(decideNextAction({ state: 'partial', unexpected: [...nonRetryable, { step: 'seed', object: 'Y__c', recordId: 'y1', message: 'UNABLE_TO_LOCK_ROW', expected: false, why: null }], mode: 'apply', unrestoredTemporary: 0 })).toBe('resume')
    expect(decideNextAction({ state: 'failed', unexpected: [], mode: 'apply', unrestoredTemporary: 2 })).toBe('restoreTargetAutomation')
    expect(decideNextAction({ state: 'failed', unexpected: [{ step: 'automation', object: null, recordId: null, message: 'x', expected: false, why: null }], mode: 'apply', unrestoredTemporary: 0 })).toBe('rerunAutomation')
    expect(decideNextAction({ state: 'clean', unexpected: [], mode: 'dry-run', unrestoredTemporary: 0 })).toBe('none')
    const base = { group: 'default', source: 0, loaded: 0, failed: 0, skipped: 0, nulled: 0, fields: 0, resumed: 0, failures: [], skips: [], nulledFields: {}, noAccess: [], missingOnTarget: [], skippedObject: null, note: null, pruned: null, bytes: null }
    expect(
      batchSizeSuggestions(
        [
          { ...base, object: 'SBQQ__BlockPrice__c', savedOnSingleRetry: 12, bulkOnlyFailures: 0 },
          { ...base, object: 'SBQQ__ProductRule__c', savedOnSingleRetry: 0, bulkOnlyFailures: 3 },
          { ...base, object: 'Fine__c', savedOnSingleRetry: 0, bulkOnlyFailures: 0 }
        ],
        [{ object: 'SBQQ__PriceRule__c', updates: 1, updated: 1, failed: 0, fields: [], failures: [], savedOnSingleRetry: 2 }]
      ).map((s) => s.object)
    ).toEqual(['SBQQ__BlockPrice__c', 'SBQQ__ProductRule__c', 'SBQQ__PriceRule__c'])
  })
})
