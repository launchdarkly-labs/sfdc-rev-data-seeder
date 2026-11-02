/**
 * S70 (UAT U-2 / U-3): the Org Connections list filter, pure so it is testable
 * without a renderer. One query box matches alias, username, org Id and the
 * instance host; one role control replaces the old "Hide unassigned" checkbox.
 */
import type { OrgConnection, OrgRole } from './types'

export type RoleFilter = 'all' | OrgRole

export const ROLE_FILTERS: ReadonlyArray<{ value: RoleFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'source', label: 'Source' },
  { value: 'target', label: 'Target' },
  { value: 'unassigned', label: 'Unassigned' }
]

/** The role a row is shown with: a prod-pinned org renders as source whatever its stored role. */
export function effectiveRole(o: Pick<OrgConnection, 'role' | 'prodPinned'>): OrgRole {
  return o.prodPinned ? 'source' : o.role
}

/** Host part of an instance URL (`https://x.my.salesforce.com` → `x.my.salesforce.com`); '' when unparseable. */
export function instanceHost(instanceUrl: string | null | undefined): string {
  if (!instanceUrl) return ''
  try {
    return new URL(instanceUrl).host
  } catch {
    return instanceUrl
  }
}

/** Case-insensitive substring match over label, CLI alias, username, org Id (15 or 18) and instance host. */
export function matchesConnectionQuery(
  o: Pick<OrgConnection, 'label' | 'cliAlias' | 'username' | 'orgId' | 'instanceUrl'>,
  query: string
): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = [o.label, o.cliAlias ?? '', o.username ?? '', o.orgId ?? '', instanceHost(o.instanceUrl)]
  return hay.some((h) => h.toLowerCase().includes(q))
}

export function filterConnections<T extends OrgConnection>(
  orgs: readonly T[],
  opts: { query: string; role: RoleFilter }
): T[] {
  return orgs.filter(
    (o) => (opts.role === 'all' || effectiveRole(o) === opts.role) && matchesConnectionQuery(o, opts.query)
  )
}
