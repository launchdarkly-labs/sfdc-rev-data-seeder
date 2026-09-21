/**
 * getCliTokenWith (S52) — pure lane: the CLI runner is injected, so no `sf`
 * process runs. Covers the Salesforce CLI 2.150 change that redacts the access
 * token in `sf org display --json` unless SF_TEMP_SHOW_SECRETS=true is set —
 * an env var a Finder-launched app never has. Before this the placeholder went
 * straight to jsforce and the Orgs step re-minted once a second forever.
 */
import { describe, it, expect } from 'vitest'
import {
  getCliTokenWith,
  REDACTED_TOKEN_MARKER,
  type SfJsonRunner
} from '../src/main/services/sfcli'

const display = {
  id: '00DTI000007RRUj2AO',
  instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com',
  username: 'admin@onesolve',
  apiVersion: '68.0',
  connectedStatus: 'Connected'
}
const REAL = '00DTI000007RRUj2AO!AQEAQ.real.token'
const PLACEHOLDER = `${REDACTED_TOKEN_MARKER} Use 'sf org auth show-access-token' instead`

/** A fake `sf … --json` runner keyed by the joined argv; records every call. */
function fakeRunner(responses: Record<string, unknown | Error>): {
  run: SfJsonRunner
  calls: string[]
} {
  const calls: string[] = []
  const run = (async (args: string[]) => {
    const key = args.join(' ')
    calls.push(key)
    if (!(key in responses)) throw new Error(`unexpected sf call: ${key}`)
    const r = responses[key]
    if (r instanceof Error) throw r
    return r
  }) as SfJsonRunner
  return { run, calls }
}

describe('getCliTokenWith', () => {
  it('pre-2.150 CLI: takes the token from org display and makes ONE call', async () => {
    const { run, calls } = fakeRunner({
      'org display -o onesolve': { ...display, accessToken: REAL }
    })
    const t = await getCliTokenWith(run, 'onesolve')
    expect(t.accessToken).toBe(REAL)
    expect(t.instanceUrl).toBe(display.instanceUrl)
    expect(t.orgId).toBe(display.id)
    expect(t.username).toBe('admin@onesolve')
    expect(t.apiVersion).toBe('68.0')
    expect(calls).toEqual(['org display -o onesolve'])
  })

  it('2.150+ CLI: a redacted token falls back to org auth show-access-token', async () => {
    const { run, calls } = fakeRunner({
      'org display -o onesolve': { ...display, accessToken: PLACEHOLDER },
      'org auth show-access-token -o onesolve': { accessToken: REAL }
    })
    const t = await getCliTokenWith(run, 'onesolve')
    expect(t.accessToken).toBe(REAL)
    // Metadata still comes from org display (which also refreshed the auth).
    expect(t.instanceUrl).toBe(display.instanceUrl)
    expect(t.orgId).toBe(display.id)
    expect(calls).toEqual([
      'org display -o onesolve',
      'org auth show-access-token -o onesolve'
    ])
  })

  it('a missing token also falls back (defensive against future output changes)', async () => {
    const { run } = fakeRunner({
      'org display -o onesolve': { ...display },
      'org auth show-access-token -o onesolve': { accessToken: REAL }
    })
    const t = await getCliTokenWith(run, 'onesolve')
    expect(t.accessToken).toBe(REAL)
  })

  it('NEVER returns the placeholder: both commands redacted → a clear error', async () => {
    const { run } = fakeRunner({
      'org display -o onesolve': { ...display, accessToken: PLACEHOLDER },
      'org auth show-access-token -o onesolve': { accessToken: PLACEHOLDER }
    })
    await expect(getCliTokenWith(run, 'onesolve')).rejects.toThrow(
      /no usable access token for onesolve.*status: Connected.*sf org login web -a onesolve/
    )
  })

  it('names both commands when the fallback itself fails (old CLI without the command)', async () => {
    const { run } = fakeRunner({
      'org display -o onesolve': { ...display, accessToken: PLACEHOLDER },
      'org auth show-access-token -o onesolve': new Error(
        'sf org auth show-access-token -o onesolve failed: command not found'
      )
    })
    await expect(getCliTokenWith(run, 'onesolve')).rejects.toThrow(
      /redacted the access token for onesolve.*show-access-token failed: .*command not found.*sf update/
    )
  })

  it('fails on a missing instance URL before touching the token', async () => {
    const { run, calls } = fakeRunner({
      'org display -o onesolve': { accessToken: REAL, connectedStatus: 'Unknown' }
    })
    await expect(getCliTokenWith(run, 'onesolve')).rejects.toThrow(
      /no instance URL for onesolve \(status: Unknown\)/
    )
    expect(calls).toHaveLength(1)
  })
})
