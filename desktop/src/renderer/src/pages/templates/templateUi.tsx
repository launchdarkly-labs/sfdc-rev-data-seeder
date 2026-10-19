/**
 * Shared bits for the Templates pages: the org picker with the "Read from"
 * scope selector, badge tones for run states, and small formatters.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { OrgConnection } from '../../../../shared/types'
import type { TemplateRunState } from '../../../../shared/templates/types'
import type { BadgeTone } from '../../ui/Badge'

export type OrgScope = 'source' | 'target' | 'all'

/** Live rows only: superseded aliases and logged-out CLI rows stay out of every picker (S52 F3). */
export function livePickable(orgs: readonly OrgConnection[] | undefined): OrgConnection[] {
  return (orgs ?? []).filter((o) => !o.supersededBy && o.cliStatus !== 'Not in CLI')
}

export function orgsForScope(orgs: readonly OrgConnection[], scope: OrgScope): OrgConnection[] {
  if (scope === 'source') return orgs.filter((o) => o.role === 'source')
  if (scope === 'target') return orgs.filter((o) => o.role === 'target' && !o.prodPinned)
  return [...orgs]
}

/**
 * "Read from": the org a template is BUILT against (describes, automation
 * catalog, filter counts). Source orgs by default — a template is usually
 * built from the org the data comes from — switchable to target orgs or all.
 * Reads only; the picked org is stored as a `builtFrom` hint, never a constraint.
 */
export function ReadFromPicker({
  orgs,
  scope,
  connectionId,
  onScope,
  onConnection,
  label = 'Read from'
}: {
  orgs: readonly OrgConnection[] | undefined
  scope: OrgScope
  connectionId: string
  onScope: (scope: OrgScope) => void
  onConnection: (id: string) => void
  label?: string
}): React.JSX.Element {
  const live = useMemo(() => livePickable(orgs), [orgs])
  const options = useMemo(() => orgsForScope(live, scope), [live, scope])
  return (
    <div className="read-from" data-testid="read-from">
      <label className="field">
        <span>{label}</span>
        <div className="read-from-row">
          <select
            className="map-strategy"
            aria-label="Read from scope"
            value={scope}
            onChange={(e) => onScope(e.target.value as OrgScope)}
          >
            <option value="source">Source orgs</option>
            <option value="target">Target orgs</option>
            <option value="all">All orgs</option>
          </select>
          <select
            className="map-strategy"
            aria-label="Read from org"
            value={connectionId}
            onChange={(e) => onConnection(e.target.value)}
          >
            <option value="">— pick an org —</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
                {o.role !== 'unassigned' ? ` (${o.role})` : ''}
              </option>
            ))}
          </select>
          <Link to="/connections" className="muted">
            Add new orgs →
          </Link>
        </div>
        {options.length === 0 && (
          <span className="muted">
            No {scope === 'all' ? '' : `${scope} `}orgs yet — assign a role on the Org Connections page.
          </span>
        )}
      </label>
    </div>
  )
}

export function runStateTone(state: TemplateRunState): BadgeTone {
  switch (state) {
    case 'clean':
      return 'success'
    case 'failed':
      return 'danger'
    case 'partial':
    case 'blocked':
      return 'warn'
    case 'running':
      return 'accent'
    default:
      return 'neutral'
  }
}

export function fmtWhen(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const d = new Date(ms)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function fmtDuration(start: number, end: number | null): string {
  if (end == null) return '—'
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** Comma / whitespace separated text → unique trimmed tokens. */
export function tokens(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]
}

export function namespaceOf(apiName: string): string | null {
  const parts = apiName.split('__')
  return parts.length >= 3 ? parts[0]! : null
}
