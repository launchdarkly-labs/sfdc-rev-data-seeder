/**
 * connect() (A5) — pure lane: proves the GuardedOrg is auth-agnostic (all auth
 * dispatch is inside the injected TokenProvider), the prod read-only pin holds
 * from the MINTED org id, and the D1 write guard behaves per role. No network:
 * the jsforce Connection constructor makes no calls, and mint/refresh are fakes.
 */
import { describe, it, expect } from 'vitest'
import {
  connect,
  createRefreshFn,
  ReadOnlyOrgError,
  isProdOrg,
  REFRESH_CAP,
  REFRESH_WINDOW_MS,
  type RefreshableConn
} from '../src/main/services/salesforce'
import { RdsHandlerError } from '../src/main/errors'
import type { TokenProvider, ConnectionInput, MintedToken } from '../src/main/services/tokenProvider'

const base: ConnectionInput = {
  id: 'c1',
  authKind: 'cli',
  role: 'target',
  cliAlias: 'sb1_714',
  loginUrl: null,
  username: 'admin@sb1',
  orgId: '00DcW000005SHnpUAG',
  instanceUrl: 'https://sb1.my.salesforce.com'
}

function fakeTokens(minted: MintedToken): TokenProvider {
  return {
    mint: async () => minted,
    refresh: async () => ({ accessToken: 'REFRESHED', instanceUrl: minted.instanceUrl })
  }
}

const sandboxMint: MintedToken = {
  accessToken: 'AT',
  instanceUrl: 'https://sb1.my.salesforce.com',
  orgId: '00DcW000005SHnpUAG',
  username: 'admin@sb1'
}

const prodMint: MintedToken = {
  accessToken: 'AT',
  instanceUrl: 'https://ld.my.salesforce.com',
  orgId: '00D41000000UvVnEAK',
  username: 'admin@ld'
}

describe('connect', () => {
  it('builds a GuardedOrg from the minted token (alias, orgId, role, version)', async () => {
    const org = await connect(base, fakeTokens(sandboxMint))
    expect(org.alias).toBe('sb1_714')
    expect(org.orgId).toBe('00DcW000005SHnpUAG')
    expect(org.role).toBe('target')
    expect(org.conn.version).toBe('66.0')
    expect(org.conn.instanceUrl).toBe('https://sb1.my.salesforce.com')
  })

  it('a target org accepts writes; a source org refuses them', async () => {
    const target = await connect(base, fakeTokens(sandboxMint))
    expect(() => target.assertWritable('insert')).not.toThrow()
    const source = await connect({ ...base, role: 'source' }, fakeTokens(sandboxMint))
    expect(() => source.assertWritable('insert')).toThrow(ReadOnlyOrgError)
  })

  it('pins LD production read-only from the MINTED org id even if role=target', async () => {
    expect(isProdOrg(prodMint.orgId)).toBe(true)
    const org = await connect({ ...base, role: 'target' }, fakeTokens(prodMint))
    expect(org.role).toBe('source') // forced
    expect(() => org.assertWritable('insert')).toThrow(/PRODUCTION/)
  })

  it('forces an OAuth connection with an empty minted org id to read-only', async () => {
    // Can't trust an unverified OAuth org as non-prod, so no writes until a live
    // identity() populates a real org id (A7/A8).
    const oauthEmpty: ConnectionInput = {
      ...base,
      id: 'uuid-x',
      authKind: 'oauth',
      cliAlias: null,
      loginUrl: 'https://test.salesforce.com',
      role: 'target'
    }
    const org = await connect(oauthEmpty, fakeTokens({ ...sandboxMint, orgId: '' }))
    expect(org.role).toBe('source')
    expect(() => org.assertWritable('insert')).toThrow(ReadOnlyOrgError)
  })

  it('a CLI connection with an empty minted org id is NOT force-downgraded', async () => {
    // Only the OAuth path lacks a live org id; CLI mints it live, so an empty
    // value there would be an upstream error, not a reason to change behavior.
    const org = await connect(base, fakeTokens({ ...sandboxMint, orgId: '' }))
    expect(org.role).toBe('target')
  })

  it('falls back to the connection id for the alias when there is no cliAlias', async () => {
    const org = await connect(
      { ...base, cliAlias: null, id: 'uuid-9' },
      fakeTokens(sandboxMint)
    )
    expect(org.alias).toBe('uuid-9')
  })
})

