/**
 * The assembled PassExecutors for a frozen plan — the four E4E.2–E4E.5 batch
 * loops behind the E4E.1 seam. The automation hooks (disableAutomation /
 * finalize / restoreAutomation) land with Epic 4A and are intentionally
 * absent here: the orchestrator treats them as optional, so a run through
 * these executors deploys data but performs NO automation disable, NO
 * contract activation, and NO CPQ-guard arm/disarm — correct for dry-run and
 * fixture work, NOT yet a live-parity deploy. 5B.9's Start Deploy binding
 * must refuse to run live until the E4A hooks exist (the CPQ attestation gate
 * already blocks the wizard side).
 *
 * Pure: composes pure modules over the injected DeployIo.
 */
import { makeFirstPass } from './firstPass'
import { makeRetryPass } from './retry'
import { makeSecondPass } from './secondPass'
import { makeJunctionPass } from './junction'
import type { DeployPlan } from './planFreeze'
import type { PassExecutors } from './types'

export function makePassExecutors(plan: DeployPlan): PassExecutors {
  return {
    firstPass: makeFirstPass(plan),
    retryPass: makeRetryPass(plan),
    secondPass: makeSecondPass(plan),
    junctionPass: makeJunctionPass(plan)
  }
}
