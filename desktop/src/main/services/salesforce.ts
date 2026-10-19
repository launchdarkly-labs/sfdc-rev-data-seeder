/**
 * Guarded Salesforce client — the ONLY way engine code talks to an org.
 *
 * Guardrail D1 (standing project rule, enforced in code from day one):
 * - A connection whose role is not exactly 'target' REFUSES every write
 *   (DML, Bulk ingest, Tooling writes). Reads are always allowed.
 * - LaunchDarkly production (org Id prefix 00D41000000UvVn) is permanently
 *   pinned read-only — it can never be assigned the 'target' role, and even
 *   if store data were tampered with, the write gate re-checks the org Id.
 *
 * API version is pinned to v66.0 to match the Apex app.
 */
import { Connection } from '@jsforce/jsforce-node'
import type { OrgRole } from '../../shared/types'
import { PROD_ORG_ID_PREFIX } from '../../shared/types'
import { RdsHandlerError } from '../errors'
import { getCliToken } from './sfcli'
import {
  createTokenProvider,
  type ConnectionInput,
  type TokenProvider
} from './tokenProvider'

export const API_VERSION = '66.0'

/**
 * Refresh-loop cap. jsforce retries a 401'd request after EVERY successful
 * refresh with no attempt limit (http-api.ts → `return this.request(request)`),
 * so a token the org keeps rejecting would otherwise re-mint and retry forever
 * with nothing reaching the UI (S52: the Orgs step spun once a second on the
 * CLI's redacted-token placeholder). The hook stops after REFRESH_CAP refreshes
 * inside REFRESH_WINDOW_MS, or as soon as a refresh hands back the SAME token
 * the org just rejected — retrying that is guaranteed to 401 again.
 */
export const REFRESH_CAP = 3
export const REFRESH_WINDOW_MS = 60_000

/** The subset of a jsforce Connection the refresh hook reads/writes. */
export type RefreshableConn = Pick<Connection, 'accessToken' | 'instanceUrl'>
export type RefreshCallback = (err: Error | null, accessToken?: string) => void
export type RefreshFn = (c: RefreshableConn, callback: RefreshCallback) => void

/**
 * Builds the jsforce `refreshFn` for one connection: delegates to
 * `tokens.refresh` (single-flight), adopts a moved instance URL, and applies the
 * loop cap above. Exported (with an injectable clock) so the cap is unit-testable
 * without a live Connection.
 */
export function createRefreshFn(
  conn: ConnectionInput,
  tokens: TokenProvider,
  now: () => number = Date.now
): RefreshFn {
  const alias = conn.cliAlias ?? conn.id
  let windowStart = 0
  let refreshes = 0
  return (c, callback) => {
    const t = now()
    if (t - windowStart > REFRESH_WINDOW_MS) {
      windowStart = t
      refreshes = 0
    }
    refreshes += 1
    if (refreshes > REFRESH_CAP) {
      callback(
        new RdsHandlerError(
          'AUTH_EXPIRED',
          `Org '${alias}' rejected ${REFRESH_CAP} freshly minted tokens in a row — ` +
            `re-authenticate the connection (CLI orgs: sf org login web -a ${alias}).`,
          undefined,
          conn.id
        )
      )
      return
    }
    tokens
      .refresh(conn)
      .then((fresh) => {
        if (fresh.accessToken === c.accessToken) {
          callback(
            new RdsHandlerError(
              'AUTH_EXPIRED',
              `Org '${alias}' rejected the current session and the refresh returned the same ` +
                `token — re-authenticate the connection (CLI orgs: sf org login web -a ${alias}).`,
              undefined,
              conn.id
            )
          )
          return
        }
        // Adopt a moved instance URL (rare; sandbox refresh) before the retry.
        if (fresh.instanceUrl && fresh.instanceUrl !== c.instanceUrl) {
          c.instanceUrl = fresh.instanceUrl
        }
        callback(null, fresh.accessToken)
      })
      .catch((err: Error) => callback(err))
  }
}

