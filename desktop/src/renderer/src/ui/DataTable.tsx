import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: string
  /** Cell renderer; defaults to String(sortValue). */
  render?: (row: T) => ReactNode
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number
  align?: 'left' | 'right'
}

type SortDir = 'asc' | 'desc'

/**
 * Generic table with client-side sort (columns exposing sortValue) and client
 * pagination (when rows exceed pageSize). Pure/controlled-free — feed it rows.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  pageSize = 25,
  empty = 'No rows.'
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  pageSize?: number
  empty?: ReactNode
}): React.JSX.Element {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find((c) => c.key === sortKey)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    const factor = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sv(a)
      const bv = sv(b)
      if (av < bv) return -1 * factor
      if (av > bv) return 1 * factor
      return 0
    })
  }, [rows, columns, sortKey, sortDir])

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize)

  const toggleSort = (col: Column<T>): void => {
    if (!col.sortValue) return
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col.key)
      setSortDir('asc')
    }
    setPage(0)
  }

  return (
    <div className="datatable-wrap">
      <table className="datatable">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.sortValue ? 'sortable' : ''}
                aria-sort={
                  sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                }
                onClick={() => toggleSort(c)}
              >
                {c.header}
                {sortKey === c.key && (
                  <span className="sort-caret">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={c.align === 'right' ? 'align-right' : ''}>
                  {c.render ? c.render(row) : c.sortValue ? String(c.sortValue(row)) : null}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="pagination">
          <button
            className="btn"
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
          >
            Prev
          </button>
          <span className="muted">
            Page {clampedPage + 1} of {pageCount} · {sorted.length} rows
          </span>
          <button
            className="btn"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(clampedPage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
