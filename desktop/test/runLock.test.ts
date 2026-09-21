/**
 * S53 (item 2) — per-target-org run lock decision (pure lane). The store side
 * (`Store.deploymentsSharingTarget`) is covered in test/integration/runLock.store.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { targetLockConflict, type TargetLockCandidate } from '../src/main/services/runLock'

const free = (
  id: number,
  name: string,
  over: Partial<TargetLockCandidate> = {}
): TargetLockCandidate => ({
  deploymentId: id,
  name,
  runningJob: false,
  liveRunPhase: null,
  unconfirmedRestore: 0,
  ...over
})

describe('targetLockConflict', () => {
  it('returns null when no sibling deployment holds the target', () => {
    expect(targetLockConflict([], 'onesolve')).toBeNull()
    expect(targetLockConflict([free(21, '11 ts'), free(22, 'onetry')], 'onesolve')).toBeNull()
  })

  it('a sibling with a RUNNING deploy job wins and names it', () => {
    const msg = targetLockConflict(
      [free(21, '11 ts'), free(25, 'jjmjjjjj', { runningJob: true, liveRunPhase: 'Deploying' })],
      'onesolve'
    )
    expect(msg).toContain('Deployment "jjmjjjjj" (#25) is deploying into onesolve right now')
    expect(msg).toContain('disable and restore each other')
  })

  it('a sibling with a live (non-terminal) run — incl. Stalled — blocks with the restore pointer', () => {
    const msg = targetLockConflict(
      [free(14, 'express scripts', { liveRunPhase: 'Stalled' })],
      'sb1_830'
    )
    expect(msg).toContain(
      'Deployment "express scripts" (#14) has a run recorded as Stalled against sb1_830'
    )
    expect(msg).toContain('Restore it')
  })

  it('a sibling whose last run left unconfirmed restore rows blocks, with the count', () => {
    expect(
      targetLockConflict([free(14, 'express scripts', { unconfirmedRestore: 3 })], 'sb1_830')
    ).toContain('ended with 3 automation items not confirmed restored on sb1_830')
    expect(
      targetLockConflict([free(14, 'express scripts', { unconfirmedRestore: 1 })], 'sb1_830')
    ).toContain('1 automation item not confirmed')
  })

  it('priority: running job > live run > unconfirmed restore', () => {
    const msg = targetLockConflict(
      [
        free(1, 'a', { unconfirmedRestore: 2 }),
        free(2, 'b', { liveRunPhase: 'RestoringAutomation' }),
        free(3, 'c', { runningJob: true })
      ],
      't'
    )
    expect(msg).toContain('Deployment "c" (#3) is deploying')
    const msg2 = targetLockConflict(
      [free(1, 'a', { unconfirmedRestore: 2 }), free(2, 'b', { liveRunPhase: 'Deploying' })],
      't'
    )
    expect(msg2).toContain('Deployment "b" (#2) has a run recorded as Deploying')
  })
})
