/**
 * S70 (UAT U-7): the Deployments list filter — the twin of connectionsFilter.
 * One query box over name / source / target / status, one "updated within"
 * control. Pure so the renderer test does not have to drive it through clicks.
 */
import type { DeploymentSummary } from './types'

export type DateFilter = 'any' | '7d' | '30d' | '90d'

export const DATE_FILTERS: ReadonlyArray<{ value: DateFilter; label: string; days: number | null }> = [
  { value: 'any', label: 'Any time', days: null },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 }
]

const DAY_MS = 86_400_000

/** Epoch-ms lower bound for a filter, or null for "any time". */
export function sinceFor(filter: DateFilter, now: number = Date.now()): number | null {
  const days = DATE_FILTERS.find((f) => f.value === filter)?.days ?? null
  return days == null ? null : now - days * DAY_MS
}

type Row = Pick<DeploymentSummary, 'name' | 'sourceLabel' | 'targetLabel' | 'status' | 'updatedAt' | 'createdAt'>

/** Case-insensitive substring match over name, source label, target label and status. */
export function matchesDeploymentQuery(d: Row, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [d.name, d.sourceLabel, d.targetLabel, d.status].some((h) => (h ?? '').toLowerCase().includes(q))
}

/** The date a card shows and the date filter uses: the last change, falling back to creation. */
export function activityAt(d: Pick<Row, 'updatedAt' | 'createdAt'>): number {
  return d.updatedAt || d.createdAt
}

export function filterDeployments<T extends Row>(
  rows: readonly T[],
  opts: { query: string; date: DateFilter; now?: number }
): T[] {
  const since = sinceFor(opts.date, opts.now)
  return rows.filter((d) => (since == null || activityAt(d) >= since) && matchesDeploymentQuery(d, opts.query))
}

/** "Oct 31" this year, "Oct 31, 2025" otherwise — short enough for a card's meta line. */
export function formatActivityDate(ms: number, now: Date = new Date()): string {
  const d = new Date(ms)
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }
  return d.toLocaleDateString(undefined, opts)
}