export class ReadOnlyOrgError extends Error {
  constructor(alias: string, role: OrgRole, detail: string) {
    super(
      `Write refused: org '${alias}' has role '${role}' — only 'target' connections accept writes. ${detail}`
    )
    this.name = 'ReadOnlyOrgError'
  }
}

export function isProdOrg(orgId: string): boolean {
  return orgId.startsWith(PROD_ORG_ID_PREFIX)
}

export interface GuardedOrg {
  alias: string
  role: OrgRole
  orgId: string
  conn: Connection
  /** Throws ReadOnlyOrgError unless this org accepts writes. */
  assertWritable(operation: string): void
}

/**
 * Builds a live jsforce connection for either a CLI- or OAuth-authenticated org.
 *
 * Auth kind is dispatched entirely inside the injected `TokenProvider`: this
 * function is auth-agnostic and only ever sees an access token + instance URL,
 * so the GuardedOrg shape is unchanged and engines need no edits.
 *
 * 401 handling is jsforce-native: `refreshFn` (NOT an oauth2 config, which would
 * bypass A4) is called on a 401, delegates to `tokens.refresh` (single-flight),
 * and hands jsforce the new access token for its automatic retry-once. We adopt
 * a moved instance URL onto the live connection at the same time.
 */
export async function connect(
  conn: ConnectionInput,
  tokens: TokenProvider
): Promise<GuardedOrg> {
  const alias = conn.cliAlias ?? conn.id
  const minted = await tokens.mint(conn)
  // Prod pin: force read-only when the MINTED org id is LD production. For CLI
  // this id is live-derived (`sf org display`); for OAuth it currently comes from
  // the stored row (A3's vault holds no orgId). So an OAuth row with an empty/
  // unknown org id can't be trusted as non-prod — treat it as read-only until a
  // live identity() (markVerified) has populated a real org id. Deriving the
  // OAuth org id live from the token idUrl (+ sandbox-refresh drift) is A7/A8.
  const untrustedOAuthOrg = conn.authKind === 'oauth' && !minted.orgId
  const effectiveRole: OrgRole =
    isProdOrg(minted.orgId) || untrustedOAuthOrg ? 'source' : conn.role

  const jsConn = new Connection({
    instanceUrl: minted.instanceUrl,
    accessToken: minted.accessToken,
    version: API_VERSION,
    refreshFn: createRefreshFn(conn, tokens)
  })

  const guarded: GuardedOrg = {
    alias,
    role: effectiveRole,
    orgId: minted.orgId,
    conn: jsConn,
    assertWritable(operation: string): void {
      if (isProdOrg(guarded.orgId)) {
        throw new ReadOnlyOrgError(
          alias,
          guarded.role,
          `This is LaunchDarkly PRODUCTION — permanently read-only (attempted: ${operation}).`
        )
      }
      if (guarded.role !== 'target') {
        throw new ReadOnlyOrgError(alias, guarded.role, `Attempted: ${operation}.`)
      }
    }
  }
  return guarded
}

/**
 * Convenience for CLI-only callers (scripts, smoke/parity harnesses) that have a
 * bare alias and no store row: wraps `connect` with a CLI-only TokenProvider.
 */
export function connectCli(alias: string, role: OrgRole): Promise<GuardedOrg> {
  const tokens = createTokenProvider({ getCliToken })
  return connect(
    {
      id: alias,
      authKind: 'cli',
      role,
      cliAlias: alias,
      loginUrl: null,
      username: alias,
      orgId: '',
      instanceUrl: ''
    },
    tokens
  )
}

export interface IdentityCheck {
  orgId: string
  username: string
  apiVersion: string
}

/** Cheap live verification: one identity call. */
export async function verifyIdentity(org: GuardedOrg): Promise<IdentityCheck> {
  const identity = await org.conn.identity()
  return {
    orgId: identity.organization_id,
    username: identity.username,
    apiVersion: API_VERSION
  }
}
