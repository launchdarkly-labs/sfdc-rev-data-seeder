/**
 * 5B.9 — ORG-WIDE target ExtId probe: which objects on the TARGET carry the
 * seeder's upsert-key field. Port of `SchemaService.batchCheckRdsField`
 * (:530-607), the exact oracle `planFreeze.FreezeInput.targetHasExtId`
 * documents: ONE Tooling CustomField query with NO object filter — a
 * readiness-scoped subset would over-downgrade A10 externalId refs that point
 * at out-of-deployment objects (E2.6 review finding; ROADMAP:45).
 *
 * Load-bearing Apex semantics kept:
 *  - DeveloperName (no __c suffix) match on the configured ExtId field.
 *  - Pagination followed on BOTH queries (a broadly-initialized org exceeds
 *    one Tooling page — silently dropping the overflow made downstream code
 *    hard-fail, :541-543). jsforce's autoFetch performs the same
 *    nextRecordsUrl walk.
 *  - TableEnumOrId is the API name for standard objects but an entity ID for
 *    custom/managed ones (starts with '0', no '__') — those resolve via
 *    EntityDefinition with the 18→15-char DurableId truncation (:569-573;
 *    without it every managed-package object silently dropped).
 *  - Read-only Tooling queries — safe on any role; no assertWritable.
 */
import type { GuardedOrg } from './salesforce'
import { EXT_ID_FIELD } from '../engine/readiness'

interface ToolingQueryRunner {
  query(soql: string, options?: { autoFetch?: boolean; maxFetch?: number }): Promise<unknown>
}

const MAX_FETCH = 50_000

function records(res: unknown): Array<Record<string, unknown>> {
  const container = res as { records?: unknown }
  return Array.isArray(container?.records)
    ? (container.records as Array<Record<string, unknown>>)
    : []
}

export async function targetHasExtIdOrgWide(target: GuardedOrg): Promise<Set<string>> {
  const tooling = target.conn.tooling as unknown as ToolingQueryRunner
  const objectsWithField = new Set<string>()
  const unresolvedIds = new Set<string>()

  const devName = EXT_ID_FIELD.endsWith('__c') ? EXT_ID_FIELD.slice(0, -3) : EXT_ID_FIELD
  const fieldRes = await tooling.query(
    `SELECT TableEnumOrId FROM CustomField WHERE DeveloperName = '${devName.replace(/'/g, "\\'")}'`,
    { autoFetch: true, maxFetch: MAX_FETCH }
  )
  for (const rec of records(fieldRes)) {
    const tableId = typeof rec.TableEnumOrId === 'string' ? rec.TableEnumOrId : null
    if (tableId === null) continue
    // Standard objects use API name; custom/managed use an entity ID
    // (starts with '0', 15/18 chars, never contains '__').
    if (!tableId.startsWith('0') || tableId.includes('__')) {
      objectsWithField.add(tableId)
    } else {
      unresolvedIds.add(tableId)
    }
  }

  if (unresolvedIds.size > 0) {
    const idList = [...unresolvedIds]
      .map((id) => `'${(id.length === 18 ? id.slice(0, 15) : id).replace(/'/g, "\\'")}'`)
      .join(',')
    const entityRes = await tooling.query(
      `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${idList})`,
      { autoFetch: true, maxFetch: MAX_FETCH }
    )
    for (const rec of records(entityRes)) {
      if (typeof rec.QualifiedApiName === 'string') objectsWithField.add(rec.QualifiedApiName)
    }
  }

  return objectsWithField
}
