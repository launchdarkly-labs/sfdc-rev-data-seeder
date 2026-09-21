/**
 * E4E.3 — the targeted-retry drain: `PassExecutors.retryPass`. Port of the
 * retry-pass arm of `DataDeploymentQueueable.executeNormalModeV2`:
 *
 *   - The orchestrator (E4E.1) owns SELECTION: candidate objects, the
 *     selection-time MAX-5 budget, the progress gate, and seeding the
 *     retry_queue from the previous pass's failed_records (its
 *     `enqueueRetries` = the Apex Retry_Source_Ids → Retry_Pending_Ids move,
 *     DDQ L2976-2985). This module only DRAINS.
 *   - Drain in RETRY_CHUNK_SIZE (150) id chunks (DDQ L1686-1707) — one chunk
 *     per Apex queueable hop, one loop iteration here; `dequeueRetryChunk`
 *     removes in insertion order (the Apex list head).
 *   - Per chunk: `buildRetrySourceQuery` (base query, NO user filter, PA
 *     filter kept, `Id IN (chunk)` — DDQ L1716-1734; PricebookEntry gets no
 *     ORDER BY on retry, matching L1721-1730), then the SAME page machinery
 *     as the first pass (`processPage` — the Apex retry hop ran the identical
 *     L1794-2041 body with `retryInputIds` set). Rows land at
 *     (pass=1, retryPass=ctx.retryPass, objectAttempt=ctx.objectAttempt) —
 *     coordinates verbatim from ObjectPassContext.
 *   - Every retry chunk hop re-entered with batchNumber 0 (`enqueueNextHop(id,
 *     null, 0, …)` — DDQ L2822/L3008): each chunk's log lines say `batch 0`,
 *     continuation pages within a chunk increment (L2043-2044).
 *   - Records_Queried / Records_Skipped are untouched by construction: the
 *     views count only retry_pass-0 rows (the Apex `retryInputIds == null`
 *     gate, DDQ L1989-1996).
 *   - FINDINGS #15 (the in-org appendMode bug family) dies structurally:
 *     every chunk's failures are ROWS at the same (retryPass, objectAttempt);
 *     multi-chunk passes count correctly because nothing accumulates.
 *
 * EMPTY QUERY RESULT (DDQ L1755-1767 — the guard ran on retry hops too): the
 * chunk's source records were deleted mid-run → Apex logged
 * 'Skipped {obj} — no records on source', marked the object complete, and
 * ABANDONED the drain (Retry_Pending_Ids left populated; the next selection
 * round's progress gate then gave up). Mirrored: log + return, remaining
 * queue rows left in place — the orchestrator's selection-time budget and
 * progress gate bound everything (two E4E.1 empirically-reproduced infinite
 * loops guard exactly this shape).
 *
 * CANCEL: checked before each chunk dequeue (nothing is lost — undrained ids
 * stay queued) and between pages within a chunk.
 *
 * TRIPWIRE: CpqTriggersActiveError propagates out of processPage — the
 * orchestrator fails the whole run; it also clears this object's queue on any
 * executor throw before the bounded whole-object rerun.
 *
 * Junction objects never retry (their path records no retry input — DDQ L762)
 * — the orchestrator never routes them here; refused defensively.
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { buildRetrySourceQuery } from './transform/queryBuild'
import { buildObjectContext } from './objectContext'
import { allObjectNames, processPage } from './firstPass'
import type { DeployPlan } from './planFreeze'
import type { ObjectPassContext } from './types'
import { RETRY_CHUNK_SIZE } from './types'

/** The PassExecutors.retryPass implementation, closed over the frozen plan. */
export function makeRetryPass(plan: DeployPlan): (ctx: ObjectPassContext) => Promise<void> {
  return (ctx) => runRetryPass(plan, ctx)
}

export async function runRetryPass(plan: DeployPlan, ctx: ObjectPassContext): Promise<void> {
  const objectName = ctx.object.objectName
  const objPlan = plan.objects.find((o) => o.objectName === objectName)
  if (objPlan == null) {
    throw new Error(`No frozen plan object for ${objectName}`)
  }
  if (objPlan.isJunction) {
    throw new Error(`${objectName} is a junction object — junctions never take targeted retries`)
  }
  const io = ctx.io
  const runObjects = allObjectNames(plan)

  for (;;) {
    // Cancel BEFORE dequeue — undrained ids stay queued for a resume.
    if (io.store.isCancelRequested(ctx.runId)) return
    const chunk = io.store.dequeueRetryChunk(ctx.runId, objectName, RETRY_CHUNK_SIZE)
    if (chunk.length === 0) return

    // Full context rebuild PER CHUNK — each 150-id chunk was its own Apex
    // queueable hop re-running the whole Phase-A prefetch (describes, picklist
    // allowed-values, inactive-PBE substitutes, target user; executeNormalModeV2
    // top). Target-side state changes between chunks stay visible, exactly as
    // in-org (E4E.3 review: a per-drain snapshot missed a PBE deactivated
    // mid-drain — failed-vs-skipped outcome divergence on later chunks).
    const octx = await buildObjectContext(objPlan, io)

    const soql = buildRetrySourceQuery(
      objectName,
      octx.keptFields,
      chunk,
      octx.sourceHasIsPersonAccount
    )

    // Each chunk is its own Apex hop: batch numbering restarts at 0
    // (enqueueNextHop L2822/L3008); pages within the chunk increment.
    let batchNumber = 0
    for await (const page of io.querySourcePages(soql)) {
      if (batchNumber > 0 && io.store.isCancelRequested(ctx.runId)) return
      if (page.records.length === 0) {
        // DDQ L1755-1767 on a retry hop: drained records were deleted on the
        // source — log the Apex line and abandon the drain (see header).
        io.emit({
          kind: 'log',
          data: {
            runId: ctx.runId,
            level: 'Info',
            message: `Skipped ${objectName} — no records on source`
          }
        })
        return
      }
      await processPage(objPlan, octx, ctx, page, batchNumber, runObjects)
      batchNumber++
    }
  }
}
