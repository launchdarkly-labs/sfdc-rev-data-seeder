/**
 * TokenProvider (A5) — pure lane: cli↔oauth dispatch, single-flight refresh,
 * rotation-safe persistence. Everything injected (getCliToken, vault, fetch),
 * no sf CLI / no network / no electron. Per the standing rule we assert the
 * INJECTED fake's call counts — never that a real refresh callout ran.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTokenProvider, type ConnectionInput } from '../src/main/services/tokenProvider'
import type { CliToken } from '../src/main/services/sfcli'
import type { TokenSet } from '../src/main/services/tokenVault'

const cliConn: ConnectionInput = {
  id: 'darkb',
  authKind: 'cli',
  role: 'source',
  cliAlias: 'darkb_714',
  loginUrl: null,
  username: 'admin@darkb',
  orgId: '00DTH000009EAtZ2AW',
  instanceUrl: 'https://darkb.my.salesforce.com'
}

const oauthConn: ConnectionInput = {
  id: 'uuid-1',
  authKind: 'oauth',
  role: 'target',
  cliAlias: null,
  loginUrl: 'https://test.salesforce.com',
  username: 'admin@sb1',
  orgId: '00DcW000005SHnpUAG',
  instanceUrl: 'https://sb1.my.salesforce.com'
}

function fakeCli(): {
  fn: (alias: string) => Promise<CliToken>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fn: async (alias) => {
      calls.push(alias)
      return {
        accessToken: `CLI_AT_${calls.length}`,
        instanceUrl: 'https://darkb.my.salesforce.com',
        orgId: '00DTH000009EAtZ2AW',
        username: 'admin@darkb',
        apiVersion: '66.0'
      }
    }
  }
}

function fakeVault(seed?: Partial<TokenSet>): {
  get: (id: string) => TokenSet | null
  put: ReturnType<typeof vi.fn>
  updateAccess: ReturnType<typeof vi.fn>
  rows: Map<string, TokenSet>
} {
  const rows = new Map<string, TokenSet>()
  if (seed) {
    rows.set('uuid-1', {
      accessToken: 'OAUTH_AT',
      refreshToken: 'OAUTH_RT',
      instanceUrl: 'https://sb1.my.salesforce.com',
      issuedAt: 1,
      refreshedAt: null,
      ...seed
    })
  }
  const put = vi.fn(
    (id: string, t: { accessToken: string; refreshToken?: string | null; instanceUrl: string }) => {
      rows.set(id, {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? null,
        instanceUrl: t.instanceUrl,
        issuedAt: 2,
        refreshedAt: null
      })
    }
  )
  const updateAccess = vi.fn((id: string, at: string, url: string) => {
    const cur = rows.get(id)
    if (cur) rows.set(id, { ...cur, accessToken: at, instanceUrl: url, refreshedAt: 3 })
  })
  return { rows, get: (id) => rows.get(id) ?? null, put, updateAccess }
}

/** Fake `typeof fetch` returning a fixed JSON body; records call count. */
function fakeFetch(body: unknown, status = 200): { fn: typeof fetch; count: () => number } {
  let n = 0
  const fn = (async () => {
    n++
    return { status, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
  return { fn, count: () => n }
}

const NOW = () => 1_700_000_000_000

describe('mint — dispatch', () => {
  it('cli: delegates to getCliToken and returns the minted token', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn })
    const t = await tp.mint(cliConn)
    expect(cli.calls).toEqual(['darkb_714'])
    expect(t).toEqual({
      accessToken: 'CLI_AT_1',
      instanceUrl: 'https://darkb.my.salesforce.com',
      orgId: '00DTH000009EAtZ2AW',
      username: 'admin@darkb'
    })
  })

  it('cli: INVALID_STATE when the row has no cliAlias', async () => {
    const tp = createTokenProvider({ getCliToken: fakeCli().fn })
    await expect(tp.mint({ ...cliConn, cliAlias: null })).rejects.toMatchObject({
      code: 'INVALID_STATE'
    })
  })

  it('oauth: returns the vault access token (falls back to conn.instanceUrl when vault url is null)', async () => {
    const vault = fakeVault({ instanceUrl: null as unknown as string })
    const tp = createTokenProvider({ getCliToken: fakeCli().fn, vault, oauthClientId: 'CID' })
    const t = await tp.mint(oauthConn)
    expect(t.accessToken).toBe('OAUTH_AT')
    expect(t.instanceUrl).toBe('https://sb1.my.salesforce.com') // conn fallback
    expect(t.orgId).toBe('00DcW000005SHnpUAG')
  })

  it('oauth: AUTH_EXPIRED when the vault has no token', async () => {
    const tp = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault: fakeVault(),
      oauthClientId: 'CID'
    })
    await expect(tp.mint(oauthConn)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      connection: 'uuid-1'
    })
  })

  it('oauth: INVALID_STATE when no vault is configured (CLI-only provider)', async () => {
    const tp = createTokenProvider({ getCliToken: fakeCli().fn })
    await expect(tp.mint(oauthConn)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})

describe('refresh — dispatch + persistence', () => {
  it('cli: re-mints via getCliToken', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn })
    const r = await tp.refresh(cliConn)
    expect(r.accessToken).toBe('CLI_AT_1')
    expect(cli.calls).toHaveLength(1)
  })

  it('oauth: refreshes via the grant and updateAccess-es the new token (no rotation)', async () => {
    const vault = fakeVault({})
    const fetchStub = fakeFetch({
      access_token: 'OAUTH_AT2',
      instance_url: 'https://sb1.my.salesforce.com'
    })
    const tp = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault,
      oauthClientId: 'CID',
      fetch: fetchStub.fn,
      now: NOW
    })
    const r = await tp.refresh(oauthConn)
    expect(r.accessToken).toBe('OAUTH_AT2')
    expect(fetchStub.count()).toBe(1)
    expect(vault.updateAccess).toHaveBeenCalledOnce()
    expect(vault.put).not.toHaveBeenCalled()
  })

  it('oauth: re-puts the FULL set when SF rotates the refresh token', async () => {
    const vault = fakeVault({})
    const fetchStub = fakeFetch({
      access_token: 'OAUTH_AT2',
      refresh_token: 'ROTATED_RT',
      instance_url: 'https://sb1.my.salesforce.com'
    })
    const tp = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault,
      oauthClientId: 'CID',
      fetch: fetchStub.fn,
      now: NOW
    })
    await tp.refresh(oauthConn)
    expect(vault.put).toHaveBeenCalledOnce()
    expect(vault.updateAccess).not.toHaveBeenCalled()
    expect(vault.rows.get('uuid-1')?.refreshToken).toBe('ROTATED_RT')
  })

  it('oauth: re-types a FAILED refresh (expired/revoked RT) to AUTH_EXPIRED w/ conn id', async () => {
    // Regression: a raw OAuthFlow('refresh_failed') would surface as UNKNOWN and
    // the global re-auth prompt would never fire.
    const vault = fakeVault({})
    const badGrant = fakeFetch({ error: 'invalid_grant', error_description: 'expired' }, 400)
    const tp = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault,
      oauthClientId: 'CID',
      fetch: badGrant.fn,
      now: NOW
    })
    await expect(tp.refresh(oauthConn)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      connection: 'uuid-1'
    })
    // A failed refresh must NOT persist anything.
    expect(vault.put).not.toHaveBeenCalled()
    expect(vault.updateAccess).not.toHaveBeenCalled()
  })

  it('oauth: AUTH_EXPIRED when the vault has no refresh token', async () => {
    const vault = fakeVault({ refreshToken: null })
    const tp = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault,
      oauthClientId: 'CID',
      fetch: fakeFetch({}).fn
    })
    await expect(tp.refresh(oauthConn)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })

  it('oauth: INVALID_STATE when the client id or loginUrl is missing', async () => {
    const vault = fakeVault({})
    const noCid = createTokenProvider({ getCliToken: fakeCli().fn, vault, fetch: fakeFetch({}).fn })
    await expect(noCid.refresh(oauthConn)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    const noHost = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault,
      oauthClientId: 'CID',
      fetch: fakeFetch({}).fn
    })
    await expect(noHost.refresh({ ...oauthConn, loginUrl: null })).rejects.toMatchObject({
      code: 'INVALID_STATE'
    })
  })
})

