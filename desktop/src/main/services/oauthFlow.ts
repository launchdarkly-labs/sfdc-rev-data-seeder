/**
 * oauthFlow — Salesforce OAuth 2.0 Authorization Code + PKCE for a PUBLIC client.
 *
 * This is the A4 building block behind the OAuth half of a dual-mode connection.
 * It NEVER holds a consumer secret (Session-26 scar): the ECA "RDS_Desktop" is a
 * public client, so every leg (authorize → exchange → refresh → revoke) is
 * secret-free and uses PKCE S256 for the auth-code binding.
 *
 * Layering (mirrors the TokenVault split so the default vitest lane stays
 * electron-free and ABI-independent):
 *   • PURE, unit-tested here: generatePkce, buildAuthorizeUrl, parseCallbackParams,
 *     parseTokenResponse, mergeRefreshResponse, redirectUriFor.
 *   • INJECTED-fetch, unit-tested with a fake: exchangeCode, refreshTokens,
 *     revokeToken. No electron, no socket — just an HTTP shape, so a fake `fetch`
 *     fully covers them.
 *   • INTEGRATION-only: authorize() opens the system browser (shell.openExternal)
 *     and binds a loopback http server. That boundary is exercised in the node
 *     integration lane / smoke, never asserted in the pure lane.
 *
 * Loopback redirect: SF has no port-agnostic redirect matching, so all three
 * URLs are registered on the ECA and we bind the first free port 53682→53684.
 * The host MUST be `localhost`, NOT `127.0.0.1` — SF rejects `http://127.0.0.1`
 * as an HTTP URL (confirmed live 2026-07-24). We bind IPv4 explicitly so the
 * browser's `localhost` → 127.0.0.1 resolution reaches us even on hosts where
 * `localhost` would otherwise prefer `::1`.
 *
 * Standing rule: tokens are NEVER logged. Nothing here writes token material to
 * a logger; callers persist via TokenVault (encrypted) and never over IPC.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

/** Ordered loopback ports registered as ECA callbacks. First free one wins. */
export const LOOPBACK_PORTS = [53682, 53683, 53684] as const

/** Default scopes for a data-migration client: API access + a refresh token. */
export const DEFAULT_SCOPES = 'api refresh_token'

/** How long we wait for the browser round-trip before giving up. */
export const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000

export type OAuthErrorCode =
  | 'user_denied'
  | 'state_mismatch'
  | 'timeout'
  | 'port_unavailable'
  | 'browser_open_failed'
  | 'exchange_failed'
  | 'refresh_failed'
  | 'revoke_failed'

/** Typed failure for the OAuth flow; the IPC seam maps this to an RdsError. */
export class OAuthFlowError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

export interface PkcePair {
  /** 86-char base64url (64 random bytes). */
  verifier: string
  /** 43-char base64url of SHA-256(verifier). */
  challenge: string
  method: 'S256'
}

/** Base64url per RFC 7636: base64, `+`→`-`, `/`→`_`, no padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a PKCE verifier/challenge pair. `rng` is injectable so tests can pin
 * the bytes; production uses node's CSPRNG.
 */
export function generatePkce(rng: (n: number) => Buffer = nodeRandomBytes): PkcePair {
  const verifier = base64url(rng(64)) // 64 bytes → 86 chars
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** Opaque CSRF/state value: 43-char base64url (32 random bytes). */
export function generateState(rng: (n: number) => Buffer = nodeRandomBytes): string {
  return base64url(rng(32))
}

/** The exact redirect URI for a port — localhost, never 127.0.0.1. */
export function redirectUriFor(port: number): string {
  return `http://localhost:${port}/callback`
}

export interface AuthorizeUrlParams {
  /** e.g. https://login.salesforce.com or a sandbox / My Domain host. */
  loginUrl: string
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /** Space-delimited; defaults to DEFAULT_SCOPES. */
  scope?: string
}

/**
 * Build the `/services/oauth2/authorize` URL. `prompt=login` is intentionally
 * omitted so an already-authenticated browser session flows through; callers
 * that need account re-selection can add it later.
 */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const base = p.loginUrl.replace(/\/+$/, '')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope ?? DEFAULT_SCOPES,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256'
  })
  return `${base}/services/oauth2/authorize?${q.toString()}`
}

