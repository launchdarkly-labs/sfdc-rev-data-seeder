import { describe, it, expect } from 'vitest'
import { wrapHandler, RdsHandlerError } from '../src/main/ipcError'
import { ReadOnlyOrgError } from '../src/main/services/salesforce'
import { parseRdsError } from '../src/shared/types'

/** Simulate how Electron wraps a handler rejection message on the renderer side. */
function electronWrap(channel: string, message: string): string {
  return `Error invoking remote method '${channel}': Error: ${message}`
}

async function roundTrip(fn: () => unknown): Promise<ReturnType<typeof parseRdsError>> {
  const wrapped = wrapHandler(fn as () => unknown)
  try {
    await wrapped()
    throw new Error('expected throw')
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return parseRdsError(electronWrap('rds:test', raw))
  }
}

describe('wrapHandler / RdsError envelope', () => {
  it('maps ReadOnlyOrgError → READ_ONLY_ORG through the Electron-wrapped message', async () => {
    const env = await roundTrip(() => {
      throw new ReadOnlyOrgError('prod_720', 'source', 'blocked at write gate')
    })
    expect(env?.code).toBe('READ_ONLY_ORG')
    expect(env?.message).toMatch(/Write refused/)
  })

  it('carries an explicit RdsHandlerError code + connection', async () => {
    const env = await roundTrip(() => {
      throw new RdsHandlerError('AUTH_EXPIRED', 'session expired', undefined, 'darkb_714')
    })
    expect(env?.code).toBe('AUTH_EXPIRED')
    expect(env?.connection).toBe('darkb_714')
  })

  it('re-types a jsforce-wrapped refresh failure → AUTH_EXPIRED (S52 refresh cap)', async () => {
    // session-refresh-delegate.ts wraps the refreshFn callback error in a plain
    // Error, so the RdsHandlerError from createRefreshFn arrives untyped.
    const env = await roundTrip(() => {
      throw new Error(
        "Unable to refresh session due to: Org 'onesolve' rejected the current session and the refresh returned the same token — re-authenticate the connection."
      )
    })
    expect(env?.code).toBe('AUTH_EXPIRED')
    expect(env?.message).toMatch(/^Org 'onesolve' rejected the current session/)
    expect(env?.detail).toMatch(/^Unable to refresh session due to: /)
  })

  it('maps an unknown error → UNKNOWN preserving the message', async () => {
    const env = await roundTrip(() => {
      throw new Error('kaboom')
    })
    expect(env?.code).toBe('UNKNOWN')
    expect(env?.message).toBe('kaboom')
  })

  it('passes a successful result through untouched', async () => {
    const wrapped = wrapHandler(async (a: number, b: number) => a + b)
    await expect(wrapped(2, 3)).resolves.toBe(5)
  })

  it('parseRdsError returns null for a non-enveloped message', () => {
    expect(parseRdsError('just a normal error')).toBeNull()
  })
})