describe('refresh — single-flight (keyed by connection id)', () => {
  it('collapses concurrent refreshes for the same id into ONE callout', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn })
    // Two synchronous refresh() calls before either settles.
    const [a, b] = await Promise.all([tp.refresh(cliConn), tp.refresh(cliConn)])
    expect(cli.calls).toHaveLength(1) // single-flight
    expect(a.accessToken).toBe('CLI_AT_1')
    expect(b.accessToken).toBe('CLI_AT_1')
  })

  it('releases the in-flight slot so a later refresh re-mints', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn })
    await tp.refresh(cliConn)
    await tp.refresh(cliConn)
    expect(cli.calls).toHaveLength(2)
  })

  it('does NOT share the in-flight promise across different connection ids', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn })
    const other: ConnectionInput = { ...cliConn, id: 'other', cliAlias: 'sb1_714' }
    await Promise.all([tp.refresh(cliConn), tp.refresh(other)])
    expect(cli.calls.sort()).toEqual(['darkb_714', 'sb1_714'])
  })
})

describe('mint — S53 CLI mint cache (measured: ~1.6–1.9 s of CLI time per mint)', () => {
  it('serves a second mint within the TTL from memory — ONE CLI call', async () => {
    const cli = fakeCli()
    let t = 1_000_000
    const tp = createTokenProvider({ getCliToken: cli.fn, now: () => t, cliMintTtlMs: 60_000 })
    const a = await tp.mint(cliConn)
    t += 30_000
    const b = await tp.mint(cliConn)
    expect(cli.calls).toEqual(['darkb_714'])
    expect(b).toEqual(a)
  })

  it('re-mints once the TTL has elapsed', async () => {
    const cli = fakeCli()
    let t = 1_000_000
    const tp = createTokenProvider({ getCliToken: cli.fn, now: () => t, cliMintTtlMs: 60_000 })
    await tp.mint(cliConn)
    t += 60_000 // exactly the TTL — expired (strict <)
    const b = await tp.mint(cliConn)
    expect(cli.calls).toHaveLength(2)
    expect(b.accessToken).toBe('CLI_AT_2')
  })

  it('refresh() always re-mints and REPLACES the cached token', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn, now: NOW, cliMintTtlMs: 60_000 })
    await tp.mint(cliConn) // CLI_AT_1 cached
    const r = await tp.refresh(cliConn) // the org rejected CLI_AT_1
    expect(r.accessToken).toBe('CLI_AT_2')
    const again = await tp.mint(cliConn) // served from the REPLACED cache entry
    expect(again.accessToken).toBe('CLI_AT_2')
    expect(cli.calls).toHaveLength(2)
  })

  it('is keyed by connection id — two rows never share a token', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn, now: NOW, cliMintTtlMs: 60_000 })
    await tp.mint(cliConn)
    await tp.mint({ ...cliConn, id: 'other', cliAlias: 'sb1_830' })
    expect(cli.calls).toEqual(['darkb_714', 'sb1_830'])
  })

  it('a failed mint caches nothing, so the next mint tries the CLI again', async () => {
    let n = 0
    const getCliToken = async (): Promise<CliToken> => {
      n++
      if (n === 1) throw new Error('sf org display failed: expired refresh token')
      return {
        accessToken: 'AT',
        instanceUrl: 'https://x',
        orgId: '00D',
        username: 'u',
        apiVersion: null
      }
    }
    const tp = createTokenProvider({ getCliToken, now: NOW, cliMintTtlMs: 60_000 })
    await expect(tp.mint(cliConn)).rejects.toThrow(/expired refresh token/)
    expect((await tp.mint(cliConn)).accessToken).toBe('AT')
    expect(n).toBe(2)
  })

  it('cliMintTtlMs: 0 disables the cache (pre-S53 behaviour)', async () => {
    const cli = fakeCli()
    const tp = createTokenProvider({ getCliToken: cli.fn, now: NOW, cliMintTtlMs: 0 })
    await tp.mint(cliConn)
    await tp.mint(cliConn)
    expect(cli.calls).toHaveLength(2)
  })

  it('oauth mints are not cached (vault reads spawn nothing)', async () => {
    const vault = fakeVault({})
    const tp = createTokenProvider({
      getCliToken: fakeCli().fn,
      vault,
      oauthClientId: 'CID',
      now: NOW
    })
    await tp.mint(oauthConn)
    vault.updateAccess('uuid-1', 'ROTATED', 'https://sb1.my.salesforce.com')
    expect((await tp.mint(oauthConn)).accessToken).toBe('ROTATED')
  })
})