export type ParsedCallback =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string; errorDescription?: string; state: string | null }

/**
 * Parse a loopback callback URL. Accepts a full URL or a bare `/callback?...`
 * path. Returns a discriminated result rather than throwing so the caller can
 * map `access_denied` → user_denied and everything else → exchange context.
 *
 * `state` is surfaced on BOTH branches (SF echoes it on error redirects per
 * RFC 6749 §4.1.2.1) so the caller can verify state FIRST and ignore any
 * unsolicited/forged callback — successful or error — that doesn't match.
 */
export function parseCallbackParams(rawUrl: string): ParsedCallback {
  let params: URLSearchParams
  try {
    // Tolerate a path-only request-target by giving it a dummy origin.
    params = new URL(rawUrl, 'http://localhost').searchParams
  } catch {
    return {
      ok: false,
      error: 'invalid_request',
      errorDescription: 'unparseable callback URL',
      state: null
    }
  }
  const state = params.get('state')
  const error = params.get('error')
  if (error) {
    return { ok: false, error, errorDescription: params.get('error_description') ?? undefined, state }
  }
  const code = params.get('code')
  if (!code || !state) {
    return { ok: false, error: 'invalid_request', errorDescription: 'missing code or state', state }
  }
  return { ok: true, code, state }
}

/** Normalized token material returned to the caller (persisted via TokenVault). */
export interface OAuthTokenSet {
  accessToken: string
  /** Null only if SF withheld one (shouldn't happen with refresh_token scope). */
  refreshToken: string | null
  instanceUrl: string
  /** SF identity URL (`id`); useful for orgId drift detection (A8). */
  idUrl: string | null
  scope: string | null
  issuedAt: number
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  instance_url?: string
  id?: string
  scope?: string
  error?: string
  error_description?: string
}

/**
 * Parse a token-endpoint response body. `now` is injected so callers stamp a
 * deterministic issuedAt in tests. Throws OAuthFlowError('exchange_failed') on
 * any error body or missing access_token / instance_url.
 */
export function parseTokenResponse(
  status: number,
  body: RawTokenResponse,
  now: number
): OAuthTokenSet {
  if (status < 200 || status >= 300 || body.error) {
    throw new OAuthFlowError(
      'exchange_failed',
      'Token exchange failed',
      body.error ? `${body.error}: ${body.error_description ?? ''}`.trim() : `HTTP ${status}`
    )
  }
  if (!body.access_token || !body.instance_url) {
    throw new OAuthFlowError(
      'exchange_failed',
      'Token response missing access_token or instance_url'
    )
  }
  return {
    accessToken: body.access_token,
    // `||` not `??`: a falsy-but-present '' must not be stored as a token.
    refreshToken: body.refresh_token || null,
    instanceUrl: body.instance_url,
    idUrl: body.id ?? null,
    scope: body.scope ?? null,
    issuedAt: now
  }
}

/**
 * Merge a refresh-grant response onto the prior token set. Rotation-safe:
 *   • adopt a rotated refresh_token if SF returns a NON-EMPTY one, else KEEP the
 *     prior RT (SF usually omits it on refresh — dropping it, or storing a stray
 *     '' from a bad proxy/gateway, would strand the connection);
 *   • adopt the returned instance_url if present (org can move), else keep prior.
 * Throws OAuthFlowError('refresh_failed') on an error body or missing access_token.
 */
export function mergeRefreshResponse(
  prev: { refreshToken: string | null; instanceUrl: string },
  status: number,
  body: RawTokenResponse,
  now: number
): OAuthTokenSet {
  if (status < 200 || status >= 300 || body.error) {
    throw new OAuthFlowError(
      'refresh_failed',
      'Token refresh failed',
      body.error ? `${body.error}: ${body.error_description ?? ''}`.trim() : `HTTP ${status}`
    )
  }
  if (!body.access_token) {
    throw new OAuthFlowError('refresh_failed', 'Refresh response missing access_token')
  }
  return {
    accessToken: body.access_token,
    // `||` not `??`: keep the prior RT/instanceUrl when the field is absent OR a
    // falsy '' — only a real, non-empty value should replace them.
    refreshToken: body.refresh_token || prev.refreshToken,
    instanceUrl: body.instance_url || prev.instanceUrl,
    idUrl: body.id ?? null,
    scope: body.scope ?? null,
    issuedAt: now
  }
}

