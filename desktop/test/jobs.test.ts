import { describe, it, expect } from 'vitest'
import { JobManager } from '../src/main/jobs'
import type { JobEvent } from '../src/shared/types'

/** Collects emitted events and drives a deterministic clock. */
function harness(): { jm: JobManager; events: JobEvent[]; tick: () => void } {
  const events: JobEvent[] = []
  let clock = 1000
  const jm = new JobManager(
    (e) => events.push(e),
    () => clock
  )
  return { jm, events, tick: () => (clock += 1) }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('JobManager', () => {
  it('runs a job to completion and emits progress then done, in order', async () => {
    const { jm, events } = harness()
    jm.start('demo', 'T', async (ctx) => {
      ctx.progress(1, 2, 'half')
      ctx.progress(2, 2, 'full')
      return { ok: true }
    })
    await flush()
    expect(events.map((e) => e.kind)).toEqual(['progress', 'progress', 'done'])
    expect(events[0]!.data).toEqual({ value: 1, max: 2, label: 'half' })
    expect(events[2]!.data).toEqual({ result: { ok: true } })
    expect(jm.list()[0]!.status).toBe('done')
    // list() reflects the latest progress snapshot (re-attach after reload).
    expect(jm.list()[0]!.progress).toEqual({ value: 2, max: 2, label: 'full' })
  })

  it('S46 D3: phase() stamps the summary AND emits — list()/get() re-attach with the current phase; ctx.jobId is the job id', async () => {
    const { jm, events } = harness()
    let seenId = ''
    const id = jm.start('deploy', 'T', async (ctx) => {
      seenId = ctx.jobId
      ctx.phase('Connecting')
      ctx.phase('Deploying')
      await flush()
    })
    await flush()
    expect(seenId).toBe(id)
    expect(jm.get(id)!.phase).toBe('Deploying')
    expect(events.filter((e) => e.kind === 'phase').map((e) => e.data)).toEqual([
      { name: 'Connecting' },
      { name: 'Deploying' }
    ])
  })

  it('emits error (not cancelled) when the work throws', async () => {
    const { jm, events } = harness()
    jm.start('demo', 'T', async () => {
      throw new Error('boom')
    })
    await flush()
    expect(events.at(-1)!.kind).toBe('error')
    expect(events.at(-1)!.data).toEqual({ message: 'boom' })
    expect(jm.get(jm.list()[0]!.id)!.error).toBe('boom')
  })

  it('honors cooperative cancel at the next checkpoint (does not finish remaining units)', async () => {
    const { jm, events } = harness()
    let reached = 0
    const id = jm.start('demo', 'T', async (ctx) => {
      for (let i = 0; i < 5; i++) {
        ctx.cancel.throwIfCancelled()
        reached = i + 1
        ctx.progress(i + 1, 5)
        await flush()
      }
    })
    await flush() // let it start + do the first unit
    jm.cancel(id)
    await flush()
    await flush()
    expect(jm.get(id)!.status).toBe('cancelled')
    expect(events.at(-1)!.kind).toBe('cancelled')
    expect(reached).toBeLessThan(5) // stopped early
  })

  it('cancel after completion is a no-op', async () => {
    const { jm } = harness()
    const id = jm.start('demo', 'T', async () => undefined)
    await flush()
    jm.cancel(id)
    expect(jm.get(id)!.status).toBe('done')
  })

  it('list() returns all jobs oldest-first with independent ids', async () => {
    const { jm } = harness()
    const a = jm.start('demo', 'A', async () => undefined)
    const b = jm.start('analysis', 'B', async () => undefined)
    await flush()
    const ids = jm.list().map((s) => s.id)
    expect(ids).toEqual([a, b])
    expect(a).not.toBe(b)
  })
})
