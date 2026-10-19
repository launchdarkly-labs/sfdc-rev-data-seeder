/**
 * The seed PLANNER (plan §4.4): which fields travel, how each reference is
 * treated, and how one source row becomes a target payload. Ported from the
 * reference tool's `classify` / `field_plan` / `build`, generalised:
 *
 *   keep    the referenced object shares Ids between the orgs (keepIdTargets) —
 *           the source Id is written as-is
 *   remap   the referenced object is an EARLIER tier — the Id goes through the
 *           source→target map; a missing parent nulls the lookup, or skips the
 *           row when the field is required
 *   defer   the referenced object is this tier or a LATER one (self-reference,
 *           forward reference) — written null now, patched in the second pass
 *   check   anything else — the source Id is kept only if that record exists
 *           on the target (one `WHERE Id IN` probe per object), else nulled /
 *           the row skipped when required
 *   poly    a polymorphic lookup — resolved per value by key prefix, then as
 *           `check`
 *
 * Deferred FIELDS (not references) load as `false` for booleans (rules load
 * inactive and activate after their children exist) or as the template's
 * placeholder (`ConditionsMet = 'All'` until the conditions exist); the real
 * value is written in the second pass. A null RecordTypeId is OMITTED — an
 * explicit null is rejected, an absent key takes the default.
 */
import type { SeedTemplate, SeedTier } from '../../../../shared/templates/types'
import type { TemplateDescribe, TemplateDescribeField } from '../io'

/** System / audit fields that never travel (the reference's SKIP_FIELDS). */
export const SKIP_FIELDS: ReadonlySet<string> = new Set([
  'Id',
  'OwnerId',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
  'ConnectionReceivedId',
  'ConnectionSentId',
  'IsLocked',
  'MayEdit',
  'UserRecordAccessId'
])

const SKIP_TYPES: ReadonlySet<string> = new Set(['address', 'location', 'base64'])

export type RefKind = 'keep' | 'remap' | 'defer' | 'check' | 'poly'

export interface RefPlan {
  to: string[]
  kind: RefKind
  required: boolean
}

export interface FieldPlan {
  cols: string[]
  refs: Record<string, RefPlan>
  types: Record<string, string>
  /** Source fields the target has but the running user cannot create. */
  noAccess: string[]
  /** Source fields the target lacks. */
  missing: string[]
}

export interface PlannerContext {
  /** object → position across ALL template tiers (defer/remap decisions). */
  order: ReadonlyMap<string, number>
  /** Objects this run seeds. */
  seedSet: ReadonlySet<string>
  keepIdTargets: ReadonlySet<string>
}

export function plannerContext(template: SeedTemplate, tiers: ReadonlyArray<SeedTier>): PlannerContext {
  return {
    order: new Map(template.tiers.map((t, i) => [t.object, i])),
    seedSet: new Set(tiers.map((t) => t.object)),
    keepIdTargets: new Set(template.keepIdTargets)
  }
}

export function classifyRef(ctx: PlannerContext, object: string, referenceTo: ReadonlyArray<string>): RefKind {
  if (referenceTo.length !== 1) return 'poly'
  const t = referenceTo[0]!
  const to = ctx.order.get(t)
  const me = ctx.order.get(object)
  if (to !== undefined && me !== undefined) {
    if (ctx.seedSet.has(t)) return to >= me ? 'defer' : 'remap'
    // A template tier not in this run: earlier rows may sit in the id map (resume / another group).
    return to < me ? 'remap' : 'check'
  }
  return ctx.keepIdTargets.has(t) ? 'keep' : 'check'
}

