/**
 * TokenProvider — the single seam that turns a stored connection into a live
 * access token, dispatching by `authKind` so the GuardedOrg / jsforce layer
 * (salesforce.ts) never knows whether an org is CLI- or OAuth-authenticated.
 *
 *   • cli   → delegate to the sf CLI (`sf org display` mints + refreshes).
 *   • oauth → read the encrypted token from the TokenVault (A3); on 401,
 *             refresh via the A4 refresh grant, re-encrypt, and hand the new
 *             access token back to jsforce for its native retry-once.
 *
 * Three robustness properties:
 *   1. SECRET-FREE — the OAuth path never touches a consumer secret (A4 is a
 *      public client). Tokens are never logged.
 *   2. SINGLE-FLIGHT refresh, keyed by connection id — many engine calls (and
 *      the source+target pair in one analysis) share one connection id, so a
 *      burst of concurrent 401s collapses to ONE refresh callout; the rest await
 *      the same promise. jsforce's own per-Connection delegate only dedups
 *      within a single Connection instance, so this covers the cross-instance case.
 *   3. SHORT-LIVED CLI MINT CACHE (S53, item 4), keyed by connection id. Every
 *      IPC handler builds a fresh GuardedOrg via `connect()` → `mint()`, and a
 *      CLI mint is TWO child processes (`sf org display` + — since CLI 2.150 —
 *      `sf org auth show-access-token`). MEASURED 2026-09-12 (rule 9, before
 *      touching anything): 0.9–1.2 s + 0.7 s per org, i.e. ~1.6–1.9 s of pure
 *      CLI time per mint, 19 `connectById` call sites in ipc.ts, and the
 *      Orgs/Objects steps connect BOTH orgs per call (~3.5 s before the first
 *      org request; S52 observed ~1 spawn/s during busy wizard steps). A token
 *      minted seconds ago is still valid, so re-minting it is pure waste.
 *      `mint()` therefore serves a token minted within CLI_MINT_TTL_MS from
 *      memory; `refresh()` (the 401 path) always re-mints and REPLACES the
 *      cached entry, so a token the org rejects self-heals through the existing
 *      capped refresh loop (salesforce.ts createRefreshFn) — the cache can never
 *      pin a dead token for longer than one failed request. OAuth mints read the
 *      vault (no process spawn) and are not cached. Tokens stay in memory only.
 *
 * Everything is injected (getCliToken, vault, fetch, now, clientId) so the whole
 * module is unit-testable in the default lane with fakes — no sf CLI, no network,
 * no electron. Per the standing rule, tests assert the INJECTED fake's call
 * counts; they never assert that a real refresh callout ran.
 */
import type { AuthKind, OrgRole } from '../../shared/types'
import { RdsHandlerError } from '../errors'
import type { CliToken } from './sfcli'
import type { TokenVault } from './tokenVault'
import { refreshTokens, OAuthFlowError } from './oauthFlow'

/** The minimal connection shape the provider needs (OrgConnection satisfies it). */
export interface ConnectionInput {
  id: string
  authKind: AuthKind
  role: OrgRole
  cliAlias: string | null
  loginUrl: string | null
  username: string
  orgId: string
  instanceUrl: string
}

/** A live, authoritative token for building a jsforce Connection. */
export interface MintedToken {
  accessToken: string
  instanceUrl: string
  orgId: string
  username: string
}

/** The result of a refresh handed back to jsforce's retry. */
export interface RefreshedToken {
  accessToken: string
  instanceUrl: string
}

export interface TokenProvider {
  /** Mint the initial token used to construct the connection. */
  mint(conn: ConnectionInput): Promise<MintedToken>
  /** Refresh on a 401 (single-flight per connection id). */
  refresh(conn: ConnectionInput): Promise<RefreshedToken>
}

export interface TokenProviderDeps {
  /** CLI token mint (sfcli.getCliToken); required for cli connections. */
  getCliToken: (aliasOrUsername: string) => Promise<CliToken>
  /** Vault for oauth connections; omit for a CLI-only provider (scripts/tests). */
  vault?: Pick<TokenVault, 'get' | 'put' | 'updateAccess'>
  /** Public PKCE client id (import.meta.env.MAIN_VITE_OAUTH_CLIENT_ID); oauth only. */
  oauthClientId?: string
  /** Injected fetch for the refresh grant (defaults to global fetch). */
  fetch?: typeof fetch
  /** Injected clock (defaults to Date.now) — kept for parity with A4/A3. */
  now?: () => number
  /**
   * S53: how long a CLI-minted token is served from memory before `sf` is
   * asked again (ms). Defaults to CLI_MINT_TTL_MS; 0 disables the cache.
   */
  cliMintTtlMs?: number
}

/** S53: default CLI mint cache TTL — well inside any org session timeout (≥15 min). */
export const CLI_MINT_TTL_MS = 10 * 60_000

/** Fetch adapter: jsforce/A4 use the WHATWG shape; A4's FetchLike is a subset. */
function toFetchLike(f: typeof fetch): Parameters<typeof refreshTokens>[1]['fetch'] {
  return async (url, init) => {
    const res = await f(url, init)
    return {
      status: res.status,
      json: () => res.json(),
      text: () => res.text()
    }
  }
}

class DefaultTokenProvider implements TokenProvider {
  private readonly inflight = new Map<string, Promise<RefreshedToken>>()
  /** S53: CLI mints by connection id, with the clock reading they were minted at. */
  private readonly cliMints = new Map<string, { token: MintedToken; mintedAt: number }>()
  private readonly fetchLike: Parameters<typeof refreshTokens>[1]['fetch']
  private readonly now: () => number
  private readonly cliMintTtlMs: number

