/** S54 (F5): peak-memory sampler — injected reader + timers, no Electron. */
import { describe, it, expect, vi } from 'vitest'
import {
  peaksToMB,
  startMemorySampler,
  summarizePeaks,
  type ProcessSample
} from '../src/main/services/memorySampler'

function fakeTimers(): {
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
  tick: () => void
  cleared: number
  intervals: number[]
} {
  const state = { fn: null as null | (() => void), cleared: 0, intervals: [] as number[] }
  return {
    timers: {
      set: (fn, ms) => {
        state.fn = fn
        state.intervals.push(ms)
        return 'h'
      },
      clear: () => {
        state.cleared += 1
      }
    },
    tick: () => state.fn?.(),
    get cleared() {
      return state.cleared
    },
    get intervals() {
      return state.intervals
    }
  }
}

const MB = 1024

describe('startMemorySampler', () => {
  it('keeps the PEAK per process type across samples, sums same-type processes, labels main/renderer', () => {
    const reads: ProcessSample[][] = [
      [
        { type: 'Browser', workingSetKB: 300 * MB },
        { type: 'Tab', workingSetKB: 200 * MB },
        { type: 'Tab', workingSetKB: 50 * MB },
        { type: 'GPU', workingSetKB: 40 * MB }
      ],
      [
        { type: 'Browser', workingSetKB: 412 * MB },
        { type: 'Tab', workingSetKB: 380 * MB },
        { type: 'GPU', workingSetKB: 30 * MB }
      ],
      [
        { type: 'Browser', workingSetKB: 100 * MB },
        { type: 'Tab', workingSetKB: 100 * MB },
        { type: 'GPU', workingSetKB: 91 * MB }
      ]
    ]
    let i = 0
    const f = fakeTimers()
    const s = startMemorySampler(() => reads[Math.min(i++, reads.length - 1)]!, 30_000, f.timers)
    f.tick()
    expect(s.stop()).toBe('Peak memory during the run: main 412 MB, renderer 380 MB, gpu 91 MB.')
    expect(f.cleared).toBe(1)
    expect(f.intervals).toEqual([30_000])
  })

  it('a failing reader never throws and contributes nothing', () => {
    const f = fakeTimers()
    const read = vi.fn(() => {
      throw new Error('metrics unavailable')
    })
    const s = startMemorySampler(read, 1000, f.timers)
    f.tick()
    expect(s.stop()).toBeNull()
    expect(read).toHaveBeenCalledTimes(3) // start, tick, stop
  })

  it('stop is idempotent', () => {
    const f = fakeTimers()
    const s = startMemorySampler(() => [{ type: 'Browser', workingSetKB: 10 * MB }], 1000, f.timers)
    expect(s.stop()).toBe('Peak memory during the run: main 10 MB.')
    expect(s.stop()).toBe('Peak memory during the run: main 10 MB.')
    expect(f.cleared).toBe(1)
  })
})

describe('summarizePeaks', () => {
  it('orders main, renderer, gpu, then others alphabetically; empty → null', () => {
    expect(summarizePeaks(new Map())).toBeNull()
    expect(
      summarizePeaks(
        new Map([
          ['Utility', 20 * MB],
          ['GPU', 30 * MB],
          ['Tab', 200 * MB],
          ['Browser', 300 * MB]
        ])
      )
    ).toBe('Peak memory during the run: main 300 MB, renderer 200 MB, gpu 30 MB, utility 20 MB.')
  })
})

describe('peaksMB (S64 P5 5.1 — the persisted shape)', () => {
  it('mirrors the summary line: MB per label, main/renderer/gpu first, others after; empty → null', () => {
    expect(peaksToMB(new Map())).toBeNull()
    expect(
      peaksToMB(
        new Map([
          ['Utility', 7 * MB],
          ['GPU', 91 * MB],
          ['Tab', 380 * MB],
          ['Browser', 412 * MB]
        ])
      )
    ).toEqual({ main: 412, renderer: 380, gpu: 91, utility: 7 })
    const ft = fakeTimers()
    const reads: ProcessSample[][] = [
      [{ type: 'Browser', workingSetKB: 100 * MB }],
      [{ type: 'Browser', workingSetKB: 300 * MB }, { type: 'Tab', workingSetKB: 50 * MB }]
    ]
    let i = 0
    const s = startMemorySampler(() => reads[Math.min(i++, reads.length - 1)]!, 30_000, ft.timers)
    expect(s.stop()).toBe('Peak memory during the run: main 300 MB, renderer 50 MB.')
    expect(s.peaksMB()).toEqual({ main: 300, renderer: 50 })
    const none = startMemorySampler(() => { throw new Error('no metrics') }, 30_000, fakeTimers().timers)
    none.stop()
    expect(none.peaksMB()).toBeNull()
  })
})
