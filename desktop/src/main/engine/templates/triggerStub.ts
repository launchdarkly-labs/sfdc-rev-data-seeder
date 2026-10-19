/**
 * The TEMPLATE comment-out convention for Apex triggers (S59 plan §6.2).
 *
 * It needs its OWN sentinel and its OWN escape token, for two reasons pinned
 * by tests here and in triggerBodyToggle.test.ts:
 *  - `restoreAllOrphanedTriggers` un-wraps EVERY body carrying the deploy's
 *    `RDS_BYPASS` marker. A template stub that reused it would be "restored"
 *    by the next orphan sweep — the opposite of what the user asked for.
 *  - `commentOutBody` REFUSES a body that already contains the deploy's escape
 *    token `*<<RDS_ESC>>/` (triggerBodyToggle.ts:118-123). A later deploy
 *    must still be able to wrap a stubbed trigger (its Status is still
 *    Active), so the template's escape token must be a different string.
 *
 * Round trip is byte-exact: `unstubBody(stubBody(b)) === b` for every body
 * without the template escape token (golden test), and the deploy wrap →
 * unwrap over a stub returns the stub byte-exact.
 */

export const TEMPLATE_BEGIN = '/*<<RDS_TEMPLATE_BEGIN>>'
export const TEMPLATE_END = '<<RDS_TEMPLATE_END>>*/'
/** Replaces a nested close-comment token (star-slash) inside the stubbed body; reversed on unstub. */
export const TEMPLATE_ESC = '*<<RDS_TPL_ESC>>/'

/** The deploy engine's markers — recognised so the catalog can name that state. */
const DEPLOY_BEGIN = '/*<<RDS_BYPASS_BEGIN>>'
const DEPLOY_ESC = '*<<RDS_ESC>>/'

export class TriggerStubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerStubError'
  }
}

/** The header line written inside the stub comment. */
export function stubHeader(templateName: string, isoDate: string): string {
  return ` RDS template "${templateName}" commented out this trigger on ${isoDate}. Never deploy this version to production. `
}

/**
 * Wrap everything between the first `{` and the last `}` in one block comment
 * bounded by the template sentinels, with a header line. Idempotent when the
 * body is already stubbed. Refuses a body that carries the template escape
 * token (it could not be reversed exactly).
 */
export function stubBody(original: string, templateName: string, isoDate: string): string {
  const firstBrace = original.indexOf('{')
  const lastBrace = original.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new TriggerStubError('Could not locate the trigger body braces')
  }
  const inner = original.substring(firstBrace + 1, lastBrace)
  if (inner.includes(TEMPLATE_BEGIN)) return original
  if (inner.includes(TEMPLATE_ESC)) {
    throw new TriggerStubError('Trigger body already contains the RDS template escape token — refusing to wrap.')
  }
  // A header that itself contains `*/` would close the comment early.
  const header = stubHeader(templateName, isoDate).replaceAll('*/', '* /')
  const escaped = inner.replaceAll('*/', TEMPLATE_ESC)
  return (
    original.substring(0, firstBrace + 1) +
    TEMPLATE_BEGIN +
    header +
    '\n' +
    escaped +
    TEMPLATE_END +
    original.substring(lastBrace)
  )
}

/** Reverse `stubBody`. Returns the input unchanged when the markers are absent or out of order. */
export function unstubBody(stubbed: string): string {
  const beginIdx = stubbed.indexOf(TEMPLATE_BEGIN)
  const endIdx = stubbed.indexOf(TEMPLATE_END)
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) return stubbed
  const before = stubbed.substring(0, beginIdx)
  const wrapped = stubbed.substring(beginIdx + TEMPLATE_BEGIN.length, endIdx)
  const after = stubbed.substring(endIdx + TEMPLATE_END.length)
  // The header is the text up to and including the first newline after BEGIN.
  const nl = wrapped.indexOf('\n')
  const inner = nl < 0 ? wrapped : wrapped.substring(nl + 1)
  return before + inner.replaceAll(TEMPLATE_ESC, '*/') + after
}

export function isTemplateStubbed(body: string | null | undefined): boolean {
  return body != null && body.includes(TEMPLATE_BEGIN) && body.includes(TEMPLATE_END)
}

export function isDeployWrapped(body: string | null | undefined): boolean {
  return body != null && body.includes(DEPLOY_BEGIN)
}

export type BodyState = 'live' | 'templateStub' | 'deployWrapped'

/** What a body says about itself — the catalog's "body state" column. */
export function bodyState(body: string | null | undefined): BodyState {
  if (isDeployWrapped(body)) return 'deployWrapped'
  if (isTemplateStubbed(body)) return 'templateStub'
  return 'live'
}

/** True when the deploy's `commentOutBody` would refuse this body (its escape token is present). */
export function wouldDeployRefuse(body: string): boolean {
  return body.includes(DEPLOY_ESC)
}

/** Guard: the template convention must never collide with the deploy's refusal. */
if (TEMPLATE_ESC.includes(DEPLOY_ESC) || TEMPLATE_BEGIN.includes(DEPLOY_BEGIN) || stubHeader('x', 'y').includes(DEPLOY_ESC)) {
  throw new Error('template trigger stub tokens collide with the deploy bypass tokens')
}
