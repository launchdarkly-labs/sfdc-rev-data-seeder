/**
 * Main-side typed-error plumbing for IPC handlers. Every `ipcMain.handle`
 * callback is wrapped so thrown errors reach the renderer as a decodable
 * `RdsError` envelope (see shared/types.ts) instead of an opaque string.
 */
import { encodeRdsError } from '../shared/types'
import type { RdsError } from '../shared/types'
import { ReadOnlyOrgError } from './services/salesforce'
import { RdsHandlerError } from './errors'

export { RdsHandlerError }

/**
 * jsforce wraps a failed `refreshFn` callback in a plain Error with this prefix
 * (session-refresh-delegate.ts), discarding the typed cause. Re-type it here so
 * the refresh cap in salesforce.ts reaches the renderer as AUTH_EXPIRED and
 * triggers the re-authenticate prompt instead of an opaque UNKNOWN toast.
 */
const JSFORCE_REFRESH_FAILED_PREFIX = 'Unable to refresh session due to: '

function toEnvelope(err: unknown): RdsError {
  if (err instanceof RdsHandlerError) {
    return { code: err.code, message: err.message, detail: err.detail, connection: err.connection }
  }
  if (err instanceof ReadOnlyOrgError) {
    return { code: 'READ_ONLY_ORG', message: err.message }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith(JSFORCE_REFRESH_FAILED_PREFIX)) {
    return {
      code: 'AUTH_EXPIRED',
      message: message.slice(JSFORCE_REFRESH_FAILED_PREFIX.length),
      detail: message
    }
  }
  return { code: 'UNKNOWN', message }
}

type Handler<A extends unknown[], R> = (...args: A) => R | Promise<R>

/**
 * Wrap an ipcMain.handle callback. On throw, re-throws an Error whose message
 * carries the encoded envelope; `callIpc` on the renderer decodes it.
 */
export function wrapHandler<A extends unknown[], R>(fn: Handler<A, R>): Handler<A, Promise<R>> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args)
    } catch (err) {
      throw new Error(encodeRdsError(toEnvelope(err)), { cause: err })
    }
  }
}
