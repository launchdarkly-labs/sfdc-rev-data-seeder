import { useMemo, useState } from 'react'
import type { DeployableObject } from '../../../shared/types'
import { SearchInput } from './SearchInput'
import { Badge } from './Badge'
import { canHostExtIdField } from '../../../shared/extIdCapability'

/**
 * Reusable object picker (wizard Objects step + the External-IDs manager).
 * Only deployable objects (present in both orgs) are selectable by default.
 * Filtering (search + type/namespace) is a pure function so it's unit-tested
 * independently; "select all" operates on the CURRENTLY-VISIBLE list only.
 *
 * S49 (UI-2b): the package filter used to be a horizontal chip wall across the
 * top — ~50 chips on a real org, which pushed the list itself below the fold
 * and read as noise. It is now a dedicated RIGHT-HAND panel beside the object
 * list, with a count per package. Behaviour is unchanged: it FILTERS (one
 * package at a time, replacing the list contents), exactly like the chips did.
 */

export type ObjectTypeFilter = 'all' | 'standard' | 'custom' | { namespace: string }

export function filterObjects(
  objects: DeployableObject[],
  opts: { search: string; type: ObjectTypeFilter; deployableOnly: boolean }
): DeployableObject[] {
  const type = opts.type
  let list = opts.deployableOnly ? objects.filter((o) => o.inSource && o.inTarget) : objects
  if (type === 'standard') list = list.filter((o) => !o.custom && o.namespace === null)
  else if (type === 'custom') list = list.filter((o) => o.custom && o.namespace === null)
  else if (typeof type === 'object') list = list.filter((o) => o.namespace === type.namespace)
  const q = opts.search.trim().toLowerCase()
  if (q)
    list = list.filter(
      (o) => o.apiName.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)
    )
  return list
}

function typeKey(t: ObjectTypeFilter): string {
  return typeof t === 'object' ? `ns:${t.namespace}` : t
}

export function ObjectPicker({
  objects,
  selected,
  onChange,
  deployableOnly = true
}: {
  objects: DeployableObject[]
  selected: string[]
  onChange: (selected: string[]) => void
  deployableOnly?: boolean
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [type, setType] = useState<ObjectTypeFilter>('all')

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const namespaces = useMemo(
    () => [...new Set(objects.filter((o) => o.namespace).map((o) => o.namespace!))].sort(),
    [objects]
  )
  const visible = useMemo(
    () => filterObjects(objects, { search, type, deployableOnly }),
    [objects, search, type, deployableOnly]
  )

  const toggle = (apiName: string): void => {
    const next = new Set(selectedSet)
    if (next.has(apiName)) next.delete(apiName)
    else next.add(apiName)
    onChange([...next])
  }
  const selectAllVisible = (): void => {
    const next = new Set(selectedSet)
    for (const o of visible) next.add(o.apiName)
    onChange([...next])
  }
  const clearAll = (): void => onChange([])

  // Counts are computed against the same predicate the list uses, minus the
  // search box — so a package's number always matches what clicking it shows
  // when the search is empty, and never contradicts the visible rows.
  const countFor = (value: ObjectTypeFilter): number =>
    filterObjects(objects, { search: '', type: value, deployableOnly }).length

  const packages: { key: string; label: string; value: ObjectTypeFilter }[] = [
    { key: 'all', label: 'All', value: 'all' },
    { key: 'standard', label: 'Standard', value: 'standard' },
    { key: 'custom', label: 'Custom', value: 'custom' },
    ...namespaces.map((ns) => ({
      key: `ns:${ns}`,
      label: ns,
      value: { namespace: ns } as ObjectTypeFilter
    }))
  ]

  return (
    <div className="object-picker">
      <div className="picker-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search objects…" />
        <div className="picker-actions">
          <button className="btn" onClick={selectAllVisible}>
            Select all shown ({visible.length})
          </button>
          <button className="btn" onClick={clearAll} disabled={selected.length === 0}>
            Clear ({selected.length})
          </button>
        </div>
      </div>

      <div className="picker-split">
        <ul className="picker-list" aria-label="Objects">
          {visible.map((o) => (
            <li key={o.apiName}>
              <label className="picker-row">
                <input
                  type="checkbox"
                  checked={selectedSet.has(o.apiName)}
                  onChange={() => toggle(o.apiName)}
                />
                <span className="picker-name">{o.apiName}</span>
                {o.namespace && <Badge tone="accent">{o.namespace}</Badge>}
                {o.custom && !o.namespace && <Badge tone="neutral">custom</Badge>}
                {!canHostExtIdField(o.apiName) && (
                  // S57 (B4): say it at selection time, not after a permanent red Readiness row.
                  <Badge tone="warn">no custom fields — can&apos;t be keyed</Badge>
                )}
              </label>
            </li>
          ))}
          {visible.length === 0 && <li className="muted">No objects match.</li>}
        </ul>

        <aside className="picker-packages" aria-label="Filter by package">
          <h4>Packages</h4>
          <ul>
            {packages.map((c) => {
              const active = typeKey(type) === c.key
              const count = countFor(c.value)
              return (
                <li key={c.key}>
                  <button
                    className={`package-row ${active ? 'active' : ''}`}
                    aria-pressed={active}
                    // Explicit: the two spans are adjacent, so the computed
                    // name would otherwise read "SBQQ2".
                    aria-label={`${c.label} (${count})`}
                    onClick={() => setType(c.value)}
                  >
                    <span className="package-name">{c.label}</span>
                    <span className="package-count">{count}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>
      </div>
    </div>
  )
}
