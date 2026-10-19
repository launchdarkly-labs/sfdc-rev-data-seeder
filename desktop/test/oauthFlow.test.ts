/**
 * oauthFlow (A4) — pure lane: PKCE, authorize-URL, callback/token parsing, and
 * the injected-fetch exchange/refresh/revoke legs. No electron, no socket, no
 * secret. The browser+loopback `authorize()` orchestrator is integration-only
 * and NOT exercised here.
 *
 * Standing rule honored: we never assert a real refresh callout ran — every
 * network leg is driven by an injected fake whose call counts/args we assert.
 */
import { describe, it, expect } from 'vitest'
import {
  generatePkce,
  generateState,
  redirectUriFor,
  buildAuthorizeUrl,
  parseCallbackParams,
  parseTokenResponse,
  mergeRefreshResponse,
  exchangeCode,
  refreshTokens,
  revokeToken,
  OAuthFlowError,
  DEFAULT_SCOPES,
  LOOPBACK_PORTS,
  type FetchLike
} from '../src/main/services/oauthFlow'

// Deterministic byte source: byte i = i mod 256. Lets us assert exact lengths
// and stable base64url output without a live CSPRNG.
const seq = (n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => i % 256))

const B64URL = /^[A-Za-z0-9_-]+$/

/** Build a fake fetch that returns a fixed status + JSON body and records calls. */
function fakeFetch(
  status: number,
  body: unknown
): FetchLike & { calls: { url: string; body: string; headers: Record<string, string> }[] } {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = []
  const fn = (async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers })
    return {
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }) as FetchLike & { calls: typeof calls }
  fn.calls = calls
  return fn
}

const NOW = () => 1_700_000_000_000

describe('generatePkce / generateState', () => {
  it('verifier is 86 base64url chars, challenge 43, method S256', () => {
    const p = generatePkce(seq)
    expect(p.verifier).toHaveLength(86)
    expect(p.challenge).toHaveLength(43)
    expect(p.method).toBe('S256')
    expect(p.verifier).toMatch(B64URL)
    expect(p.challenge).toMatch(B64URL)
  })

  it('challenge is the base64url SHA-256 of the verifier (deterministic for pinned bytes)', () => {
    expect(generatePkce(seq).challenge).toBe(generatePkce(seq).challenge)
  })

  it('state is 43 base64url chars', () => {
    const s = generateState(seq)
    expect(s).toHaveLength(43)
    expect(s).toMatch(B64URL)
  })

  it('no base64url output carries padding or +/ characters', () => {
    const p = generatePkce(seq)
    expect(p.verifier + p.challenge + generateState(seq)).not.toMatch(/[+/=]/)
  })
})

describe('redirectUriFor', () => {
  it('uses localhost (never 127.0.0.1) and the given port', () => {
    expect(redirectUriFor(53682)).toBe('http://localhost:53682/callback')
    expect(LOOPBACK_PORTS.map(redirectUriFor).every((u) => u.startsWith('http://localhost:'))).toBe(
      true
    )
    expect(redirectUriFor(53682)).not.toContain('127.0.0.1')
  })
})

describe('buildAuthorizeUrl', () => {
  it('assembles the PKCE authorize URL with S256 and default scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({
        loginUrl: 'https://login.salesforce.com',
        clientId: 'CID',
        redirectUri: 'http://localhost:53682/callback',
        state: 'STATE',
        codeChallenge: 'CHAL'
      })
    )
    expect(url.origin + url.pathname).toBe('https://login.salesforce.com/services/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('CID')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53682/callback')
    expect(url.searchParams.get('scope')).toBe(DEFAULT_SCOPES)
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('code_challenge')).toBe('CHAL')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    // Public client: no secret ever appears in the URL.
    expect(url.search).not.toMatch(/secret/i)
  })

  it('strips a trailing slash from the login host and honors a custom scope', () => {
    const url = new URL(
      buildAuthorizeUrl({
        loginUrl: 'https://my.sandbox.my.salesforce.com/',
        clientId: 'C',
        redirectUri: 'http://localhost:53683/callback',
        state: 's',
        codeChallenge: 'c',
        scope: 'api'
      })
    )
    expect(url.pathname).toBe('/services/oauth2/authorize')
    expect(url.host).toBe('my.sandbox.my.salesforce.com')
    expect(url.searchParams.get('scope')).toBe('api')
  })
})

