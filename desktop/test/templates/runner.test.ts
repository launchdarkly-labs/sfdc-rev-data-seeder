/**
 * runTemplate over a fake TemplateIo — the end-to-end engine contract:
 * a dry run writes nothing; blocked preflights stop an apply; a seed apply
 * remaps ids tier by tier, runs the second pass, relinks, verifies; temporary
 * target automation is restored even when the seed fails; cancel leaves a map.
 */
import { describe, it, expect } from 'vitest'
import { runTemplate } from '../../src/main/engine/templates/runner'
import { resolveRun } from '../../src/main/engine/templates/resolve'
import { emptySeedTemplate, type SeedTemplate, type PostRefreshTemplate } from '../../src/shared/templates/types'
import { FakeLedger, FakeOrg, fakeIo, fld, ref } from './fakes'

const DESCRIBES = {
  Rule__c: [fld('Name'), fld('Active__c', { type: 'boolean' }), ref('Parent__c', 'Rule__c'), ref('Owner__c', 'User')],
  Condition__c: [fld('Name'), ref('Rule__c', 'Rule__c', { nillable: false }), ref('Account__c', 'Account')],
  Product2: [fld('Name'), ref('Rule__c', 'Rule__c')]
}

const TEMPLATE: SeedTemplate = {
  ...emptySeedTemplate(),
  keepIdTargets: ['User', 'Product2'],
  copiedObjectsMustMatchSource: ['Product2'],
  relinkCopiedObjects: [{ object: 'Product2', optionalFields: [] }],
  deferredFields: { Rule__c: ['Active__c'] },
  tiers: [{ object: 'Rule__c' }, { object: 'Condition__c', batchSize: 50 }],
  expectedFailures: [{ object: 'Condition__c', contains: 'KNOWN', why: 'a known VR' }]
}

function source(): FakeOrg {
  return new FakeOrg({
    orgId: '00DSRC000000000AAA',
    label: 'src',
    describes: DESCRIBES,
    rows: {
      Rule__c: [
        { Id: 'r1', Name: 'Rule 1', Active__c: true, Parent__c: null, Owner__c: '005u' },
        { Id: 'r2', Name: 'Rule 2', Active__c: true, Parent__c: 'r1', Owner__c: '005u' }
      ],
      Condition__c: [
        { Id: 'c1', Name: 'C1', Rule__c: 'r1', Account__c: '001gone' },
        { Id: 'c2', Name: 'C2', Rule__c: 'r2', Account__c: null },
        { Id: 'c3', Name: 'KNOWN', Rule__c: 'r9', Account__c: null } // parent never loaded → skipped (required)
      ],
      Product2: [{ Id: 'p1', Name: 'P', Rule__c: 'r1' }]
    }
  })
}

function target(over: Partial<ConstructorParameters<typeof FakeOrg>[0]> = {}): FakeOrg {
  return new FakeOrg({
    orgId: '00DTGT000000000AAA',
    label: 'sb',
    describes: DESCRIBES,
    rows: { Product2: [{ Id: 'p1', Name: 'P', Rule__c: 'r1' }] },
    isSandbox: true,
    ...over
  })
}

const steps = { automation: false, seeds: [{ name: 'T', groups: [] }], optInPatches: [] }
const resolved = (t: SeedTemplate = TEMPLATE) =>
  resolveRun({ kind: 'seed', name: 'T', payload: t, steps, seedTemplatesByName: new Map() })

const baseOpts = {
  disableTargetAutomation: false,
  cpqAttestation: false,
  purge: false,
  resume: false,
  targetStoredRole: 'target',
  sourceStoredRole: 'source',
  lockConflict: null
}

