/**
 * S70 (UAT U-7): the Deployments list filter — pure lane.
 */
import { describe, it, expect } from 'vitest'
import {
  activityAt,
  DATE_FILTERS,
  filterDeployments,
  formatActivityDate,
  matchesDeploymentQuery,
  sinceFor
} from '../src/shared/deploymentsFilter'

const NOW = Date.UTC(2026, 10, 1, 12) // 2026-11-01T12:00Z
const DAY = 86_400_000
const row = (name: string, daysAgo: number, over: Record<string, unknown> = {}) => ({
  name,
  sourceLabel: 'srcbox_1',
  targetLabel: 'tgt_a',
  status: 'Completed',
  createdAt: NOW - daysAgo * DAY - DAY,
  updatedAt: NOW - daysAgo * DAY,
  ...over
})

describe('matchesDeploymentQuery', () => {
  it('matches name, source, target and status, case-insensitively; empty matches all', () => {
    const d = row('keyless 44', 0)
    expect(matchesDeploymentQuery(d, 'KEYLESS')).toBe(true)
    expect(matchesDeploymentQuery(d, 'srcbox')).toBe(true)
    expect(matchesDeploymentQuery(d, 'tgt_a')).toBe(true)
    expect(matchesDeploymentQuery(d, 'completed')).toBe(true)
    expect(matchesDeploymentQuery(d, '')).toBe(true)
    expect(matchesDeploymentQuery(d, 'zz')).toBe(false)
  })
})

describe('sinceFor / filterDeployments', () => {
  it('"any" has no lower bound; the others count back whole days from now', () => {
    expect(sinceFor('any', NOW)).toBeNull()
    expect(sinceFor('7d', NOW)).toBe(NOW - 7 * DAY)
    expect(sinceFor('90d', NOW)).toBe(NOW - 90 * DAY)
    expect(DATE_FILTERS.map((f) => f.value)).toEqual(['any', '7d', '30d', '90d'])
  })
  it('filters on the last activity date and the query together', () => {
    const rows = [row('today', 0), row('last week', 6), row('last month', 20), row('old', 200)]
    const names = (date: 'any' | '7d' | '30d' | '90d', query = '') =>
      filterDeployments(rows, { query, date, now: NOW }).map((r) => r.name)
    expect(names('any')).toEqual(['today', 'last week', 'last month', 'old'])
    expect(names('7d')).toEqual(['today', 'last week'])
    expect(names('30d')).toEqual(['today', 'last week', 'last month'])
    expect(names('90d', 'last')).toEqual(['last week', 'last month'])
  })
  it('falls back to createdAt when updatedAt is 0', () => {
    expect(activityAt({ updatedAt: 0, createdAt: 5 })).toBe(5)
    expect(filterDeployments([row('x', 0, { updatedAt: 0, createdAt: NOW - DAY })], { query: '', date: '7d', now: NOW })).toHaveLength(1)
  })
})

describe('formatActivityDate', () => {
  it('omits the year inside the current year and shows it otherwise', () => {
    const now = new Date(NOW)
    expect(formatActivityDate(Date.UTC(2026, 9, 31, 12), now)).not.toMatch(/2026/)
    expect(formatActivityDate(Date.UTC(2025, 9, 31, 12), now)).toMatch(/2025/)
  })
})