  constructor(private readonly deps: TokenProviderDeps) {
    this.fetchLike = toFetchLike(deps.fetch ?? fetch)
    this.now = deps.now ?? Date.now
    this.cliMintTtlMs = deps.cliMintTtlMs ?? CLI_MINT_TTL_MS
  }

  async mint(conn: ConnectionInput): Promise<MintedToken> {
    if (conn.authKind === 'cli') {
      if (!conn.cliAlias) {
        throw new RdsHandlerError('INVALID_STATE', `CLI connection ${conn.id} has no cliAlias`)
      }
      const cached = this.cliMints.get(conn.id)
      if (cached != null && this.now() - cached.mintedAt < this.cliMintTtlMs) {
        return cached.token
      }
      return this.mintCli(conn.id, conn.cliAlias)
    }
    // oauth
    const vault = this.requireVault()
    const ts = vault.get(conn.id)
    if (!ts || !ts.accessToken) {
      throw new RdsHandlerError(
        'AUTH_EXPIRED',
        `Connection ${conn.id} is not signed in — re-authenticate to continue.`,
        undefined,
        conn.id
      )
    }
    return {
      accessToken: ts.accessToken,
      instanceUrl: ts.instanceUrl ?? conn.instanceUrl,
      orgId: conn.orgId,
      username: conn.username
    }
  }

  refresh(conn: ConnectionInput): Promise<RefreshedToken> {
    const existing = this.inflight.get(conn.id)
    if (existing) return existing
    const p = this.doRefresh(conn).finally(() => {
      // Clear only if still ours — a later refresh may have replaced it.
      if (this.inflight.get(conn.id) === p) this.inflight.delete(conn.id)
    })
    this.inflight.set(conn.id, p)
    return p
  }

  /** Ask the CLI for a token and cache it (S53). A throw leaves no stale entry behind. */
  private async mintCli(connectionId: string, cliAlias: string): Promise<MintedToken> {
    this.cliMints.delete(connectionId)
    const t = await this.deps.getCliToken(cliAlias)
    const token: MintedToken = {
      accessToken: t.accessToken,
      instanceUrl: t.instanceUrl,
      orgId: t.orgId,
      username: t.username
    }
    if (this.cliMintTtlMs > 0) this.cliMints.set(connectionId, { token, mintedAt: this.now() })
    return token
  }

  private async doRefresh(conn: ConnectionInput): Promise<RefreshedToken> {
    if (conn.authKind === 'cli') {
      // The CLI re-mints (and transparently refreshes) on demand. Always a real
      // re-mint — the org just rejected what we had — and it REPLACES the cached
      // entry so the next `mint()` hands out the fresh token (S53).
      if (!conn.cliAlias) {
        throw new RdsHandlerError('INVALID_STATE', `CLI connection ${conn.id} has no cliAlias`)
      }
      const t = await this.mintCli(conn.id, conn.cliAlias)
      return { accessToken: t.accessToken, instanceUrl: t.instanceUrl }
    }
    // oauth
    const vault = this.requireVault()
    const clientId = this.deps.oauthClientId
    if (!clientId) {
      throw new RdsHandlerError('INVALID_STATE', 'OAuth client id is not configured')
    }
    if (!conn.loginUrl) {
      throw new RdsHandlerError('INVALID_STATE', `OAuth connection ${conn.id} has no loginUrl`)
    }
    const ts = vault.get(conn.id)
    if (!ts || !ts.refreshToken) {
      throw new RdsHandlerError(
        'AUTH_EXPIRED',
        `Connection ${conn.id} has no refresh token — re-authenticate to continue.`,
        undefined,
        conn.id
      )
    }
    let fresh
    try {
      fresh = await refreshTokens(
        {
          loginUrl: conn.loginUrl,
          clientId,
          refreshToken: ts.refreshToken,
          instanceUrl: ts.instanceUrl ?? conn.instanceUrl
        },
        { fetch: this.fetchLike, now: this.now }
      )
    } catch (err) {
      // A failed refresh (expired/revoked RT — the COMMON expiry, or an
      // unreachable endpoint) must re-type to AUTH_EXPIRED carrying conn.id, so
      // wrapHandler routes it to the global re-auth prompt for THIS connection.
      // A raw OAuthFlowError would fall through ipcError as UNKNOWN with no
      // connection id and the prompt would never fire.
      if (err instanceof OAuthFlowError) {
        throw new RdsHandlerError(
          'AUTH_EXPIRED',
          `Session for connection ${conn.id} could not be refreshed — re-authenticate to continue.`,
          err.detail ?? err.message,
          conn.id
        )
      }
      throw err
    }
    // Persist the new access token; if SF rotated the refresh token, re-put the
    // full set so the rotated RT is not lost (updateAccess only touches the AT).
    if (fresh.refreshToken && fresh.refreshToken !== ts.refreshToken) {
      vault.put(conn.id, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        instanceUrl: fresh.instanceUrl
      })
    } else {
      vault.updateAccess(conn.id, fresh.accessToken, fresh.instanceUrl)
    }
    return { accessToken: fresh.accessToken, instanceUrl: fresh.instanceUrl }
  }

  private requireVault(): NonNullable<TokenProviderDeps['vault']> {
    if (!this.deps.vault) {
      throw new RdsHandlerError('INVALID_STATE', 'OAuth connection used without a TokenVault')
    }
    return this.deps.vault
  }
}

/** Build a TokenProvider. Provide `vault`+`oauthClientId` to enable OAuth orgs. */
export function createTokenProvider(deps: TokenProviderDeps): TokenProvider {
  return new DefaultTokenProvider(deps)
}
