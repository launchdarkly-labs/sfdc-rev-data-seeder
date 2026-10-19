/**
 * S64 P5 (5.4) — one guarded refresh path for pages that mirror a persisted
 * snapshot while a job runs. See the doc comment on `useGuardedRefresh`.
 */
import { useCallback, useEffect, useRef } from 'react'
import { callIpc, toRdsError } from './client'

export const REFETCH_DEBOUNCE_MS = 400

/**
 * Backstop cadence for the run's long tail (UI-4). Deliberately slow: one
 * `deployRunState` read, whose counter views are 25 ms since migration 007.
 */
export const TAIL_POLL_MS = 3000

/**
 * S64 P5 (5.4) — ONE guarded refresh path for a page that mirrors a persisted
 * snapshot while a job runs (this page and the template run report).
 *
 * Before: a 400 ms debounce on the live job's key and a 3 s poll each called
 * `load()` independently, with no in-flight guard and no ordering, so the two
 * overlapped on the main thread (perf findings §2) and a slow earlier read
 * could land after — and overwrite — a newer one. Now every trigger (first
 * mount, a key change, a job-store change, the poll, the Retry button) goes
 * through `load`, which:
 *  - coalesces: while a read is in flight, N further requests become at most
 *    ONE trailing read, issued when the current one settles;
 *  - orders: each read carries an increasing sequence number and a response
 *    older than the last applied one is dropped;
 *  - resets on `key` (the deployment / run id): reads issued for the previous
 *    key can no longer apply or release the guard.
 * The event-driven path stays the fast one (debounced `jobKey`); the poll is
 * the floor while `polling` is true; a terminal job event changes `jobKey`
 * (status is part of it), so one final read follows it and the terminal state
 * renders even if a read was in flight when the event arrived.
 *
 * Refs hold the guard, the pending flag and the counters; state is only set
 * from the response callbacks — the same shape as `useIpcQuery`, and nothing
 * the react-hooks v7 rules flag. Page-agnostic: the deployment
 * monitor and the template run report both use it.
 */
export function useGuardedRefresh<T>(opts: {
  /** Identity of what is being read (deployment id, run id). A change resets the guard. */
  key: unknown
  /** False while the page cannot read at all (invalid route param): `load` is a no-op. */
  enabled: boolean
  fetch: () => Promise<T>
  onLoaded: (value: T) => void
  onError: (message: string) => void
  /** Live-job fingerprint: a change schedules one debounced read; '' means no live job. */
  jobKey: string
  /** While true, a read is also requested every `pollMs` (the UI-4 floor). */
  polling: boolean
  pollMs?: number
  debounceMs?: number
}): () => void {
  const { key, jobKey, polling, pollMs = TAIL_POLL_MS, debounceMs = REFETCH_DEBOUNCE_MS } = opts
  // Latest callbacks, refreshed after every commit so a read issued from a
  // timer or a trailing request always uses the current fetch/setters.
  const latest = useRef(opts)
  useEffect(() => {
    latest.current = opts
  })

  const nextSeq = useRef(0)
  const appliedSeq = useRef(0)
  const inFlightSeq = useRef<number | null>(null)
  const pending = useRef(false)
  const lastKey = useRef<unknown>(Symbol('unset'))

  const load = useCallback((): void => {
    if (!latest.current.enabled) return
    if (inFlightSeq.current != null) {
      pending.current = true
      return
    }
    // Hoisted so the trailing read can re-enter without referencing `load`
    // from inside its own initialiser (react-hooks/immutability).
    function issue(): void {
      const seq = ++nextSeq.current
      inFlightSeq.current = seq
      const { fetch, onLoaded, onError } = latest.current
      callIpc(fetch)
        .then((value) => {
          if (seq <= appliedSeq.current) return // stale: a newer read already applied, or the key changed
          appliedSeq.current = seq
          onLoaded(value)
        })
        .catch((e: unknown) => {
          if (seq > appliedSeq.current) onError(toRdsError(e).message)
        })
        .finally(() => {
          if (inFlightSeq.current !== seq) return // superseded by a key reset
          inFlightSeq.current = null
          if (pending.current && latest.current.enabled) {
            pending.current = false
            issue()
          }
        })
    }
    issue()
  }, [])

  // The one scheduling path for mount / key change / job change. A new key
  // reads at once and invalidates everything issued before; a job change
  // waits out the debounce so a burst of events costs one read.
  useEffect(() => {
    const fresh = lastKey.current !== key
    if (fresh) {
      lastKey.current = key
      appliedSeq.current = nextSeq.current
      inFlightSeq.current = null
      pending.current = false
    }
    const t = setTimeout(load, fresh || jobKey === '' ? 0 : debounceMs)
    return () => clearTimeout(t)
  }, [key, jobKey, debounceMs, load])

  useEffect(() => {
    if (!polling) return
    const t = setInterval(load, pollMs)
    return () => clearInterval(t)
  }, [polling, pollMs, load])

  return load
}
