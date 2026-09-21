/**
 * TokenVault ↔ Store integration (A3) — node-ABI lane (`npm run test:store`).
 * Proves the real Buffer↔BLOB boundary through better-sqlite3 (migration 003),
 * that persisted bytes are not plaintext, and the ON DELETE CASCADE from
 * connections → oauth_tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store } from '../../src/main/services/store'
import { TokenVault, type Cipher } from '../../src/main/services/tokenVault'

function fakeCipher(): Cipher {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => Buffer.from(b.toString('utf8').slice(4), 'base64').toString('utf8')
  }
}

function seedConnection(store: Store): void {
  store.upsertConnections([
    {
      alias: 'c1',
      username: 'c1@x.io',
      orgId: '00Dc1000000',
      instanceUrl: 'https://c1.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    }
  ])
}

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
  seedConnection(store)
})
afterEach(() => store.close())

describe('TokenVault + Store (migration 003 oauth_tokens)', () => {
  it('round-trips ciphertext through a real BLOB column', () => {
    const vault = new TokenVault(store, fakeCipher())
    vault.put('c1', { accessToken: 'AT', refreshToken: 'RT', instanceUrl: 'https://c1' })
    const got = vault.get('c1')!
    expect(got.accessToken).toBe('AT')
    expect(got.refreshToken).toBe('RT')
    expect(got.instanceUrl).toBe('https://c1')
  })

  it('persists ciphertext, not plaintext (raw SELECT)', () => {
    const vault = new TokenVault(store, fakeCipher())
    vault.put('c1', { accessToken: 'PLAINTEXT_AT', instanceUrl: 'https://c1' })
    const row = store.getOAuthTokenRow('c1')!
    expect(Buffer.isBuffer(row.accessTokenCt)).toBe(true)
    expect(row.accessTokenCt!.toString('utf8')).not.toContain('PLAINTEXT_AT')
  })

  it('wipe deletes the row', () => {
    const vault = new TokenVault(store, fakeCipher())
    vault.put('c1', { accessToken: 'AT', instanceUrl: 'https://c1' })
    vault.wipe('c1')
    expect(store.getOAuthTokenRow('c1')).toBeNull()
  })

  it('deleting a connection cascades to its oauth_tokens (ON DELETE CASCADE)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rds-vault-'))
    const dbPath = join(dir, 'rds.db')
    try {
      const s = new Store(dbPath)
      seedConnection(s)
      new TokenVault(s, fakeCipher()).put('c1', { accessToken: 'AT', instanceUrl: 'https://c1' })
      expect(s.getOAuthTokenRow('c1')).not.toBeNull()
      s.close()

      // Delete the connection via a raw FK-enabled handle and assert the cascade.
      const raw = new Database(dbPath)
      raw.pragma('foreign_keys = ON')
      raw.prepare('DELETE FROM connections WHERE id = ?').run('c1')
      const remaining = (
        raw.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE connection_id = ?').get('c1') as {
          n: number
        }
      ).n
      raw.close()
      expect(remaining).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
