/**
 * Deployment role rules (S52 F1/F2). Roles live on the CONNECTION, not the
 * deployment, and until S52 nothing in the deployment flow ever wrote them: a
 * user could pick an `unassigned` org as the target, walk every wizard step, and
 * be refused at deploy start with "cannot be a deploy target (role 'unassigned')".
 *
 * The rule here is deliberately narrow — assign the NEVER-assigned, never
 * re-promote the demoted. A row that already carries a role is left alone
 * (the S49 REVIEW-FIX: overriding a stored role would silently undo a demotion
 * the user made on the Connections page). Pure and renderer-safe.
 */
import type { OrgConnection, OrgRole, RoleAssignment } from './types'

export type RoleSide = 'source' | 'target'

export interface RoleIssue {
  side: RoleSide
  connectionId: string
  label: string
  role: OrgRole
  /** True when an "Assign roles" write resolves it (the row is unassigned). */
  fixable: boolean
  /** Human sentence for the banner. */
  reason: string
}

export type RoleRow = Pick<OrgConnection, 'id' | 'label' | 'role' | 'prodPinned'>

/** Everything wrong with a source/target pair, fixable or not. Empty = ready. */
export function deploymentRoleIssues(source: RoleRow, target: RoleRow): RoleIssue[] {
  const issues: RoleIssue[] = []
  if (source.id === target.id) {
    issues.push({
      side: 'target',
      connectionId: target.id,
      label: target.label,
      role: target.role,
      fixable: false,
      reason: 'Source and target must be different orgs.'
    })
    return issues
  }
  if (source.role !== 'source') {
    const unassigned = source.role === 'unassigned'
    issues.push({
      side: 'source',
      connectionId: source.id,
      label: source.label,
      role: source.role,
      fixable: unassigned,
      reason: unassigned
        ? `${source.label} has no role yet — it will be set to Source (read-only).`
        : `${source.label} is a target org — change its role on the Connections page before reading from it.`
    })
  }
  if (target.prodPinned) {
    issues.push({
      side: 'target',
      connectionId: target.id,
      label: target.label,
      role: target.role,
      fixable: false,
      reason: `${target.label} is LaunchDarkly production — permanently read-only, it can never be a target.`
    })
  } else if (target.role !== 'target') {
    const unassigned = target.role === 'unassigned'
    issues.push({
      side: 'target',
      connectionId: target.id,
      label: target.label,
      role: target.role,
      fixable: unassigned,
      reason: unassigned
        ? `${target.label} has no role yet — it will be set to Target.`
        : `${target.label} is a source org (read-only) — change its role on the Connections page to deploy into it.`
    })
  }
  return issues
}

/**
 * What an "Assign roles" write would do for this pair: which sides it sets, and
 * which issues it CANNOT fix (those need the Connections page). Pure.
 */
export function rolesToAssign(
  source: RoleRow,
  target: RoleRow
): { assign: RoleAssignment; blocked: RoleIssue[] } {
  const issues = deploymentRoleIssues(source, target)
  return {
    assign: {
      source: issues.some((i) => i.side === 'source' && i.fixable),
      target: issues.some((i) => i.side === 'target' && i.fixable)
    },
    blocked: issues.filter((i) => !i.fixable)
  }
}

/** Toast copy after a create/assign: "onesolve set as Target" / "" when nothing was written. */
export function describeAssignment(
  assigned: RoleAssignment,
  labels: { source: string; target: string }
): string {
  const parts: string[] = []
  if (assigned.source) parts.push(`${labels.source} set as Source`)
  if (assigned.target) parts.push(`${labels.target} set as Target`)
  return parts.join(' · ')
}
