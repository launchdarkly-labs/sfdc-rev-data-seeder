/**
 * TokenVault (A3) — pure lane: fully injected fakes, no better-sqlite3, no electron.
 * Proves the encrypt/persist/decrypt contract, lazy fail-loud, and no plaintext leak.
 */
import { describe, it, expect } from 'vitest'
import {
  TokenVault,
  EncryptionUnavailableError,
  type Cipher,
  type OAuthTokenStore,
  type StoredTokenRow
} from '../src/main/services/tokenVault'

// Reversible fake: ciphertext = 'enc:' + base64(plaintext). Never contains the
// raw plaintext substring, so the no-leak assertion is meaningful.
function fakeCipher(available = true): Cipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => {
      const raw = b.toString('utf8')
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext')
      return Buffer.from(raw.slice(4), 'base64').toString('utf8')
    }
  }
}

function fakeStore(): OAuthTokenStore & { rows: Map<string, StoredTokenRow> } {
  const rows = new Map<string, StoredTokenRow>()
  return {
    rows,
    putOAuthTokens(i) {
      rows.set(i.connectionId, {
        accessTokenCt: i.accessTokenCt,
        refreshTokenCt: i.refreshTokenCt,
        instanceUrl: i.instanceUrl,
        issuedAt: i.issuedAt,
        refreshedAt: null
      })
    },
    getOAuthTokenRow(id) {
      return rows.get(id) ?? null
    },
    updateOAuthAccessCt(id, ct, url, refreshedAt) {
      const r = rows.get(id)
      if (r) {
        r.accessTokenCt = ct
        r.instanceUrl = url
        r.refreshedAt = refreshedAt
      }
    },
    wipeOAuthTokens(id) {
      rows.delete(id)
    }
  }
}

describe('TokenVault', () => {
  it('put → get round-trips tokens + instanceUrl and stamps issuedAt', () => {
    const vault = new TokenVault(fakeStore(), fakeCipher())
    vault.put('c1', {
      accessToken: 'AT_secret',
      refreshToken: 'RT_secret',
      instanceUrl: 'https://x.my.salesforce.com'
    })
    const got = vault.get('c1')!
    expect(got.accessToken).toBe('AT_secret')
    expect(got.refreshToken).toBe('RT_secret')
    expect(got.instanceUrl).toBe('https://x.my.salesforce.com')
    expect(typeof got.issuedAt).toBe('number')
    expect(got.refreshedAt).toBeNull()
  })

  it('stores a null refresh token as null (get returns null field)', () => {
    const vault = new TokenVault(fakeStore(), fakeCipher())
    vault.put('c1', { accessToken: 'AT', instanceUrl: 'https://x' })
    expect(vault.get('c1')!.refreshToken).toBeNull()
  })

  it('updateAccess re-encrypts the access token, adopts instanceUrl, keeps refresh token', () => {
    const store = fakeStore()
    const vault = new TokenVault(store, fakeCipher())
    vault.put('c1', { accessToken: 'AT1', refreshToken: 'RT', instanceUrl: 'https://old' })
    vault.updateAccess('c1', 'AT2', 'https://new')
    const got = vault.get('c1')!
    expect(got.accessToken).toBe('AT2')
    expect(got.instanceUrl).toBe('https://new')
    expect(got.refreshToken).toBe('RT') // untouched
    expect(typeof got.refreshedAt).toBe('number')
  })

  it('get returns null when there is no stored token', () => {
    expect(new TokenVault(fakeStore(), fakeCipher()).get('missing')).toBeNull()
  })

  it('wipe removes the entry', () => {
    const vault = new TokenVault(fakeStore(), fakeCipher())
    vault.put('c1', { accessToken: 'AT', instanceUrl: 'https://x' })
    vault.wipe('c1')
    expect(vault.get('c1')).toBeNull()
  })

  it('fails loud on put/get/updateAccess when encryption is unavailable — but wipe still works', () => {
    const store = fakeStore()
    const down = new TokenVault(store, fakeCipher(false))
    expect(() => down.put('c1', { accessToken: 'AT', instanceUrl: 'x' })).toThrow(
      EncryptionUnavailableError
    )
    expect(() => down.get('c1')).toThrow(EncryptionUnavailableError)
    expect(() => down.updateAccess('c1', 'AT', 'x')).toThrow(EncryptionUnavailableError)
    // Deletion must succeed even with a broken keychain.
    expect(() => down.wipe('c1')).not.toThrow()
  })

  it('never persists plaintext (stored ciphertext excludes the token)', () => {
    const store = fakeStore()
    const vault = new TokenVault(store, fakeCipher())
    vault.put('c1', {
      accessToken: 'SUPER_SECRET_ACCESS',
      refreshToken: 'SUPER_SECRET_REFRESH',
      instanceUrl: 'https://x'
    })
    const row = store.rows.get('c1')!
    expect(row.accessTokenCt!.toString('utf8')).not.toContain('SUPER_SECRET_ACCESS')
    expect(row.refreshTokenCt!.toString('utf8')).not.toContain('SUPER_SECRET_REFRESH')
  })

  it('get treats a null-ciphertext row as no token', () => {
    const store = fakeStore()
    store.rows.set('c1', {
      accessTokenCt: null,
      refreshTokenCt: null,
      instanceUrl: 'https://x',
      issuedAt: 1,
      refreshedAt: null
    })
    expect(new TokenVault(store, fakeCipher()).get('c1')).toBeNull()
  })
})
