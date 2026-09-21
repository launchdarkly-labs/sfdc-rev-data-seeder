import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store, MIGRATIONS } from '../../src/main/services/store'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})
afterEach(() => store.close())

const payload = { Opportunity: { AccountId: { strategy: 'nameMatch', matchField: 'Name' } } }

describe('templates store (5B.5, migration 004)', () => {
  it('saves, lists, and round-trips the JSON payload', () => {
    const saved = store.saveTemplate('mappings', 'Acme', payload)
    expect(saved.id).toBeGreaterThan(0)
    expect(saved.kind).toBe('mappings')
    expect(saved.name).toBe('Acme')
    const list = store.listTemplates('mappings')
    expect(list).toHaveLength(1)
    expect(list[0]!.payload).toEqual(payload)
  })

  it('save is upsert by (kind, name) — same name overwrites in place', () => {
    const a = store.saveTemplate('mappings', 'T', payload)
    const b = store.saveTemplate('mappings', 'T', { Account: { OwnerId: { strategy: 'directId' } } })
    expect(b.id).toBe(a.id) // same row
    expect(store.listTemplates('mappings')).toHaveLength(1)
    expect(store.listTemplates('mappings')[0]!.payload).toEqual({
      Account: { OwnerId: { strategy: 'directId' } }
    })
  })

  it('trims and rejects a blank name', () => {
    expect(() => store.saveTemplate('mappings', '   ', payload)).toThrow(/blank/i)
  })

  it('lists are kind-scoped', () => {
    store.saveTemplate('mappings', 'm1', payload)
    store.saveTemplate('fields', 'f1', { Account: ['Name'] })
    expect(store.listTemplates('mappings').map((t) => t.name)).toEqual(['m1'])
    expect(store.listTemplates('fields').map((t) => t.name)).toEqual(['f1'])
  })

  it('renames, and rejects a duplicate name within the kind', () => {
    const t = store.saveTemplate('mappings', 'old', payload)
    store.saveTemplate('mappings', 'taken', payload)
    store.renameTemplate(t.id, 'new')
    expect(store.listTemplates('mappings').map((t) => t.name).sort()).toEqual(['new', 'taken'])
    expect(() => store.renameTemplate(t.id, 'taken')).toThrow(/already exists/i)
  })

  it('deletes, and throws NOT_FOUND for missing ids', () => {
    const t = store.saveTemplate('mappings', 'gone', payload)
    store.deleteTemplate(t.id)
    expect(store.listTemplates('mappings')).toHaveLength(0)
    expect(() => store.deleteTemplate(t.id)).toThrow(/not found/i)
    expect(() => store.renameTemplate(9999, 'x')).toThrow(/not found/i)
  })

  it('migration 004 adds the templates table cleanly on upgrade from 003', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rds-tmpl-'))
    const dbPath = join(dir, 'db.sqlite')
    try {
      const raw = new Database(dbPath)
      raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )`)
      for (const m of MIGRATIONS) {
        if (m.id === '004-templates') break
        raw.exec(m.sql)
        raw.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id)
      }
      raw.close()
      // Opening the Store applies the pending 004 migration.
      const upgraded = new Store(dbPath)
      upgraded.saveTemplate('mappings', 'post-upgrade', payload)
      expect(upgraded.listTemplates('mappings')).toHaveLength(1)
      upgraded.close()
      const check = new Database(dbPath)
      expect(check.pragma('foreign_key_check') as unknown[]).toEqual([])
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
