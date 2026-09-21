/**
 * Main-side error carrying an explicit RdsError code. Kept dependency-free so
 * services (e.g. Store) can throw it without importing the jsforce-heavy
 * salesforce/ipcError modules. `wrapHandler` maps it to the wire envelope.
 */
import type { RdsErrorCode } from '../shared/types'

export class RdsHandlerError extends Error {
  constructor(
    readonly code: RdsErrorCode,
    message: string,
    readonly detail?: string,
    readonly connection?: string
  ) {
    super(message)
    this.name = 'RdsHandlerError'
  }
}
