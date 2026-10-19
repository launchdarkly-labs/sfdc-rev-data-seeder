/**
 * Slot-refill plan reorder — verbatim port of the Apex
 * `DataSeederController.applyDeploymentPlan` interleave algorithm
 * (DataSeederController.cls:1574-1636, the Session-16 ordering fix).
 *
 * THE INVARIANT: every object keeps its current (analysis-derived) slot;
 * only the slots occupied by objects named in `desiredOrder` are refilled,
 * in `desiredOrder`'s sequence. Objects omitted from `desiredOrder` (and
 * junctions, which the UI never lets you drag) therefore stay exactly where
 * the analysis put them — a partial or mis-ordered reorder can never push
 * omitted objects to the end (the "Quote Terms first / Account appended
 * last" bug class from Session 16 is impossible by construction).
 *
 * Pure and dependency-free: `currentOrder` comes from the persisted plan
 * (deployment_objects ORDER BY sort_order), `desiredOrder` from the UI.
 */
export function slotRefillReorder(
  currentOrder: readonly string[],
  desiredOrder: readonly string[]
): string[] {
  // Ordered, de-duplicated list of objects explicitly placed by the caller.
  const planOrder: string[] = []
  const planSet = new Set<string>()
  for (const name of desiredOrder) {
    if (!planSet.has(name)) {
      planOrder.push(name)
      planSet.add(name)
    }
  }

  const present = new Set(currentOrder)

  // Slots currently occupied by plan objects, in current order.
  const planSlots: number[] = []
  currentOrder.forEach((name, i) => {
    if (planSet.has(name)) planSlots.push(i)
  })

  // Plan order limited to objects actually present in this deployment.
  const presentPlanOrder = planOrder.filter((n) => present.has(n))

  // Refill the plan-occupied slots with the plan's order; everything else
  // (omitted objects, junctions) stays exactly where the analysis put it.
  const finalNames = [...currentOrder]
  const bound = Math.min(planSlots.length, presentPlanOrder.length)
  for (let k = 0; k < bound; k++) {
    const slot = planSlots[k]
    const name = presentPlanOrder[k]
    if (slot === undefined || name === undefined) continue
    finalNames[slot] = name
  }
  return finalNames
}