export function fieldPlan(
  ctx: PlannerContext,
  object: string,
  source: TemplateDescribe,
  target: TemplateDescribe
): FieldPlan {
  const targetByName = new Map(target.fields.map((f) => [f.name, f]))
  const plan: FieldPlan = { cols: [], refs: {}, types: {}, noAccess: [], missing: [] }
  for (const f of source.fields) {
    if (SKIP_FIELDS.has(f.name) || f.calculated || f.autoNumber) continue
    if (SKIP_TYPES.has(f.type)) continue
    if (!(f.createable || f.updateable)) continue
    const t = targetByName.get(f.name)
    if (!t) {
      plan.missing.push(f.name)
      continue
    }
    if (!t.createable) {
      plan.noAccess.push(f.name)
      continue
    }
    plan.cols.push(f.name)
    plan.types[f.name] = f.type
    if (f.type === 'reference') {
      plan.refs[f.name] = {
        to: [...f.referenceTo],
        kind: classifyRef(ctx, object, f.referenceTo),
        required: !t.nillable && !t.defaultedOnCreate
      }
    }
  }
  return plan
}

export interface BuildResult {
  payload: Record<string, unknown> | null
  /** field → source value to write in the second pass. */
  later: Record<string, unknown>
  nulled: string[]
  /** Why the row is skipped (null when `payload` is set). */
  error: string | null
}

export interface BuildContext {
  deferredFields: ReadonlySet<string>
  placeholders: Readonly<Record<string, string | number | boolean>>
  /** source Id → target Id (or a dry-run marker). */
  idMap: ReadonlyMap<string, string>
  /** Source Ids of `check`/`poly` references that exist on the target. */
  exists: ReadonlySet<string>
}

export function buildRecord(rec: Record<string, unknown>, plan: FieldPlan, ctx: BuildContext): BuildResult {
  const out: Record<string, unknown> = {}
  const later: Record<string, unknown> = {}
  const nulled: string[] = []
  for (const n of plan.cols) {
    const v = rec[n]
    if (ctx.deferredFields.has(n)) {
      if (v !== null && v !== undefined) later[n] = v
      if (n in ctx.placeholders) out[n] = ctx.placeholders[n]
      else if (plan.types[n] === 'boolean') out[n] = false
      continue
    }
    if (n === 'RecordTypeId' && (v === null || v === undefined)) continue
    const ref = plan.refs[n]
    if (ref === undefined || v === null || v === undefined) {
      out[n] = v === undefined ? null : v
      continue
    }
    const value = String(v)
    switch (ref.kind) {
      case 'keep':
        out[n] = value
        break
      case 'remap': {
        const nv = ctx.idMap.get(value)
        if (nv !== undefined) out[n] = nv
        else if (ref.required) return { payload: null, later: {}, nulled: [], error: `required ${n} → ${value} was not loaded` }
        else {
          out[n] = null
          nulled.push(n)
        }
        break
      }
      case 'defer':
        later[n] = value
        out[n] = null
        break
      default: {
        // check / poly: an already-mapped Id (a template tier from another group) wins over the probe.
        const mapped = ctx.idMap.get(value)
        if (mapped !== undefined) out[n] = mapped
        else if (ctx.exists.has(value)) out[n] = value
        else if (ref.required)
          return { payload: null, later: {}, nulled: [], error: `required ${n} → ${value} doesn't exist in the target` }
        else {
          out[n] = null
          nulled.push(n)
        }
      }
    }
  }
  return { payload: out, later, nulled, error: null }
}

/** The fields of an object that get second-pass values: deferred fields + defer-kind refs. */
export function deferredFieldsFor(plan: FieldPlan, configured: ReadonlyArray<string>): string[] {
  const out = configured.filter((n) => plan.cols.includes(n))
  for (const [n, r] of Object.entries(plan.refs)) if (r.kind === 'defer' && !out.includes(n)) out.push(n)
  return out
}

/** `SELECT Id, cols FROM object[ WHERE where]` on the SOURCE. */
export function sourceSoql(tier: SeedTier, plan: FieldPlan): string {
  const where = (tier.where ?? '').trim()
  return `SELECT ${['Id', ...plan.cols].join(', ')} FROM ${tier.object}${where ? ` WHERE ${where}` : ''}`
}

/** Field-value equality across orgs: blank == null, text compared trimmed, numbers within 1e-9. */
export function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown): boolean => v === null || v === undefined || v === ''
  if (blank(a) && blank(b)) return true
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b)
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9
  const norm = (v: unknown): string => String(v).replaceAll('\r\n', '\n').trim()
  return norm(a) === norm(b)
}

export type { TemplateDescribeField }
