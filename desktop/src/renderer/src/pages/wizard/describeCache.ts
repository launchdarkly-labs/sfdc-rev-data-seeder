import type { FieldInfo } from '../../../../shared/types'
import { callIpc } from '../../ipc/client'

/**
 * S64 P5 (5.6a) — a renderer-side describe cache shared by the wizard steps.
 *
 * Main caches describes in SQLite, but every IPC round-trip still costs a
 * 200–280 KB JSON parse plus a structured clone, and the steps are mounted
 * conditionally, so each step entry re-pulled 2N describes (N=11 ≈ 5–6 MB).
 * One instance lives per mounted `WizardShell` (leaving the wizard drops it),
 * keyed on `connectionId|objectApiName` and holding the PROMISE so concurrent
 * callers share a single in-flight request. A rejected entry is deleted, so a
 * transient failure is retried on the next call — never pinned.
 *
 * Schema only: `sampleGet` / `fieldsPopulated` read DATA and are not cached.
 */
export interface DescribeCache {
  describe: (connectionId: string, objectApiName: string) => Promise<FieldInfo[]>
  /** Number of resolved-or-in-flight entries (tests / diagnostics). */
  readonly size: number
  clear: () => void
}

export type DescribeFetcher = (connectionId: string, objectApiName: string) => Promise<FieldInfo[]>

/** Default fetcher: the bridge call, routed through `callIpc` so an
 *  AUTH_EXPIRED describe surfaces the re-auth prompt for every caller. */
const bridgeFetcher: DescribeFetcher = (connectionId, objectApiName) =>
  callIpc(() => window.rds.describeObject(connectionId, objectApiName))

export function createDescribeCache(fetcher: DescribeFetcher = bridgeFetcher): DescribeCache {
  const entries = new Map<string, Promise<FieldInfo[]>>()
  const describe = (connectionId: string, objectApiName: string): Promise<FieldInfo[]> => {
    const key = `${connectionId}|${objectApiName}`
    const hit = entries.get(key)
    if (hit) return hit
    const p = fetcher(connectionId, objectApiName)
    entries.set(key, p)
    p.catch(() => {
      // Only drop OUR entry — a later successful re-fetch may already sit there.
      if (entries.get(key) === p) entries.delete(key)
    })
    return p
  }
  return {
    describe,
    get size() {
      return entries.size
    },
    clear: () => entries.clear()
  }
}
