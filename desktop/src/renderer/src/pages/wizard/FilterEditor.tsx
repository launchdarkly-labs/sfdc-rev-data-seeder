import { useEffect, useState } from 'react'
import type { FilterValidateResult } from '../../../../shared/types'
import type { FilterProbe } from '../../../../shared/scopeAdvisor'
import { useDebounced, useIpcQuery } from '../../ipc/hooks'

interface Props {
  /** Source connection id — filters count SOURCE records. */
  connectionId: string
  /** S54 (F1): target connection id — lets a zero-match literal Id be probed on the
   *  target so "that record lives on sb3, not the source" can be said. Optional. */
  targetConnectionId?: string
  objectName: string
  /** Current WHERE clause for this object (from config.filters). */
  value: string
  onChange: (next: string) => void
  /** S49 (UI-2d): remove this filter row entirely ("add a filter" model). */
  onRemove?: () => void
  /**
   * S57 (B3): report every validation verdict upward — busy / error / exact
   * count — so the Scope step can tell when NOTHING can deploy and close Next.
   * Must be referentially stable (the parent memoises it); fired for the
   * current debounced clause only, and as `busy` while a probe is in flight.
   */
  onResult?: (objectName: string, probe: FilterProbe | null) => void
}

/**
 * Per-object filter editor (5B.3): a WHERE-clause input with field-name
 * autocomplete (lazy `describeObject` on first focus) and debounced, inline
 * COUNT() validation against the source org. Empty clause = no validation.
 * A stripped top-level ORDER BY is surfaced, never silent.
 */
export function FilterEditor({
  connectionId,
  targetConnectionId,
  objectName,
  value,
  onChange,
  onRemove,
  onResult
}: Props): React.JSX.Element {
  const debounced = useDebounced(value.trim(), 500)
  const [fields, setFields] = useState<string[] | null>(null)

  const { data, loading } = useIpcQuery<FilterValidateResult | null>(
    () =>
      debounced
        ? window.rds.filterValidate({
            connectionId,
            objectName,
            filterClause: debounced,
            targetConnectionId
          })
        : Promise.resolve(null),
    [debounced, connectionId, targetConnectionId, objectName]
  )

  // S57 (B3): lift the verdict to the Scope step (null = no clause to judge).
  useEffect(() => {
    if (!onResult) return
    if (!debounced) {
      onResult(objectName, null)
      return
    }
    if (loading) onResult(objectName, { kind: 'busy' })
    else if (!data) onResult(objectName, null)
    else if (!data.ok) onResult(objectName, { kind: 'error' })
    else onResult(objectName, { kind: 'count', count: data.count ?? 0 })
  }, [onResult, objectName, debounced, loading, data])

  // Lazy field-name autocomplete — one describe per object, only when focused.
  function loadFields(): void {
    if (fields !== null) return
    void window.rds
      .describeObject(connectionId, objectName)
      .then((fs) => setFields(fs.map((f) => f.apiName).sort()))
      .catch(() => setFields([]))
  }

  const listId = `fields-${objectName}`

  return (
    <div className="filter-item" data-testid={`filter-${objectName}`}>
      <label className="filter-row">
        <span className="filter-object">{objectName}</span>
        <input
          type="text"
          className="filter-input"
          placeholder="WHERE clause (optional)"
          value={value}
          list={listId}
          aria-label={`Filter for ${objectName}`}
          onFocus={loadFields}
          onChange={(e) => onChange(e.target.value)}
        />
        {onRemove && (
          <button
            type="button"
            className="filter-remove"
            aria-label={`Remove filter for ${objectName}`}
            title={`Remove filter for ${objectName}`}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </label>
      {fields && fields.length > 0 && (
        <datalist id={listId}>
          {fields.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      )}
      <FilterStatus
        busy={loading && !!debounced}
        result={debounced ? data : null}
        objectName={objectName}
      />
    </div>
  )
}

function FilterStatus({
  busy,
  result,
  objectName
}: {
  busy: boolean
  result: FilterValidateResult | null | undefined
  objectName: string
}): React.JSX.Element | null {
  if (busy) return <span className="filter-status muted">Validating…</span>
  if (!result) return null
  const count = result.count ?? 0
  return (
    <div className="filter-status">
      {!result.ok ? (
        <span className="err">✕ {result.error}</span>
      ) : count === 0 ? (
        // S54 F1 (L4): valid SOQL that matches nothing is a WARNING, never a
        // green check — a zero-row root filter empties the whole deployment.
        <span className="warn" role="status">
          ⚠ 0 records — nothing will deploy for {objectName}, or for anything scoped under it.
        </span>
      ) : (
        <span className="ok">
          ✓ {count.toLocaleString()} record{count === 1 ? '' : 's'}
        </span>
      )}
      {result.ok && result.hint && <span className="hint">{result.hint}</span>}
      {result.strippedClause && (
        <span className="muted">
          {' · '}trailing clause ignored for the count: <code>{result.strippedClause}</code>
        </span>
      )}
    </div>
  )
}
