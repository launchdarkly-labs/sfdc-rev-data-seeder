/**
 * Setting patches (S59 plan D5): object → field → `prefix` or `set`, over the
 * rows a WHERE fragment selects. Pure planner — the runner queries the rows,
 * this decides the updates, the runner writes them and records the undo
 * values in template_automation_changes.
 *
 * Idempotent by construction: a row already carrying the prefix, or already
 * holding the set value, is "already patched" and never rewritten.
 */
import type { SettingPatch } from '../../../shared/templates/types'

export interface SettingPatchPlan {
  updates: Array<Record<string, unknown>>
  /** Original values keyed by record Id — the undo record. */
  undo: Array<{ id: string; original: unknown }>
  alreadyPatched: number
  /** Rows skipped because the field was blank and the transform is a prefix. */
  blank: number
}

/** `SELECT Id, <field> FROM <object>[ WHERE <where>]` — what the runner queries. */
export function settingPatchSoql(patch: SettingPatch): string {
  const where = (patch.where ?? '').trim()
  return `SELECT Id, ${patch.field} FROM ${patch.object}${where ? ` WHERE ${where}` : ''}`
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}

export function planSettingPatch(
  rows: ReadonlyArray<Record<string, unknown>>,
  patch: SettingPatch,
  fieldLength: number | null
): SettingPatchPlan {
  const plan: SettingPatchPlan = { updates: [], undo: [], alreadyPatched: 0, blank: 0 }
  for (const row of rows) {
    const id = typeof row.Id === 'string' ? row.Id : null
    if (id === null) continue
    const current = row[patch.field]
    if (patch.transform.kind === 'prefix') {
      const prefix = patch.transform.value
      if (current == null || current === '') {
        plan.blank++
        continue
      }
      const text = String(current)
      if (text.startsWith(prefix)) {
        plan.alreadyPatched++
        continue
      }
      let next = prefix + text
      if (fieldLength != null && fieldLength > 0 && next.length > fieldLength) next = next.slice(0, fieldLength)
      plan.updates.push({ Id: id, [patch.field]: next })
      plan.undo.push({ id, original: current })
    } else {
      const value = patch.transform.value
      if (sameValue(current, value)) {
        plan.alreadyPatched++
        continue
      }
      plan.updates.push({ Id: id, [patch.field]: value })
      plan.undo.push({ id, original: current ?? null })
    }
  }
  return plan
}
