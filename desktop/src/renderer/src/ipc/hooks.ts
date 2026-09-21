/*
 * Generic IPC data hooks. These intentionally use patterns the react-compiler
 * lint rules flag but that are correct for a generic data-fetching utility:
 *  - `exhaustive-deps`: deps are caller-provided by contract, not static.
 *  - `refs`: a "latest fetcher" ref is updated in render so the mount effect
 *    keys off `deps` alone, never a changing function identity.
 *  - `set-state-in-effect`: fetching-on-mount necessarily sets loading/error
 *    state in the effect (the canonical React data-fetch pattern).
 * Disabled for THIS utility file only; app components keep the rules on.
 */
/* eslint-disable react-hooks/exhaustive-deps, react-hooks/refs, react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RdsError } from '../../../shared/types'
import { callIpc, toRdsError } from './client'

export interface QueryResult<T> {
  data: T | undefined
  loading: boolean
  error: RdsError | undefined
  refetch: () => void
}

/**
 * Fetch-on-mount (and on `deps` change) over an IPC call. `main` owns the
 * source of truth, so there's no caching layer — just loading/error/refetch.
 */
export function useIpcQuery<T>(fetcher: () => Promise<T>, deps: unknown[] = []): QueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RdsError | undefined>(undefined)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const load = useCallback((): (() => void) => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    callIpc(() => fetcherRef.current())
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => {
        if (!cancelled) setError(toRdsError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(), deps)

  return { data, loading, error, refetch: () => void load() }
}

/** Debounce a value: returns `value` once it has stayed unchanged for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export interface MutationResult<TArgs extends unknown[], T> {
  mutate: (...args: TArgs) => Promise<T | undefined>
  loading: boolean
  error: RdsError | undefined
}

/** Imperative IPC call (button actions, form submits) with loading/error state. */
export function useIpcMutation<TArgs extends unknown[], T>(
  fn: (...args: TArgs) => Promise<T>
): MutationResult<TArgs, T> {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<RdsError | undefined>(undefined)

  const mutate = useCallback(
    async (...args: TArgs): Promise<T | undefined> => {
      setLoading(true)
      setError(undefined)
      try {
        return await callIpc(() => fn(...args))
      } catch (err) {
        setError(toRdsError(err))
        return undefined
      } finally {
        setLoading(false)
      }
    },
    [fn]
  )

  return { mutate, loading, error }
}
