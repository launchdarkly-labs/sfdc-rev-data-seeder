/**
 * Pure mapping between the analysis engine's `PlannedObject`, the
 * `deployment_objects` row, and the renderer-facing `PlanObjectView`.
 *
 * The full PlannedObject (including its structured `scope`, which the deploy
 * engine needs) is stored verbatim in `plan_json`; the typed columns are a
 * queryable projection. Type-only imports keep this free of the sqlite/engine
 * runtime so it unit-tests in the default (pure) lane.
 */
import type { PlannedObject } from './engine/analysis'
import type { PlanObjectView } from '../shared/types'

export interface DeploymentObjectRow {
  deployment_id: number
  object_api_name: string
  sort_order: number
  status: string
  filter_clause: string | null
  scoped_filter: string | null
  scoped_filter_display: string | null
  scoped_record_count: number | null
  api_strategy: string | null
  gating_tier: string | null
  has_circular_refs: number
  deferred_fields: string | null
  is_junction: number
  junction_parents: string | null
  plan_json: string | null
  error_message: string | null
}

export function plannedObjectToRow(deploymentId: number, p: PlannedObject): DeploymentObjectRow {
  return {
    deployment_id: deploymentId,
    object_api_name: p.objectName,
    sort_order: p.sortOrder,
    status: 'Pending',
    filter_clause: null,
    scoped_filter: JSON.stringify(p.scope),
    scoped_filter_display: p.scopedFilterDisplay,
    scoped_record_count: p.recordCount,
    api_strategy: p.apiStrategy,
    gating_tier: p.gatingTier,
    has_circular_refs: p.hasCircularReference ? 1 : 0,
    deferred_fields: JSON.stringify(p.deferredFields),
    is_junction: p.isJunction ? 1 : 0,
    junction_parents: p.junctionParents ? JSON.stringify(p.junctionParents) : null,
    plan_json: JSON.stringify(p),
    error_message: null
  }
}

/** Reconstruct the full PlannedObject from a row (plan_json is authoritative). */
export function rowToPlannedObject(row: DeploymentObjectRow): PlannedObject {
  if (!row.plan_json) {
    throw new Error(`deployment_objects row for ${row.object_api_name} has no plan_json`)
  }
  return JSON.parse(row.plan_json) as PlannedObject
}

export function plannedObjectToView(p: PlannedObject): PlanObjectView {
  return {
    objectName: p.objectName,
    sortOrder: p.sortOrder,
    recordCount: p.recordCount,
    apiStrategy: p.apiStrategy,
    gatingTier: p.gatingTier,
    isJunction: p.isJunction,
    hasCircularReference: p.hasCircularReference,
    deferredFields: p.deferredFields,
    scopedFilterDisplay: p.scopedFilterDisplay,
    junctionParents: p.junctionParents,
    requiresTriggerBypass: p.requiresTriggerBypass,
    recommendedBatchSize: p.recommendedBatchSize
  }
}
