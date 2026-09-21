/**
 * TokenVault — the ONLY place OAuth token plaintext is encrypted or decrypted.
 *
 * Two collaborators are INJECTED so the vault needs no Electron runtime in tests:
 *  1. `Cipher` — a structural subset of Electron `safeStorage` (production passes
 *     `safeStorage` directly; tests inject a reversible fake).
 *  2. `OAuthTokenStore` — the narrow persistence port `Store` implements (BLOB CRUD
 *     against the A2 `oauth_tokens` table). safeStorage.encryptString returns a Node
 *     Buffer and better-sqlite3 binds/returns BLOB as Buffer, so the round trip is
 *     Buffer→BLOB→Buffer→decryptString with no base64 layer.
 *
 * Standing rule (enforced HERE): tokens are NEVER logged and NEVER cross IPC.
 * Fail-loud is LAZY: put/get/updateAccess throw when encryption is unavailable —
 * never a plaintext downgrade — but the app still boots (CLI-mode connections work
 * on a keychain-less machine; only OAuth paths fail). `wipe()` requires NO
 * encryption so disconnect/cleanup always succeeds even on a broken keychain.
 */

/** Structural subset of Electron `safeStorage` (so `safeStorage` satisfies it directly). */
export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Ciphertext row as persisted (BLOBs come back from better-sqlite3 as Buffers). */
export interface StoredTokenRow {
  accessTokenCt: Buffer | null
  refreshTokenCt: Buffer | null
  instanceUrl: string | null
  issuedAt: number | null
  refreshedAt: number | null
}

/** The persistence port the vault needs — `Store` implements this. */
export interface OAuthTokenStore {
  putOAuthTokens(input: {
    connectionId: string
    accessTokenCt: Buffer
    refreshTokenCt: Buffer | null
    instanceUrl: string
    issuedAt: number
  }): void
  getOAuthTokenRow(connectionId: string): StoredTokenRow | null
  updateOAuthAccessCt(
    connectionId: string,
    accessTokenCt: Buffer,
    instanceUrl: string,
    refreshedAt: number
  ): void
  wipeOAuthTokens(connectionId: string): void
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'OS encryption (safeStorage) is unavailable — refusing to store OAuth tokens in plaintext. ' +
        'Use CLI-mode connections, or repair the OS keychain.'
    )
    this.name = 'EncryptionUnavailableError'
  }
}

/** Decrypted token material — stays main-side, never returned over IPC. */
export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  instanceUrl: string | null
  issuedAt: number | null
  refreshedAt: number | null
}

export class TokenVault {
  constructor(
    private readonly store: OAuthTokenStore,
    private readonly cipher: Cipher
  ) {
    // Constructor must NOT touch the cipher — safeStorage is only usable after
    // app-ready, and CLI-only sessions must construct the vault without failing.
  }

  /** Call only after app-ready. */
  isAvailable(): boolean {
    return this.cipher.isEncryptionAvailable()
  }

  put(
    connectionId: string,
    tokens: { accessToken: string; refreshToken?: string | null; instanceUrl: string }
  ): void {
    this.assertAvailable()
    this.store.putOAuthTokens({
      connectionId,
      accessTokenCt: this.cipher.encryptString(tokens.accessToken),
      refreshTokenCt: tokens.refreshToken ? this.cipher.encryptString(tokens.refreshToken) : null,
      instanceUrl: tokens.instanceUrl,
      issuedAt: Date.now()
    })
  }

  /** The ONLY decryption site. Returns null when there is no stored access token. */
  get(connectionId: string): TokenSet | null {
    this.assertAvailable()
    const row = this.store.getOAuthTokenRow(connectionId)
    if (!row || row.accessTokenCt == null) return null
    return {
      accessToken: this.cipher.decryptString(row.accessTokenCt),
      refreshToken: row.refreshTokenCt ? this.cipher.decryptString(row.refreshTokenCt) : null,
      instanceUrl: row.instanceUrl,
      issuedAt: row.issuedAt,
      refreshedAt: row.refreshedAt
    }
  }

  /** After a refresh: re-encrypt the access token, adopt the returned instance_url. */
  updateAccess(connectionId: string, accessToken: string, instanceUrl: string): void {
    this.assertAvailable()
    this.store.updateOAuthAccessCt(
      connectionId,
      this.cipher.encryptString(accessToken),
      instanceUrl,
      Date.now()
    )
  }

  /** Deletion must always succeed — even on a broken/changed keychain. No gate. */
  wipe(connectionId: string): void {
    this.store.wipeOAuthTokens(connectionId)
  }

  private assertAvailable(): void {
    if (!this.cipher.isEncryptionAvailable()) throw new EncryptionUnavailableError()
  }
}
