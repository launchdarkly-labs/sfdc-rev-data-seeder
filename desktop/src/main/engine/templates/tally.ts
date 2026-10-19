/**
 * Every problem a template run meets, marked expected (it matches one of the
 * template's `expectedFailures`) or not — the closing SUMMARY and the run's
 * state come from here, so a run that "finished" with gaps cannot look clean
 * (the reference tool's Tally, ported).
 */
import type {
  BatchSizeSuggestion,
  NextAction,
  ProblemGroup,
  SeedTierReport,
  SecondPassReport,
  TemplateProblem,
  TemplateReport,
  TemplateRunState,
  TemplateStep
} from '../../../shared/templates/types'

export interface ExpectedFailureRule {
  object: string | null
  contains: string
  why: string
}

export class Tally {
  readonly items: TemplateProblem[] = []
  private rules: ExpectedFailureRule[] = []

  configure(rules: ReadonlyArray<ExpectedFailureRule>): void {
    this.rules = [...this.rules, ...rules]
  }

  add(step: TemplateStep, object: string | null, recordId: string | null, message: string): TemplateProblem {
    const msg = message ?? ''
    const hit = this.rules.find((r) => (r.object == null || r.object === object) && msg.includes(r.contains))
    const p: TemplateProblem = {
      step,
      object,
      recordId,
      message: msg.length > 400 ? msg.slice(0, 400) : msg,
      expected: hit != null,
      why: hit?.why ?? null
    }
    this.items.push(p)
    return p
  }

  /** A problem the engine itself knows is a consequence of an expected failure (S61 U-6). */
  addKnown(step: TemplateStep, object: string | null, recordId: string | null, message: string, why: string): TemplateProblem {
    const p: TemplateProblem = { step, object, recordId, message: message.length > 400 ? message.slice(0, 400) : message, expected: true, why }
    this.items.push(p)
    return p
  }

  unexpected(): TemplateProblem[] {
    return this.items.filter((i) => !i.expected)
  }

  expected(): TemplateProblem[] {
    return this.items.filter((i) => i.expected)
  }

  hasObjectProblem(object: string): boolean {
    return this.items.some((i) => i.object === object)
  }
}

export function groupProblems(items: ReadonlyArray<TemplateProblem>): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>()
  for (const i of items) {
    const key = `${i.step}|${i.object ?? ''}`
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { step: i.step, object: i.object, count: 1, example: i.message, why: i.why })
  }
  return [...groups.values()].sort((a, b) => (a.step + (a.object ?? '')).localeCompare(b.step + (b.object ?? '')))
}

/**
 * D4 — objects whose rows saved only on the single-record retry, or failed
 * with the bulk-only error class and never saved: suggest batchSize 1.
 */
export function batchSizeSuggestions(
  seed: ReadonlyArray<SeedTierReport>,
  secondPass: ReadonlyArray<SecondPassReport>
): BatchSizeSuggestion[] {
  const out = new Map<string, string>()
  for (const t of seed) {
    if (t.savedOnSingleRetry > 0) {
      out.set(t.object, `${t.savedOnSingleRetry} row${t.savedOnSingleRetry === 1 ? '' : 's'} saved only on the single-record retry`)
    } else if (t.bulkOnlyFailures > 0) {
      out.set(t.object, `${t.bulkOnlyFailures} row${t.bulkOnlyFailures === 1 ? '' : 's'} failed with a bulk-only trigger error`)
    }
  }
  for (const s of secondPass) {
    if (s.savedOnSingleRetry > 0 && !out.has(s.object)) {
      out.set(s.object, `${s.savedOnSingleRetry} second-pass update${s.savedOnSingleRetry === 1 ? '' : 's'} saved only on the single-record retry`)
    }
  }
  return [...out].map(([object, reason]) => ({ object, reason }))
}

/**
 * Error classes a Resume would meet again unchanged: the row itself (or what it points at)
 * is the problem, not the moment. Row locks, CPU time and timeouts are NOT here — those are
 * what Resume is for. Skips are terminal by design ("A SKIP is terminal").
 */
export const NON_RETRYABLE_PATTERNS = [
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  'FIELD_INTEGRITY_EXCEPTION',
  'REQUIRED_FIELD_MISSING',
  'INVALID_CROSS_REFERENCE_KEY',
  'INVALID_FIELD',
  'INVALID_TYPE_ON_FIELD_IN_RECORD',
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  'STRING_TOO_LONG',
  'NUMBER_OUTSIDE_VALID_RANGE',
  'DUPLICATE_VALUE',
  'DUPLICATES_DETECTED',
  'MALFORMED_ID',
  'ENTITY_IS_DELETED',
  'skipped',
  'not found in the source',
  'is not in the target'
] as const

/** Would a Resume plausibly write this row? False for data/validation/cross-reference classes and skips. */
export function isRetryable(p: Pick<TemplateProblem, 'message'>): boolean {
  return !NON_RETRYABLE_PATTERNS.some((pat) => p.message.includes(pat))
}

const SEED_STEPS: ReadonlySet<TemplateStep> = new Set(['seed', 'secondPass', 'relink', 'verify', 'resume'])

export function decideNextAction(input: {
  state: TemplateRunState
  unexpected: ReadonlyArray<TemplateProblem>
  mode: TemplateReport['mode']
  unrestoredTemporary: number
}): NextAction {
  if (input.unrestoredTemporary > 0) return 'restoreTargetAutomation'
  if (input.mode === 'dry-run') return 'none'
  if (input.state === 'cancelled') return 'resume'
  const steps = new Set(input.unexpected.map((p) => p.step))
  if (steps.has('automation') || steps.has('settingPatch') || steps.has('safety')) return 'rerunAutomation'
  // S61 U-7: Resume only when at least one seed-side problem could come out differently. Four
  // approvers pointing at users the target does not have would fail identically on every Resume.
  const seedSide = input.unexpected.filter((p) => SEED_STEPS.has(p.step))
  if (seedSide.length > 0) return seedSide.some(isRetryable) ? 'resume' : 'fixAndRerun'
  if (input.unexpected.length > 0) return 'fixAndRerun'
  return 'none'
}

/**
 * Final state from the facts: cancelled → blocked → (unexpected problems: partial when every
 * step ran to the end, failed when the run did not finish) → clean. S61 U-8: a run that wrote
 * 4,750 rows and could not write 4 is not the same thing as a run that died halfway.
 */
export function decideState(input: {
  blocked: boolean
  cancelled: boolean
  unexpected: number
  /** Every step ran to its end (nothing threw, nothing was cut short). */
  completed: boolean
}): TemplateRunState {
  if (input.cancelled) return 'cancelled'
  if (input.blocked) return 'blocked'
  if (input.unexpected > 0) return input.completed ? 'partial' : 'failed'
  return 'clean'
}
