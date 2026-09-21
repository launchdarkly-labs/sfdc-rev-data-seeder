/**
 * S52 F1/F2 — deployment role rules (pure). Roles live on the connection; a
 * deployment pick must assign the NEVER-assigned and never touch a row that
 * already has a role (the S49 REVIEW-FIX: no silent re-promotion).
 */
import { describe, it, expect } from 'vitest'
import { deploymentRoleIssues, describeAssignment, rolesToAssign, type RoleRow } from '../src/shared/roles'

const row = (id: string, role: RoleRow['role'], prodPinned = false): RoleRow => ({
  id,
  label: id,
  role,
  prodPinned
})

describe('rolesToAssign', () => {
  it('assigns both sides when both are unassigned (the S52 shape: darkb_911 → onesolve)', () => {
    const r = rolesToAssign(row('darkb_911', 'unassigned'), row('onesolve', 'unassigned'))
    expect(r.assign).toEqual({ source: true, target: true })
    expect(r.blocked).toEqual([])
  })

  it('assigns only the unassigned side', () => {
    const r = rolesToAssign(row('darkb_829', 'source'), row('onesolve', 'unassigned'))
    expect(r.assign).toEqual({ source: false, target: true })
  })

  it('writes nothing when both already carry the right role', () => {
    const r = rolesToAssign(row('src', 'source'), row('tgt', 'target'))
    expect(r.assign).toEqual({ source: false, target: false })
    expect(r.blocked).toEqual([])
  })

  it('never re-promotes: a target picked as source is BLOCKED, not flipped', () => {
    const r = rolesToAssign(row('sb1', 'target'), row('onesolve', 'unassigned'))
    expect(r.assign.source).toBe(false)
    expect(r.assign.target).toBe(true)
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0]?.side).toBe('source')
    expect(r.blocked[0]?.reason).toMatch(/Connections page/)
  })

  it('never demotes: a source picked as target is BLOCKED', () => {
    const r = rolesToAssign(row('darkb', 'unassigned'), row('darkb_829', 'source'))
    expect(r.assign).toEqual({ source: true, target: false })
    expect(r.blocked.map((b) => b.side)).toEqual(['target'])
  })

  it('prod can never become a target, whatever its stored role says', () => {
    const r = rolesToAssign(row('darkb', 'source'), row('prod_729', 'unassigned', true))
    expect(r.assign.target).toBe(false)
    expect(r.blocked[0]?.reason).toMatch(/production/i)
  })

  it('the same org on both sides is blocked before any role is considered', () => {
    const r = rolesToAssign(row('x', 'unassigned'), row('x', 'unassigned'))
    expect(r.assign).toEqual({ source: false, target: false })
    expect(r.blocked[0]?.reason).toMatch(/different orgs/)
  })
})

describe('deploymentRoleIssues', () => {
  it('is empty for a ready pair', () => {
    expect(deploymentRoleIssues(row('s', 'source'), row('t', 'target'))).toEqual([])
  })

  it('marks an unassigned side fixable and says what will be written', () => {
    const issues = deploymentRoleIssues(row('darkb_911', 'source'), row('onesolve', 'unassigned'))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ side: 'target', fixable: true, role: 'unassigned' })
    expect(issues[0]?.reason).toMatch(/onesolve has no role yet.*Target/)
  })
})

describe('describeAssignment', () => {
  const labels = { source: 'darkb_911', target: 'onesolve' }
  it('names what was written', () => {
    expect(describeAssignment({ source: true, target: true }, labels)).toBe(
      'darkb_911 set as Source · onesolve set as Target'
    )
    expect(describeAssignment({ source: false, target: true }, labels)).toBe('onesolve set as Target')
  })
  it('is empty when nothing was written (no toast)', () => {
    expect(describeAssignment({ source: false, target: false }, labels)).toBe('')
  })
})