/** Fetch surface we depend on — the global `fetch` satisfies it in production. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>

/** Read a token-endpoint body as JSON, tolerating a non-JSON error page. */
async function readBody(
  res: { status: number; json(): Promise<unknown>; text(): Promise<string> }
): Promise<RawTokenResponse> {
  try {
    return (await res.json()) as RawTokenResponse
  } catch {
    // SF returns HTML/text on some gateway errors; surface the status only.
    return {}
  }
}

export interface ExchangeParams {
  loginUrl: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}

/** Exchange an auth code for tokens (public client — no secret, with PKCE verifier). */
export async function exchangeCode(
  p: ExchangeParams,
  deps: { fetch: FetchLike; now: () => number }
): Promise<OAuthTokenSet> {
  const base = p.loginUrl.replace(/\/+$/, '')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier
  }).toString()
  let res
  try {
    res = await deps.fetch(`${base}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    })
  } catch (e) {
    throw new OAuthFlowError('exchange_failed', 'Token endpoint unreachable', String(e))
  }
  return parseTokenResponse(res.status, await readBody(res), deps.now())
}

export interface RefreshParams {
  loginUrl: string
  clientId: string
  refreshToken: string
  /** Prior instance_url, kept if the response omits one. */
  instanceUrl: string
}

/** Refresh grant (public client — no secret). Rotation-safe via mergeRefreshResponse. */
export async function refreshTokens(
  p: RefreshParams,
  deps: { fetch: FetchLike; now: () => number }
): Promise<OAuthTokenSet> {
  const base = p.loginUrl.replace(/\/+$/, '')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: p.refreshToken,
    client_id: p.clientId
  }).toString()
  let res
  try {
    res = await deps.fetch(`${base}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    })
  } catch (e) {
    throw new OAuthFlowError('refresh_failed', 'Token endpoint unreachable', String(e))
  }
  return mergeRefreshResponse(
    { refreshToken: p.refreshToken, instanceUrl: p.instanceUrl },
    res.status,
    await readBody(res),
    deps.now()
  )
}

/**
 * Best-effort token revocation on disconnect. Returns true on success, FALSE on
 * any failure — it NEVER throws, because a failed revoke must not block the
 * local wipe of stored tokens (which is what actually protects the machine).
 */