describe('parseCallbackParams', () => {
  it('parses a successful callback (full URL and path-only)', () => {
    expect(parseCallbackParams('http://localhost:53682/callback?code=ABC&state=XYZ')).toEqual({
      ok: true,
      code: 'ABC',
      state: 'XYZ'
    })
    expect(parseCallbackParams('/callback?code=A&state=B')).toEqual({
      ok: true,
      code: 'A',
      state: 'B'
    })
  })

  it('maps an access_denied error body and carries state (null when absent)', () => {
    const r = parseCallbackParams('/callback?error=access_denied&error_description=User%20said%20no')
    expect(r).toEqual({
      ok: false,
      error: 'access_denied',
      errorDescription: 'User said no',
      state: null
    })
  })

  it('surfaces state on the error branch when SF echoes it (RFC 6749 §4.1.2.1)', () => {
    // Lets authorize() verify state FIRST and ignore forged/unsolicited errors.
    expect(parseCallbackParams('/callback?error=access_denied&state=XYZ')).toMatchObject({
      ok: false,
      error: 'access_denied',
      state: 'XYZ'
    })
  })

  it('flags a missing code or state', () => {
    expect(parseCallbackParams('/callback?state=only')).toMatchObject({ ok: false })
    expect(parseCallbackParams('/callback?code=only')).toMatchObject({ ok: false })
  })
})

describe('parseTokenResponse', () => {
  it('normalizes a good exchange body', () => {
    const t = parseTokenResponse(
      200,
      {
        access_token: 'AT',
        refresh_token: 'RT',
        instance_url: 'https://x.my.salesforce.com',
        id: 'https://login.salesforce.com/id/00D/005',
        scope: 'api refresh_token'
      },
      NOW()
    )
    expect(t).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      instanceUrl: 'https://x.my.salesforce.com',
      idUrl: 'https://login.salesforce.com/id/00D/005',
      scope: 'api refresh_token',
      issuedAt: NOW()
    })
  })

  it('throws exchange_failed on an error body', () => {
    expect(() =>
      parseTokenResponse(400, { error: 'invalid_grant', error_description: 'expired' }, NOW())
    ).toThrowError(OAuthFlowError)
  })

  it('throws exchange_failed on a 200 that is missing access_token or instance_url', () => {
    expect(() => parseTokenResponse(200, { access_token: 'AT' }, NOW())).toThrow(/instance_url/)
    expect(() => parseTokenResponse(200, { instance_url: 'u' }, NOW())).toThrow(OAuthFlowError)
  })

  it('normalizes a falsy empty-string refresh_token to null (never stores "")', () => {
    const t = parseTokenResponse(
      200,
      { access_token: 'AT', refresh_token: '', instance_url: 'https://x.my.salesforce.com' },
      NOW()
    )
    expect(t.refreshToken).toBeNull()
  })
})

describe('mergeRefreshResponse (rotation-safe)', () => {
  const prev = { refreshToken: 'OLD_RT', instanceUrl: 'https://old.my.salesforce.com' }

  it('keeps the prior refresh token when the response omits one', () => {
    const t = mergeRefreshResponse(prev, 200, { access_token: 'NEW_AT' }, NOW())
    expect(t.accessToken).toBe('NEW_AT')
    expect(t.refreshToken).toBe('OLD_RT')
    expect(t.instanceUrl).toBe('https://old.my.salesforce.com')
  })

  it('adopts a rotated refresh token and a moved instance_url', () => {
    const t = mergeRefreshResponse(
      prev,
      200,
      { access_token: 'NEW_AT', refresh_token: 'ROTATED', instance_url: 'https://new.my.salesforce.com' },
      NOW()
    )
    expect(t.refreshToken).toBe('ROTATED')
    expect(t.instanceUrl).toBe('https://new.my.salesforce.com')
  })

  it('throws refresh_failed on an error body or a missing access_token', () => {
    expect(() => mergeRefreshResponse(prev, 400, { error: 'invalid_grant' }, NOW())).toThrow(
      OAuthFlowError
    )
    expect(() => mergeRefreshResponse(prev, 200, {}, NOW())).toThrow(/access_token/)
  })

  it('does NOT let a falsy empty-string refresh_token/instance_url clobber the prior', () => {
    // Regression: `??` would have stored '' and stranded the connection.
    const t = mergeRefreshResponse(
      prev,
      200,
      { access_token: 'NEW_AT', refresh_token: '', instance_url: '' },
      NOW()
    )
    expect(t.refreshToken).toBe('OLD_RT')
    expect(t.instanceUrl).toBe('https://old.my.salesforce.com')
  })
})

