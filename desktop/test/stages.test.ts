import { describe, expect, it } from 'vitest'
import { dataStageState, stageAllowsContinue, stageStateOf } from '../src/main/engine/deploy/stages'

/**
 * S62 (U-2) — the stop rule for composed deployments. A stage's report state becomes the stage's
 * word; only clean/partial let the sequence continue; the data stage is partial (not failed) when it
 * finished with failed records.
 */
describe('composed deployment stages — pure rules', () => {
  it('maps a template report state to the stage word, unknown → failed', () => {
    for (const s of ['clean', 'partial', 'failed', 'blocked', 'cancelled'] as const) expect(stageStateOf(s)).toBe(s)
    expect(stageStateOf('running')).toBe('failed')
    expect(stageStateOf('bogus')).toBe('failed')
  })
  it('only clean and partial continue the sequence', () => {
    expect(stageAllowsContinue('clean')).toBe(true)
    expect(stageAllowsContinue('partial')).toBe(true)
    for (const s of ['failed', 'blocked', 'cancelled', 'skipped', 'pending', 'running'] as const) {
      expect(stageAllowsContinue(s)).toBe(false)
    }
  })
  it('the data stage is partial with failed records, clean without', () => {
    expect(dataStageState(0)).toBe('clean')
    expect(dataStageState(4)).toBe('partial')
  })
})
