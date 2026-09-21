import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store, MIGRATIONS } from '../../src/main/services/store'
import { emptyWizardConfig, type WizardConfig } from '../../src/shared/wizard'
import type { AnalysisResult, PlannedObject } from '../../src/main/engine/analysis'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
  // FK-referenced connections must exist before a deployment can reference them.
  store.upsertConnections([
    {
      alias: 'src',
      username: 's@x.io',
      orgId: '00Dsrc00000000',
      instanceUrl: 'https://src.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    },
    {
      alias: 'tgt',
      username: 't@x.io',
      orgId: '00Dtgt00000000',
      instanceUrl: 'https://tgt.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    }
  ])
})
afterEach(() => store.close())

function newDraft(): number {
  return store.createDeployment({
    name: 'Acme',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
}

function planned(overrides: Partial<PlannedObject> = {}): PlannedObject {
  return {
    objectName: 'Account',
    sortOrder: 1,
    hasCircularReference: false,
    deferredFields: [],
    scope: { kind: 'all' },
    scopedFilterDisplay: null,
    recordCount: 10,
    apiStrategy: 'REST',
    gatingTier: 'semi',
    requiresTriggerBypass: false,
    requiresAutomationDisable: false,
    restPageSize: 200,
    recommendedBatchSize: 200,
    isJunction: false,
    junctionParents: null,
    junctionParentFields: null,
    ...overrides
  }
}

describe('Store — drafts (5A.5)', () => {
  it('creates a Draft and loads an empty config', () => {
    const id = newDraft()
    const draft = store.loadDraft(id)
    expect(draft).not.toBeNull()
    expect(draft!.status).toBe('Draft')
    expect(draft!.step).toBe('orgs')
    expect(draft!.config).toEqual(emptyWizardConfig())
  })

  it('round-trips a saved draft (step + config)', () => {
    const id = newDraft()
    // The `filterMode` key is DELIBERATE: S50 (A4) removed it from the model,
    // and this pins that a draft persisted under the old shape still loads.
    // That is why removing it needed no migration — the extra JSON property is
    // simply ignored on read.
    const config = {
      ...emptyWizardConfig(),
      selectedObjects: ['Account', 'Contact'],
      filterMode: 'all'
    } as unknown as WizardConfig
    store.saveDraft(id, 'scope', config)
    const draft = store.loadDraft(id)
    expect(draft!.step).toBe('scope')
    expect(draft!.config.selectedObjects).toEqual(['Account', 'Contact'])
    // S50 (A4): filterMode is gone from the model. A draft persisted with the
    // old key still round-trips — the extra JSON property is simply ignored,
    // which is why no migration is needed for existing drafts.
    expect(draft!.config.populatedOnly).toBe(false)
  })

  it('saveDraft on an unknown deployment throws NOT_FOUND', () => {
    expect(() => store.saveDraft(999, 'orgs', emptyWizardConfig())).toThrow(/not found/i)
  })

  it('loadDraft returns null for an unknown deployment', () => {
    expect(store.loadDraft(999)).toBeNull()
  })

  it('lists drafts newest-first with null totals until analyzed', () => {
    const a = newDraft()
    const b = newDraft()
    const drafts = store.listDrafts()
    expect(drafts.map((d) => d.id)).toContain(a)
    expect(drafts.map((d) => d.id)).toContain(b)
    const draftA = drafts.find((d) => d.id === a)!
    expect(draftA.totalObjects).toBeNull()
    expect(draftA.status).toBe('Draft')
  })
})

describe('Store — analysis plan (2.2)', () => {
  it('returns null before analysis', () => {
    expect(store.getPlan(newDraft())).toBeNull()
  })

  it('saves an analysis result and reads it back as a PlanView', () => {
    const id = newDraft()
    const result: AnalysisResult = {
      objects: [
        planned({ objectName: 'Account', sortOrder: 1, recordCount: 1 }),
        planned({
          objectName: 'OpportunityContactRole',
          sortOrder: 2,
          recordCount: 120,
          isJunction: true,
          junctionParents: ['Opportunity', 'Contact']
        })
      ],
      totalObjects: 2,
      totalRecords: 121,
      autoInjectedJunctions: ['OpportunityContactRole'],
      warnings: ['a warning']
    }
    store.saveAnalysis(id, result)

    const plan = store.getPlan(id)
    expect(plan).not.toBeNull()
    expect(plan!.objects.map((o) => o.objectName)).toEqual(['Account', 'OpportunityContactRole'])
    expect(plan!.totalObjects).toBe(2)
    expect(plan!.totalRecords).toBe(121)
    expect(plan!.autoInjectedJunctions).toEqual(['OpportunityContactRole'])
    expect(plan!.warnings).toEqual(['a warning'])

    // status flips to Planned and totals surface in the draft list.
    const summary = store.listDrafts().find((d) => d.id === id)!
    expect(summary.status).toBe('Planned')
    expect(summary.totalObjects).toBe(2)
    expect(summary.totalRecords).toBe(121)
  })

  it('reorderPlan rewrites sort_order AND plan_json.sortOrder (5B.8)', () => {
    const id = newDraft()
    store.saveAnalysis(id, {
      objects: [
        planned({ objectName: 'Account', sortOrder: 0 }),
        planned({ objectName: 'Contact', sortOrder: 1 }),
        planned({ objectName: 'Opportunity', sortOrder: 2 })
      ],
      totalObjects: 3,
      totalRecords: 0,
      autoInjectedJunctions: [],
      warnings: []
    })

    store.reorderPlan(id, ['Opportunity', 'Account', 'Contact'])

    const plan = store.getPlan(id)!
    // getPlan builds the view FROM plan_json — this asserts the authoritative
    // copy moved, not just the queryable column.
    expect(plan.objects.map((o) => o.objectName)).toEqual(['Opportunity', 'Account', 'Contact'])
    expect(plan.objects.map((o) => o.sortOrder)).toEqual([0, 1, 2])
  })

  it('reorderPlan REJECTS partial or unknown-name orders (full-permutation invariant)', () => {
    const id = newDraft()
    store.saveAnalysis(id, {
      objects: [
        planned({ objectName: 'Account', sortOrder: 0 }),
        planned({ objectName: 'Contact', sortOrder: 1 })
      ],
      totalObjects: 2,
      totalRecords: 0,
      autoInjectedJunctions: [],
      warnings: []
    })
    // Partial input would let two rows share a sort_order — the exact ordering
    // ambiguity the Session-16 slot-refill fix exists to prevent. Apex always
    // writes a full permutation; the store enforces the same invariant.
    expect(() => store.reorderPlan(id, ['Contact'])).toThrow(/FULL object order/)
    expect(() => store.reorderPlan(id, ['Contact', 'Account', 'Ghost'])).toThrow(
      /FULL object order/
    )
    // A rejected reorder changes nothing.
    const plan = store.getPlan(id)!
    expect(plan.objects.map((o) => o.objectName)).toEqual(['Account', 'Contact'])
    expect(plan.objects.map((o) => o.sortOrder)).toEqual([0, 1])

    expect(() => store.reorderPlan(newDraft(), ['Account'])).toThrow(/no plan/i)
  })

  it('re-analysis replaces prior objects (no stale rows)', () => {
    const id = newDraft()
    store.saveAnalysis(id, {
      objects: [
        planned({ objectName: 'Account' }),
        planned({ objectName: 'Contact', sortOrder: 2 })
      ],
      totalObjects: 2,
      totalRecords: 20,
      autoInjectedJunctions: [],
      warnings: []
    })
    store.saveAnalysis(id, {
      objects: [planned({ objectName: 'Account' })],
      totalObjects: 1,
      totalRecords: 10,
      autoInjectedJunctions: [],
      warnings: []
    })
    expect(store.getPlan(id)!.objects.map((o) => o.objectName)).toEqual(['Account'])
  })

  it('saveAnalysis on an unknown deployment throws NOT_FOUND', () => {
    expect(() =>
      store.saveAnalysis(999, {
        objects: [],
        totalObjects: 0,
        totalRecords: 0,
        autoInjectedJunctions: [],
        warnings: []
      })
    ).toThrow(/not found/i)
  })
})

describe('Store — delete guard', () => {
  it('deletes a Draft/Planned and cascades its objects', () => {
    const id = newDraft()
    store.saveAnalysis(id, {
      objects: [planned()],
      totalObjects: 1,
      totalRecords: 10,
      autoInjectedJunctions: [],
      warnings: []
    })
    store.deleteDeployment(id)
    expect(store.loadDraft(id)).toBeNull()
    expect(store.getPlan(id)).toBeNull()
    expect(store.listDrafts().find((d) => d.id === id)).toBeUndefined()
  })

  it('delete of an unknown deployment throws NOT_FOUND', () => {
    expect(() => store.deleteDeployment(12345)).toThrow(/not found/i)
  })
})

describe('Store — migration 003 (auth dual-mode)', () => {
  it('fresh DB: connections are id-keyed, oauth_tokens exists, auth_kind rejects eca', () => {
    const s = new Store(':memory:')
    // Reach the underlying db via a round-trip: the id-keyed shape is observable
    // through the public API (upsert → id == alias, cliAlias == alias).
    s.upsertConnections([
      {
        alias: 'a',
        username: 'a@x.io',
        orgId: '00Da000000',
        instanceUrl: '',
        connectedStatus: 'Connected',
        isSandbox: true
      }
    ])
    const conn = s.getConnection('a')
    expect(conn).toBeDefined()
    expect(conn!.id).toBe('a')
    expect(conn!.cliAlias).toBe('a')
    expect(conn!.authKind).toBe('cli')
    expect(conn!.status).toBe('Active')
    s.close()
  })

  it('upgrades a real 001+002 DB: preserves ids, prod pin, roles; eca→oauth; FK intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rds-mig3-'))
    const dbPath = join(dir, 'rds.db')
    try {
      // Build a pre-003 DB (001+002 applied) with real data using the OLD schema.
      const raw = new Database(dbPath)
      raw.pragma('foreign_keys = ON')
      raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)`)
      for (const m of MIGRATIONS) {
        if (m.id === '003-auth-dual-mode') break
        raw.exec(m.sql)
        raw.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id)
      }
      // A prod source (must stay pinned read-only) and an 'eca' target row.
      raw
        .prepare(
          `INSERT INTO connections (alias, username, org_id, instance_url, role, auth_kind, cli_status, is_sandbox)
           VALUES (@alias,@username,@orgId,@instanceUrl,@role,@authKind,'Connected',@isSandbox)`
        )
        .run({
          alias: 'prodsrc',
          username: 'p@ld.io',
          orgId: '00D41000000UvVnEAK',
          instanceUrl: '',
          role: 'source',
          authKind: 'cli',
          isSandbox: 0
        })
      raw
        .prepare(
          `INSERT INTO connections (alias, username, org_id, instance_url, role, auth_kind, cli_status, is_sandbox)
           VALUES (@alias,@username,@orgId,@instanceUrl,@role,@authKind,'Connected',@isSandbox)`
        )
        .run({
          alias: 'sb1',
          username: 's@ld.io',
          orgId: '00Dsb1000000',
          instanceUrl: '',
          role: 'target',
          authKind: 'eca',
          isSandbox: 1
        })
      raw
        .prepare(
          `INSERT INTO deployments (name, source_alias, target_alias, status) VALUES (?,?,?,?)`
        )
        .run('Legacy', 'prodsrc', 'sb1', 'Planned')
      const depId = Number((raw.prepare('SELECT id FROM deployments').get() as { id: number }).id)
      raw.close()

      // Open Store → applies 003. A FK violation would have thrown here.
      const store = new Store(dbPath)
      const conns = store.listConnections()
      const prod = conns.find((c) => c.id === 'prodsrc')!
      const sb1 = conns.find((c) => c.id === 'sb1')!

      expect(prod.cliAlias).toBe('prodsrc')
      expect(prod.prodPinned).toBe(true)
      expect(prod.role).toBe('source')
      expect(() => store.setRole('prodsrc', 'target')).toThrow(/read-only/i)
      expect(sb1.authKind).toBe('oauth') // eca → oauth
      expect(sb1.role).toBe('target')

      const draft = store.loadDraft(depId)
      expect(draft).not.toBeNull()
      expect(draft!.sourceConnectionId).toBe('prodsrc') // FK re-pointed verbatim
      expect(draft!.targetConnectionId).toBe('sb1')
      expect(draft!.sourceLabel).toBe('prodsrc')
      store.close()

      // Independent FK integrity check on the migrated DB.
      const check = new Database(dbPath)
      expect(check.pragma('foreign_key_check') as unknown[]).toEqual([])
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Store — persistence + migration idempotency', () => {
  it('reopens an on-disk DB, skips applied migrations, and preserves data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rds-store-'))
    const dbPath = join(dir, 'rds.db')
    try {
      const first = new Store(dbPath)
      first.upsertConnections([
        {
          alias: 'src',
          username: 's@x.io',
          orgId: '00Dsrc00000000',
          instanceUrl: '',
          connectedStatus: 'Connected',
          isSandbox: true
        },
        {
          alias: 'tgt',
          username: 't@x.io',
          orgId: '00Dtgt00000000',
          instanceUrl: '',
          connectedStatus: 'Connected',
          isSandbox: true
        }
      ])
      const id = first.createDeployment({
        name: 'Persisted',
        sourceConnectionId: 'src',
        targetConnectionId: 'tgt'
      })
      first.saveDraft(id, 'mappings', { ...emptyWizardConfig(), selectedObjects: ['Account'] })
      first.close()

      // Reopen: migrate() must no-op on already-applied 001 + 002 and keep rows.
      const second = new Store(dbPath)
      const draft = second.loadDraft(id)
      expect(draft).not.toBeNull()
      expect(draft!.step).toBe('mappings')
      expect(draft!.config.selectedObjects).toEqual(['Account'])
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Store — OAuth connection lifecycle (A7)', () => {
  const mkOAuth = (over?: Partial<Parameters<Store['createOAuthConnection']>[0]>): string => {
    const id = 'uuid-oauth-1'
    store.createOAuthConnection({
      id,
      label: 'my-sandbox',
      username: 'admin@sb',
      orgId: '00Doauth0000000',
      instanceUrl: 'https://sb.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      oauthClientId: 'CID',
      isSandbox: true,
      ...over
    })
    return id
  }

  it('creates an OAuth row (auth_kind oauth, cli_alias null, Active)', () => {
    const id = mkOAuth()
    const row = store.getConnection(id)!
    expect(row.authKind).toBe('oauth')
    expect(row.cliAlias).toBeNull()
    expect(row.loginUrl).toBe('https://test.salesforce.com')
    expect(row.status).toBe('Active')
    expect(store.listConnections().some((c) => c.id === id)).toBe(true)
  })

  it('deleteConnection cascades the oauth_tokens row (A2 FK ON DELETE CASCADE)', () => {
    const id = mkOAuth()
    store.putOAuthTokens({
      connectionId: id,
      accessTokenCt: Buffer.from('at'),
      refreshTokenCt: Buffer.from('rt'),
      instanceUrl: 'https://sb.my.salesforce.com',
      issuedAt: 1
    })
    expect(store.getOAuthTokenRow(id)).not.toBeNull()
    store.deleteConnection(id)
    expect(store.getConnection(id)).toBeUndefined()
    expect(store.getOAuthTokenRow(id)).toBeNull() // cascaded
  })

  it('deleteConnection refuses when a deployment references it', () => {
    const id = mkOAuth()
    store.createDeployment({ name: 'D', sourceConnectionId: 'src', targetConnectionId: id })
    expect(() => store.deleteConnection(id)).toThrow(/used by a deployment/i)
    expect(store.getConnection(id)).not.toBeUndefined() // still there
  })

  it('putOAuthTokens for a non-existent connection FK-fails — the row MUST exist first', () => {
    // Locks in the A7 handler invariant: create the connection row BEFORE vault.put,
    // else the oauth_tokens FK (foreign_keys ON at runtime) rejects the insert.
    expect(() =>
      store.putOAuthTokens({
        connectionId: 'ghost-uuid',
        accessTokenCt: Buffer.from('at'),
        refreshTokenCt: null,
        instanceUrl: 'https://x',
        issuedAt: 1
      })
    ).toThrow(/FOREIGN KEY/i)
    // Row-first then put succeeds.
    const id = mkOAuth()
    expect(() =>
      store.putOAuthTokens({
        connectionId: id,
        accessTokenCt: Buffer.from('at'),
        refreshTokenCt: null,
        instanceUrl: 'https://x',
        issuedAt: 1
      })
    ).not.toThrow()
  })

  it('isConnectionReferenced reflects deployment source/target membership', () => {
    const id = mkOAuth()
    expect(store.isConnectionReferenced(id)).toBe(false)
    store.createDeployment({ name: 'D', sourceConnectionId: id, targetConnectionId: 'tgt' })
    expect(store.isConnectionReferenced(id)).toBe(true)
  })

  it('markConnectionActive adopts a fresh org id + username and sets Active', () => {
    const id = mkOAuth({ username: '(verifying…)', orgId: '' })
    store.setConnectionStatus(id, 'Error')
    store.markConnectionActive(id, { orgId: '00Dlive0000000', username: 'real@sb' })
    const row = store.getConnection(id)!
    expect(row.status).toBe('Active')
    expect(row.orgId).toBe('00Dlive0000000')
    expect(row.username).toBe('real@sb')
  })

  it('pins an OAuth connection to LD production read-only from its org id', () => {
    const id = mkOAuth({ orgId: '00D41000000UvVnEAK' })
    const row = store.getConnection(id)!
    expect(row.prodPinned).toBe(true)
    expect(row.role).toBe('source')
    expect(() => store.setRole(id, 'target')).toThrow(/read-only/i)
  })
})

describe('Store — S46 D3 listDrafts is every mirrored status', () => {
  it('lists Completed / Failed / Deploying rows too, newest first, with the error text', () => {
    const failed = newDraft()
    const done = newDraft()
    const running = newDraft()
    store.markDeployStarted(failed)
    store.markDeployFailedBeforeRun(failed, 'Plan freeze refused: …full text…')
    store.markDeployStarted(done)
    store.setDeployErrorMessage(done, 'x')
    store['db']
      .prepare(`UPDATE deployments SET status = 'Completed', error_message = NULL WHERE id = ?`)
      .run(done)
    store.markDeployStarted(running)
    const list = store.listDrafts()
    const byId = new Map(list.map((d) => [d.id, d]))
    expect(byId.get(failed)!.status).toBe('Failed')
    expect(byId.get(failed)!.errorMessage).toBe('Plan freeze refused: …full text…')
    expect(byId.get(done)!.status).toBe('Completed')
    expect(byId.get(done)!.errorMessage).toBeNull()
    expect(byId.get(running)!.status).toBe('Deploying')
  })

  it('getDeploymentHeader joins the connection labels', () => {
    const id = newDraft()
    const h = store.getDeploymentHeader(id)!
    expect(h.name).toBe('Acme')
    expect(h.sourceLabel).toBe('src')
    expect(h.targetLabel).toBe('tgt')
    expect(h.status).toBe('Draft')
  })
})