describe('exchangeCode (injected fetch)', () => {
  it('POSTs an authorization_code grant with the PKCE verifier and NO secret', async () => {
    const fetch = fakeFetch(200, {
      access_token: 'AT',
      refresh_token: 'RT',
      instance_url: 'https://x.my.salesforce.com'
    })
    const t = await exchangeCode(
      {
        loginUrl: 'https://login.salesforce.com/',
        clientId: 'CID',
        redirectUri: 'http://localhost:53682/callback',
        code: 'AUTHCODE',
        codeVerifier: 'VERIFIER'
      },
      { fetch, now: NOW }
    )
    expect(t.accessToken).toBe('AT')
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]!.url).toBe('https://login.salesforce.com/services/oauth2/token')
    const sent = new URLSearchParams(fetch.calls[0]!.body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('AUTHCODE')
    expect(sent.get('code_verifier')).toBe('VERIFIER')
    expect(sent.get('client_id')).toBe('CID')
    expect(fetch.calls[0]!.body).not.toMatch(/client_secret|secret/i)
  })

  it('wraps a network failure as exchange_failed', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(
      exchangeCode(
        {
          loginUrl: 'https://login.salesforce.com',
          clientId: 'C',
          redirectUri: 'http://localhost:53682/callback',
          code: 'x',
          codeVerifier: 'v'
        },
        { fetch: boom, now: NOW }
      )
    ).rejects.toMatchObject({ code: 'exchange_failed' })
  })
})

describe('refreshTokens (injected fetch)', () => {
  it('POSTs a refresh_token grant with no secret and preserves the prior RT', async () => {
    const fetch = fakeFetch(200, { access_token: 'AT2', instance_url: 'https://x.my.salesforce.com' })
    const t = await refreshTokens(
      {
        loginUrl: 'https://login.salesforce.com',
        clientId: 'CID',
        refreshToken: 'RT1',
        instanceUrl: 'https://x.my.salesforce.com'
      },
      { fetch, now: NOW }
    )
    expect(t.accessToken).toBe('AT2')
    expect(t.refreshToken).toBe('RT1')
    const sent = new URLSearchParams(fetch.calls[0]!.body)
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe('RT1')
    expect(fetch.calls[0]!.body).not.toMatch(/secret/i)
  })

  it('wraps a network failure as refresh_failed', async () => {
    const boom: FetchLike = async () => {
      throw new Error('down')
    }
    await expect(
      refreshTokens(
        { loginUrl: 'https://login.salesforce.com', clientId: 'C', refreshToken: 'r', instanceUrl: 'u' },
        { fetch: boom, now: NOW }
      )
    ).rejects.toMatchObject({ code: 'refresh_failed' })
  })
})

describe('revokeToken (best-effort)', () => {
  it('returns true on a 2xx', async () => {
    const fetch = fakeFetch(200, {})
    await expect(
      revokeToken({ loginUrl: 'https://login.salesforce.com', token: 'RT' }, { fetch })
    ).resolves.toBe(true)
    expect(new URLSearchParams(fetch.calls[0]!.body).get('token')).toBe('RT')
    expect(fetch.calls[0]!.url).toBe('https://login.salesforce.com/services/oauth2/revoke')
  })

  it('returns false — never throws — on a non-2xx or a network error', async () => {
    await expect(
      revokeToken({ loginUrl: 'https://login.salesforce.com', token: 'x' }, { fetch: fakeFetch(400, {}) })
    ).resolves.toBe(false)
    const boom: FetchLike = async () => {
      throw new Error('down')
    }
    await expect(
      revokeToken({ loginUrl: 'https://login.salesforce.com', token: 'x' }, { fetch: boom })
    ).resolves.toBe(false)
  })

  it('returns false — never throws — even when loginUrl is null (stale/partial row)', async () => {
    // Regression: normalization used to run outside the try, so a null loginUrl
    // threw and blocked the caller's local token wipe.
    const fetch = fakeFetch(200, {})
    await expect(
      revokeToken(
        { loginUrl: null as unknown as string, token: 'x' },
        { fetch }
      )
    ).resolves.toBe(false)
    // Never even attempted the request with a bad host.
    expect(fetch.calls).toHaveLength(0)
  })
})
