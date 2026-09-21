import type { RdsError } from '../../../shared/types'
import { parseRdsError } from '../../../shared/types'

/**
 * Renderer-side IPC wrapper. Decodes the main-side error envelope into a typed
 * `RdsError` and routes `AUTH_EXPIRED` to a globally-registered handler (the
 * re-auth prompt) before rejecting, so callers get a structured error and never
 * string-sniff (pain 3.13).
 */

type AuthExpiredHandler = (err: RdsError) => void
let authExpiredHandler: AuthExpiredHandler | null = null

/** App registers this once (mapped to a re-auth prompt / toast). */
export function setAuthExpiredHandler(handler: AuthExpiredHandler | null): void {
  authExpiredHandler = handler
}

export function toRdsError(err: unknown): RdsError {
  // Idempotent: callIpc rethrows an already-decoded RdsError, and the hooks may
  // run this again on it — don't degrade a real code to UNKNOWN.
  if (
    err !== null &&
    typeof err === 'object' &&
    typeof (err as RdsError).code === 'string' &&
    typeof (err as RdsError).message === 'string'
  ) {
    return err as RdsError
  }
  const message = err instanceof Error ? err.message : String(err)
  return parseRdsError(message) ?? { code: 'UNKNOWN', message }
}

/** Run an IPC call, converting any rejection into a typed RdsError. */
export async function callIpc<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const rdsError = toRdsError(err)
    if (rdsError.code === 'AUTH_EXPIRED') authExpiredHandler?.(rdsError)
    throw rdsError
  }
}
