import { useState } from 'react'

/**
 * S49 (UI-2c) — the selected objects, as removable pills.
 *
 * Selection used to be a checkbox in a 1,550-row list and nothing else, so with
 * a search filter applied you could not see what was selected off-screen; the
 * only signal was a "Clear (5)" count. Pills put the whole selected set in one
 * place, and each one can be removed without hunting for its row.
 *
 * Capped at {@link COLLAPSED_LIMIT} with a "+N more" toggle — a 27-object
 * selection is normal and would otherwise push the picker off the page.
 *
 * Used on BOTH the Objects step (where it is editable) and the Scope step
 * (where `readOnly` makes it context for the filters).
 */

const COLLAPSED_LIMIT = 12

export function SelectionPills({
  selected,
  onRemove,
  onClear,
  readOnly = false
}: {
  selected: string[]
  onRemove?: (objectName: string) => void
  onClear?: () => void
  readOnly?: boolean
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (selected.length === 0) return null

  const hidden = Math.max(0, selected.length - COLLAPSED_LIMIT)
  const shown = expanded ? selected : selected.slice(0, COLLAPSED_LIMIT)

  return (
    <section className="selection-pills" aria-label="Selected objects">
      <div className="selection-pills-head">
        <h3>Selected ({selected.length})</h3>
        {!readOnly && onClear && (
          <button className="btn subtle" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
      <ul className="pill-list">
        {shown.map((obj) => (
          <li key={obj} className="pill">
            <span className="pill-label">{obj}</span>
            {!readOnly && onRemove && (
              <button
                className="pill-remove"
                aria-label={`Remove ${obj}`}
                title={`Remove ${obj}`}
                onClick={() => onRemove(obj)}
              >
                ×
              </button>
            )}
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button className="pill pill-more" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show fewer' : `+${hidden} more`}
            </button>
          </li>
        )}
      </ul>
    </section>
  )
}
