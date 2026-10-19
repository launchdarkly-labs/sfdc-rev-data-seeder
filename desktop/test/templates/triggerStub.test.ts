import { describe, it, expect } from 'vitest'
import {
  TEMPLATE_BEGIN,
  TEMPLATE_END,
  TEMPLATE_ESC,
  bodyState,
  isTemplateStubbed,
  stubBody,
  unstubBody,
  wouldDeployRefuse
} from '../../src/main/engine/templates/triggerStub'
import {
  BEGIN_MARKER,
  ESCAPED_CLOSE,
  commentOutBody,
  uncommentBody
} from '../../src/main/engine/triggerBodyToggle'

const BODY = `trigger AcmeOrderSync on Order (after insert, after update) {
    // sync orders  */ odd comment token
    if (Trigger.isAfter) { AcmeSync.run(Trigger.new); /* inline */ }
}`

describe('template trigger stub', () => {
  it('round-trips byte-exact, escaping nested close-comment tokens', () => {
    const stubbed = stubBody(BODY, 'Acme dev sandbox', '2026-10-11')
    expect(stubbed).toContain(TEMPLATE_BEGIN)
    expect(stubbed).toContain(TEMPLATE_END)
    expect(stubbed).toContain('RDS template "Acme dev sandbox" commented out this trigger on 2026-10-11')
    // The two nested `*/` were escaped, so the stub holds exactly ONE close token (the END marker's).
    expect(stubbed.split('*/').length - 1).toBe(1)
    expect(stubbed).toContain(TEMPLATE_ESC)
    expect(unstubBody(stubbed)).toBe(BODY)
  })

  it('is idempotent and recognises its own state', () => {
    const once = stubBody(BODY, 't', 'd')
    expect(stubBody(once, 't', 'd')).toBe(once)
    expect(isTemplateStubbed(once)).toBe(true)
    expect(isTemplateStubbed(BODY)).toBe(false)
    expect(bodyState(once)).toBe('templateStub')
    expect(bodyState(BODY)).toBe('live')
  })

  it('unstub leaves a non-stubbed body alone', () => {
    expect(unstubBody(BODY)).toBe(BODY)
    expect(unstubBody(`${TEMPLATE_END} before ${TEMPLATE_BEGIN}`)).toBe(`${TEMPLATE_END} before ${TEMPLATE_BEGIN}`)
  })

  it('refuses a body that already carries the template escape token, and bodies without braces', () => {
    expect(() => stubBody(`trigger T on A (before insert) { ${TEMPLATE_ESC} }`, 't', 'd')).toThrow(/escape token/)
    expect(() => stubBody('trigger T on A (before insert)', 't', 'd')).toThrow(/braces/)
  })

  it('GOLDEN: the deploy wrap → unwrap over a template stub returns the stub byte-exact', () => {
    const stub = stubBody(BODY, 'Acme dev sandbox', '2026-10-11')
    // The deploy engine must be WILLING to wrap it (no refusal) …
    expect(wouldDeployRefuse(stub)).toBe(false)
    const wrapped = commentOutBody(stub)
    expect(wrapped).toContain(BEGIN_MARKER)
    expect(wrapped).toContain(ESCAPED_CLOSE) // our END marker's `*/` got escaped by the deploy
    expect(wrapped).not.toBe(stub)
    // … and its unwrap must return exactly the stub.
    expect(uncommentBody(wrapped)).toBe(stub)
    // The deploy-wrapped state is recognised as the DEPLOY's, not ours.
    expect(bodyState(wrapped)).toBe('deployWrapped')
    // And unstubbing the restored stub still yields the original body.
    expect(unstubBody(uncommentBody(wrapped))).toBe(BODY)
  })

  it('the orphan predicate is false for a template stub (the sweep never touches it)', () => {
    const stub = stubBody(BODY, 't', 'd')
    expect(stub.includes(BEGIN_MARKER)).toBe(false)
  })
})
