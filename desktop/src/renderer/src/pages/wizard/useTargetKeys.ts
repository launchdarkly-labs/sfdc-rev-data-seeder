import { useMemo } from 'react'
import type { TargetKeyedObjectsResult } from '../../../../shared/types'
import { NO_TARGET_KEYS, type TargetKeyInfo } from '../../../../shared/mappingPolicy'
import { useIpcQuery } from '../../ipc/hooks'

/**
 * S57 (B1): what the TARGET knows about the given out-of-scope objects — which
 * carry the ExtId field and which already hold RDS-keyed rows. Shared by the
 * Scope, Mappings and Fields steps so their verdicts agree. Degrades OPEN: while
 * loading, on error, or when the bridge lacks the call (older test stubs), the
 * policy sees `NO_TARGET_KEYS` — i.e. the pre-S57 lock, never a false unlock.
 */
export function useTargetKeys(
  targetConnectionId: string,
  objectNames: readonly string[]
): { keys: TargetKeyInfo; loading: boolean } {
  const key = [...new Set(objectNames)].sort().join(',')
  const q = useIpcQuery<TargetKeyedObjectsResult>(
    // async so a missing bridge method rejects instead of throwing synchronously
    async () =>
      key === ''
        ? { hasField: [], keyedRows: [] }
        : window.rds.targetKeyedObjects({ targetConnectionId, objectNames: key.split(',') }),
    [targetConnectionId, key]
  )
  const keys = useMemo<TargetKeyInfo>(
    () =>
      q.data ? { hasField: new Set(q.data.hasField), keyedRows: new Set(q.data.keyedRows) } : NO_TARGET_KEYS,
    [q.data]
  )
  return { keys, loading: q.loading }
}