describe('createRefreshFn (S52 refresh-loop cap)', () => {
  /** Drives the hook the way jsforce does: one call per 401, then adopt the token. */
  function harness(refreshTokens: string[], now?: () => number) {
    const calls: string[] = []
    let i = 0
    const tokens: TokenProvider = {
      mint: async () => sandboxMint,
      refresh: async (c) => {
        calls.push(c.id)
        const accessToken = refreshTokens[Math.min(i, refreshTokens.length - 1)] ?? ''
        i += 1
        return { accessToken, instanceUrl: sandboxMint.instanceUrl }
      }
    }
    const fn = createRefreshFn(base, tokens, now)
    const c: RefreshableConn = { accessToken: 'AT', instanceUrl: sandboxMint.instanceUrl }
    const call = (): Promise<{ err: Error | null; token?: string }> =>
      new Promise((resolve) =>
        fn(c, (err, token) => {
          if (!err && token) c.accessToken = token // jsforce adopts the new token
          resolve({ err, token })
        })
      )
    return { call, calls, c }
  }

  it('hands jsforce the refreshed token', async () => {
    const h = harness(['R1'])
    const r = await h.call()
    expect(r.err).toBeNull()
    expect(r.token).toBe('R1')
    expect(h.calls).toEqual(['c1'])
  })

  it('adopts a moved instance URL before the retry', async () => {
    const tokens: TokenProvider = {
      mint: async () => sandboxMint,
      refresh: async () => ({ accessToken: 'R1', instanceUrl: 'https://moved.my.salesforce.com' })
    }
    const fn = createRefreshFn(base, tokens)
    const c: RefreshableConn = { accessToken: 'AT', instanceUrl: sandboxMint.instanceUrl }
    await new Promise<void>((resolve) => fn(c, () => resolve()))
    expect(c.instanceUrl).toBe('https://moved.my.salesforce.com')
  })

  it('the SAME token the org just rejected → AUTH_EXPIRED naming the connection, no retry', async () => {
    // The S52 shape: the CLI keeps handing back a token (there: the redacted
    // placeholder) that the org keeps rejecting. Retrying it is pointless.
    const h = harness(['AT'])
    const r = await h.call()
    expect(r.token).toBeUndefined()
    expect(r.err).toBeInstanceOf(RdsHandlerError)
    const e = r.err as RdsHandlerError
    expect(e.code).toBe('AUTH_EXPIRED')
    expect(e.connection).toBe('c1')
    expect(e.message).toMatch(/sb1_714.*same token.*sf org login web -a sb1_714/)
  })

  it(`stops after ${REFRESH_CAP} refreshes inside the window without minting again`, async () => {
    const h = harness(['R1', 'R2', 'R3', 'R4'], () => 1_000)
    for (let n = 1; n <= REFRESH_CAP; n++) {
      const r = await h.call()
      expect(r.err).toBeNull()
      expect(r.token).toBe(`R${n}`)
    }
    const capped = await h.call()
    expect(capped.err).toBeInstanceOf(RdsHandlerError)
    expect((capped.err as RdsHandlerError).code).toBe('AUTH_EXPIRED')
    expect(capped.err?.message).toMatch(new RegExp(`rejected ${REFRESH_CAP} freshly minted tokens`))
    expect(h.calls).toHaveLength(REFRESH_CAP) // the capped call never reached the provider
  })

  it('the window resets — a genuine expiry an hour later is allowed again', async () => {
    let t = 1_000
    const h = harness(['R1', 'R2', 'R3', 'R4'], () => t)
    for (let n = 1; n <= REFRESH_CAP; n++) await h.call()
    t += REFRESH_WINDOW_MS + 1
    const r = await h.call()
    expect(r.err).toBeNull()
    expect(r.token).toBe('R4')
  })

  it('passes a refresh failure through unchanged', async () => {
    const boom = new Error('cli exploded')
    const tokens: TokenProvider = {
      mint: async () => sandboxMint,
      refresh: async () => {
        throw boom
      }
    }
    const fn = createRefreshFn(base, tokens)
    const c: RefreshableConn = { accessToken: 'AT', instanceUrl: sandboxMint.instanceUrl }
    const err = await new Promise<Error | null>((resolve) => fn(c, (e) => resolve(e)))
    expect(err).toBe(boom)
  })
})