describe('runTemplate — seed', () => {
  it('a DRY RUN plans every tier and writes nothing', async () => {
    const src = source()
    const tgt = target()
    const io = fakeIo({ source: src, target: tgt })
    const ledger = new FakeLedger()
    const report = await runTemplate(io, resolved(), ledger, { ...baseOpts, mode: 'dry-run' })
    // c3's skip (parent never loaded) is an UNEXPECTED problem → the dry run is 'failed', honestly.
    expect(report.state).toBe('partial') // the c3 skip is unexpected; the dry run still ran to the end (U-8)
    expect(tgt.writes).toEqual([])
    expect(ledger.idMap).toEqual([])
    expect(report.seed.map((s) => `${s.object}:${s.source}/${s.loaded}/${s.skipped}`)).toEqual(['Rule__c:2/2/0', 'Condition__c:3/2/1'])
    // The skipped row's reason is an EXPECTED failure (matches 'KNOWN'? no — the message is about the parent).
    expect(report.seed[1]!.skips[0]!.message).toMatch(/required Rule__c → r9 was not loaded/)
    expect(report.secondPass.map((s) => `${s.object}:${s.updates}:${s.fields.join('+')}`)).toEqual(['Rule__c:2:Active__c+Parent__c'])
    expect(report.verify).toBeNull()
    expect(report.summary.unexpected).toBe(1) // the skip
  })

  it('an APPLY remaps ids tier by tier, defers self-references, relinks copied objects and verifies', async () => {
    const src = source()
    const tgt = target()
    const io = fakeIo({ source: src, target: tgt })
    const ledger = new FakeLedger()
    const report = await runTemplate(io, resolved(), ledger, { ...baseOpts, mode: 'apply' })
    expect(report.state).toBe('partial') // c3 skipped (unexpected) — but every step ran to the end (U-8)
    const rules = tgt.rows.Rule__c!
    expect(rules).toHaveLength(2)
    // First pass: Active__c false (deferred boolean), Parent__c null (self-ref deferred), Owner__c kept.
    const firstInsert = tgt.writes.find((w) => w.object === 'Rule__c' && w.method === 'POST')!
    expect(firstInsert.records[0]).toEqual({ Name: 'Rule 1', Active__c: false, Parent__c: null, Owner__c: '005u' })
    // Second pass: Active__c true, Parent__c remapped to the new id of r1.
    const r1New = ledger.idMap.find((m) => m.sourceId === 'r1')!.targetId
    const patch = tgt.writes.find((w) => w.object === 'Rule__c' && w.method === 'PATCH')!
    expect(patch.records.find((r) => r.Parent__c != null)!.Parent__c).toBe(r1New)
    expect(patch.records.every((r) => r.Active__c === true)).toBe(true)
    // Conditions: Rule__c remapped, Account__c (check, missing on target) nulled.
    const condInsert = tgt.writes.find((w) => w.object === 'Condition__c' && w.method === 'POST')!
    expect(condInsert.records[0]).toEqual({ Name: 'C1', Rule__c: r1New, Account__c: null })
    expect(report.seed[1]!.nulledFields).toEqual({ Account__c: 1 })
    // Relink: Product2.Rule__c → the new rule id.
    const relink = tgt.writes.find((w) => w.object === 'Product2' && w.method === 'PATCH')!
    expect(relink.records).toEqual([{ Id: 'p1', Rule__c: r1New }])
    expect(report.relink[0]!.updated).toBe(1)
    // Id map persisted per tier.
    expect(ledger.idMap.map((m) => m.objectApiName)).toEqual(['Rule__c', 'Rule__c', 'Condition__c', 'Condition__c'])
    // Verify ran: counts + parity (second-pass values now match the source).
    expect(report.verify!.counts.map((c) => `${c.object}:${c.gap}`)).toEqual(['Rule__c:false', 'Condition__c:true'])
    expect(report.verify!.parity[0]).toMatchObject({ object: 'Rule__c', checked: 2, mismatches: 0 })
    expect(report.summary.batchSizeSuggestions).toEqual([])
  })

  it('preflight blockers stop an APPLY before any write (not a sandbox; wrong role; same org; existing rows)', async () => {
    const src = source()
    const tgt = target({ isSandbox: false, rows: { Product2: [{ Id: 'p1' }], Rule__c: [{ Id: 'x' }] } })
    const io = fakeIo({ source: src, target: tgt })
    const ledger = new FakeLedger()
    const report = await runTemplate(io, resolved(), ledger, { ...baseOpts, mode: 'apply', targetStoredRole: 'unassigned' })
    expect(report.state).toBe('blocked')
    expect(report.preflight.blockers.join('\n')).toMatch(/stored role is 'unassigned'/)
    expect(report.preflight.blockers.join('\n')).toMatch(/not a sandbox/)
    expect(tgt.writes).toEqual([])
    // Existing rows surface inside the seed preflight (reached only when the outer preflight passes).
    const tgt2 = target({ rows: { Product2: [{ Id: 'p1' }], Rule__c: [{ Id: 'x', Name: 'old' }] } })
    const report2 = await runTemplate(fakeIo({ source: source(), target: tgt2 }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'apply' })
    expect(report2.state).toBe('blocked')
    expect(report2.preflight.blockers.join('\n')).toMatch(/already holds rows in 1 seed object/)
    expect(tgt2.writes).toEqual([])
    // Copied objects that do not match the source (zero tolerance so one missing row blocks).
    const tgt3 = target({ rows: { Product2: [] } })
    const strict = { ...TEMPLATE, copiedMatchTolerance: { absolute: 0, fraction: 0 } }
    const report3 = await runTemplate(fakeIo({ source: source(), target: tgt3 }), resolved(strict), new FakeLedger(), { ...baseOpts, mode: 'apply' })
    expect(report3.preflight.blockers.join('\n')).toMatch(/Product2: 1 of 1 source records are missing/)
    // The default tolerance (5 absolute) lets one missing row through.
    const tgt4 = target({ rows: { Product2: [] } })
    const report4 = await runTemplate(fakeIo({ source: source(), target: tgt4 }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'dry-run' })
    expect(report4.preflight.blockers).toEqual([])
  })

  it('PURGE deletes existing rows children-first, drops their id-map rows, then seeds', async () => {
    const tgt = target({ rows: { Product2: [{ Id: 'p1', Name: 'P', Rule__c: 'r1' }], Rule__c: [{ Id: 'oldR' }], Condition__c: [{ Id: 'oldC', Rule__c: 'oldR' }] } })
    const ledger = new FakeLedger([{ objectApiName: 'Rule__c', sourceId: 'zz', targetId: 'oldR' }])
    const report = await runTemplate(fakeIo({ source: source(), target: tgt }), resolved(), ledger, { ...baseOpts, mode: 'apply', purge: true })
    expect(report.purge!.map((p) => `${p.object}:${p.deleted}`)).toEqual(['Condition__c:1', 'Rule__c:1'])
    expect(tgt.writes[0]!.method).toBe('DELETE')
    expect(ledger.idMap.find((m) => m.sourceId === 'zz')).toBeUndefined()
    expect(report.seed[0]!.loaded).toBe(2)
  })

  it('RESUME loads only unmapped rows, reconciles second-pass values, and the stale guard blocks a bad map', async () => {
    // First apply.
    const src = source()
    const tgt = target()
    const ledger = new FakeLedger()
    await runTemplate(fakeIo({ source: src, target: tgt }), resolved(), ledger, { ...baseOpts, mode: 'apply' })
    const writesBefore = tgt.writes.length
    // Add a new source rule and resume: only it loads; Conditions pointing at it follow.
    src.rows.Rule__c!.push({ Id: 'r3', Name: 'Rule 3', Active__c: false, Parent__c: null, Owner__c: null })
    const report = await runTemplate(fakeIo({ source: src, target: tgt }), resolved(), ledger, { ...baseOpts, mode: 'apply', resume: true })
    expect(report.seed[0]!.resumed).toBe(2)
    expect(report.seed[0]!.loaded).toBe(1)
    expect(tgt.writes.length).toBeGreaterThan(writesBefore)
    expect(tgt.rows.Rule__c).toHaveLength(3)
    // Stale guard: a map that disagrees with the target blocks.
    ledger.idMap.push({ objectApiName: 'Rule__c', sourceId: 'ghost', targetId: 'nope' })
    const blocked = await runTemplate(fakeIo({ source: src, target: tgt }), resolved(), ledger, { ...baseOpts, mode: 'apply', resume: true })
    expect(blocked.state).toBe('blocked')
    expect(blocked.preflight.blockers.join('\n')).toMatch(/id map does not match the target/)
  })

  it('D3a: temporary target automation is disabled before tier 1 and restored even when the seed throws', async () => {
    const src = source()
    const tgt = target({
      onToolingQuery: (soql) => {
        if (/FROM ValidationRule/.test(soql)) return [{ Id: '03dVR', ValidationName: 'Rule_VR', EntityDefinition: { QualifiedApiName: 'Rule__c' } }]
        if (/FROM ApexTrigger/.test(soql)) return [{ Id: '01qT', Name: 'RuleTrigger', TableEnumOrId: 'Rule__c', NamespacePrefix: null }]
        return []
      },
      onQuery: (soql) => (/FROM FlowDefinitionView/.test(soql) ? [] : undefined),
      onCallout: (path, method, body) => {
        // VR GET → a Metadata block; PATCHes succeed; trigger body fetch → a body; container flow → Completed.
        if (/ValidationRule\/03dVR$/.test(path) && method === 'GET') return { success: true, statusCode: 200, body: JSON.stringify({ Metadata: { active: true } }) }
        if (/tooling\/composite/.test(path)) {
          const sub = JSON.parse(body ?? '{}').compositeRequest as Array<{ method: string }>
          return { success: true, statusCode: 200, body: JSON.stringify({ compositeResponse: sub.map((s) => ({ httpStatusCode: s.method === 'GET' ? 200 : 204, body: { Metadata: { active: true } } })) }) }
        }
        if (/query\/\?q=SELECT\+Id%2C\+Body/.test(path)) return { success: true, statusCode: 200, body: JSON.stringify({ records: [{ Id: '01qT', Body: 'trigger RuleTrigger on Rule__c (before insert) { x(); }' }] }) }
        if (/query\/\?q=SELECT\+State/.test(path)) return { success: true, statusCode: 200, body: JSON.stringify({ records: [{ State: 'Completed' }] }) }
        if (/MetadataContainer\/$/.test(path)) return { success: true, statusCode: 201, body: JSON.stringify({ id: '1dc1' }) }
        if (/ContainerAsyncRequest\/$/.test(path)) return { success: true, statusCode: 201, body: JSON.stringify({ id: '1dr1' }) }
        return { success: true, statusCode: 200, body: '{}' }
      }
    })
    // Make the seed itself blow up on the first collections call.
    const orig = tgt.collections.bind(tgt)
    tgt.collections = async () => {
      throw new Error('kaboom')
    }
    const io = fakeIo({ source: src, target: tgt })
    const ledger = new FakeLedger()
    const report = await runTemplate(io, resolved(), ledger, { ...baseOpts, mode: 'apply', disableTargetAutomation: true })
    tgt.collections = orig
    expect(report.state).toBe('failed')
    expect(report.problems.some((p) => p.message === 'kaboom')).toBe(true)
    expect(report.targetAutomation!.planned).toBe(2)
    expect(report.targetAutomation!.disabled).toBe(2)
    expect(report.targetAutomation!.restored).toBe(2)
    expect(report.targetAutomation!.unconfirmed).toBe(0)
    expect(ledger.changes.filter((c) => c.mode === 'temporary')).toHaveLength(2)
    expect(ledger.changes.every((c) => c.confirmed)).toBe(true)
    expect(io.phases).toContain('Disabling target automation')
    expect(io.phases).toContain('Restoring target automation')
    expect(report.summary.nextAction).toBe('resume')
  })

  it('cancel between tiers leaves the id map and ends cancelled', async () => {
    const src = source()
    const tgt = target()
    const io = fakeIo({ source: src, target: tgt })
    // Cancel as soon as the first tier logs its summary.
    const origLog = io.log
    io.log = (level, m) => {
      origLog(level, m)
      if (/^Rule__c: source/.test(m)) io.cancel()
    }
    const ledger = new FakeLedger()
    const report = await runTemplate(io, resolved(), ledger, { ...baseOpts, mode: 'apply' })
    expect(report.state).toBe('cancelled')
    expect(report.seed).toHaveLength(1)
    expect(ledger.idMap).toHaveLength(2)
    expect(report.summary.nextAction).toBe('resume')
  })

  it('expected failures are counted but do not fail the run', async () => {
    const src = source()
    src.rows.Condition__c = src.rows.Condition__c!.filter((c) => c.Id !== 'c3')
    const tgt = target({
      onWrite: (_m, object, r) => (object === 'Condition__c' && r.Name === 'C2' ? { success: false, id: null, error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: KNOWN rule', statusCode: null } : undefined)
    })
    const report = await runTemplate(fakeIo({ source: src, target: tgt }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'apply' })
    expect(report.problems.filter((p) => !p.expected)).toEqual([])
    expect(report.state).toBe('clean')
    expect(report.summary.expected).toBe(1)
    expect(report.summary.expectedGroups[0]).toMatchObject({ step: 'seed', object: 'Condition__c', why: 'a known VR' })
    // Verify's count gap on Condition__c is not re-reported (the object already has a problem).
    expect(report.problems.filter((p) => p.step === 'verify')).toEqual([])
  })
  it('U-11: a seed preflight that blocks (existing rows) never touches the target automation', async () => {
    const tgt = target({
      rows: { Product2: [{ Id: 'p1', Name: 'P', Rule__c: 'r1' }], Rule__c: [{ Id: 'x', Name: 'old' }] },
      onToolingQuery: (soql) => (/FROM ValidationRule/.test(soql) ? [{ Id: '03dVR', ValidationName: 'Rule_VR', EntityDefinition: { QualifiedApiName: 'Rule__c' } }] : []),
      onQuery: (soql) => (/FROM FlowDefinitionView/.test(soql) ? [] : undefined)
    })
    const io = fakeIo({ source: source(), target: tgt })
    const report = await runTemplate(io, resolved(), new FakeLedger(), { ...baseOpts, mode: 'apply', disableTargetAutomation: true })
    expect(report.state).toBe('blocked')
    expect(report.preflight.blockers.join('\n')).toMatch(/already holds rows/)
    expect(report.targetAutomation).toBeNull()
    expect(tgt.callouts).toEqual([])
    expect(tgt.writes).toEqual([])
    expect(io.phases).not.toContain('Disabling target automation')
  })

  it('U-12: a child delete the package trigger refuses is forgiven when the parent’s cascade removes the rows; children are still tried FIRST', async () => {
    const describes = {
      ...DESCRIBES,
      Condition__c: [fld('Name'), ref('Rule__c', 'Rule__c', { nillable: false, cascadeDelete: true }), ref('Account__c', 'Account')]
    }
    const mk = (): FakeOrg =>
      new FakeOrg({
        orgId: '00DTGT000000000AAA',
        label: 'sb',
        describes,
        isSandbox: true,
        rows: { Product2: [{ Id: 'p1', Name: 'P', Rule__c: 'r1' }], Rule__c: [{ Id: 'oldR' }], Condition__c: [{ Id: 'oldC', Rule__c: 'oldR' }] },
        // Advanced Approvals' delete trigger: a direct child delete is refused while the parent still references its index.
        onDelete: (id) => (id === 'oldC' ? { success: false, id: null, error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION:  Condition Index Number 110 does not exist.', statusCode: null } : undefined)
      })
    const src = new FakeOrg({ ...source().opts, describes })
    src.rows.Condition__c = src.rows.Condition__c!.filter((c) => c.Id !== 'c3') // the base fixture's unexpected skip
    // Dry run: plain plan rows, children first.
    const dry = await runTemplate(fakeIo({ source: src, target: mk() }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'dry-run', purge: true })
    expect(dry.purge).toEqual([
      { object: 'Condition__c', deleted: 1, failed: 0 },
      { object: 'Rule__c', deleted: 1, failed: 0 }
    ])
    // Apply: the child is TRIED first (CPQ refuses to delete a quote template while it has line
    // columns, so a child must never be skipped), the trigger refuses it, the parent delete cascades
    // it away, the re-count forgives the refusal, nothing is a problem, the seed proceeds.
    const tgt = mk()
    const ledger = new FakeLedger([{ objectApiName: 'Condition__c', sourceId: 'zz', targetId: 'oldC' }])
    const report = await runTemplate(fakeIo({ source: src, target: tgt }), resolved(), ledger, { ...baseOpts, mode: 'apply', purge: true })
    expect(report.state).toBe('clean')
    expect(report.purge).toEqual([
      { object: 'Condition__c', deleted: 1, failed: 0, via: '1 direct delete refused by a trigger; removed by the parent’s cascade' },
      { object: 'Rule__c', deleted: 1, failed: 0 }
    ])
    const deletes = tgt.writes.filter((w) => w.method === 'DELETE')
    expect(deletes.map((d) => d.records)).toEqual([[{ Id: 'oldC' }], [{ Id: 'oldR' }]])
    expect(ledger.idMap.find((m) => m.sourceId === 'zz')).toBeUndefined()
    expect(report.problems.filter((p) => p.step === 'purge')).toEqual([])
    expect(report.seed[0]!.loaded).toBe(2)
  })

  it('U-12: a refused delete that NO cascade cures stays a purge problem and the leftover check blocks the seed', async () => {
    const tgt = target({
      rows: { Product2: [{ Id: 'p1', Name: 'P', Rule__c: 'r1' }], Rule__c: [{ Id: 'oldR' }], Condition__c: [{ Id: 'oldC', Rule__c: 'oldR' }] },
      // plain lookup (no cascade) and the trigger refuses the child
      onDelete: (id) => (id === 'oldC' ? { success: false, id: null, error: 'DELETE_FAILED: refused', statusCode: null } : undefined)
    })
    const report = await runTemplate(fakeIo({ source: source(), target: tgt }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'apply', purge: true })
    expect(report.state).toBe('blocked')
    expect(report.preflight.blockers.join('\n')).toMatch(/Rows still present after the purge.*Condition__c \(1\)/)
    expect(report.problems.filter((p) => p.step === 'purge')).toHaveLength(1)
    expect(report.seed).toEqual([])
  })

  it('U-6: dangling lookups left by KNOWN relink failures are expected, not a second problem', async () => {
    const t: SeedTemplate = {
      ...TEMPLATE,
      expectedFailures: [...TEMPLATE.expectedFailures, { object: 'Product2', contains: 'Phase Category', why: 'a package VR the same products fail in the source' }]
    }
    const tgt = target({
      onWrite: (m, object) =>
        m === 'PATCH' && object === 'Product2' ? { success: false, id: null, error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phase Category is required', statusCode: null } : undefined
    })
    const src = source()
    src.rows.Condition__c = src.rows.Condition__c!.filter((c) => c.Id !== 'c3')
    const report = await runTemplate(fakeIo({ source: src, target: tgt }), resolved(t), new FakeLedger(), { ...baseOpts, mode: 'apply' })
    expect(report.relink[0]).toMatchObject({ object: 'Product2', failed: 1 })
    expect(report.verify!.dangling).toEqual([{ object: 'Product2', field: 'Rule__c', count: 1, known: 1 }])
    expect(report.problems.filter((p) => p.step === 'verify' && !p.expected)).toEqual([])
    expect(report.problems.find((p) => p.step === 'verify' && p.expected)?.why).toMatch(/package VR/)
    expect(report.state).toBe('clean')
    expect(report.summary.nextAction).toBe('none')
  })

  it('U-7 / U-8: rows that cannot be written as they are make the run PARTIAL and do not suggest Resume', async () => {
    const src = source()
    src.rows.Condition__c = src.rows.Condition__c!.filter((c) => c.Id !== 'c3')
    const tgt = target({
      onWrite: (_m, object, r) =>
        object === 'Condition__c' && r.Name === 'C2'
          ? { success: false, id: null, error: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id: 005x', statusCode: null }
          : undefined
    })
    const report = await runTemplate(fakeIo({ source: src, target: tgt }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'apply' })
    expect(report.state).toBe('partial')
    expect(report.summary.unexpected).toBe(1)
    expect(report.summary.nextAction).toBe('fixAndRerun')
    // A transient class on the same row would still be a Resume.
    const tgt2 = target({
      onWrite: (_m, object, r) => (object === 'Condition__c' && r.Name === 'C2' ? { success: false, id: null, error: 'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access', statusCode: null } : undefined)
    })
    const report2 = await runTemplate(fakeIo({ source: source(), target: tgt2 }), resolved(), new FakeLedger(), { ...baseOpts, mode: 'apply' })
    expect(report2.state).toBe('partial')
    expect(report2.summary.nextAction).toBe('resume')
  })

})

describe('runTemplate — post-refresh automation', () => {
  const PR: PostRefreshTemplate = {
    schemaVersion: 1,
    automation: {
      flows: [{ apiName: 'Acme_Notify', action: 'deactivate' }, { apiName: 'Gone', action: 'deactivate' }],
      triggers: [{ name: 'AcmeOrderSync', action: 'commentOut' }],
      settingPatches: [{ label: 'Prefix the key', object: 'Setting__c', field: 'Key__c', transform: { kind: 'prefix', value: 'SBOFF_' } }]
    },
    seedTemplates: [],
    verify: { safetyCheck: true }
  }
  const prSteps = { automation: true, seeds: [], optInPatches: [] }

  function prTarget(): FakeOrg {
    let flowActive = true
    let body = 'trigger AcmeOrderSync on Order (after insert) { run(); }'
    const tgt = new FakeOrg({
      orgId: '00DTGT000000000AAA',
      label: 'sb',
      isSandbox: true,
      describes: { Setting__c: [fld('Key__c', { length: 25 })] },
      rows: { Setting__c: [{ Id: 's1', Key__c: 'T123' }, { Id: 's2', Key__c: 'SBOFF_T9' }] },
      onQuery: (soql) => {
        if (/FROM FlowDefinitionView/.test(soql))
          return [{ DurableId: 'd1', ApiName: 'Acme_Notify', Label: 'N', IsActive: flowActive, VersionNumber: flowActive ? 3 : null, NamespacePrefix: null }]
        if (/FROM FlowVersionView/.test(soql)) return [{ FlowDefinitionViewId: 'd1', VersionNumber: 3 }]
        return undefined
      },
      onToolingQuery: (soql) => {
        if (/FROM ApexTrigger/.test(soql)) return [{ Id: '01qT', Name: 'AcmeOrderSync', TableEnumOrId: 'Order', Status: 'Active', NamespacePrefix: null, Body: body }]
        if (/FROM FlowDefinition WHERE/.test(soql)) return [{ Id: '300d1', LatestVersionId: '301v3' }]
        return []
      },
      onCallout: (path, method, b) => {
        if (/FlowDefinition\/300d1$/.test(path) && method === 'GET') return { success: true, statusCode: 200, body: JSON.stringify({ Metadata: { activeVersionNumber: 3 } }) }
        if (/FlowDefinition\/300d1\?_HttpMethod=PATCH/.test(path)) {
          flowActive = false
          return { success: true, statusCode: 204, body: '' }
        }
        if (/query\/\?q=SELECT\+Id%2C\+Name%2C\+Body/.test(path)) return { success: true, statusCode: 200, body: JSON.stringify({ records: [{ Id: '01qT', Name: 'AcmeOrderSync', Body: body, ApiVersion: 62, Status: 'Active' }] }) }
        if (/ApexTriggerMember\/$/.test(path)) {
          body = (JSON.parse(b ?? '{}') as { Body: string }).Body
          return { success: true, statusCode: 201, body: '{}' }
        }
        if (/MetadataContainer\/$/.test(path)) return { success: true, statusCode: 201, body: JSON.stringify({ id: '1dc1' }) }
        if (/ContainerAsyncRequest\/$/.test(path)) return { success: true, statusCode: 201, body: JSON.stringify({ id: '1dr1' }) }
        if (/query\/\?q=SELECT\+State/.test(path)) return { success: true, statusCode: 200, body: JSON.stringify({ records: [{ State: 'Completed' }] }) }
        return { success: true, statusCode: 200, body: '{}' }
      }
    })
    return tgt
  }

  it('dry run plans; apply changes, patches, and the safety check re-reads clean', async () => {
    const tgt = prTarget()
    const r = resolveRun({ kind: 'postRefresh', name: 'P', payload: PR, steps: prSteps, seedTemplatesByName: new Map() })
    const ledger = new FakeLedger()
    const dry = await runTemplate(fakeIo({ target: tgt }), r, ledger, { ...baseOpts, mode: 'dry-run', sourceStoredRole: null })
    expect(dry.automation.map((a) => `${a.name}:${a.result}`)).toEqual(['Acme_Notify:planned', 'Gone:notFound', 'AcmeOrderSync:planned'])
    expect(dry.settingPatches[0]).toMatchObject({ rows: 2, alreadyPatched: 1, result: 'planned' })
    expect(tgt.writes).toEqual([])
    expect(dry.state).toBe('partial') // 'Gone' not found is unexpected; the run ran to the end (U-8)
    expect(dry.summary.unexpectedGroups[0]!.example).toMatch(/not in this org/)

    const apply = await runTemplate(fakeIo({ target: tgt }), r, ledger, { ...baseOpts, mode: 'apply', sourceStoredRole: null })
    expect(apply.automation.map((a) => `${a.name}:${a.result}`)).toEqual(['Acme_Notify:changed', 'Gone:notFound', 'AcmeOrderSync:changed'])
    expect(apply.settingPatches[0]).toMatchObject({ updated: 1, failed: 0, result: 'applied' })
    expect(tgt.rows.Setting__c![0]!.Key__c).toBe('SBOFF_T123')
    expect(apply.safetyCheck).toEqual({ ran: true, problems: [] })
    expect(ledger.changes.filter((c) => c.mode === 'persistent').map((c) => `${c.itemType}:${c.action}`)).toEqual(['Flow:deactivate', 'ApexTrigger:commentOut', 'SettingPatch:patch'])
    expect(apply.summary.nextAction).toBe('rerunAutomation') // because of 'Gone'
  })
})
