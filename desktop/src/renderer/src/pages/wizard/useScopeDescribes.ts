import { useMemo } from 'react'
import type { FieldInfo } from '../../../../shared/types'
import { useIpcQuery } from '../../ipc/hooks'
import type { DescribeCache } from './describeCache'
import { useWizard } from './WizardShell'

export interface ScopeDescribes {
  /** objectName → SOURCE describe (cached in main). Null until every object has loaded. */
  source: Record<string, FieldInfo[]> | null
  /** objectName → TARGET describe. Null until loaded. */
  target: Record<string, FieldInfo[]> | null
  loading: boolean
}

async function describeAll(
  describe: DescribeCache['describe'],
  connectionId: string,
  objects: readonly string[]
): Promise<Record<string, FieldInfo[]>> {
  const out: Record<string, FieldInfo[]> = {}
  await Promise.all(
    objects.map(async (obj) => {
      out[obj] = await describe(connectionId, obj)
    })
  )
  return out
}

/**
 * S57 (B2/B3): the Scope step needs each selected object's reference fields —
 * on BOTH orgs — to know (a) which objects are scoped under which (the
 * "nothing will deploy" gate) and (b) which references point OUTSIDE the scope
 * (the missing-parent advisor). Describes go through the shell's describe cache
 * (S64 P5, 5.6a) — one IPC per connection+object for the life of the wizard,
 * on top of main's SQLite cache. Degrades OPEN: while loading or on error both
 * maps are null and the callers show nothing / block nothing.
 */
export function useScopeDescribes(
  sourceConnectionId: string,
  targetConnectionId: string,
  selectedObjects: readonly string[]
): ScopeDescribes {
  const { describe } = useWizard()
  const key = [...selectedObjects].sort().join(',')
  const src = useIpcQuery<Record<string, FieldInfo[]>>(
    async () => (key === '' ? {} : describeAll(describe, sourceConnectionId, key.split(','))),
    [sourceConnectionId, key]
  )
  const tgt = useIpcQuery<Record<string, FieldInfo[]>>(
    async () => (key === '' ? {} : describeAll(describe, targetConnectionId, key.split(','))),
    [targetConnectionId, key]
  )
  return useMemo<ScopeDescribes>(
    () => ({
      source: src.data && !src.error ? src.data : null,
      target: tgt.data && !tgt.error ? tgt.data : null,
      loading: src.loading || tgt.loading
    }),
    [src.data, src.error, src.loading, tgt.data, tgt.error, tgt.loading]
  )
}
