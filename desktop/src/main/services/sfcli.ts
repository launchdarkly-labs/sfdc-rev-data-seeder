/**
 * CLI-delegated auth bridge (SFDMU-GUI pattern): enumerate orgs the user has
 * already authenticated in the Salesforce CLI, and mint a live access token
 * on demand via `sf org display`. This is the zero-setup convenience path —
 * the ECA (PKCE + JWT Bearer) path is the distribution-grade primary and
 * lands in Epic 1.4/1.5 (see ROADMAP.md).
 *
 * Tokens minted here are held in memory only and never persisted — the CLI's
 * own keychain storage stays the source of truth.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

/** Generous timeout: `sf org display` refreshes expired tokens via OAuth. */
const SF_TIMEOUT_MS = 60_000

/**
 * PATH augmentation for the packaged app (A1 fix). A launchd-spawned process
 * (Finder / Dock / `open`) inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, so
 * `sf` — installed under Homebrew or npm-global — is not on PATH and every CLI
 * call fails ENOENT. We prepend the canonical `sf` install locations to the
 * inherited PATH. (In `npm run dev` from a terminal the shell PATH already has
 * these; prepending is harmless.)
 */
const SF_BIN_DIRS = [
  '/opt/homebrew/bin', // Apple Silicon Homebrew
  '/usr/local/bin', // Intel Homebrew / standalone installer / npm-global default
  `${homedir()}/.npm-global/bin` // common npm global prefix
]
const EXEC_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [...SF_BIN_DIRS, process.env.PATH ?? ''].filter(Boolean).join(':')
}

export interface CliOrg {
  alias: string
  username: string
  orgId: string
  instanceUrl: string
  connectedStatus: string
  isSandbox: boolean | null
  isScratch: boolean | null
}

export interface CliToken {
  accessToken: string
  instanceUrl: string
  orgId: string
  username: string
  apiVersion: string | null
}

async function sfJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync('sf', [...args, '--json'], {
    timeout: SF_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: EXEC_ENV
  })
  const parsed = JSON.parse(stdout)
  if (parsed.status !== 0) {
    throw new Error(
      `sf ${args.join(' ')} failed: ${parsed.message ?? JSON.stringify(parsed).slice(0, 300)}`
    )
  }
  return parsed.result as T
}

interface SfOrgListResult {
  nonScratchOrgs?: SfOrgEntry[]
  scratchOrgs?: SfOrgEntry[]
  other?: SfOrgEntry[]
  sandboxes?: SfOrgEntry[]
  devHubs?: SfOrgEntry[]
}

interface SfOrgEntry {
  alias?: string
  aliases?: string[]
  username?: string
  orgId?: string
  instanceUrl?: string
  connectedStatus?: string
  isSandbox?: boolean
  isScratch?: boolean
  isExpired?: boolean | string
}

/**
 * Lists CLI-authenticated orgs, deduplicated by username (the CLI reports the
 * same org under multiple category buckets — devHubs, sandboxes, etc.).
 * Orgs without an alias use their username as the local identity.
 */
export async function listCliOrgs(): Promise<CliOrg[]> {
  const result = await sfJson<SfOrgListResult>(['org', 'list'])
  const byUsername = new Map<string, CliOrg>()
  const buckets: (SfOrgEntry[] | undefined)[] = [
    result.nonScratchOrgs,
    result.sandboxes,
    result.devHubs,
    result.scratchOrgs,
    result.other
  ]
  for (const bucket of buckets) {
    if (!bucket) continue
    for (const o of bucket) {
      if (!o.username) continue
      if (byUsername.has(o.username)) continue
      byUsername.set(o.username, {
        alias: o.alias ?? o.aliases?.[0] ?? o.username,
        username: o.username,
        orgId: o.orgId ?? '',
        instanceUrl: o.instanceUrl ?? '',
        connectedStatus: o.connectedStatus ?? 'Unknown',
        isSandbox: o.isSandbox ?? null,
        isScratch: o.isScratch ?? null
      })
    }
  }
  return [...byUsername.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

interface SfOrgDisplayResult {
  accessToken?: string
  instanceUrl?: string
  id?: string
  username?: string
  apiVersion?: string
  connectedStatus?: string
}

interface SfShowAccessTokenResult {
  accessToken?: string
}

/**
 * Salesforce CLI 2.150+ (2026-09) substitutes this placeholder for the access
 * token in `sf org display --json` unless SF_TEMP_SHOW_SECRETS=true is in the
 * environment — which a Finder/Dock-launched app never has. The real token
 * must then be read via `sf org auth show-access-token`.
 */
export const REDACTED_TOKEN_MARKER = '[REDACTED]'

/** A runner for `sf <args> --json` that returns the parsed `result`. */
export type SfJsonRunner = <T>(args: string[]) => Promise<T>

function isUsableToken(token: string | undefined): token is string {
  return !!token && !token.startsWith(REDACTED_TOKEN_MARKER)
}

/**
 * Mints a live access token for one org. The CLI transparently refreshes an
 * expired token when it can; a hard auth failure surfaces as a thrown error
 * with the CLI's message (e.g. expired refresh token → user must re-login).
 *
 * `org display` is always called first: it refreshes the stored auth and
 * reports connectedStatus. When it hands back the redacted placeholder (CLI
 * 2.150+, see REDACTED_TOKEN_MARKER) the token is read through the CLI's
 * replacement command instead. Passing the placeholder on to jsforce would
 * 401 → refresh → placeholder → 401 … with no attempt cap (S52 incident:
 * the Orgs step sat on "Comparing schemas…" forever, re-minting once a second).
 */
export function getCliToken(aliasOrUsername: string): Promise<CliToken> {
  return getCliTokenWith(sfJson, aliasOrUsername)
}

/** `getCliToken` with the CLI runner injected — the unit-testable core. */
export async function getCliTokenWith(
  run: SfJsonRunner,
  aliasOrUsername: string
): Promise<CliToken> {
  const r = await run<SfOrgDisplayResult>(['org', 'display', '-o', aliasOrUsername])
  const status = r.connectedStatus ? ` (status: ${r.connectedStatus})` : ''
  if (!r.instanceUrl) {
    throw new Error(`sf org display returned no instance URL for ${aliasOrUsername}${status}`)
  }
  let accessToken = r.accessToken
  if (!isUsableToken(accessToken)) {
    try {
      const t = await run<SfShowAccessTokenResult>([
        'org',
        'auth',
        'show-access-token',
        '-o',
        aliasOrUsername
      ])
      accessToken = t.accessToken
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `sf org display redacted the access token for ${aliasOrUsername} and ` +
          `sf org auth show-access-token failed: ${detail}. Update the Salesforce CLI (sf update) and retry.`,
        { cause: err }
      )
    }
  }
  if (!isUsableToken(accessToken)) {
    throw new Error(
      `The Salesforce CLI returned no usable access token for ${aliasOrUsername}${status}. ` +
        `Re-authenticate (sf org login web -a ${aliasOrUsername}) and retry.`
    )
  }
  return {
    accessToken,
    instanceUrl: r.instanceUrl,
    orgId: r.id ?? '',
    username: r.username ?? aliasOrUsername,
    apiVersion: r.apiVersion ?? null
  }
}
