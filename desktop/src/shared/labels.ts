/**
 * S64 (P3): ONE vocabulary for status words and run phases across the renderer.
 *
 * Three raw vocabularies reach the UI — job statuses (`running/done/error/
 * cancelled`), deployment statuses (`Draft/Planned/Deploying/…`) and template
 * run states (`clean/partial/blocked/…`) — and Home used to print all three
 * side by side in their raw casing (ux C-5). Everything user-facing goes
 * through `statusLabel` / `statusTone`; the raw value stays available for
 * `title` attributes and tests. Dependency-free (shared by main and renderer).
 */
import type { DeployRunPhaseView } from './types'

export type StatusKind = 'job' | 'deployment' | 'templateRun'

/** Mirrors the Badge tones in the renderer without importing it. */
export type StatusTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

const JOB: Record<string, [string, StatusTone]> = {
  running: ['Running', 'accent'],
  done: ['Completed', 'success'],
  error: ['Failed', 'danger'],
  cancelled: ['Cancelled', 'neutral']
}

const DEPLOYMENT: Record<string, [string, StatusTone]> = {
  Draft: ['Draft', 'neutral'],
  Planned: ['Planned', 'neutral'],
  Deploying: ['Deploying', 'accent'],
  Retrying: ['Retrying', 'accent'],
  Finalizing: ['Finalizing', 'accent'],
  RestoringAutomation: ['Restoring automation', 'accent'],
  Completed: ['Completed', 'success'],
  Failed: ['Failed', 'danger'],
  Cancelled: ['Cancelled', 'neutral'],
  Stalled: ['Stalled', 'danger']
}

const TEMPLATE_RUN: Record<string, [string, StatusTone]> = {
  pending: ['Pending', 'neutral'],
  running: ['Running', 'accent'],
  clean: ['Completed', 'success'],
  partial: ['Completed with issues', 'warn'],
  failed: ['Failed', 'danger'],
  blocked: ['Blocked', 'warn'],
  cancelled: ['Cancelled', 'neutral'],
  skipped: ['Skipped', 'neutral']
}

const TABLES: Record<StatusKind, Record<string, [string, StatusTone]>> = {
  job: JOB,
  deployment: DEPLOYMENT,
  templateRun: TEMPLATE_RUN
}

/** Title-case, human label for a raw status; unknown values pass through unchanged. */
export function statusLabel(kind: StatusKind, raw: string): string {
  return TABLES[kind][raw]?.[0] ?? raw
}

/** Badge tone for a raw status; unknown values are neutral. */
export function statusTone(kind: StatusKind, raw: string): StatusTone {
  return TABLES[kind][raw]?.[1] ?? 'neutral'
}

/** Engine run phases as the operator reads them (ux T-4: "RestoringAutomation" was printed raw). */
export const PHASE_LABELS: Record<DeployRunPhaseView, string> = {
  Frozen: 'Plan frozen',
  DisablingAutomation: 'Disabling automation',
  Deploying: 'Deploying records',
  Retrying: 'Retrying failed rows',
  SecondPass: 'Second pass (deferred fields)',
  Finalizing: 'Finalizing',
  RestoringAutomation: 'Restoring automation',
  Completed: 'Completed',
  Failed: 'Failed',
  Cancelled: 'Cancelled',
  Stalled: 'Stalled'
}

export function phaseLabel(phase: string): string {
  return (PHASE_LABELS as Record<string, string>)[phase] ?? phase
}

/**
 * The pre-run phases the monitor shows as a checklist before the engine's
 * first event arrives (ux F-3: "Deploying" with no phase for several seconds).
 */
export const PRE_RUN_PHASES: readonly string[] = ['Connecting to both orgs', 'Checking gates', 'Freezing the plan']

/** One-line glossary for terms the UI cannot avoid (ux T-5 … T-7). Used in `title` attributes. */
export const GLOSSARY = {
  junction: 'Link object between two parents — matched by both lookups, never upserted.',
  keyless: 'No External Id field on the target: rows are inserted and tracked in this app’s local id map.',
  keyed: 'Rows are matched by the External Id field this app adds to the target, so re-runs update in place.',
  externalId: 'The custom text field this app adds to each object on the target to recognise rows it wrote.',
  attestation: 'Your confirmation that CPQ’s org-wide “Triggers Disabled” setting is on for this run.',
  alreadyOnTarget: 'Rows whose values already matched the target, so nothing was written.',
  skipped: 'Rows left out on purpose: a parent missing on the target, or a policy skip.',
  deferred: 'Fields written in the second pass, once the records they point at exist.',
  // S64 P3 — the Deployment page KPIs (ux T-8) and the Summary table (T-15).
  planned: 'Records the analysis counted in scope, across every object in the plan.',
  queried: 'Records read from the source org so far.',
  deployed: 'Records written to the target (inserted or updated), plus rows that were already there.',
  failed: 'Records the target refused after every retry — export the failure list for the reasons.',
  relinked: 'Text fields holding record Ids that were rewritten to the target’s Ids after the load.',
  unresolved: 'Text-Id values that could not be mapped and were left as the source Id.',
  gating: 'How the deploy engine paces this object: a managed package or playbook entry forces slower, REST-only batches.',
  loadGroup: 'A named subset of the seed order — a run can load one group on its own.'
} as const