export async function revokeToken(
  p: { loginUrl: string; token: string },
  deps: { fetch: FetchLike }
): Promise<boolean> {
  try {
    // Inside the try: a null/absent loginUrl (stale/partly-migrated row) must
    // yield `false` with no bogus request, never a thrown TypeError that would
    // block the caller's local token wipe.
    if (!p.loginUrl) return false
    const base = p.loginUrl.replace(/\/+$/, '')
    const res = await deps.fetch(`${base}/services/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: p.token }).toString()
    })
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// INTEGRATION-only orchestrator: system browser + loopback server.
// Not exercised in the pure lane (it binds a socket and opens a browser).
// ---------------------------------------------------------------------------

export interface AuthorizeOptions {
  loginUrl: string
  clientId: string
  scope?: string
  timeoutMs?: number
}

export interface AuthorizeDeps {
  /** Electron `shell.openExternal`. */
  openExternal(url: string): Promise<void>
  fetch: FetchLike
  now: () => number
  /** Injectable RNG so a harness can pin PKCE/state; defaults to CSPRNG. */
  randomBytes?: (n: number) => Buffer
}

/** Bind an http server to the first free loopback port in LOOPBACK_PORTS. */
function bindLoopback(
  handler: (reqUrl: string, end: (status: number, html: string) => void) => void
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const ports = [...LOOPBACK_PORTS]
    const tryNext = (): void => {
      const port = ports.shift()
      if (port === undefined) {
        reject(new OAuthFlowError('port_unavailable', 'No free loopback port in 53682-53684'))
        return
      }
      const server = createServer((req, res) => {
        handler(req.url ?? '/', (status, html) => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
          res.end(html)
        })
      })
      // Bind-phase error handler ONLY — a bind failure falls through to the next
      // port or rejects. It is removed the instant we start listening (below) so
      // it can't later close the live listener out from under authorize(); a
      // post-listen accept error is handled by authorize's own listener.
      const onBindError = (err: NodeJS.ErrnoException): void => {
        server.close()
        if (err.code === 'EADDRINUSE') tryNext()
        else reject(new OAuthFlowError('port_unavailable', `Loopback bind failed`, String(err)))
      }
      server.once('error', onBindError)
      // Bind IPv4 localhost explicitly so browser `localhost`→127.0.0.1 reaches us.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onBindError)
        resolve({ server, port })
      })
    }
    tryNext()
  })
}

const DONE_HTML = (msg: string): string =>
  `<!doctype html><meta charset=utf-8><title>RDS</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${msg}</h2><p>You can close this tab and return to Rev Data Seeder.</p></body>`

/**
 * Full interactive authorization: bind loopback → open browser → await callback
 * → verify state → exchange code. Resolves with the token set + the resolved
 * loginUrl/idUrl for persistence. Integration-only.
 */
export async function authorize(
  opts: AuthorizeOptions,
  deps: AuthorizeDeps
): Promise<OAuthTokenSet> {
  const rng = deps.randomBytes ?? nodeRandomBytes
  const pkce = generatePkce(rng)
  const state = generateState(rng)
  const timeoutMs = opts.timeoutMs ?? AUTHORIZE_TIMEOUT_MS

  let resolveCb: (code: string) => void
  let rejectCb: (err: OAuthFlowError) => void
  const callbackReceived = new Promise<string>((resolve, reject) => {
    resolveCb = resolve
    rejectCb = reject
  })

  const { server, port } = await bindLoopback((reqUrl, end) => {
    // Ignore favicon / non-callback probes so a browser prefetch can't resolve us.
    if (!reqUrl.startsWith('/callback')) {
      end(404, DONE_HTML('Not found'))
      return
    }
    const parsed = parseCallbackParams(reqUrl)
    // Verify state FIRST. A callback whose state doesn't match ours is
    // unsolicited/forged (another tab, a probe, a cross-origin <img> hitting our
    // fixed port). Per RFC 8252 we IGNORE it and keep listening — tearing the
    // flow down here would let any local page/process DoS an in-progress sign-in.
    if (parsed.state !== state) {
      end(400, DONE_HTML('Ignoring an unrelated request.'))
      return
    }
    // State matches → this is genuinely our redirect. Now honor error vs code.
    if (!parsed.ok) {
      const code: OAuthErrorCode = parsed.error === 'access_denied' ? 'user_denied' : 'exchange_failed'
      end(400, DONE_HTML('Authorization failed.'))
      rejectCb(new OAuthFlowError(code, parsed.errorDescription ?? parsed.error))
      return
    }
    end(200, DONE_HTML('Signed in.'))
    resolveCb(parsed.code)
  })

  // A post-listen socket/accept error must fail the flow fast (not hang until the
  // 5-min timeout, and not throw as an uncaught 'error' event).
  server.on('error', (err: NodeJS.ErrnoException) =>
    rejectCb(new OAuthFlowError('port_unavailable', 'Loopback server error', String(err)))
  )

  const redirectUri = redirectUriFor(port)
  const timer = setTimeout(
    () => rejectCb(new OAuthFlowError('timeout', `Authorization timed out after ${timeoutMs}ms`)),
    timeoutMs
  )
  timer.unref?.()

  try {
    // Kick off the browser WITHOUT an intervening await: attaching the
    // `await callbackReceived` consumer synchronously (no microtask gap after the
    // server goes live) means the server can never reject an unhandled promise.
    // openExternal's own failure is routed into the same reject channel.
    deps
      .openExternal(
        buildAuthorizeUrl({
          loginUrl: opts.loginUrl,
          clientId: opts.clientId,
          redirectUri,
          state,
          codeChallenge: pkce.challenge,
          scope: opts.scope
        })
      )
      .catch((e) =>
        rejectCb(new OAuthFlowError('browser_open_failed', 'Could not open the system browser', String(e)))
      )
    const code = await callbackReceived
    return await exchangeCode(
      {
        loginUrl: opts.loginUrl,
        clientId: opts.clientId,
        redirectUri,
        code,
        codeVerifier: pkce.verifier
      },
      { fetch: deps.fetch, now: deps.now }
    )
  } finally {
    clearTimeout(timer)
    server.close()
  }
}
